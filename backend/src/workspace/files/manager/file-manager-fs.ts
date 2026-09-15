/**
 * 文件管理器的本机 fs 网关：**这一个文件**是 `workspace/files/manager` 里唯一直接调用 fs 的地方
 * （`test/fs-call-sites.test.ts` 按文件名豁免，与 `runtime-fs.ts` 同理）。
 *
 * 路径是数据给的（用户在界面上点出来的），所以这里的每个入口都先过包含判定：
 * - 已存在的目标：`realpath` 必须落在根的真实路径之内——软链指向根外（文件或目录）一律拒绝；
 * - 要新建的目标：**最近的已存在祖先**的真实路径必须在根内，目标本身若已存在且是软链则拒绝写穿；
 * - 读只读普通文件（命名管道、设备文件挂不住请求）；写一律同目录临时文件 + rename；
 * - 删除与改名作用在链接本身（lstat），不跟随。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';

import { fmError } from './file-manager-errors';
import { isInside } from './path-policy';

const fsp = fs.promises;

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fsp.realpath(target);
  } catch {
    return null;
  }
}

/** 根的真实路径；根不存在或不是目录抛 rootNotFound。 */
export async function realRoot(rootPath: string): Promise<string> {
  const real = await realpathOrNull(rootPath);
  if (!real) throw fmError.rootNotFound();
  const stat = await fsp.stat(real).catch(() => null);
  if (!stat?.isDirectory()) throw fmError.rootNotFound();
  return real;
}

/** 已存在的目标：返回真实路径（在根内），不存在抛 notFound，逃出根抛 outsideRoot。 */
export async function resolveExisting(root: string, relPath: string): Promise<string> {
  const rootReal = await realRoot(root);
  const lexical = path.join(rootReal, relPath);
  if (!isInside(lexical, rootReal)) throw fmError.outsideRoot();
  const real = await realpathOrNull(lexical);
  if (!real) {
    // 断掉的软链也算「不存在」，但要先判它是不是链接：链接本身在根内，删除可以作用在链接上。
    const lstat = await fsp.lstat(lexical).catch(() => null);
    if (lstat?.isSymbolicLink()) throw fmError.outsideRoot();
    throw fmError.notFound();
  }
  if (!isInside(real, rootReal)) throw fmError.outsideRoot();
  return real;
}

/** 链接本身（不跟随）的路径：父目录真实路径在根内，返回「父目录真实路径 + 名字」。 */
export async function resolveLinkItself(root: string, relPath: string): Promise<{ path: string; exists: boolean; isSymlink: boolean }> {
  const rootReal = await realRoot(root);
  if (!relPath) return { path: rootReal, exists: true, isSymlink: false };
  const parentReal = await resolveCreatableParent(rootReal, path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath));
  const target = path.join(parentReal, path.posix.basename(relPath));
  const lstat = await fsp.lstat(target).catch(() => null);
  return { path: target, exists: Boolean(lstat), isSymlink: Boolean(lstat?.isSymbolicLink()) };
}

/** 要新建的目标：最近的已存在祖先真实路径在根内；返回「祖先真实路径 + 剩余段」。 */
async function resolveCreatableParent(rootReal: string, relDir: string): Promise<string> {
  const lexical = path.join(rootReal, relDir);
  if (!isInside(lexical, rootReal)) throw fmError.outsideRoot();
  let probe = lexical;
  const rest: string[] = [];
  for (;;) {
    const real = await realpathOrNull(probe);
    if (real) {
      if (!isInside(real, rootReal)) throw fmError.outsideRoot();
      return path.join(real, ...rest.reverse());
    }
    // 断链：不许借它往外建。
    const lstat = await fsp.lstat(probe).catch(() => null);
    if (lstat?.isSymbolicLink()) throw fmError.outsideRoot();
    rest.push(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) throw fmError.outsideRoot();
    probe = parent;
  }
}

export async function resolveForCreate(root: string, relPath: string): Promise<string> {
  const rootReal = await realRoot(root);
  // 目标本身若是软链：rename 落位替换的是链接本身，不写穿到链接指向的地方；读当前内容（版本号比对）时经 resolveExisting 已判过。
  return path.join(await resolveCreatableParent(rootReal, path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath)), path.posix.basename(relPath));
}

export type LocalEntryStat = { kind: 'file' | 'dir' | 'symlink' | 'other'; size: number; mtimeMs: number };

function kindOf(stat: fs.Stats): LocalEntryStat['kind'] {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

export async function statReal(realPath: string): Promise<LocalEntryStat> {
  const stat = await fsp.stat(realPath);
  return { kind: kindOf(stat), size: stat.size, mtimeMs: stat.mtimeMs };
}

/** 列目录：按 lstat 报类型（软链显示为 symlink，不跟随）。 */
export async function listDirReal(realDir: string): Promise<Array<{ name: string } & LocalEntryStat>> {
  const stat = await fsp.stat(realDir);
  if (!stat.isDirectory()) throw fmError.notDirectory();
  const names = await fsp.readdir(realDir);
  const entries = await Promise.all(names.map(async (name) => {
    const lstat = await fsp.lstat(path.join(realDir, name)).catch(() => null);
    if (!lstat) return null;
    return { name, kind: kindOf(lstat), size: lstat.isFile() ? lstat.size : 0, mtimeMs: lstat.mtimeMs };
  }));
  return entries.filter((entry): entry is { name: string } & LocalEntryStat => entry !== null);
}

/** 只读普通文件，≤ maxBytes。 */
export async function readRegularFile(realPath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fsp.open(realPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) throw fmError.isDirectory();
    if (!stat.isFile()) throw fmError.notFound();
    if (stat.size > maxBytes) throw fmError.tooLarge(maxBytes);
    const buffer = await handle.readFile();
    if (buffer.length > maxBytes) throw fmError.tooLarge(maxBytes);
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function openRegularReadStream(realPath: string, maxBytes: number): Promise<{ stream: Readable; size: number }> {
  const stat = await fsp.stat(realPath);
  if (stat.isDirectory()) throw fmError.isDirectory();
  if (!stat.isFile()) throw fmError.notFound();
  if (stat.size > maxBytes) throw fmError.tooLarge(maxBytes);
  return { stream: fs.createReadStream(realPath), size: stat.size };
}

/** 原子写：同目录临时文件 + fsync + rename。父目录必须已存在。 */
export async function writeAtomic(targetPath: string, data: Buffer): Promise<void> {
  const dir = path.dirname(targetPath);
  const parent = await fsp.stat(dir).catch(() => null);
  if (!parent?.isDirectory()) throw fmError.notFound();
  const existing = await fsp.lstat(targetPath).catch(() => null);
  if (existing?.isDirectory()) throw fmError.isDirectory();
  const temp = path.join(dir, `.clawopt-fm-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const handle = await fsp.open(temp, 'wx', existing ? existing.mode & 0o777 : 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(temp, targetPath);
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
}

/** 把本机文件搬到目标：同设备 rename，跨设备复制后删除。 */
export async function moveLocalFile(source: string, targetPath: string, overwrite: boolean): Promise<void> {
  const existing = await fsp.lstat(targetPath).catch(() => null);
  if (existing && !overwrite) throw fmError.exists();
  if (existing?.isDirectory()) throw fmError.isDirectory();
  try {
    await fsp.rename(source, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const temp = path.join(path.dirname(targetPath), `.clawopt-fm-${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
    await fsp.rename(temp, targetPath);
    await fsp.rm(source, { force: true });
  }
}

export async function makeDir(targetPath: string): Promise<void> {
  await fsp.mkdir(targetPath, { recursive: false });
}

export async function renameEntry(from: string, to: string): Promise<void> {
  const exists = await fsp.lstat(to).catch(() => null);
  if (exists) throw fmError.exists();
  await fsp.rename(from, to);
}

/** 复制：不解引用软链（链接照原样复制，之后经它读写仍要过包含判定）。 */
export async function copyEntry(from: string, to: string): Promise<void> {
  const exists = await fsp.lstat(to).catch(() => null);
  if (exists) throw fmError.exists();
  await fsp.cp(from, to, { recursive: true, dereference: false, errorOnExist: true, force: false, verbatimSymlinks: true });
}

export async function removeEntry(target: string, recursive: boolean): Promise<void> {
  const lstat = await fsp.lstat(target);
  if (lstat.isDirectory() && !lstat.isSymbolicLink()) {
    if (!recursive) {
      await fsp.rmdir(target);
      return;
    }
    await fsp.rm(target, { recursive: true, force: false });
    return;
  }
  await fsp.unlink(target);
}

// ---- 分块上传的临时文件（在 ClawOPT 数据目录里，不在根里） ----

export async function ensurePrivateDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function createEmptyPart(partPath: string): Promise<void> {
  await ensurePrivateDir(path.dirname(partPath));
  const handle = await fsp.open(partPath, 'wx', 0o600);
  await handle.close();
}

export async function partSize(partPath: string): Promise<number> {
  const stat = await fsp.stat(partPath).catch(() => null);
  return stat?.isFile() ? stat.size : -1;
}

/** 在 `offset` 处追加一块：文件当前大小必须恰好等于 offset。 */
export async function appendPartChunk(partPath: string, offset: number, chunk: Buffer): Promise<number> {
  const handle = await fsp.open(partPath, 'r+');
  try {
    const stat = await handle.stat();
    if (stat.size !== offset) return stat.size;
    await handle.write(chunk, 0, chunk.length, offset);
    await handle.sync();
    return offset + chunk.length;
  } finally {
    await handle.close();
  }
}

/** 分块上传完成后把临时文件送到远端后端的 stdin。 */
export function openLocalReadStream(localFile: string): Readable {
  return fs.createReadStream(localFile);
}

export async function removeFileQuiet(target: string): Promise<void> {
  await fsp.rm(target, { force: true }).catch(() => undefined);
}

export async function listDirNamesQuiet(dir: string): Promise<string[]> {
  return fsp.readdir(dir).catch(() => []);
}

// ---- 额外根的校验、known_hosts 文件 ----

export async function statDirectoryReal(candidate: string): Promise<string | null> {
  const real = await realpathOrNull(candidate);
  if (!real) return null;
  const stat = await fsp.stat(real).catch(() => null);
  return stat?.isDirectory() ? real : null;
}

export async function readSmallText(filePath: string, maxBytes = 1024 * 1024): Promise<string | null> {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size > maxBytes) throw fmError.tooLarge(maxBytes);
  return fsp.readFile(filePath, 'utf8');
}

export async function writeSmallTextAtomic(filePath: string, text: string): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  const temp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(temp, text, { mode: 0o600 });
  await fsp.rename(temp, filePath);
}

export async function isRegularFile(filePath: string): Promise<boolean> {
  const stat = await fsp.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}
