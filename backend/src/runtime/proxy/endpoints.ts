/**
 * 上游端点解析（spec 04 §2.6）。服务商给的 base URL 形状不一：有的带 `/v1`，有的带 `/api/paas/v4`，
 * 有的干脆就是完整的 `/chat/completions`。规则：
 *
 * - 已经以目标路径结尾 → 原样用；
 * - 最后一段像「版本根」（`v1`、`v2beta`、`openai`，或 `/api/paas/vN`、`/coding/vN`、`/step_plan/vN`）→ 追加目标路径；
 * - 否则追加 `v1/<目标路径>`。
 *
 * Anthropic 的版本根只认 `vN` / `vNbeta`。
 */
import type { ApiMode } from './types';

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

const VERSION_SEGMENT = /^v\d+(?:[a-z]+\d*)?$/i;

function looksLikeOpenAiVersionRoot(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (VERSION_SEGMENT.test(last) || last.toLowerCase() === 'openai') return true;
  return /\/(?:api\/paas|coding|step_plan)\/v\d+$/i.test(pathname);
}

export function resolveUpstreamEndpoint(baseUrl: string, apiMode: ApiMode): string {
  const url = new URL(trimTrailingSlashes(baseUrl.trim()));
  const pathname = trimTrailingSlashes(url.pathname);
  const join = (suffix: string) => {
    url.pathname = `${pathname}/${suffix}`.replace(/\/{2,}/g, '/');
    return url.toString();
  };

  if (apiMode === 'anthropic_messages') {
    if (/(?:^|\/)messages$/i.test(pathname)) return url.toString();
    const last = pathname.split('/').filter(Boolean).pop() ?? '';
    return VERSION_SEGMENT.test(last) ? join('messages') : join('v1/messages');
  }

  const target = apiMode === 'chat_completions' ? 'chat/completions' : 'responses';
  if (pathname.toLowerCase().endsWith(`/${target}`) || pathname.toLowerCase() === target) return url.toString();
  return looksLikeOpenAiVersionRoot(pathname) ? join(target) : join(`v1/${target}`);
}

/** 官方 Anthropic 上游：加密思维块重试永远不对它做。 */
export function isOfficialAnthropicUpstream(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.anthropic.com';
  } catch {
    return false;
  }
}

/** DeepSeek / Moonshot / Kimi / MiMo：Chat 接口要求带思维的助手轮次回传 `reasoning_content`。 */
export function requiresReasoningContentRoundTrip(target: { provider: string; model: string; baseUrl: string }): boolean {
  const haystack = `${target.provider} ${target.model} ${target.baseUrl}`.toLowerCase();
  return /deepseek|moonshot|kimi|mimo/.test(haystack);
}
