/**
 * 主机能力探测（吸收方案 §3.5）：可用内存、原生模块能否加载、常用工具在不在。
 *
 * 结果进 `/api/diagnostics` 的 `host` 块，并被重型功能拿来做闸门（安装 / 升级外部运行时、自动升级、
 * pip 运行时需要 Python 或 uv）。**只报布尔与版本号，不报路径**——诊断接口目前注册在登录闸门之前。
 */
import os from 'os';

import { firstSemver, whichAll } from './path-env';
import type { ProcessRunner } from './process-runner';

export interface HostCapabilities {
  probedAt: string;
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  memory: { totalMb: number; freeMb: number };
  cpus: number;
  modules: { nodePty: boolean; sharp: boolean };
  tools: { git: string | null; npm: string | null; pnpm: string | null; uv: string | null; python3: string | null };
  /** 由上面的事实推出来的闸门。 */
  gates: {
    /** 可用内存够不够跑 npm / pip 安装。 */
    runtimeInstall: { allowed: boolean; reason: string | null };
    pipRuntimes: { allowed: boolean; reason: string | null };
    terminal: { allowed: boolean; reason: string | null };
  };
}

/** 低于这个可用内存就不在本机跑安装：2 GB 主机上 npm 解包进 swap 会拖垮整机（生产机的前车之鉴）。 */
export const RUNTIME_INSTALL_MIN_FREE_MB = 300;

function canLoad(moduleName: string): boolean {
  try {
    require.resolve(moduleName);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(moduleName);
    return true;
  } catch {
    return false;
  }
}

export async function probeHostCapabilities(options: {
  runner: ProcessRunner;
  searchPath: string;
  env: NodeJS.ProcessEnv;
  /** 测试替身：原生模块能否加载。 */
  loadable?: (name: string) => boolean;
  freeMemBytes?: () => number;
}): Promise<HostCapabilities> {
  const version = async (command: string, args: string[]): Promise<string | null> => {
    const [resolved] = whichAll(command, options.searchPath);
    if (!resolved) return null;
    const result = await options.runner(resolved, args, { env: { ...options.env, PATH: options.searchPath }, timeoutMs: 5000, maxOutputBytes: 64 * 1024 }).catch(() => null);
    if (!result || result.code !== 0) return 'unknown';
    return firstSemver(`${result.stdout}\n${result.stderr}`) ?? 'unknown';
  };
  const [git, npm, pnpm, uv, python3] = await Promise.all([
    version('git', ['--version']),
    version('npm', ['--version']),
    version('pnpm', ['--version']),
    version('uv', ['--version']),
    version('python3', ['--version']),
  ]);
  const loadable = options.loadable ?? canLoad;
  let freeBytes = (options.freeMemBytes ?? os.freemem)();
  if (!options.freeMemBytes && process.platform === 'darwin') {
    // macOS 的 os.freemem() 只算完全空闲页，文件缓存占着的也算「用了」，常年只剩几百 MB。
    // 可回收的 inactive / speculative / purgeable 页一起算，才是「装个 npm 包够不够」的意思。
    const vm = await options.runner('/usr/bin/vm_stat', [], { env: options.env, timeoutMs: 3000, maxOutputBytes: 64 * 1024 }).catch(() => null);
    if (vm && vm.code === 0) {
      const pageSize = Number(/page size of (\d+) bytes/.exec(vm.stdout)?.[1] ?? 4096);
      const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vm.stdout)?.[1] ?? 0);
      const available = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * pageSize;
      if (available > freeBytes) freeBytes = available;
    }
  }
  const freeMb = Math.round(freeBytes / (1024 * 1024));
  const nodePty = loadable('node-pty');
  const lowMemory = freeMb < RUNTIME_INSTALL_MIN_FREE_MB;
  return {
    probedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    memory: { totalMb: Math.round(os.totalmem() / (1024 * 1024)), freeMb },
    cpus: os.cpus().length,
    modules: { nodePty, sharp: loadable('sharp') },
    tools: { git, npm, pnpm, uv, python3 },
    gates: {
      runtimeInstall: lowMemory
        ? { allowed: false, reason: 'runtime.hostInsufficientMemory' }
        : npm ? { allowed: true, reason: null } : { allowed: false, reason: 'runtime.nodeEnvironmentMissing' },
      pipRuntimes: uv || python3 ? { allowed: true, reason: null } : { allowed: false, reason: 'runtime.pythonMissing' },
      terminal: nodePty ? { allowed: true, reason: null } : { allowed: false, reason: 'host.nodePtyMissing' },
    },
  };
}
