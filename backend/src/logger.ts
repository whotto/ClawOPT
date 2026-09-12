/**
 * 结构化日志 + 可导出的环形缓冲。
 *
 * 排障场景决定了这个模块的形状：用户在自己的 Linux 主机上，我们看不见。
 * 所以日志不只是打给 systemd journal 看的，还要能经 `/api/diagnostics` 取回来。
 *
 * **正因为它会从 HTTP 出去，脱敏是头等大事。** v1.2.3 修过一个同型的洞——
 * 「配置解析报错把凭据带进 HTTP 响应体」，`openclaw.json` 里存着 gateway 凭据
 * 与全部模型 apiKey。日志缓冲区如果不脱敏，就是把那个洞换个出口重开一次。
 *
 * 两条设计选择，都不是随手定的：
 *
 * 1. **进缓冲区之前脱敏，不是导出时才洗。** 导出时洗意味着凭据在进程内存里以
 *    明文躺着，任何绕过导出口的读取（core dump、另一个 handler、日后新加的接口）
 *    都能拿到。洗在入口，只需要守一个点。
 * 2. **沿用既有的 `[Tag] 正文` 控制台形态。** 仓库里已有 91 处 `console.*` 是这个
 *    样子，新旧混排时肉眼读起来才一致；结构化的部分走缓冲区，不打乱 journal。
 */
import os from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  tag: string;
  msg: string;
  requestId?: string;
  fields?: Record<string, unknown>;
}

/** 缓冲区上限。取值依据：够覆盖一次完整的升级或一轮聊天，又不至于占住可观内存。 */
export const LOG_BUFFER_LIMIT = 500;

const REDACTED = '[redacted]';

/** 字段名命中即抹。用词表而不是「看内容像不像」，是因为字段名是作者的意图声明。 */
const SENSITIVE_KEY = /(key|token|secret|password|passwd|authorization|auth|cookie|credential|session)/i;

/**
 * 值的形状命中即抹。字段名无辜时的兜底——真实泄露往往发生在 `detail` / `message`
 * 这类字段上（v1.2.3 就是）。
 */
const SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,              // OpenAI / Anthropic 风格
  /\bghp_[A-Za-z0-9]{20,}/g,              // GitHub token
  /\b[A-Fa-f0-9]{40,}\b/g,                // 长 hex（会话令牌是 64 位 hex）
];

const MAX_DEPTH = 6;

function redactString(value: string): string {
  let out = value;
  // 家目录含用户名，换成 ~。先做这一步，后面的形状匹配不受路径干扰。
  const home = os.homedir();
  if (home && home !== '/' && out.includes(home)) {
    out = out.split(home).join('~');
  }
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, REDACTED);
  }
  return out;
}

/** Error 只留类别与错误码。message 原文可能嵌着输入（V8 的 JSON 报错就会），stack 带绝对路径。 */
function redactError(error: Error): Record<string, unknown> {
  const code = (error as NodeJS.ErrnoException).code;
  const out: Record<string, unknown> = { name: error.name };
  if (typeof code === 'string' && code) out.code = code;
  const position = /position (\d+)/.exec(error.message)?.[1];
  if (position) out.at = `position ${position}`;
  return out;
}

export function redactLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return redactError(value);
  if (typeof value !== 'object') return String(value);

  if (depth >= MAX_DEPTH) return '[depth]';
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactLogValue(item, depth + 1, seen);
  }
  return out;
}

const buffer: LogEntry[] = [];

function push(entry: LogEntry): void {
  buffer.push(entry);
  // 只会一次多一条，所以 shift 一次就够；用 while 是为了让「改小上限」也能立刻收敛。
  while (buffer.length > LOG_BUFFER_LIMIT) buffer.shift();
}

/** 取最近若干条。不传则取全部（至多 LOG_BUFFER_LIMIT 条）。 */
export function recentLogEntries(limit = LOG_BUFFER_LIMIT): LogEntry[] {
  if (limit >= buffer.length) return [...buffer];
  return buffer.slice(buffer.length - Math.max(0, limit));
}

/** 只给用例用：缓冲区是模块级单例，不清空的话用例之间会互相污染。 */
export function resetLogBufferForTests(): void {
  buffer.length = 0;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** 派生一个带请求号的子 logger，把一次请求的多条串起来。 */
  withRequestId(requestId: string): Logger;
}

const CONSOLE_BY_LEVEL: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.log,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

function emit(tag: string, requestId: string | undefined, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const safeMsg = redactString(msg);
  const safeFields = fields && Object.keys(fields).length > 0
    ? (redactLogValue(fields) as Record<string, unknown>)
    : undefined;

  const entry: LogEntry = { ts: new Date().toISOString(), level, tag, msg: safeMsg };
  if (requestId) entry.requestId = requestId;
  if (safeFields) entry.fields = safeFields;
  push(entry);

  // 控制台沿用既有形态，便于和仓库里那 91 处 console.* 混排阅读。
  const prefix = requestId ? `[${tag}][${requestId}]` : `[${tag}]`;
  if (safeFields) CONSOLE_BY_LEVEL[level](`${prefix} ${safeMsg}`, safeFields);
  else CONSOLE_BY_LEVEL[level](`${prefix} ${safeMsg}`);
}

export function createLogger(tag: string, requestId?: string): Logger {
  return {
    debug: (msg, fields) => emit(tag, requestId, 'debug', msg, fields),
    info: (msg, fields) => emit(tag, requestId, 'info', msg, fields),
    warn: (msg, fields) => emit(tag, requestId, 'warn', msg, fields),
    error: (msg, fields) => emit(tag, requestId, 'error', msg, fields),
    withRequestId: (nextId: string) => createLogger(tag, nextId),
  };
}
