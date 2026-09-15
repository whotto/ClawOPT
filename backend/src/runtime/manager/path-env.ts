/**
 * 子进程环境与 PATH 发现（spec 04 §2.13）。
 *
 * ## 白名单环境（修正参考实现的泄露）
 *
 * 参考实现最后一次提交把「扩充过的 PATH」塞进每次运行的启动环境，而启动环境是**整个进程环境**合并出来的——
 * 白名单隔离形同虚设，ClawOPT 进程里的一切（`CLAWOPT_*`、云厂商凭据、别的 API key）都会流进外部 CLI。
 * 这里反过来：从白名单起步，**只把 PATH 换成扩充版**，再叠调用方显式给的变量。守卫见 test/runtime-manager.test.ts。
 *
 * ## PATH 扩充
 *
 * 服务以 systemd / launchd 起时 PATH 很短，`npm i -g` 装的 CLI 找不到。按顺序去重拼接：
 * 原 PATH → ClawOPT 管理的 venv bin → 运行 ClawOPT 的 node 所在目录 → `npm prefix -g`/bin → macOS 登录 shell 的 PATH →
 * 常见 bin 目录。与参考实现不同，原 PATH 在最前（理由见 compute 里的注释）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ProcessRunner } from './process-runner';

export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)',
];

/** 安装器（npm / uv / pip）额外放行的变量：包管理器自己的配置（prefix、registry、缓存目录）。不进 Agent 子进程。 */
const INSTALLER_ENV_PATTERN = /^(npm_config_|NPM_CONFIG_|UV_|PIP_INDEX_URL$|PIP_EXTRA_INDEX_URL$)/;

export function pickAllowlistedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CHILD_ENV_ALLOWLIST.includes(key) || key.startsWith('LC_')) out[key] = value;
  }
  return out;
}

export function pickInstallerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && INSTALLER_ENV_PATTERN.test(key)) out[key] = value;
  }
  return out;
}

export interface PathAugmenterOptions {
  runner: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** ClawOPT 管理的 venv 的 bin 目录（hermes 这类 pip 运行时）。 */
  extraBinDirs?: () => string[];
  /** 拼常见 bin 目录（`/opt/homebrew/bin` 之类）。用例关掉，免得开发机上装的真 CLI 混进来。 */
  includeHostBins?: boolean;
  cacheMs?: number;
}

export class PathAugmenter {
  private cached: { value: string; at: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly options: PathAugmenterOptions) {}

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  invalidate(): void {
    this.cached = null;
  }

  async augmentedPath(): Promise<string> {
    const cacheMs = this.options.cacheMs ?? 60_000;
    if (this.cached && Date.now() - this.cached.at < cacheMs) return this.cached.value;
    if (!this.inflight) {
      this.inflight = this.compute().then((value) => {
        this.cached = { value, at: Date.now() };
        return value;
      }).finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async compute(): Promise<string> {
    const platform = this.options.platform ?? process.platform;
    const home = this.options.home ?? this.env.HOME ?? os.homedir();
    const basePath = this.env.PATH ?? '';
    const baseEnv = { ...pickAllowlistedEnv(this.env), ...pickInstallerEnv(this.env) };
    // 原 PATH 排最前：管理器报告的可执行文件必须就是 ClawOPT 起子进程时真正会跑的那一个。
    // 实测本机两份 claude（/opt/homebrew/bin 2.1.272、/usr/local/bin 2.1.234），登录 shell 的顺序与服务进程相反；
    // 把补充目录前置会让「检测到的版本」与「实际运行的版本」分家。补充目录只负责找到原 PATH 里没有的。
    const entries: string[] = [...basePath.split(path.delimiter)];

    entries.push(...(this.options.extraBinDirs?.() ?? []));
    entries.push(path.dirname(process.execPath));

    // 优先用运行 ClawOPT 的那个 node 旁边的 npm：服务管理器给的 PATH 里常常根本没有 npm。
    const siblingNpm = path.join(path.dirname(process.execPath), platform === 'win32' ? 'npm.cmd' : 'npm');
    const npmCommand = whichAll(siblingNpm, '', platform).length > 0 ? siblingNpm : 'npm';
    const npmEnv = { ...baseEnv, PATH: [path.dirname(process.execPath), basePath].filter(Boolean).join(path.delimiter) };
    const npmPrefix = await this.options.runner(npmCommand, ['prefix', '-g'], { env: npmEnv, timeoutMs: 5000, maxOutputBytes: 64 * 1024 }).catch(() => null);
    const prefix = npmPrefix && npmPrefix.code === 0 ? npmPrefix.stdout.trim().split('\n').pop()?.trim() : '';
    if (prefix) entries.push(platform === 'win32' ? prefix : path.join(prefix, 'bin'));

    if (platform === 'darwin') {
      for (const shell of [this.env.SHELL, '/bin/zsh', '/bin/bash'].filter(Boolean) as string[]) {
        const result = await this.options.runner(shell, ['-lc', 'printf %s "$PATH"'], { env: baseEnv, timeoutMs: 3000, maxOutputBytes: 64 * 1024 }).catch(() => null);
        if (result && result.code === 0 && result.stdout.trim()) {
          // 登录脚本可能先打印别的东西：只取最后一行。
          entries.push(...result.stdout.trim().split('\n').pop()!.split(path.delimiter));
          break;
        }
      }
    }

    if (platform !== 'win32' && this.options.includeHostBins !== false) {
      entries.push(
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.local', 'bin'),
        path.join(home, '.yarn', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.pnpm'),
        path.join(home, 'Library', 'pnpm'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      );
    }
    const seen = new Set<string>();
    return entries
      .map((entry) => entry.trim())
      .filter((entry) => entry && path.isAbsolute(entry) && !seen.has(entry) && (seen.add(entry), true))
      .join(path.delimiter);
  }
}

/** `which -a` 的等价实现：沿 PATH 找所有可执行的同名文件（不 shell out，判据不随 shell 配置漂移）。 */
export function whichAll(command: string, searchPath: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!command) return [];
  if (path.isAbsolute(command)) return isExecutable(command) ? [command] : [];
  const extensions = platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : [''];
  const found: string[] = [];
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (!found.includes(candidate) && isExecutable(candidate)) found.push(candidate);
    }
  }
  return found;
}

function isExecutable(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function firstSemver(text: string): string | null {
  const match = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(text);
  return match ? match[1] : null;
}

/**
 * 版本比较：主.次.修订按数字比；预发布（`-rc.1`）排在同号正式版之前，预发布标识按段比（数字段按数值）。
 * 返回负数 / 0 / 正数。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ? pre.split('.') : null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = Number(l);
    const rn = Number(r);
    const diff = Number.isFinite(ln) && Number.isFinite(rn) ? ln - rn : l.localeCompare(r);
    if (diff !== 0) return diff;
  }
  return 0;
}
