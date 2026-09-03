#!/usr/bin/env node
/**
 * 判断「引擎已是 2026.8+，但配置里还留着废弃键」。
 *
 * 输出 `yes` / `no` / `unknown:<原因>` 到 stdout，供 `deploy-release.sh` 判断。
 * **判断不出来时输出 unknown，不猜**——猜「no」会让一次真正需要的迁移被跳过，
 * 而 gateway 会带着半旧的配置起来。
 *
 * 版本判据与形状判据都与后端共用同一套语义（`backend/src/openclaw-version.ts`、
 * `backend/src/agents-roster.ts`），但这个脚本要能在 **dist 没构建、后端没起**
 * 的机器上单独跑，所以重述而不 import——与 `install-preset.mjs` 对注入预算的
 * 处理方式一致。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');

/** 与 `openclaw-version.ts` 的候选列表保持一致。 */
const PKG_CANDIDATES = [
  '/usr/lib/node_modules/openclaw/package.json',
  '/usr/local/lib/node_modules/openclaw/package.json',
  '/opt/homebrew/lib/node_modules/openclaw/package.json',
  path.join(os.homedir(), '.npm-global/lib/node_modules/openclaw/package.json'),
  path.join(os.homedir(), '.local/lib/node_modules/openclaw/package.json'),
];

function readJsonIfRegularFile(p) {
  // 与后端网关同一条判据：命名管道上的同步读会永久挂死，
  // 而这个脚本跑在部署链路上——挂死等于升级卡住且没有任何提示。
  if (!fs.existsSync(p)) return null;
  if (!fs.statSync(p).isFile()) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

/**
 * 先问 PATH 上那个 `openclaw` 是哪一份 —— **因为 gateway 用的就是它**。
 *
 * 固定候选列表按顺序找，会在装了两份的机器上挑错：开发机上
 * `/opt/homebrew`（2026.7.1）排在 `~/.npm-global` 前面，于是无论 HOME 指向哪，
 * 拿到的都是 homebrew 那份。生产机上只有一份所以碰巧对——**碰巧对不算对**。
 *
 * 生产机实测：`/usr/bin/openclaw` → `/usr/lib/node_modules/openclaw/openclaw.mjs`，
 * package.json 就在它旁边。
 */
function versionFromPath() {
  let resolved;
  try {
    resolved = execFileSync('sh', ['-c', 'command -v openclaw'], { encoding: 'utf-8' }).trim();
  } catch { return null; }
  if (!resolved) return null;

  try {
    let real = fs.realpathSync(resolved);
    // 沿目录往上找最近的 package.json（bin 可能是 dist/xxx.mjs，也可能就在包根）
    for (let i = 0; i < 5; i++) {
      real = path.dirname(real);
      const pkg = path.join(real, 'package.json');
      const parsed = readJsonIfRegularFile(pkg);
      if (parsed?.name === 'openclaw' && parsed?.version) return parsed.version;
    }
  } catch { /* 解析不了就退回候选列表 */ }
  return null;
}

function detectVersion() {
  const fromPath = versionFromPath();
  const m0 = /^(\d{4})\.(\d{1,2})\.(\d{1,3})/.exec(String(fromPath ?? ''));
  if (m0) return { year: +m0[1], month: +m0[2], patch: +m0[3] };

  for (const p of PKG_CANDIDATES) {
    try {
      const pkg = readJsonIfRegularFile(p);
      const m = /^(\d{4})\.(\d{1,2})\.(\d{1,3})/.exec(String(pkg?.version ?? ''));
      if (m) return { year: +m[1], month: +m[2], patch: +m[3] };
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

function main() {
  const version = detectVersion();
  if (!version) return 'unknown:versionNotDetected';

  // 2026.8 是 entries schema 的分界。三段整数比较，不用 semver
  // （`2026.7.1-2` 的后缀是同月重发次数，semver 会判它小于 2026.7.1）。
  const usesEntries = version.year > 2026 || (version.year === 2026 && version.month >= 8);
  if (!usesEntries) return 'no';

  let config;
  try {
    config = readJsonIfRegularFile(CONFIG);
  } catch (err) {
    return `unknown:configUnreadable:${err?.code ?? err?.name ?? 'Error'}`;
  }
  if (!config) return 'unknown:configMissing';

  const agents = config.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return 'unknown:agentsNotAnObject';
  }

  // 引擎是 2.x 而配置里还有 `agents.list` → 需要迁移。
  // 注意：`list` 与 `entries` 同时存在也算需要——那是迁到一半的状态。
  return Array.isArray(agents.list) ? 'yes' : 'no';
}

try {
  process.stdout.write(main() + '\n');
} catch (err) {
  process.stdout.write(`unknown:${err?.code ?? err?.name ?? 'Error'}\n`);
}
