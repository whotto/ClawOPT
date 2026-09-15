/**
 * 列出「可能被改过」的工作区路径：git 工作区问 `git status`，普通目录做有界扫描。
 *
 * git 一律参数数组（`execFile`，不经 shell），带超时与输出上限；`-c core.quotepath=off` + `-z` 让非 ASCII 与空格文件名原样出来。
 */
import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';

import { isCredentialLikeFileName } from '../../../core/files';
import { IGNORED_DIR_NAMES, IGNORED_FILE_EXTENSIONS, extensionOf, type WorkspaceDiffLimits } from './limits';

export type GitRunner = (args: string[], options: { cwd: string; timeoutMs: number; maxBuffer: number }) => Promise<{ ok: true; stdout: Buffer } | { ok: false; code: string }>;

export const runGit: GitRunner = (args, options) => new Promise((resolve) => {
  execFile('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    encoding: 'buffer',
    windowsHide: true,
    // 不让仓库里的配置把 git 拉去跑外部程序（fsmonitor、pager），也不交互式要凭据。
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  }, (error, stdout) => {
    if (error) {
      const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
      resolve({ ok: false, code: typeof code === 'string' ? code : String(code ?? 'git_failed') });
      return;
    }
    resolve({ ok: true, stdout: stdout as unknown as Buffer });
  });
});

/** 相对路径里任何一段命中忽略目录，或文件名是凭据类，就不进 diff。 */
export function isIgnoredRelPath(relPath: string): boolean {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (isCredentialLikeFileName(base)) return true;
  return segments.slice(0, -1).some((segment) => IGNORED_DIR_NAMES.has(segment));
}

export interface GitWorkspace {
  /** git 仓库根（realpath）。 */
  gitRoot: string;
  /** 工作区相对仓库根的前缀（posix，空串 = 工作区就是仓库根）。 */
  prefix: string;
  head: string | null;
}

export async function detectGitWorkspace(rootReal: string, git: GitRunner, limits: WorkspaceDiffLimits): Promise<GitWorkspace | null> {
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: rootReal, timeoutMs: limits.gitCommandTimeoutMs, maxBuffer: 64 * 1024 });
  if (!top.ok) return null;
  const topPath = top.stdout.toString('utf8').trim();
  if (!topPath) return null;
  let gitRoot: string;
  try {
    gitRoot = await fsp.realpath(topPath);
  } catch {
    return null;
  }
  const rel = path.relative(gitRoot, rootReal);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { gitRoot, prefix: rel.split(path.sep).join('/'), head: await gitHead(rootReal, git, limits) };
}

export async function gitHead(rootReal: string, git: GitRunner, limits: WorkspaceDiffLimits): Promise<string | null> {
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: rootReal, timeoutMs: limits.gitCommandTimeoutMs, maxBuffer: 1024 });
  if (!head.ok) return null;
  const sha = head.stdout.toString('utf8').trim();
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** 仓库相对路径 → 工作区相对路径（不在工作区里返回 null）。 */
function toWorkspaceRel(repoRel: string, prefix: string): string | null {
  if (!prefix) return repoRel;
  return repoRel.startsWith(`${prefix}/`) ? repoRel.slice(prefix.length + 1) : null;
}

export async function listGitDirtyPaths(rootReal: string, workspace: GitWorkspace, git: GitRunner, limits: WorkspaceDiffLimits): Promise<{ paths: string[]; truncated: boolean } | null> {
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'], {
    cwd: rootReal,
    timeoutMs: limits.gitCommandTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!status.ok) return null;
  const entries = status.stdout.toString('utf8').split('\0').filter(Boolean);
  const paths: string[] = [];
  let truncated = false;
  for (const entry of entries) {
    if (entry.length < 4) continue;
    const rel = toWorkspaceRel(entry.slice(3), workspace.prefix);
    if (!rel || rel.endsWith('/') || isIgnoredRelPath(rel)) continue;
    if (paths.length >= limits.gitMaxDirtyPaths) { truncated = true; break; }
    paths.push(rel);
  }
  return { paths, truncated };
}

/** 运行期间 HEAD 挪了（Agent 自己提交了）：两次 HEAD 之间改过的路径也要算进来。 */
export async function listGitCommittedPaths(rootReal: string, workspace: GitWorkspace, fromHead: string, toHead: string, git: GitRunner, limits: WorkspaceDiffLimits): Promise<string[]> {
  const diff = await git(['diff', '--name-only', '-z', '--no-renames', fromHead, toHead, '--', '.'], {
    cwd: rootReal,
    timeoutMs: limits.gitCommandTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!diff.ok) return [];
  return diff.stdout.toString('utf8').split('\0').filter(Boolean)
    .map((entry) => toWorkspaceRel(entry, workspace.prefix))
    .filter((rel): rel is string => !!rel && !isIgnoredRelPath(rel))
    .slice(0, limits.gitMaxDirtyPaths);
}

/** 取某个提交里的文件内容；不存在或超过上限返回 absent / 只给大小。 */
export async function readGitBlob(rootReal: string, workspace: GitWorkspace, ref: string, relPath: string, git: GitRunner, limits: WorkspaceDiffLimits): Promise<{ kind: 'absent' } | { kind: 'present'; size: number; content: Buffer | null }> {
  const repoRel = workspace.prefix ? `${workspace.prefix}/${relPath}` : relPath;
  const spec = `${ref}:${repoRel}`;
  const size = await git(['cat-file', '-s', spec], { cwd: rootReal, timeoutMs: limits.gitCommandTimeoutMs, maxBuffer: 1024 });
  if (!size.ok) return { kind: 'absent' };
  const bytes = Number(size.stdout.toString('utf8').trim());
  if (!Number.isFinite(bytes)) return { kind: 'absent' };
  if (bytes > limits.maxSnapshotBytes) return { kind: 'present', size: bytes, content: null };
  const blob = await git(['cat-file', 'blob', spec], { cwd: rootReal, timeoutMs: limits.gitCommandTimeoutMs, maxBuffer: limits.maxSnapshotBytes + 1024 });
  if (!blob.ok) return { kind: 'present', size: bytes, content: null };
  return { kind: 'present', size: bytes, content: blob.stdout };
}

export interface ScanEntry { relPath: string; size: number; mtimeMs: number }

/**
 * 普通目录的有界扫描：目录数、深度、文件数、时间四个上限，任何一个到了就停并标 truncated。
 * 不进符号链接（目录与文件都不跟），忽略目录与二进制扩展名直接跳过。
 */
export async function scanWorkspace(rootReal: string, limits: WorkspaceDiffLimits, now: () => number = Date.now): Promise<{ entries: ScanEntry[]; truncated: boolean }> {
  const deadline = now() + limits.scanBudgetMs;
  const entries: ScanEntry[] = [];
  let dirs = 0;
  let truncated = false;
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: rootReal, rel: '', depth: 0 }];
  while (queue.length > 0) {
    if (now() > deadline || dirs >= limits.scanMaxDirs) { truncated = true; break; }
    const dir = queue.shift()!;
    dirs += 1;
    let children: import('fs').Dirent[];
    try {
      children = await fsp.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const rel = dir.rel ? `${dir.rel}/${child.name}` : child.name;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(child.name)) continue;
        if (dir.depth + 1 > limits.scanMaxDepth) { truncated = true; continue; }
        queue.push({ abs: path.join(dir.abs, child.name), rel, depth: dir.depth + 1 });
        continue;
      }
      if (!child.isFile()) continue;
      if (isCredentialLikeFileName(child.name) || IGNORED_FILE_EXTENSIONS.has(extensionOf(child.name))) continue;
      if (entries.length >= limits.scanMaxFiles) { truncated = true; break; }
      try {
        const stat = await fsp.lstat(path.join(dir.abs, child.name));
        if (stat.isFile()) entries.push({ relPath: rel, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 扫描途中被删了：当作不存在。
      }
    }
  }
  return { entries, truncated };
}
