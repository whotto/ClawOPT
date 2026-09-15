/**
 * 本地模型代理的对外形状。适配器（runtime/adapters/*）按这里的签名编码，**改签名要两边一起改**。
 *
 * scoped 模式下外部 CLI 不拿上游 key：适配器先 `register(target)` 拿到代理地址与每目标令牌，
 * 写进 CLI 的运行副本配置；CLI 打到 `/api/runtime-proxy/...`，代理在服务端换成上游 key 转发，
 * 同时把流 tee 成规范事件（含用量）交给协调器。
 */
import type { CanonicalEvent } from '../contract';

export type ApiMode = 'chat_completions' | 'responses' | 'anthropic_messages';

/** 规范事件（contract 的 `CanonicalEvent`）。代理 tee 出去的事件都属于 `proxy` 这一路。 */
export type CanonicalRuntimeEvent = CanonicalEvent;

export interface ProxyTarget {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  apiMode: ApiMode;
  reasoningEffort?: string;
  /** 哪个运行时在用（'codex' / 'grok' / 'opencode' …）：决定 grok 的 system→developer、OpenCode 的用量补零。 */
  runtime: string;
  runId: string;
  sessionId: string;
}

export interface RegisteredProxyTarget {
  routeKey: string;
  token: string;
  /** `.../api/runtime-proxy/anthropic/<routeKey>`（不带 /v1：Claude Code 的 ANTHROPIC_BASE_URL 自己拼 /v1/messages）。 */
  anthropicBaseUrl: string;
  /** `.../api/runtime-proxy/responses/<routeKey>/v1`。 */
  responsesBaseUrl: string;
  revoke(): void;
}

export interface ProviderProxy {
  register(target: ProxyTarget): RegisteredProxyTarget;
  /** 代理流的 tee：按 target.runId 订阅规范事件（含 `usage.reported`）。返回退订函数。 */
  onCanonicalEvent(runId: string, listener: (e: CanonicalRuntimeEvent) => void): () => void;
}

export const API_MODES: readonly ApiMode[] = ['chat_completions', 'responses', 'anthropic_messages'];

export function isApiMode(value: unknown): value is ApiMode {
  return typeof value === 'string' && (API_MODES as readonly string[]).includes(value);
}
