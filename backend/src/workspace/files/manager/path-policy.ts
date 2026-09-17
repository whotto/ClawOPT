/**
 * 文件管理器的路径策略（纯函数）：相对路径校验与敏感文件判据。
 *
 * - 客户端只给「根 id + 相对路径」：不收绝对路径、不收 `..` 段、不收 NUL 与反斜杠；
 * - 敏感文件判据与 `core/files/served-paths.ts` **逐条相同**（凭据、密钥、环境变量、数据库；
 *   `.ssh` / `.aws` / `.gnupg` / `.config` / `agents` / `node_modules` / `.git` 整棵子树），
 *   源与**目标**两头都判（spec 07 §3.2 第 5 条：对方只判源，文件能被改名成 `.env`、复制不判）。
 *   两份判据的一致性由 `test/file-manager/path-policy.test.ts` 对照 `resolveServablePath` 钉住。
 */
import path from 'path';

import { fmError } from './file-manager-errors';

/** 与 served-paths.ts 的 DENIED_BASENAMES 相同。 */
export const FM_DENIED_BASENAMES: ReadonlySet<string> = new Set([
  'auth-profiles.json',
  'openclaw.json',
  'credentials.json',
  '.env',
  '.htpasswd',
]);

/** 与 served-paths.ts 的 DENIED_PATTERNS 相同。 */
export const FM_DENIED_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|ppk)$/i,
  /\.sqlite(-wal|-shm)?$/i,
  /^\.htpasswd/i,
];

/** 与 served-paths.ts 的 DENIED_DIR_SEGMENTS 相同。 */
export const FM_DENIED_DIR_SEGMENTS: ReadonlySet<string> = new Set(['.ssh', '.aws', '.gnupg', '.config', 'agents', 'node_modules', '.git']);

/** 规范化相对路径：`''` 表示根本身。非法一律抛 `fileManager.invalidPath`。 */
export function normalizeRelativePath(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw fmError.invalidPath();
  if (input.includes('\0') || input.includes('\\')) throw fmError.invalidPath();
  if (input.length > 4096) throw fmError.invalidPath();
  if (input.startsWith('/') || path.isAbsolute(input) || /^[A-Za-z]:/.test(input)) throw fmError.invalidPath();
  const segments = input.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) throw fmError.invalidPath();
  return segments.join('/');
}

/** 单个文件名（新建 / 改名的目标名、上传文件名）：不含分隔符、不是 `.` / `..`。 */
export function validateEntryName(input: unknown): string {
  if (typeof input !== 'string') throw fmError.invalidPath();
  const name = input.trim();
  if (!name || name === '.' || name === '..' || name.length > 255) throw fmError.invalidPath();
  if (/[/\\\0]/.test(name) || /[\r\n]/.test(name)) throw fmError.invalidPath();
  return name;
}

export function isDeniedBasename(name: string): boolean {
  if (FM_DENIED_BASENAMES.has(name)) return true;
  return FM_DENIED_PATTERNS.some((pattern) => pattern.test(name));
}

/** 相对路径（相对根）是否落在敏感判据里：文件名或任何一段目录名命中。 */
export function isDeniedRelativePath(relPath: string): boolean {
  if (!relPath) return false;
  const segments = relPath.split('/');
  if (isDeniedBasename(segments[segments.length - 1])) return true;
  return segments.some((segment) => FM_DENIED_DIR_SEGMENTS.has(segment));
}

export function assertNotDenied(relPath: string): void {
  if (isDeniedRelativePath(relPath)) throw fmError.deniedFile();
}

export function joinRelative(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index === -1 ? '' : relPath.slice(0, index);
}

/** `child` 是否在 `parent` 之内（含相等）。两者都应是已 realpath 的绝对路径。 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
