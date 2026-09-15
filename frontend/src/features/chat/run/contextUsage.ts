// 上下文占用徽标的纯逻辑（带单测）：数字压缩、颜色档位（60% 提醒、80% 危险）。

export type ContextUsageView = {
  usedTokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  approximate: boolean;
};

export function normalizeContextUsage(payload: any): ContextUsageView | null {
  if (!payload || payload.success !== true) return null;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    usedTokens: num(payload.usedTokens),
    contextWindow: num(payload.contextWindow),
    percent: num(payload.percent),
    approximate: payload.approximate === true,
  };
}

/** 12345 → 12.3k，1000 → 1k，1250000 → 1.3M；不显示多余的「.0」。 */
export function formatTokenCount(value: number): string {
  const format = (n: number, unit: string) => `${(Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (value >= 1_000_000) return format(value / 1_000_000, 'M');
  if (value >= 1_000) return format(value / 1_000, 'k');
  return String(Math.round(value));
}

export type UsageTone = 'normal' | 'warn' | 'danger';

export function usageTone(percent: number | null): UsageTone {
  if (percent === null) return 'normal';
  if (percent > 80) return 'danger';
  if (percent > 60) return 'warn';
  return 'normal';
}
