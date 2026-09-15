/**
 * 远端后端（SSH / Docker）共用：一段**固定**的 POSIX sh 脚本 + 参数数组，经传输层在远端执行。
 *
 * - 脚本本身是常量，不拼任何用户数据；用户给的根路径、相对路径作为位置参数传入（`sh -c <脚本> sh <op> <根> <路径>…`）；
 * - Docker 走 execFile 参数数组，参数原样到达；SSH 的远端命令必须是一个字符串，参数逐个用单引号转义（`shellQuote`）；
 * - 包含判定在远端做：根按 `pwd -P` 取真实路径，目标的父目录也按 `pwd -P` 判在根内，**目标本身是软链一律拒绝**
 *   （远端没法可靠地跨平台 realpath，宁可比本地后端更严）；
 * - 退出码映射成 `fileManager.*`，ssh 自己的 255 与「Host key verification failed」单独认。
 */
import { spawn } from 'child_process';
import type { Readable } from 'stream';

import { fmError, type FileManagerError } from '../file-manager-errors';
import type { FileEntry } from './types';

export const REMOTE_TIMEOUT_MS = 30_000;
export const REMOTE_MAX_OUTPUT_BYTES = 12 * 1024 * 1024;

export const REMOTE_SCRIPT = [
  'set -u',
  'op=$1; root=$2; shift 2',
  'ROOT=$(cd -- "$root" 2>/dev/null && pwd -P) || exit 80',
  'inroot() { case "$1/" in "$ROOT"/*) return 0;; *) return 1;; esac; }',
  'parentok() { d=$(dirname -- "$1"); [ -d "$d" ] || exit 82; d=$(cd -- "$d" && pwd -P) || exit 82; inroot "$d" || exit 81; }',
  'existing() { if [ -z "$1" ]; then P=$ROOT; return 0; fi; P="$ROOT/$1"; [ -L "$P" ] && exit 81; [ -e "$P" ] || exit 82; parentok "$P"; }',
  'creatable() { [ -n "$1" ] || exit 87; P="$ROOT/$1"; [ -L "$P" ] && exit 81; parentok "$P"; }',
  'line() { f=$1; n=$2; if [ -L "$f" ]; then t=l; s=0; elif [ -d "$f" ]; then t=d; s=0; elif [ -f "$f" ]; then t=f; s=$(wc -c < "$f" | tr -d " "); else t=o; s=0; fi; m=$(date -r "$f" +%s 2>/dev/null || echo 0); printf "%s\\t%s\\t%s\\t%s\\n" "$t" "$s" "$m" "$n"; }',
  'case "$op" in',
  '  list) existing "$1"; [ -d "$P" ] || exit 83; for f in "$P"/* "$P"/.[!.]* "$P"/..?*; do { [ -e "$f" ] || [ -L "$f" ]; } || continue; line "$f" "${f##*/}"; done ;;',
  '  stat) existing "$1"; line "$P" "${P##*/}" ;;',
  '  size) existing "$1"; [ -f "$P" ] || exit 84; wc -c < "$P" | tr -d " " ;;',
  '  read) existing "$1"; [ -f "$P" ] || exit 84; s=$(wc -c < "$P" | tr -d " "); [ "$s" -le "$2" ] || exit 85; cat -- "$P" ;;',
  '  write) creatable "$1"; [ -d "$P" ] && exit 84; if [ "$2" != 1 ] && [ -e "$P" ]; then exit 86; fi; t="$P.clawopt-fm-$$.tmp"; cat > "$t" || { rm -f -- "$t"; exit 88; }; mv -f -- "$t" "$P" ;;',
  '  mkdir) creatable "$1"; [ -e "$P" ] && exit 86; mkdir -- "$P" ;;',
  '  rename) existing "$1"; F=$P; creatable "$2"; [ -e "$P" ] && exit 86; mv -- "$F" "$P" ;;',
  '  copy) existing "$1"; F=$P; creatable "$2"; [ -e "$P" ] && exit 86; cp -R -P -- "$F" "$P" ;;',
  '  remove) [ -n "$1" ] || exit 87; P="$ROOT/$1"; { [ -e "$P" ] || [ -L "$P" ]; } || exit 82; parentok "$P"; if [ -d "$P" ] && [ ! -L "$P" ]; then if [ "$2" = 1 ]; then rm -rf -- "$P"; else rmdir -- "$P" || exit 89; fi; else rm -f -- "$P"; fi ;;',
  '  *) exit 87 ;;',
  'esac',
].join('\n');

export type RemoteOp = 'list' | 'stat' | 'size' | 'read' | 'write' | 'mkdir' | 'rename' | 'copy' | 'remove';

/** POSIX 单引号转义：`it's` → `'it'\''s'`。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 远端 sh 的参数数组（Docker 直接用；SSH 再逐个 shellQuote 拼成一个字符串）。 */
export function remoteShellArgv(op: RemoteOp, root: string, args: string[]): string[] {
  return ['sh', '-c', REMOTE_SCRIPT, 'sh', op, root, ...args];
}

export type TransportCommand = { command: string; args: string[] };

export type RemoteResult = { code: number | null; stdout: Buffer; stderr: string; timedOut: boolean; spawnError: NodeJS.ErrnoException | null };

export type RemoteRunner = (command: TransportCommand, options: { stdin?: Readable | Buffer | null; timeoutMs?: number; maxOutputBytes?: number }) => Promise<RemoteResult>;

export type RemoteStreamer = (command: TransportCommand) => { stdout: Readable; kill: () => void; done: Promise<RemoteResult> };

/** 缺省执行器：child_process.spawn（不经 shell），stdout 有上限，超时 SIGKILL。 */
export const spawnRemoteRunner: RemoteRunner = (command, options) => new Promise((resolve) => {
  const child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = '';
  let timedOut = false;
  let spawnError: NodeJS.ErrnoException | null = null;
  const limit = options.maxOutputBytes ?? REMOTE_MAX_OUTPUT_BYTES;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs ?? REMOTE_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) {
      child.kill('SIGKILL');
      return;
    }
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 16_000) stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    spawnError = error as NodeJS.ErrnoException;
  });
  child.stdin.on('error', () => undefined);
  if (options.stdin && typeof (options.stdin as Readable).pipe === 'function') (options.stdin as Readable).pipe(child.stdin);
  else child.stdin.end(options.stdin ?? undefined);
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut, spawnError });
  });
});

export const spawnRemoteStreamer: RemoteStreamer = (command) => {
  const child = spawn(command.command, command.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 16_000) stderr += chunk.toString('utf8');
  });
  const done = new Promise<RemoteResult>((resolve) => {
    let spawnError: NodeJS.ErrnoException | null = null;
    child.on('error', (error) => { spawnError = error as NodeJS.ErrnoException; });
    child.on('close', (code) => resolve({ code, stdout: Buffer.alloc(0), stderr, timedOut: false, spawnError }));
  });
  return { stdout: child.stdout, kill: () => child.kill('SIGKILL'), done };
};

/** stderr 只留末几行、抹掉家目录形状，作为诊断细节。 */
export function sanitizeRemoteStderr(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4);
  if (!lines.length) return null;
  return lines.join('\n').replace(/\/(home|Users)\/[^/\s]+/g, '/$1/~').slice(0, 800);
}

export function mapRemoteFailure(result: RemoteResult, transport: 'ssh' | 'docker'): FileManagerError {
  if (result.spawnError) return fmError.backendUnavailable(transport === 'ssh' ? 'host.sshMissing' : 'host.dockerMissing');
  if (result.timedOut) return fmError.backendTimeout();
  const detail = sanitizeRemoteStderr(result.stderr);
  if (transport === 'ssh' && /host key verification failed|no .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(result.stderr)) {
    return fmError.hostKeyUnknown(detail);
  }
  switch (result.code) {
    case 80: return fmError.rootNotFound();
    case 81: return fmError.outsideRoot();
    case 82: return fmError.notFound();
    case 83: return fmError.notDirectory();
    case 84: return fmError.isDirectory();
    case 85: return fmError.tooLarge(0);
    case 86: return fmError.exists();
    case 87: return fmError.invalidPath();
    case 89: return fmError.directoryNotEmpty();
    default: return fmError.backendError(detail);
  }
}

export function parseRemoteEntries(stdout: string, relDir: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const [type, size, mtime, ...nameParts] = raw.split('\t');
    const name = nameParts.join('\t');
    if (!name || name === '.' || name === '..') continue;
    const kind = type === 'd' ? 'dir' : type === 'f' ? 'file' : type === 'l' ? 'symlink' : 'other';
    entries.push({ name, path: relDir ? `${relDir}/${name}` : name, kind, size: Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000 });
  }
  return entries;
}
