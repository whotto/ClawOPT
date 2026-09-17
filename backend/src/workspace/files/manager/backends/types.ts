/**
 * 可插拔文件后端（spec 07 §2.8）：同一套操作，经本地 fs、`ssh` CLI、`docker exec` 三种传输。
 *
 * 所有路径都是**已校验的相对路径**（`path-policy.ts` 的 `normalizeRelativePath` 之后），`''` 是根本身。
 * 包含判定（软链逃逸）在后端内部做：本地后端按 realpath，远端后端在远端脚本里按 `pwd -P` 判并拒绝软链。
 */
import type { Readable } from 'stream';

export type FileEntryKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  /** 相对根的路径。 */
  path: string;
  kind: FileEntryKind;
  size: number;
  /** 毫秒时间戳。 */
  mtimeMs: number;
}

export interface FileBackend {
  readonly kind: 'local' | 'ssh' | 'docker';
  list(relDir: string): Promise<FileEntry[]>;
  stat(relPath: string): Promise<FileEntry>;
  /** 读整个文件（≤ maxBytes，超过抛 tooLarge）。 */
  read(relPath: string, maxBytes: number): Promise<Buffer>;
  /** 原子替换写（本地：同目录临时文件 + rename）。父目录必须存在。 */
  write(relPath: string, data: Buffer): Promise<void>;
  /** 从本机临时文件整体写到目标（分块上传完成时用）。`overwrite` 为 false 时目标已存在抛 alreadyExists。 */
  writeFromLocalFile(relPath: string, localFile: string, options: { overwrite: boolean }): Promise<void>;
  mkdir(relPath: string): Promise<void>;
  rename(fromRel: string, toRel: string): Promise<void>;
  copy(fromRel: string, toRel: string): Promise<void>;
  remove(relPath: string, options: { recursive: boolean }): Promise<void>;
  /** 下载流（≤ maxBytes）。 */
  openReadStream(relPath: string, maxBytes: number): Promise<{ stream: Readable; size: number }>;
  /** 本地后端给出根的真实路径（git 状态标注、服务路径闸门用）；远端为 null。 */
  localRealPath(relPath: string): Promise<string | null>;
}
