/**
 * 探测本机安装的 OpenClaw 版本。
 *
 * ## 为什么不 shell out 跑 `openclaw --version`
 *
 * 生产机实测（2026-09-03，64.186.235.99）：
 *
 * ```
 * $ openclaw --version
 * openclaw: Node.js >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0 is required (current: v20.20.2).
 * $ echo $?
 * 1
 * ```
 *
 * 系统 Node 是 v20，而 openclaw 要 ≥22 —— **同一台机器上这条命令成不成功，
 * 取决于谁的 PATH 在前**。ClawOPT 的 systemd 单元把隔离 Node
 * （`~/.openclaw/tools/node-v24.15.0/bin`）放在 PATH 最前所以能跑通，
 * 但任何不继承那份 PATH 的调用点都会拿到退出码 1。
 *
 * 这个雷本仓库踩过一次，`AGENTS.md` 与 commit `c2c0637`
 * 「服务 PATH 未指向隔离 Node，导致 openclaw CLI 调用失败」记着它。
 *
 * 读 `package.json` 绕开了整件事：不起进程、不看 PATH、不受 Node 版本约束，
 * 而且在 330MB 可用内存的生产机上，不 fork 一个 Node 进程本身就是收益。
 *
 * ## 取不到就是 `unknown`，不猜
 *
 * 「猜一个默认版本」在这里的代价是不对称的：猜成 2.x 会让写入落到
 * `agents.entries`，而 1.x 的引擎**完全看不见**那个 Agent，且没有恢复路径；
 * 猜成 1.x 只会在 2.x 上多留一个废弃键，doctor 一跑就迁移了。
 * 所以宁可明确说「不知道」，让调用方按代价小的方向失败。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** 解析后的版本。OpenClaw 用 `年.月.序号` 加可选后缀，如 `2026.7.1-2`。 */
export type OpenClawVersion = {
  readonly known: true;
  readonly raw: string;
  readonly year: number;
  readonly month: number;
  readonly patch: number;
};

export type OpenClawVersionResult = OpenClawVersion | { readonly known: false; readonly reason: string };

/** 明确的「不知道」。**调用方不得把它当成任何具体版本。** */
export function unknownVersion(reason: string): OpenClawVersionResult {
  return { known: false, reason };
}

/**
 * 解析 `2026.7.1-2` 这样的版本串。
 *
 * 不引入 semver 依赖：OpenClaw 的版本不是 semver（`2026.7.1-2` 里的 `-2`
 * 是同月内的重发次数，不是 semver 的 prerelease），拿 semver 去比会得出
 * 「2026.7.1-2 < 2026.7.1」这种错误结论——prerelease 在 semver 里排在正式版之前。
 * 三段整数按 `年 → 月 → 序号` 比较，后缀忽略，这才是它真实的排序语义。
 */
export function parseOpenClawVersion(raw: unknown): OpenClawVersionResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return unknownVersion('versionNotAString');
  }
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,3})/.exec(raw.trim());
  if (!m) return unknownVersion(`unparsableVersion:${raw.trim().slice(0, 24)}`);

  return {
    known: true,
    raw: raw.trim(),
    year: Number(m[1]),
    month: Number(m[2]),
    patch: Number(m[3]),
  };
}

/**
 * 比较两个版本。`a` 比 `b` 新返回正数，旧返回负数，相同返回 0。
 * 只比 `年.月.序号` 三段——见 `parseOpenClawVersion` 里为什么不用 semver。
 */
export function compareOpenClawVersion(a: OpenClawVersion, b: OpenClawVersion): number {
  return a.year - b.year || a.month - b.month || a.patch - b.patch;
}

/** `agents.entries` 是 2026.8 引入的形状。这是本模块唯一的业务判据。 */
export const ENTRIES_SCHEMA_SINCE: OpenClawVersion = {
  known: true,
  raw: '2026.8.0',
  year: 2026,
  month: 8,
  patch: 0,
};

/**
 * 这个版本是否使用 `agents.entries` schema。
 * **`unknown` 一律返回 false**——朝代价小的方向失败，理由见文件头。
 */
export function usesEntriesSchema(version: OpenClawVersionResult): boolean {
  if (!version.known) return false;
  return compareOpenClawVersion(version, ENTRIES_SCHEMA_SINCE) >= 0;
}

/**
 * OpenClaw 的 `package.json` 可能在哪。
 *
 * 顺序有讲究：先找本机 npm 全局根（生产机实测是 `/usr/lib/node_modules`），
 * 再找用户级前缀。**不猜 `~/.openclaw` 下面**——那是数据目录，不是安装目录，
 * 混淆这两者是另一类事故的开端。
 */
function candidatePackageJsonPaths(): string[] {
  const home = os.homedir();
  return [
    '/usr/lib/node_modules/openclaw/package.json',
    '/usr/local/lib/node_modules/openclaw/package.json',
    '/opt/homebrew/lib/node_modules/openclaw/package.json',
    path.join(home, '.npm-global', 'lib', 'node_modules', 'openclaw', 'package.json'),
    path.join(home, '.local', 'lib', 'node_modules', 'openclaw', 'package.json'),
  ];
}

/**
 * 探测本机 OpenClaw 版本。
 *
 * 读取走 `readJsonConfigSafe` 的兄弟判据——这里不引入网关（那是 `~/.openclaw`
 * 配置的入口，而这是**安装目录**里的文件，两回事），但同样先确认是普通文件：
 * 一个命名管道放在这些位置同样能把进程挂死，而判据是「同步读一个我们不控制的路径」。
 */
export function detectOpenClawVersion(
  readFileSyncImpl: typeof fs.readFileSync = fs.readFileSync,
  statSyncImpl: typeof fs.statSync = fs.statSync,
  existsSyncImpl: typeof fs.existsSync = fs.existsSync,
): OpenClawVersionResult {
  const tried: string[] = [];

  for (const candidate of candidatePackageJsonPaths()) {
    if (!existsSyncImpl(candidate)) continue;
    tried.push(candidate);
    try {
      if (!statSyncImpl(candidate).isFile()) continue;
      const parsed = JSON.parse(String(readFileSyncImpl(candidate, 'utf-8')));
      const version = parseOpenClawVersion(parsed?.version);
      if (version.known) return version;
    } catch {
      // 这个候选读不动或不是合法 JSON——试下一个。
      // 这里不出声：候选列表本来就是「可能在这几个位置」，读不到是正常情形。
      // 全部试完都没有才是真的失败，那时才报。
    }
  }

  return unknownVersion(tried.length === 0 ? 'notInstalled' : 'installedButVersionUnreadable');
}
