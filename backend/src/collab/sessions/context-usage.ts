/**
 * 单聊的上下文占用徽标与原生压缩（P1b）。
 *
 * ClawOPT **不拥有** OpenClaw 会话与外部 CLI 的模型上下文，所以这里不做宿主侧摘要：
 * - 占用 = 运行时自己报的用量里**最近一次模型调用**的 输入 + 缓存读 + 缓存写 + 输出（缓存 token 计费分开，但同样占窗口）；
 *   来源是协调器落的 `session_usage`（按确定性 call id 去重，估算值不落库）。整轮合计的行（scope=run）不代表单次调用的窗口占用，
 *   只有没有逐次调用的行时才退而用它，并标 `approximate`。
 * - 窗口 = ClawOPT / OpenClaw 模型配置里的 `contextWindow`（模型级覆盖提供方级）；global 模式的外部 CLI 用自己的登录与模型，查不到就不给。
 * - `/compact`：OpenClaw 会话走网关的 `sessions.compact` RPC；外部运行时交给运行时自己的原生压缩（在 external-chat-turn 里）。
 * - 「上下文窗口太小」：运行时 / 服务商报的超长错误翻成可操作的 `chat.contextWindowTooSmall`（先 /compact，或调大窗口、缩短输入）。
 */
import type { SessionUsageDbRow } from '../../core/db';
import type { SessionCommandResult } from '../../runtime';

export type ContextUsage = {
  usedTokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  approximate: boolean;
  model: string | null;
  updatedAt: string | null;
};

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 最近一次模型调用的窗口占用。 */
export function computeContextUsage(rows: ReadonlyArray<SessionUsageDbRow>, contextWindow: number | null): ContextUsage {
  const calls = rows.filter((row) => row.usage_scope !== 'run');
  const pool = calls.length > 0 ? calls : rows;
  const last = pool[pool.length - 1];
  if (!last) return { usedTokens: null, contextWindow, percent: null, approximate: false, model: null, updatedAt: null };
  const used = num(last.input_tokens) + num(last.cache_read_tokens) + num(last.cache_write_tokens) + num(last.output_tokens);
  const window = contextWindow && contextWindow > 0 ? contextWindow : null;
  return {
    usedTokens: used,
    contextWindow: window,
    percent: window ? Math.min(100, Math.round((used / window) * 1000) / 10) : null,
    approximate: calls.length === 0,
    model: last.model ?? null,
    updatedAt: last.created_at ?? null,
  };
}

/**
 * 从 OpenClaw 配置里找模型的上下文窗口：`models.providers.<端点>.models[].contextWindow`（没有再看 contextTokens），
 * 模型级没有就用提供方级。模型 ref 形如 `<端点>/<模型>`。
 */
export function resolveContextWindow(config: any, modelRef: string | null | undefined): number | null {
  if (!modelRef || typeof modelRef !== 'string') return null;
  const slash = modelRef.indexOf('/');
  if (slash <= 0) return null;
  const endpoint = modelRef.slice(0, slash);
  const modelName = modelRef.slice(slash + 1);
  const provider = config?.models?.providers?.[endpoint];
  if (!provider || typeof provider !== 'object') return null;
  const pick = (source: any) => {
    for (const key of ['contextWindow', 'contextTokens']) {
      const value = source?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    }
    return null;
  };
  const model = Array.isArray(provider.models) ? provider.models.find((entry: any) => entry?.id === modelName || entry?.name === modelName) : null;
  return pick(model) ?? pick(provider);
}

/** `/usage` 与 `/context` 的结构化结果（与外部运行时的会话命令同一个形状，界面按码本地化）。 */
export function usageCommandResult(rows: ReadonlyArray<SessionUsageDbRow>, contextWindow: number | null): SessionCommandResult {
  const total = rows.reduce((acc, row) => ({
    inputTokens: acc.inputTokens + num(row.input_tokens),
    outputTokens: acc.outputTokens + num(row.output_tokens),
    cacheReadTokens: acc.cacheReadTokens + num(row.cache_read_tokens),
    cacheWriteTokens: acc.cacheWriteTokens + num(row.cache_write_tokens),
    costUsd: acc.costUsd + num(row.cost_usd),
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
  const context = computeContextUsage(rows, contextWindow);
  return {
    command: 'usage',
    ok: true,
    usage: {
      ...total,
      totalTokens: total.inputTokens + total.outputTokens,
      contextTokens: context.usedTokens ?? undefined,
      contextWindow: context.contextWindow ?? undefined,
      contextPercent: context.percent ?? undefined,
    },
  };
}

/** 网关 `sessions.compact` 的回应 → 会话命令结果。 */
export function compactCommandResult(response: any): SessionCommandResult {
  if (!response || response.ok !== true) {
    return { command: 'compact', ok: false, error: typeof response?.reason === 'string' ? response.reason : typeof response?.error === 'string' ? response.error : 'compaction failed' };
  }
  const before = response.result?.tokensBefore;
  const after = response.result?.tokensAfter;
  return {
    command: 'compact',
    ok: true,
    compaction: {
      trigger: 'manual',
      preTokens: typeof before === 'number' ? before : undefined,
      postTokens: typeof after === 'number' ? after : undefined,
      summary: response.compacted === false
        ? (typeof response.reason === 'string' ? `not compacted: ${response.reason}` : 'no compaction needed')
        : undefined,
    },
  };
}

export const CONTEXT_WINDOW_TOO_SMALL_CODE = 'chat.contextWindowTooSmall';

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context window (?:is )?(?:too small|exceeded|full)/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many tokens/i,
  /exceeds? (?:the )?(?:model'?s? )?(?:max(?:imum)? )?context/i,
  /reduce the length of the messages/i,
  /上下文(?:长度|窗口)?(?:超出|超过|过长|太小)/,
];

/** 运行时 / 服务商的超长错误（只看短错误文本，长回答里讨论这些词不算）。 */
export function isContextWindowTooSmallError(detail: string | null | undefined): boolean {
  if (typeof detail !== 'string' || !detail || detail.length > 4000) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(detail));
}
