// 性能页的纯函数：字节与时长的人话格式、占用率的色调判定、自动刷新间隔的合法值。
export const REFRESH_INTERVALS_MS = [2000, 5000, 10000, 30000] as const;
export const DEFAULT_REFRESH_MS = 5000;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${Math.floor(totalSeconds % 60)}s`;
}

export type UsageTone = 'green' | 'amber' | 'red' | 'gray';

/** 占用率色调：< 70 绿，70–90 琥珀，≥ 90 红；拿不到为灰。 */
export function usageTone(percent: number | null | undefined): UsageTone {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 'gray';
  if (percent >= 90) return 'red';
  if (percent >= 70) return 'amber';
  return 'green';
}

export function normalizeRefreshInterval(value: unknown): number {
  const number = Number(value);
  return (REFRESH_INTERVALS_MS as readonly number[]).includes(number) ? number : DEFAULT_REFRESH_MS;
}
