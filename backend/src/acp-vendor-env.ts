/**
 * 外接 Agent（ACP 运行时）的厂商凭据。
 *
 * ## 我上一版接错了对象
 *
 * v1.3.2 用 `openclaw models auth list` 判断 Claude Code / Gemini 有没有登录，
 * 并让用户去敲 `openclaw models auth login --provider anthropic`。**两件都是错的。**
 *
 * 引擎自己的文档（`docs/tools/acp-agents.md`）写得很清楚：
 *
 * > Vendor auth must already exist on the host for that harness.
 * > `claude` — Requires Claude Code auth on the host.
 * > `gemini` — Requires Gemini CLI auth or API key setup.
 *
 * ACP 运行时启动的是**厂商自己的 CLI 进程**，它读自己的凭据库（`~/.claude` 等），
 * 跟 OpenClaw 的 `auth-profiles.json` 是两个互不相干的store。
 * `openclaw models auth` 认证的是「OpenClaw 自己调 Anthropic API」的权限。
 *
 * 后果不是「少个功能」，是**页面自信地显示错的状态**：用户按正确方式登录了
 * Claude Code，页面仍显示未登录；反过来在 OpenClaw 里加个 Anthropic key，
 * 页面显示已登录，而 Claude Code 照样跑不起来。
 *
 * ## 网页端能走的那条路
 *
 * 故障排查表原文：
 *
 * > Vendor auth error from the harness → Log in or **provide the required
 * > provider key on the Gateway host environment**.
 *
 * 环境变量是官方支持的路径，且**不需要 TTY**——这正是只用网页的用户能走的。
 * ACP harness 是 Gateway spawn 出来的子进程，继承 Gateway 的 `process.env`。
 *
 * ## 为什么写 `~/.openclaw/.env` 而不是 `openclaw.json` 的 `env.vars`
 *
 * 两个位置引擎都读（配置参考 §Environment）。选 `.env` 是因为：
 *
 * ClawOPT 会把 `openclaw.json` 解析成对象，并在多个接口里回显它的片段。
 * 本仓库**已经修过一次**「`gateway.auth.password` 从 HTTP 500 响应里漏出去」。
 * 把明文密钥放进那个对象，等于把同一类事故重造一遍，而且这次泄漏的是
 * 用户的厂商 API Key。密钥待在一个 ClawOPT 只写不解析的文件里，
 * 泄漏面小一个数量级。
 *
 * ## 为什么 openclaw 的 secrets store 走不通
 *
 * 查过了，明确排除。`docs/cli/secrets.md` 末段：
 *
 * > Sandbox, remote `node`, **ACP**, and Codex-native shell execution do not receive them.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeFileAtomicSync } from './config-atomic-write';
import { AGENT_RUNTIMES, type AgentRuntimeId } from './agent-runtimes';

/**
 * 每个 ACP 运行时认哪个环境变量。
 *
 * **这张表里的每一项都来自引擎自带文档，没有一个是我推测的**——
 * 猜一个名字的后果是用户填了 key、页面显示已配置、而 Agent 依然回不了话，
 * 且没有任何报错指向原因。
 *
 * | 运行时 | 变量 | 出处 |
 * |---|---|---|
 * | claude | `ANTHROPIC_API_KEY` | `docs/concepts/model-providers.md:134` |
 * | gemini | `GEMINI_API_KEY` | 同上 `:229` |
 * | opencode | `OPENCODE_API_KEY` | 同上 `:214` |
 * | codex | `OPENAI_API_KEY` | 同上 `:105` |
 * | pi | **无** | 文档里查不到，见下 |
 *
 * `pi` 留空是**如实标注**，不是漏了。`docs/cli/migrate.md:221` 列出了引擎认识的
 * 全部 40 个凭据环境变量，里面没有 Pi 的。给它编一个 `PI_API_KEY` 会让界面
 * 假装这条路通着。界面必须说「这个只能在主机上登录」。
 */
export const VENDOR_ENV_KEY: Readonly<Record<AgentRuntimeId, string | null>> = {
  openclaw: null,
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  codex: 'OPENAI_API_KEY',
  pi: null,
};

/** 引擎读取的 `.env` 位置，见配置参考 §Environment。 */
export function vendorEnvPath(): string {
  return path.join(os.homedir(), '.openclaw', '.env');
}

/** 合法变量名，与 `openclaw secrets store` 的判据一致。 */
const NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

/** 这个名字是不是我们管的——**只认白名单**，不接受调用方任意指定的变量名。 */
export function isManagedEnvName(name: string): boolean {
  return Object.values(VENDOR_ENV_KEY).includes(name);
}

type EnvLine = { readonly name: string | null; readonly raw: string };

function parseEnvLines(text: string): EnvLine[] {
  return text.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return { name: null, raw };
    const eq = raw.indexOf('=');
    if (eq <= 0) return { name: null, raw };
    const name = raw.slice(0, eq).trim().replace(/^export\s+/, '');
    return { name: NAME_RE.test(name) ? name : null, raw };
  });
}

function readEnvTextSafe(): string | null {
  const target = vendorEnvPath();
  try {
    // 与 `openclaw-config` 同样的判据：先确认是普通文件。
    // 一个命名管道放在这个位置能把整个后端挂死，而这是同步读一个我们不控制的路径。
    const st = fs.statSync(target);
    if (!st.isFile()) return null;
    return fs.readFileSync(target, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    return null;
  }
}

/**
 * 读出**已设置的变量名**。永远不返回值。
 *
 * 返回 `null` 表示读不出来（区别于「读出来是空的」）——调用方要把这两者
 * 显示成不同的状态，而不是都当成「没配」。
 */
export function readVendorEnvNames(): Set<string> | null {
  const text = readEnvTextSafe();
  if (text === null) return null;
  const names = new Set<string>();
  for (const line of parseEnvLines(text)) {
    if (line.name) names.add(line.name);
  }
  return names;
}

export class VendorEnvWriteError extends Error {
  constructor(readonly reason: 'unknownName' | 'emptyValue' | 'valueHasNewline' | 'unreadable') {
    super(reason);
    this.name = 'VendorEnvWriteError';
  }
}

/**
 * 写入或更新一个厂商 key。**保留文件里其余所有行**——这个文件可能还有
 * 用户自己放的东西，整份重写会把它们吃掉。
 */
export function setVendorEnvKey(name: string, value: string): void {
  if (!isManagedEnvName(name)) throw new VendorEnvWriteError('unknownName');
  const v = value.trim();
  // 空值不写。引擎对空凭据的行为是「像没设一样」，但界面会显示已配置——
  // 又一个「显示的和真的不一致」。空就是没配，走删除路径。
  if (!v) throw new VendorEnvWriteError('emptyValue');
  // 换行会在 .env 里注入出**另一个变量**。这不是理论问题：
  // 从网页表单粘贴凭据时带上尾随换行是常事。
  if (/[\r\n]/.test(v)) throw new VendorEnvWriteError('valueHasNewline');

  const text = readEnvTextSafe();
  if (text === null) throw new VendorEnvWriteError('unreadable');

  const lines = parseEnvLines(text);
  const next = lines.filter((l) => l.name !== name).map((l) => l.raw);
  // 去掉尾部空行再追加，避免每写一次多一个空行。
  while (next.length > 0 && next[next.length - 1].trim() === '') next.pop();
  next.push(`${name}=${v}`);

  writeFileAtomicSync(vendorEnvPath(), `${next.join('\n')}\n`);
  // 600：这个文件全是凭据。`writeFileAtomicSync` 保留已有权限位，
  // 但新建时要显式收紧——默认 644 会让同机其他用户读到全部 key。
  fs.chmodSync(fs.realpathSync(vendorEnvPath()), 0o600);
}

/** 删掉一个 key。返回是否真的删了。 */
export function clearVendorEnvKey(name: string): boolean {
  if (!isManagedEnvName(name)) throw new VendorEnvWriteError('unknownName');
  const text = readEnvTextSafe();
  if (text === null) throw new VendorEnvWriteError('unreadable');
  const lines = parseEnvLines(text);
  if (!lines.some((l) => l.name === name)) return false;
  const next = lines.filter((l) => l.name !== name).map((l) => l.raw);
  while (next.length > 0 && next[next.length - 1].trim() === '') next.pop();
  writeFileAtomicSync(vendorEnvPath(), next.length ? `${next.join('\n')}\n` : '');
  return true;
}

/** 有 env 变量可填的运行时（界面据此决定显不显示输入框）。 */
export function runtimesWithVendorEnv(): AgentRuntimeId[] {
  return AGENT_RUNTIMES.map((r) => r.id).filter((id) => VENDOR_ENV_KEY[id] !== null);
}
