/**
 * 运行时输出脱敏：stderr 尾巴、错误详情、日志都先过这里。
 *
 * 外部 CLI 的 stderr 里什么都可能有——绝对路径（含用户名）、Bearer 令牌、`sk-` 开头的上游 key、
 * `api_key=` 形式的配置值、终端控制序列。错误详情会进库、进帧、进诊断快照，所以原文一律不出这一层。
 *
 * 凭据形状的规则只有一份（运行时管理器的 `redactSecretShapes`）；这里只决定标记写法、家目录与长度上限。
 */
import os from 'os';
import { redactSecretShapes, stripTerminalControls } from '../../manager/process-runner';

export function sanitizeRuntimeText(input: string, options: { homeDir?: string; maxChars?: number } = {}): string {
  if (!input) return '';
  const home = options.homeDir ?? os.homedir();
  let text = redactSecretShapes(stripTerminalControls(input), '[redacted]');
  if (home && home.length > 1) text = text.split(home).join('~');
  const max = options.maxChars ?? 4000;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 错误详情只取有意义的最后几行。 */
export function tailLines(text: string, lines = 6): string {
  return text.split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-lines).join('\n');
}
