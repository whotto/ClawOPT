/**
 * 群共享工作区（spec 02 F17 / F20 的文件部分）：路径闸门、文件操作（带 SHA-256 乐观并发）、每次运行的 diff。
 *
 * ## 路径
 *
 * 一律相对工作区根：不收绝对路径、不收 `..`、realpath 之后必须仍在根里（软链接逃不出去）、
 * 敏感名字（凭据 / 密钥 / 数据库 / `.git` / `node_modules`…，与可服务路径闸门同一份名单）一律拒绝。
 *
 * ## 每次运行的 diff（工作区 diff 检查点的最小缝）
 *
 * 协调器的 `WorkspaceCheckpointer` 缝在 P1a 定下、实现留给 P1b，P1b 还没合进来；群聊先在 rooms 里实现一个最小版本，
 * 包在群成员的一跳外面（本机成员与远程成员一样：远程成员经令牌写的是 host 的群工作区）。
 * 有界扫描：≤20k 个文件、≤5k 个目录、深度 ≤16、≤1 秒、快照里文本内容合计 ≤64 MB；跳过常见的构建 / 依赖目录与二进制扩展名。
 * 结束时：≤80 个文件、单文件补丁 ≤256 KB、合计 ≤1 MB，超出的标 truncated。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

import { diffLines, unifiedDiff } from '../../control';
import { isSensitiveRelativePath } from '../../core/files';
import { applyRoomSchema } from './room-schema';

export const WORKSPACE_TEXT_READ_LIMIT = 1024 * 1024;
export const WORKSPACE_BINARY_LIMIT = 20 * 1024 * 1024;
export const WORKSPACE_LIST_LIMIT = 500;

const SNAPSHOT_MAX_FILES = 20_000;
const SNAPSHOT_MAX_DIRS = 5_000;
const SNAPSHOT_MAX_DEPTH = 16;
const SNAPSHOT_MAX_MS = 1000;
const SNAPSHOT_MAX_TEXT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_TEXT_FILE_LIMIT = 512 * 1024;
const DIFF_MAX_FILES = 80;
const DIFF_MAX_PATCH_BYTES = 256 * 1024;
const DIFF_MAX_TOTAL_BYTES = 1024 * 1024;
const DIFF_MAX_LINES = 5000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'target', '.turbo', 'coverage']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.mp3', '.mp4', '.mov', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.exe', '.dll', '.so', '.dylib', '.bin', '.sqlite', '.db', '.jar', '.class', '.o', '.a', '.xlsx', '.docx', '.pptx']);

export class WorkspacePathError extends Error {
  constructor(readonly code: 'workspace.invalidPath' | 'workspace.permissionDenied' | 'workspace.notFound' | 'workspace.conflict' | 'workspace.tooLarge' | 'workspace.notAFile', message?: string, readonly status = code === 'workspace.notFound' ? 404 : code === 'workspace.conflict' ? 409 : code === 'workspace.tooLarge' ? 413 : code === 'workspace.permissionDenied' ? 403 : 400) {
    super(message ?? code);
    this.name = 'WorkspacePathError';
  }
}

export function sha256(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 群工作区里**唯一**的读入口：路径来自请求（相对路径已过 normalizeRelativePath + resolveInsideRoot），
 * 读之前 lstat 判普通文件、拒绝软链接与命名管道（不跟 FIFO 较劲挂住读取）。
 */
export function readRegularFile(abs: string): Buffer {
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new WorkspacePathError('workspace.notAFile');
  return fs.readFileSync(abs);
}

/** 群工作区里**唯一**的写入口：同目录临时文件 + rename（0644），调用方已按路径加锁并做完 SHA-256 并发检查。 */
export function writeFileAtomic(abs: string, temp: string, content: Buffer): void {
  fs.writeFileSync(temp, content, { mode: 0o644 });
  fs.renameSync(temp, abs);
}

/** 规范化相对路径；不合法抛错。空串 = 根。 */
export function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string') throw new WorkspacePathError('workspace.invalidPath');
  const raw = input.replace(/\\/g, '/').trim();
  if (raw.includes('\0') || raw.length > 4096) throw new WorkspacePathError('workspace.invalidPath');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new WorkspacePathError('workspace.invalidPath', 'absolute paths are not accepted');
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) throw new WorkspacePathError('workspace.invalidPath', 'parent segments are not accepted');
  const rel = segments.join('/');
  if (rel && isSensitiveRelativePath(rel)) throw new WorkspacePathError('workspace.permissionDenied');
  return rel;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 相对路径 → 绝对路径，保证 realpath 在根里。目标不存在时检查最近一个存在的祖先（新建文件的场景）。
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  const realRoot = fs.realpathSync(root);
  const target = path.join(realRoot, relativePath);
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (!isInside(realProbe, realRoot)) throw new WorkspacePathError('workspace.permissionDenied', 'path escapes the workspace');
  if (fs.existsSync(target)) {
    const lst = fs.lstatSync(target);
    if (lst.isSymbolicLink()) {
      const real = fs.realpathSync(target);
      if (!isInside(real, realRoot)) throw new WorkspacePathError('workspace.permissionDenied', 'path escapes the workspace');
    }
  }
  return target;
}

export type WorkspaceEntry = { name: string; path: string; type: 'file' | 'directory'; size: number; modifiedAt: number };

/** 文件操作（群工作区编辑器与远程令牌接口共用）。按路径串行写入，SHA-256 乐观并发。 */
export class WorkspaceFiles {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: () => string) {}

  private async withLock<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  list(relativePath: string): { path: string; entries: WorkspaceEntry[]; truncated: boolean } {
    const rel = normalizeRelativePath(relativePath);
    const abs = resolveInsideRoot(this.root(), rel);
    if (!fs.existsSync(abs)) throw new WorkspacePathError('workspace.notFound');
    if (!fs.statSync(abs).isDirectory()) throw new WorkspacePathError('workspace.invalidPath', 'not a directory');
    const entries: WorkspaceEntry[] = [];
    const names = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of names) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (isSensitiveRelativePath(childRel)) continue;
      if (dirent.isSymbolicLink()) continue;
      if (!dirent.isFile() && !dirent.isDirectory()) continue;
      const stat = fs.statSync(path.join(abs, dirent.name));
      entries.push({ name: dirent.name, path: childRel, type: dirent.isDirectory() ? 'directory' : 'file', size: dirent.isDirectory() ? 0 : stat.size, modifiedAt: Math.floor(stat.mtimeMs) });
      if (entries.length >= WORKSPACE_LIST_LIMIT) break;
    }
    return { path: rel, entries, truncated: names.length > entries.length };
  }

  statFile(relativePath: string): { abs: string; rel: string; size: number } {
    const rel = normalizeRelativePath(relativePath);
    if (!rel) throw new WorkspacePathError('workspace.invalidPath');
    const abs = resolveInsideRoot(this.root(), rel);
    if (!fs.existsSync(abs)) throw new WorkspacePathError('workspace.notFound');
    const lst = fs.lstatSync(abs);
    if (lst.isSymbolicLink() || !lst.isFile()) throw new WorkspacePathError('workspace.notAFile');
    return { abs, rel, size: lst.size };
  }

  readText(relativePath: string, limit = WORKSPACE_TEXT_READ_LIMIT): { path: string; content: string; sha256: string; size: number } {
    const { abs, rel, size } = this.statFile(relativePath);
    if (size > limit) throw new WorkspacePathError('workspace.tooLarge');
    const buffer = readRegularFile(abs);
    return { path: rel, content: buffer.toString('utf8'), sha256: sha256(buffer), size };
  }

  readBinary(relativePath: string, limit = WORKSPACE_BINARY_LIMIT): { path: string; buffer: Buffer; sha256: string } {
    const { abs, rel, size } = this.statFile(relativePath);
    if (size > limit) throw new WorkspacePathError('workspace.tooLarge');
    const buffer = readRegularFile(abs);
    return { path: rel, buffer, sha256: sha256(buffer) };
  }

  /**
   * 写入：文件已存在时必须带 `expectedSha256` 且对得上（否则 409）；写完再核一遍磁盘内容（中途被别人改了 → 409）。
   * 原子写：先写同目录临时文件再 rename，权限 0644。
   */
  async write(relativePath: string, content: Buffer, expectedSha256: string | null | undefined, limit = WORKSPACE_TEXT_READ_LIMIT): Promise<{ path: string; sha256: string; created: boolean }> {
    const rel = normalizeRelativePath(relativePath);
    if (!rel) throw new WorkspacePathError('workspace.invalidPath');
    if (content.length > limit) throw new WorkspacePathError('workspace.tooLarge');
    return this.withLock(rel, async () => {
      const abs = resolveInsideRoot(this.root(), rel);
      const exists = fs.existsSync(abs);
      if (exists) {
        const lst = fs.lstatSync(abs);
        if (lst.isSymbolicLink() || !lst.isFile()) throw new WorkspacePathError('workspace.notAFile');
        const current = sha256(readRegularFile(abs));
        if (!expectedSha256 || expectedSha256 !== current) throw new WorkspacePathError('workspace.conflict', 'file changed or expectedSha256 missing');
      } else if (expectedSha256) {
        throw new WorkspacePathError('workspace.conflict', 'file does not exist');
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      resolveInsideRoot(this.root(), rel);
      const temp = `${abs}.clawopt-tmp-${crypto.randomBytes(6).toString('hex')}`;
      writeFileAtomic(abs, temp, content);
      const written = sha256(readRegularFile(abs));
      const expected = sha256(content);
      if (written !== expected) throw new WorkspacePathError('workspace.conflict', 'file changed while writing');
      return { path: rel, sha256: written, created: !exists };
    });
  }

  async mkdir(relativePath: string): Promise<{ path: string }> {
    const rel = normalizeRelativePath(relativePath);
    if (!rel) throw new WorkspacePathError('workspace.invalidPath');
    return this.withLock(rel, () => {
      const abs = resolveInsideRoot(this.root(), rel);
      fs.mkdirSync(abs, { recursive: true });
      return { path: rel };
    });
  }

  /** 删除：文件必须带对得上的 `expectedSha256`；目录只删空目录；软链接拒绝。 */
  async remove(relativePath: string, expectedSha256: string | null | undefined): Promise<{ path: string }> {
    const rel = normalizeRelativePath(relativePath);
    if (!rel) throw new WorkspacePathError('workspace.invalidPath');
    return this.withLock(rel, () => {
      const abs = resolveInsideRoot(this.root(), rel);
      if (!fs.existsSync(abs)) throw new WorkspacePathError('workspace.notFound');
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink()) throw new WorkspacePathError('workspace.permissionDenied', 'symlinks cannot be deleted');
      if (lst.isDirectory()) {
        fs.rmdirSync(abs);
        return { path: rel };
      }
      const current = sha256(readRegularFile(abs));
      if (!expectedSha256 || expectedSha256 !== current) throw new WorkspacePathError('workspace.conflict');
      fs.rmSync(abs);
      return { path: rel };
    });
  }

  async rename(fromPath: string, toPath: string): Promise<{ from: string; to: string }> {
    const from = normalizeRelativePath(fromPath);
    const to = normalizeRelativePath(toPath);
    if (!from || !to) throw new WorkspacePathError('workspace.invalidPath');
    return this.withLock(from, () => {
      const absFrom = resolveInsideRoot(this.root(), from);
      const absTo = resolveInsideRoot(this.root(), to);
      if (!fs.existsSync(absFrom)) throw new WorkspacePathError('workspace.notFound');
      if (fs.lstatSync(absFrom).isSymbolicLink()) throw new WorkspacePathError('workspace.permissionDenied');
      if (fs.existsSync(absTo)) throw new WorkspacePathError('workspace.conflict', 'target exists');
      fs.mkdirSync(path.dirname(absTo), { recursive: true });
      fs.renameSync(absFrom, absTo);
      return { from, to };
    });
  }

  /** 进行中的写入全部落定（远程运行结束、令牌吊销后等它们排空再算 diff）。 */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.locks.values()]);
  }
}

// ---------------------------------------------------------------- diff

type SnapshotFile = { size: number; mtimeMs: number; hash: string; text: string | null; binary: boolean };
export type WorkspaceSnapshot = { root: string; files: Map<string, SnapshotFile>; truncated: boolean };

export type WorkspaceChangeFile = {
  id: string;
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  patch: string;
  binary: boolean;
  truncated: boolean;
};

export type WorkspaceChange = {
  status: 'completed' | 'failed' | 'aborted';
  filesChanged: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  files: WorkspaceChangeFile[];
};

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8000));
  return probe.includes(0);
}

export function takeWorkspaceSnapshot(root: string, now: () => number = Date.now): WorkspaceSnapshot {
  const files = new Map<string, SnapshotFile>();
  const started = now();
  let dirs = 0;
  let textBytes = 0;
  let truncated = false;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { root, files, truncated: false };
  }
  const stack: Array<{ abs: string; rel: string; depth: number }> = [{ abs: realRoot, rel: '', depth: 0 }];
  while (stack.length > 0) {
    if (now() - started > SNAPSHOT_MAX_MS || files.size >= SNAPSHOT_MAX_FILES || dirs >= SNAPSHOT_MAX_DIRS) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    dirs += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (current.depth + 1 > SNAPSHOT_MAX_DEPTH) { truncated = true; continue; }
        stack.push({ abs: path.join(current.abs, entry.name), rel, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSensitiveRelativePath(rel)) continue;
      const abs = path.join(current.abs, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      const binaryExt = BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
      let hash = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
      let text: string | null = null;
      let binary = binaryExt;
      if (!binaryExt && stat.size <= SNAPSHOT_TEXT_FILE_LIMIT && textBytes + stat.size <= SNAPSHOT_MAX_TEXT_BYTES) {
        try {
          const buffer = readRegularFile(abs);
          hash = sha256(buffer);
          if (looksBinary(buffer)) binary = true;
          else { text = buffer.toString('utf8'); textBytes += buffer.length; }
        } catch {
          continue;
        }
      } else if (binaryExt && stat.size <= WORKSPACE_BINARY_LIMIT) {
        try { hash = sha256(readRegularFile(abs)); } catch { continue; }
      }
      files.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, hash, text, binary });
      if (files.size >= SNAPSHOT_MAX_FILES) { truncated = true; break; }
    }
  }
  return { root: realRoot, files, truncated };
}

/** 行级 diff：复用写入审批的 Myers 实现（`control/write-gate/line-diff.ts`），这里只加上限与统计。 */
export function lineDiff(before: string, after: string): { patch: string; additions: number; deletions: number; truncated: boolean } {
  if (before.split('\n').length > DIFF_MAX_LINES || after.split('\n').length > DIFF_MAX_LINES) {
    return { patch: '', additions: after.split('\n').length, deletions: before.split('\n').length, truncated: true };
  }
  const ops = diffLines(before, after);
  const additions = ops.filter((op) => op.type === 'insert').length;
  const deletions = ops.filter((op) => op.type === 'delete').length;
  let patch = additions + deletions === 0 ? '' : unifiedDiff(before, after, { from: 'a', to: 'b' });
  let truncated = false;
  if (Buffer.byteLength(patch) > DIFF_MAX_PATCH_BYTES) {
    patch = patch.slice(0, DIFF_MAX_PATCH_BYTES);
    truncated = true;
  }
  return { patch, additions, deletions, truncated };
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, status: WorkspaceChange['status']): WorkspaceChange {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const files: WorkspaceChangeFile[] = [];
  let totalBytes = 0;
  let truncated = before.truncated || after.truncated;
  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;
  for (const rel of [...paths].sort()) {
    const prev = before.files.get(rel);
    const next = after.files.get(rel);
    if (prev && next && prev.hash === next.hash) continue;
    filesChanged += 1;
    const changeType: WorkspaceChangeFile['changeType'] = !prev ? 'added' : !next ? 'deleted' : 'modified';
    let file: WorkspaceChangeFile;
    const binary = !!(prev?.binary || next?.binary);
    if (binary || (prev && prev.text === null && !prev.binary) || (next && next.text === null && !next.binary)) {
      file = { id: sha256(rel).slice(0, 16), path: rel, changeType, additions: 0, deletions: 0, patch: '', binary, truncated: !binary };
    } else {
      const diff = lineDiff(prev?.text ?? '', next?.text ?? '');
      const adds = changeType === 'added' && (next?.text ?? '') === '' ? 0 : diff.additions;
      file = { id: sha256(rel).slice(0, 16), path: rel, changeType, additions: adds, deletions: diff.deletions, patch: diff.patch, binary: false, truncated: diff.truncated };
    }
    additions += file.additions;
    deletions += file.deletions;
    if (files.length >= DIFF_MAX_FILES || totalBytes + Buffer.byteLength(file.patch) > DIFF_MAX_TOTAL_BYTES) {
      truncated = true;
      continue;
    }
    totalBytes += Buffer.byteLength(file.patch);
    files.push(file);
  }
  return { status, filesChanged, additions, deletions, truncated, files };
}

export type StoredWorkspaceChange = WorkspaceChange & { id: string; groupId: string; memberId: string; runMarker: string; parentMessageId: number | null; createdAt: number };

export function createWorkspaceChangeStore(conn: Database.Database, now: () => number = Date.now) {
  applyRoomSchema(conn);

  function save(input: { groupId: string; memberId: string; runMarker: string; parentMessageId: number | null; change: WorkspaceChange }): StoredWorkspaceChange {
    const id = crypto.randomUUID();
    const createdAt = now();
    conn.prepare(`INSERT INTO room_workspace_changes (id, group_id, member_id, run_marker, parent_message_id, status, files_changed, additions, deletions, truncated, files_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.groupId, input.memberId, input.runMarker, input.parentMessageId, input.change.status, input.change.filesChanged,
      input.change.additions, input.change.deletions, input.change.truncated ? 1 : 0, JSON.stringify(input.change.files), createdAt,
    );
    return { ...input.change, id, groupId: input.groupId, memberId: input.memberId, runMarker: input.runMarker, parentMessageId: input.parentMessageId, createdAt };
  }

  function forMessages(groupId: string, messageIds: number[]): Map<number, StoredWorkspaceChange[]> {
    const out = new Map<number, StoredWorkspaceChange[]>();
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) return out;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const rows = conn.prepare(`SELECT * FROM room_workspace_changes WHERE group_id = ? AND parent_message_id IN (${chunk.map(() => '?').join(',')}) ORDER BY created_at ASC`)
        .all(groupId, ...chunk) as Array<Record<string, any>>;
      for (const row of rows) {
        const change: StoredWorkspaceChange = {
          id: row.id, groupId: row.group_id, memberId: row.member_id, runMarker: row.run_marker, parentMessageId: row.parent_message_id,
          status: row.status, filesChanged: row.files_changed, additions: row.additions, deletions: row.deletions, truncated: row.truncated === 1,
          files: JSON.parse(row.files_json), createdAt: row.created_at,
        };
        out.set(row.parent_message_id, [...(out.get(row.parent_message_id) ?? []), change]);
      }
    }
    return out;
  }

  function deleteForGroup(groupId: string): void {
    conn.prepare('DELETE FROM room_workspace_changes WHERE group_id = ?').run(groupId);
  }

  return { save, forMessages, deleteForGroup };
}

export type WorkspaceChangeStore = ReturnType<typeof createWorkspaceChangeStore>;
