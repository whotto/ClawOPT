/**
 * 外部运行时的错误分类 → messageCode。
 *
 * 前端用 messageCode 当 i18n 键本地化主句（三语都在 locales 的 `runtime.*` 下），
 * 诊断信息（脱敏后的 stderr 尾巴、上游报错原文）走 `error` 字段单独展示。
 * 新增一个码必须同时进三份 locale——`npm run locales:check` 只比键集，
 * `test/runtime/adapters/shared/error-codes.test.ts` 把这里的清单与 locale 钉在一起。
 */
export const RUNTIME_MESSAGE_CODES = [
  'runtime.notInstalled',
  'runtime.exitNonZero',
  'runtime.apiError',
  'runtime.busy',
  'runtime.updating',
  'runtime.sessionClosed',
  'runtime.providerCredentialsMissing',
  'runtime.oauthProviderScopedUnsupported',
  'runtime.modelRequired',
  'runtime.modeUnsupported',
  'runtime.notLoggedIn',
  'runtime.noOutput',
  'runtime.resumeFailed',
  'runtime.protocolError',
  'runtime.commandUnsupported',
  'runtime.launchFailed',
  'runtime.capabilityUnsupported',
] as const;

export type RuntimeMessageCode = (typeof RUNTIME_MESSAGE_CODES)[number];

export class RuntimeAdapterError extends Error {
  constructor(readonly messageCode: RuntimeMessageCode, detail: string) {
    super(detail);
  }
}

/** 订阅 / OAuth 类上游：静态 key 代理不了，scoped 模式一律拒绝。 */
export const OAUTH_ONLY_PROVIDERS = new Set([
  'openai-codex', 'copilot', 'github-copilot', 'xai-oauth', 'qwen-oauth', 'nous', 'claude-oauth', 'anthropic-oauth', 'minimax-oauth',
]);

/**
 * 最终文本就是网关错误（`API Error: 4xx`、`Provider returned HTTP n`）：退出码 0 也按失败算。
 * Claude 原生结果不走这条（它有自己的 is_error 位）。
 */
export function detectGatewayErrorText(text: string | undefined): string | null {
  if (!text) return null;
  const head = text.trimStart().slice(0, 200);
  if (/^API Error: \d{3}\b/.test(head) || /^Provider returned HTTP \d{3}\b/.test(head)) return head.split('\n')[0];
  return null;
}

/** 常见「没登录 / 没配服务商」的输出特征。只用于把失败归类，不决定成败。 */
export function looksLikeAuthMissing(text: string): boolean {
  return /not logged in|please (?:run|use) .*login|no (?:api key|credentials)|missing (?:api key|credentials)|unauthori[sz]ed|authentication (?:failed|required)|invalid api key|no provider|401\b/i.test(text);
}

export function looksLikeSessionMissing(text: string): boolean {
  return /no (?:conversation|session|thread) found|session not found|unknown session|thread .*not found/i.test(text);
}
