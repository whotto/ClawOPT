/**
 * 管理器起子进程的唯一出口（`which`、`--version`、`npm install`、`uv pip install`……）。可注入，用例换成脚本。
 *
 * - 不过 shell，参数是数组；
 * - 独立进程组，超时对整组发 SIGTERM、宽限后 SIGKILL（npm 会派生孙进程）；
 * - 输出有上限（默认 10 MiB），超出截断而不是撑爆内存；
 * - 结果里的输出**未脱敏**，调用方给前端之前必须过 `sanitizeProcessOutput`。
 */
import { spawn } from 'child_process';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** spawn 本身失败（ENOENT 之类）。 */
  spawnError?: string;
}

export interface ProcessRunOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  cwd?: string;
}

export type ProcessRunner = (command: string, args: string[], options: ProcessRunOptions) => Promise<ProcessResult>;

export const defaultProcessRunner: ProcessRunner = (command, args, options) => new Promise((resolve) => {
  const limit = options.maxOutputBytes ?? 10 * 1024 * 1024;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const finish = (result: ProcessResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    resolve(result);
  };
  let child;
  try {
    child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
  } catch (error) {
    resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: (error as NodeJS.ErrnoException)?.code ?? 'spawn failed' });
    return;
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* 已退出 */ }
    }
  };
  let killTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), 1500);
    killTimer.unref?.();
  }, options.timeoutMs);
  timer.unref?.();
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => { if (stdout.length < limit) stdout += chunk.slice(0, limit - stdout.length); });
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < limit) stderr += chunk.slice(0, limit - stderr.length); });
  child.on('error', (error: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, timedOut, spawnError: error.code ?? error.name }));
  child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
});

/**
 * 凭据形状的脱敏（唯一一份规则；运行时管理器的输出与适配器的 stderr / 错误详情都经它）：
 * Bearer 令牌、`sk-…` 系列、常见厂商令牌前缀、ClawOPT 代理令牌、`api_key=` 这类赋值、URL 里的 userinfo。
 */
export function redactSecretShapes(text: string, marker: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${marker}`)
    .replace(/\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{8,}/g, `sk-${marker}`)
    .replace(/\b(xai|gsk|ghp|github_pat|glpat|hf|npm)_[A-Za-z0-9_]{12,}/g, `$1_${marker}`)
    .replace(/\bclawopt_[A-Za-z0-9_-]{12,}/g, `clawopt_${marker}`)
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|_authToken|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi, `$1${marker}`)
    .replace(/(\/\/)[^/@\s:]+:[^/@\s]+@/g, `$1${marker}@`);
}

/**
 * 输出脱敏：去 ANSI / OSC、统一换行、抹掉凭据形状（redactSecretShapes），家目录换成 `~`。
 * **给前端、写日志之前都必须过它。**
 */
export function sanitizeProcessOutput(text: string, options: { home?: string; maxLines?: number } = {}): string {
  let out = redactSecretShapes(stripTerminalControls(text), '[REDACTED]');
  const home = options.home ?? process.env.HOME;
  if (home && home.length > 1) out = out.split(home).join('~');
  if (options.maxLines) out = out.split('\n').filter((line) => line.trim()).slice(0, options.maxLines).join('\n');
  return out.trim();
}

/** 去 ANSI / OSC 控制序列、统一换行。 */
export function stripTerminalControls(text: string): string {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\][^]*(?:|\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n');
}
