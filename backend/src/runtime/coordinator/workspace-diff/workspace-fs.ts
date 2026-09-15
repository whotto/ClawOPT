/**
 * 工作区 diff 读文件的唯一入口。
 *
 * 路径来自运行时在工作区里改出来的文件名（数据给的），所以：
 * - 凭据类文件名（与出文件闸门同一份判据）连读都不读；
 * - 目录里任何一段是符号链接就不读（realpath 必须等于「工作区真实根 + 相对路径」），逃不出工作区；
 * - 最后一段用 O_NOFOLLOW 打开、fstat 判普通文件（命名管道、设备挂不住）；
 * - 只读前 `maxBytes + 1` 个字节：读到多于上限就只报大小，不给内容。
 */
import { constants as fsConstants, promises as fsp } from 'fs';
import path from 'path';

import { isCredentialLikeFileName } from '../../../core/files';

export type FileProbe =
  | { kind: 'absent' }
  /** 存在但不进 diff：符号链接（含路径中间的）、非普通文件、越界、凭据类文件名。 */
  | { kind: 'skipped' }
  | { kind: 'present'; size: number; mtimeMs: number; content: Buffer | null };

export function isInsideRoot(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 相对路径（posix 分隔）→ 绝对路径；越界、凭据类文件名返回 null。 */
export function resolveWorkspaceFile(rootReal: string, relPath: string): string | null {
  if (!relPath || path.isAbsolute(relPath)) return null;
  const abs = path.resolve(rootReal, ...relPath.split('/'));
  if (!isInsideRoot(abs, rootReal) || abs === rootReal) return null;
  if (isCredentialLikeFileName(path.basename(abs))) return null;
  return abs;
}

/**
 * 看一个工作区文件的当前状态。`wantContent` 为 false 时只 stat（完成阶段先比大小与修改时间，没变就不读）。
 * 不存在返回 absent；符号链接、非普通文件、越界、凭据类返回 skipped——它们不进 diff（既不算删除也不算新增）。
 */
export async function probeWorkspaceFile(rootReal: string, relPath: string, options: { maxBytes: number; wantContent: boolean }): Promise<FileProbe> {
  const abs = resolveWorkspaceFile(rootReal, relPath);
  if (!abs) return { kind: 'skipped' };
  let real: string;
  try {
    real = await fsp.realpath(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // 最后一段不存在；可要是它是一个悬空的符号链接，照样按 skipped 处理。
      try {
        await fsp.lstat(abs);
        return { kind: 'skipped' };
      } catch {
        return { kind: 'absent' };
      }
    }
    return { kind: 'skipped' };
  }
  if (real !== abs) return { kind: 'skipped' };
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: 'skipped' };
    if (!options.wantContent || stat.size > options.maxBytes) {
      return { kind: 'present', size: stat.size, mtimeMs: stat.mtimeMs, content: null };
    }
    const buffer = Buffer.alloc(Math.min(stat.size, options.maxBytes) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > options.maxBytes) return { kind: 'present', size: offset, mtimeMs: stat.mtimeMs, content: null };
    return { kind: 'present', size: offset, mtimeMs: stat.mtimeMs, content: buffer.subarray(0, offset) };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'skipped' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
