/**
 * 运行时输出脱敏：stderr 尾巴、错误详情、日志都先过这里。
 *
 * 外部 CLI 的 stderr 里什么都可能有——绝对路径（含用户名）、Bearer 令牌、`sk-` 开头的上游 key、
 * `api_key=` 形式的配置值、终端控制序列。错误详情会进库、进帧、进诊断快照，所以原文一律不出这一层。
 */
import os from 'os';

const ANSI_RE = /\[[0-?]*[ -/]*[@-~]|\][^]*(?:|\\)/g;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SK_RE = /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{8,}/g;
const KEY_ASSIGN_RE = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi;
/** ClawOPT 本地代理签发的令牌前缀（平台约定之外的前缀也按长串处理）。 */
const PROXY_TOKEN_RE = /\bclawopt_[A-Za-z0-9_-]{12,}/g;

export function sanitizeRuntimeText(input: string, options: { homeDir?: string; maxChars?: number } = {}): string {
  if (!input) return '';
  const home = options.homeDir ?? os.homedir();
  let text = input.replace(ANSI_RE, '').replace(/\r\n?/g, '\n');
  text = text
    .replace(BEARER_RE, '$1 [redacted]')
    .replace(SK_RE, 'sk-[redacted]')
    .replace(PROXY_TOKEN_RE, 'clawopt_[redacted]')
    .replace(KEY_ASSIGN_RE, '$1[redacted]');
  if (home && home.length > 1) text = text.split(home).join('~');
  const max = options.maxChars ?? 4000;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 错误详情只取有意义的最后几行。 */
export function tailLines(text: string, lines = 6): string {
  return text.split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-lines).join('\n');
}
