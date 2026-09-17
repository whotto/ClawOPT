/**
 * git 状态标注（spec 07 §2.14）：`git status --porcelain=v1 -z --untracked-files=all`，5 秒超时、4 MB 缓冲；
 * 每个条目取最强状态（冲突 > 修改 > 改名 > 删除 > 新增 > 未跟踪），目录再带「有改动的后代数」。
 *
 * **不在不可信仓库里执行代码**：工作区是 Agent 写的，`.git/config` 里的 `core.fsmonitor`、过滤器（`filter.*.clean`）、
 * `include.path` 都能让 `git status` 执行任意命令。这里先 `git config --local --list`（只读配置、不执行）检查，
 * 命中就不标注并说明原因；执行时再强制 `core.fsmonitor=false`、`core.hooksPath=/dev/null`、不拿可选锁。
 */
import { execFile } from 'child_process';
import path from 'path';

export type GitStatusCode = 'conflicted' | 'modified' | 'renamed' | 'deleted' | 'added' | 'untracked';

export const GIT_STATUS_PRIORITY: readonly GitStatusCode[] = ['conflicted', 'modified', 'renamed', 'deleted', 'added', 'untracked'];

export type GitDecoration = { status: GitStatusCode | null; changedDescendants: number };

export type GitDecorationResult =
  | { state: 'ok'; repoRoot: string; byName: Record<string, GitDecoration> }
  | { state: 'notRepo' | 'gitMissing' | 'unsafeConfig' | 'failed' | 'timeout' };

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function codeFor(xy: string): GitStatusCode | null {
  if (xy === '??') return 'untracked';
  if (xy === '!!') return null;
  if (CONFLICT_CODES.has(xy)) return 'conflicted';
  if (xy.includes('M') || xy.includes('T')) return 'modified';
  if (xy.includes('R') || xy.includes('C')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return null;
}

export function strongest(a: GitStatusCode | null, b: GitStatusCode | null): GitStatusCode | null {
  if (!a) return b;
  if (!b) return a;
  return GIT_STATUS_PRIORITY.indexOf(a) <= GIT_STATUS_PRIORITY.indexOf(b) ? a : b;
}

/** 解析 porcelain v1 -z：`XY path\0`，改名 / 复制后面紧跟原路径（原路径记为 deleted）。 */
export function parsePorcelainV1Z(output: string): Array<{ path: string; status: GitStatusCode }> {
  const records = output.split('\0');
  const out: Array<{ path: string; status: GitStatusCode }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const filePath = record.slice(3);
    const status = codeFor(xy);
    if ((xy[0] === 'R' || xy[0] === 'C') && index + 1 < records.length) {
      const original = records[index + 1];
      index += 1;
      if (xy[0] === 'R' && original) out.push({ path: original, status: 'deleted' });
    }
    if (status) out.push({ path: filePath.replace(/\/$/, ''), status });
  }
  return out;
}

/** 本目录下每个名字的标注：自身状态 + 后代改动数（目录）。`relDirFromRepo` 为 '' 表示仓库根。 */
export function decorateEntries(changes: Array<{ path: string; status: GitStatusCode }>, relDirFromRepo: string, names: string[]): Record<string, GitDecoration> {
  const prefix = relDirFromRepo ? `${relDirFromRepo}/` : '';
  const byName: Record<string, GitDecoration> = {};
  const wanted = new Set(names);
  for (const change of changes) {
    if (prefix && !change.path.startsWith(prefix)) continue;
    const rest = change.path.slice(prefix.length);
    if (!rest) continue;
    const [first, ...deeper] = rest.split('/');
    if (!wanted.has(first)) continue;
    const current = byName[first] ?? { status: null, changedDescendants: 0 };
    current.status = strongest(current.status, change.status);
    if (deeper.length > 0) current.changedDescendants += 1;
    byName[first] = current;
  }
  return byName;
}

const UNSAFE_CONFIG = /^(core\.fsmonitor|core\.hookspath|include\.path|includeif\.|filter\.[^=]*\.(clean|smudge|process|required)|core\.sshcommand|diff\.[^=]*\.textconv|core\.pager|uploadpack\.packobjectshook)/i;

export function hasUnsafeLocalConfig(configList: string): boolean {
  return configList.split('\n').some((line) => UNSAFE_CONFIG.test(line.trim()));
}

type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; missing: boolean; timedOut: boolean }>;

const GIT_ENV = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
});

export const defaultGitRunner: GitRunner = (args, cwd) => new Promise((resolve) => {
  execFile('git', args, { cwd, env: GIT_ENV(), timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
    const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
    resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: String(stdout ?? ''),
      missing: err?.code === 'ENOENT',
      timedOut: Boolean(err?.killed),
    });
  });
});

export async function gitDecorationsFor(realDir: string, names: string[], runner: GitRunner = defaultGitRunner): Promise<GitDecorationResult> {
  const top = await runner(['rev-parse', '--show-toplevel'], realDir);
  if (top.missing) return { state: 'gitMissing' };
  if (top.timedOut) return { state: 'timeout' };
  if (top.code !== 0) return { state: 'notRepo' };
  const repoRoot = top.stdout.trim();
  const config = await runner(['config', '--local', '--list'], realDir);
  if (config.code === 0 && hasUnsafeLocalConfig(config.stdout)) return { state: 'unsafeConfig' };
  const relDirFromRepo = path.relative(repoRoot, realDir).split(path.sep).join('/');
  if (relDirFromRepo.startsWith('..')) return { state: 'failed' };
  const status = await runner(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', relDirFromRepo ? `:(literal)${relDirFromRepo}` : '.'], repoRoot);
  if (status.timedOut) return { state: 'timeout' };
  if (status.code !== 0) return { state: 'failed' };
  return { state: 'ok', repoRoot, byName: decorateEntries(parsePorcelainV1Z(status.stdout), relDirFromRepo, names) };
}
