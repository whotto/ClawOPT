/**
 * 用量分析：按天 / 按模型 / 按 Agent 的 token 与费用。
 *
 * ## 数据源与「不重复计数」
 *
 * - **按天与总计**：`openclaw gateway usage-cost --json --all-agents --days N`。引擎从会话日志算出
 *   input / output / cacheRead / cacheWrite 与费用，是唯一带费用的来源。
 * - **按模型 / 按 Agent**：`openclaw sessions list --json --all-agents --active <N 天>`，按会话累计。
 *   会话里的 token 是「会话当前累计」，所以窗口内每个会话只算一次（按 key 去重）。
 * - **ClawOPT 自己的库不计 token**：单聊 / 群聊都经网关跑，已经记在引擎的会话日志里；
 *   `chat_messages` 只有文本与模型名，没有用量。把两边相加就是重复计数，所以这里只读引擎。
 *   外部运行时（Claude Code 等，路线 B）的用量目前哪边都没记，界面如实标「未统计」。
 *
 * 两个 CLI 调用互不依赖、各自可以失败：一块失败就在响应里标 `unavailable` + errorCode，另一块照常返回。
 */
import type { OpenClawCliRunner } from '../../openclaw';
import { OpenClawCliError } from '../../openclaw';

type Raw = Record<string, unknown>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  missingCostEntries: number;
};

export type UsageDay = UsageTotals & { date: string };
export type UsageBreakdownRow = { key: string; sessions: number; inputTokens: number; outputTokens: number; totalTokens: number };

function totalsOf(raw: unknown): UsageTotals {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  return {
    input: num(record.input),
    output: num(record.output),
    cacheRead: num(record.cacheRead),
    cacheWrite: num(record.cacheWrite),
    totalTokens: num(record.totalTokens),
    totalCost: num(record.totalCost),
    missingCostEntries: num(record.missingCostEntries),
  };
}

export function normalizeUsageCost(raw: Raw): { totals: UsageTotals; daily: UsageDay[]; cacheStatus: string | null } {
  const daily = (Array.isArray(raw.daily) ? raw.daily : [])
    .filter((entry): entry is Raw => !!entry && typeof entry === 'object' && typeof (entry as Raw).date === 'string')
    .map((entry) => ({ date: String(entry.date), ...totalsOf(entry) }));
  const cacheStatus = raw.cacheStatus && typeof raw.cacheStatus === 'object' ? str((raw.cacheStatus as Raw).status) : null;
  return { totals: totalsOf(raw.totals), daily, cacheStatus };
}

/** 会话按 key 去重后按模型、按 Agent 累计。 */
export function aggregateSessions(sessions: unknown[]): { byModel: UsageBreakdownRow[]; byAgent: UsageBreakdownRow[]; sessionCount: number } {
  const seen = new Set<string>();
  const byModel = new Map<string, UsageBreakdownRow>();
  const byAgent = new Map<string, UsageBreakdownRow>();
  const add = (map: Map<string, UsageBreakdownRow>, key: string, row: Raw) => {
    const current = map.get(key) ?? { key, sessions: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const input = num(row.inputTokens);
    const output = num(row.outputTokens);
    current.sessions += 1;
    current.inputTokens += input;
    current.outputTokens += output;
    current.totalTokens += num(row.totalTokens) || input + output;
    map.set(key, current);
  };
  for (const entry of sessions) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Raw;
    const identity = `${str(row.agentId) ?? ''}\u0000${str(row.key) ?? str(row.sessionId) ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const provider = str(row.modelProvider);
    const model = str(row.model);
    add(byModel, model ? (provider ? `${provider}/${model}` : model) : 'unknown', row);
    add(byAgent, str(row.agentId) ?? 'unknown', row);
  }
  const sort = (rows: Iterable<UsageBreakdownRow>) => [...rows].sort((a, b) => b.totalTokens - a.totalTokens);
  return { byModel: sort(byModel.values()), byAgent: sort(byAgent.values()), sessionCount: seen.size };
}

function unavailable(error: unknown) {
  return { available: false as const, errorCode: error instanceof OpenClawCliError ? error.errorCode : 'usage.unavailable' };
}

export function createUsageService(deps: { openclawCli: OpenClawCliRunner }) {
  const cli = deps.openclawCli;

  async function summary(daysInput: unknown) {
    const days = Math.min(365, Math.max(1, Math.floor(Number(daysInput)) || 30));
    const [cost, sessions] = await Promise.allSettled([
      cli.runJson<Raw>(['gateway', 'usage-cost', '--json', '--all-agents', '--days', String(days)], { timeoutMs: 60_000 }),
      cli.runJson<Raw>(['sessions', 'list', '--json', '--all-agents', '--active', String(days * 24 * 60), '--limit', 'all'], { timeoutMs: 60_000 }),
    ]);
    return {
      days,
      cost: cost.status === 'fulfilled' ? { available: true as const, ...normalizeUsageCost(cost.value) } : unavailable(cost.reason),
      breakdown: sessions.status === 'fulfilled'
        ? { available: true as const, ...aggregateSessions(Array.isArray(sessions.value.sessions) ? sessions.value.sessions : []) }
        : unavailable(sessions.reason),
      externalRuntimesTracked: false,
    };
  }

  return { summary };
}

export type UsageService = ReturnType<typeof createUsageService>;
