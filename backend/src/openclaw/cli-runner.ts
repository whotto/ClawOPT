/**
 * OpenClaw CLI 的**唯一调用口**（控制面：cron / channels / skills / mcp / plugins / models aliases / logs / usage）。
 *
 * ## 为什么走 CLI 而不是网关 RPC
 *
 * `openclaw cron *`、`logs`、`gateway usage-cost` 这些命令本身就是网关 RPC 的客户端：
 * CLI 替我们做了设备身份、作用域升级与重连，还天然认 `--profile`。
 * ClawOPT 自己的 `OpenClawClient` 固定连配置里的那一个网关，拿它去做控制面，
 * 测试时就没法把写操作隔离到一个一次性 profile 上。
 * 代价是每次冷启 1–2 秒，所以列表类结果由各服务自己做短缓存。
 *
 * ## 四条纪律
 *
 * 1. **参数数组，不拼 shell。** 一律 `execFile(bin, args)`；用户输入（任务名、消息、MCP JSON）
 *    只会成为 argv 里的一个元素，不会被 shell 解释。
 * 2. **错误出口统一脱敏。** stderr 里常带配置路径（含用户名）、偶尔带回显的令牌；
 *    这里把 ANSI、调用方声明的密钥值、家目录、长 hex / sk- 形状一律抹掉后才放进 `errorDetail`。
 * 3. **错误 → messageCode。** 前端只认 code 去本地化主句；原文只作诊断信息。
 * 4. **写操作串行。** CLI 写 `openclaw.json` 有自己的备份与替换，但两次并发写照样会丢更新；
 *    `mutating: true` 的调用在进程内排队。
 *
 * `CLAWOPT_OPENCLAW_PROFILE` 设了就在所有调用前注入 `--profile <name>`——
 * 测试与验收用它把引擎状态隔离到 `~/.openclaw-<name>`，生产不设。
 */
import { execFile } from 'child_process';

import { redactLogValue } from '../core/logger';
import { findOpenClawExecutablePath } from './cli';

export const OPENCLAW_CLI_ERROR_CODES = {
  missing: 'openclaw.cliMissing',
  timeout: 'openclaw.cliTimeout',
  unsupported: 'openclaw.cliUnsupported',
  pairingRequired: 'openclaw.pairingRequired',
  gatewayUnreachable: 'openclaw.gatewayUnreachable',
  notFound: 'openclaw.notFound',
  badJson: 'openclaw.cliBadJson',
  failed: 'openclaw.cliFailed',
  invalidProfile: 'openclaw.invalidProfile',
} as const;

export type OpenClawCliErrorCode = typeof OPENCLAW_CLI_ERROR_CODES[keyof typeof OPENCLAW_CLI_ERROR_CODES];

export class OpenClawCliError extends Error {
  constructor(
    readonly errorCode: OpenClawCliErrorCode,
    /** 已脱敏的诊断信息，可以回给前端。 */
    readonly detail: string,
    readonly exitCode: number | null = null,
  ) {
    super(`${errorCode}: ${detail}`);
    this.name = 'OpenClawCliError';
  }
}

export type CliExecResult = { stdout: string; stderr: string };
export type CliExecError = Error & { code?: unknown; killed?: boolean; signal?: unknown; stdout?: string; stderr?: string };
export type CliExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<CliExecResult>;

export type CliRunOptions = {
  timeoutMs?: number;
  /** 改引擎状态的调用：进程内串行。 */
  mutating?: boolean;
  /** 这次调用里出现的密钥值（令牌、口令），报错时一并抹掉。 */
  secrets?: string[];
};

export type CliRunResult = { stdout: string; stderr: string };

export type OpenClawCliRunnerOptions = {
  exec?: CliExec;
  resolveExecutable?: () => string;
  /** 不给则读 `CLAWOPT_OPENCLAW_PROFILE`。 */
  profile?: string | null;
  defaultTimeoutMs?: number;
};

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_DETAIL_LENGTH = 2000;

const defaultExec: CliExec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error) {
      const failure = error as CliExecError;
      failure.stdout = String(stdout ?? '');
      failure.stderr = String(stderr ?? '');
      reject(failure);
      return;
    }
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** 抹掉调用方声明的密钥值与日志层已知的敏感形状（家目录、sk-、长 hex）。 */
export function redactCliText(text: string, secrets: string[] = []): string {
  let out = stripAnsi(String(text ?? ''));
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  // `--token xxx` 这类形状即使调用方忘了声明，也按参数名兜底抹掉。
  out = out.replace(/(--(?:token|bot-token|app-token|password|secret|api-key)[ =])(\S+)/gi, '$1[redacted]');
  out = redactLogValue(out) as string;
  return out.length > MAX_DETAIL_LENGTH ? `${out.slice(0, MAX_DETAIL_LENGTH)}…` : out;
}

export function classifyCliFailure(text: string, error: CliExecError | null): OpenClawCliErrorCode {
  if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) return OPENCLAW_CLI_ERROR_CODES.missing;
  if (error && (error.killed || error.signal === 'SIGTERM') && !/exited with/i.test(error.message || '')) {
    return OPENCLAW_CLI_ERROR_CODES.timeout;
  }
  if (/unknown command|unknown option|no built-in command/i.test(text)) return OPENCLAW_CLI_ERROR_CODES.unsupported;
  if (/pairing required|scope upgrade pending|asking for more scopes/i.test(text)) return OPENCLAW_CLI_ERROR_CODES.pairingRequired;
  if (/gateway (connect failed|closed|not reachable|unreachable)|ECONNREFUSED|gateway is not running/i.test(text)) {
    return OPENCLAW_CLI_ERROR_CODES.gatewayUnreachable;
  }
  if (/\bnot found\b|no (mcp server|job|plugin|skill|channel) named|unknown (job|plugin|skill)/i.test(text)) {
    return OPENCLAW_CLI_ERROR_CODES.notFound;
  }
  return OPENCLAW_CLI_ERROR_CODES.failed;
}

/**
 * 解析 `--json` 输出。多数命令只打一个 JSON 文档，但写配置的命令会在前面打
 * 「Updated config: …」之类的人话行，所以整段解析失败时从第一个以 `{` / `[` 开头的行重试。
 */
export function parseCliJson<T = unknown>(stdout: string): T {
  const text = stripAnsi(stdout).trim();
  if (!text) throw new OpenClawCliError(OPENCLAW_CLI_ERROR_CODES.badJson, 'empty output');
  try {
    return JSON.parse(text) as T;
  } catch {
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const head = lines[index].trimStart();
      if (!head.startsWith('{') && !head.startsWith('[')) continue;
      try {
        return JSON.parse(lines.slice(index).join('\n')) as T;
      } catch {
        // 继续找下一个候选起点
      }
    }
  }
  throw new OpenClawCliError(OPENCLAW_CLI_ERROR_CODES.badJson, 'output is not JSON');
}

/** 逐行 JSON（`logs --json`）。读不懂的行跳过，不让一行坏数据毁掉整页。 */
export function parseCliJsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stripAnsi(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
    } catch {
      // 跳过
    }
  }
  return out;
}

export function resolveCliProfile(raw: string | null | undefined): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  if (!PROFILE_PATTERN.test(value)) {
    throw new OpenClawCliError(OPENCLAW_CLI_ERROR_CODES.invalidProfile, 'CLAWOPT_OPENCLAW_PROFILE must match [a-z0-9][a-z0-9_-]{0,63}');
  }
  return value;
}

export function createOpenClawCliRunner(options: OpenClawCliRunnerOptions = {}) {
  const exec = options.exec ?? defaultExec;
  const resolveExecutable = options.resolveExecutable ?? findOpenClawExecutablePath;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  let mutationTail: Promise<unknown> = Promise.resolve();

  function profile(): string | null {
    return resolveCliProfile(options.profile !== undefined ? options.profile : process.env.CLAWOPT_OPENCLAW_PROFILE);
  }

  function buildArgs(args: string[]): string[] {
    const name = profile();
    return name ? ['--profile', name, ...args] : [...args];
  }

  async function execute(args: string[], runOptions: CliRunOptions): Promise<CliRunResult> {
    let executable: string;
    try {
      executable = resolveExecutable();
    } catch {
      throw new OpenClawCliError(OPENCLAW_CLI_ERROR_CODES.missing, 'OpenClaw CLI not found on this host');
    }
    const secrets = runOptions.secrets ?? [];
    try {
      const { stdout, stderr } = await exec(executable, buildArgs(args), {
        timeout: runOptions.timeoutMs ?? defaultTimeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
      return { stdout, stderr };
    } catch (raw) {
      const error = raw as CliExecError;
      const combined = `${error.stderr ?? ''}\n${error.stdout ?? ''}`.trim() || String(error.message ?? '');
      const errorCode = classifyCliFailure(stripAnsi(combined), error);
      const exitCode = typeof error.code === 'number' ? error.code : null;
      throw new OpenClawCliError(errorCode, redactCliText(combined, secrets), exitCode);
    }
  }

  async function run(args: string[], runOptions: CliRunOptions = {}): Promise<CliRunResult> {
    if (!runOptions.mutating) return execute(args, runOptions);
    const task = mutationTail.then(() => execute(args, runOptions), () => execute(args, runOptions));
    mutationTail = task.catch(() => undefined);
    return task;
  }

  async function runJson<T = unknown>(args: string[], runOptions: CliRunOptions = {}): Promise<T> {
    const { stdout } = await run(args, runOptions);
    return parseCliJson<T>(stdout);
  }

  return { run, runJson, profile, buildArgs };
}

export type OpenClawCliRunner = ReturnType<typeof createOpenClawCliRunner>;
