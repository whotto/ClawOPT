/**
 * 标准 cron 语义，交给 `croner`（零依赖）：
 * - 5 段（分 时 日 月 周），允许英文名（JAN、MON）与 `@hourly/@daily/@weekly/@monthly/@yearly`；
 * - 日与周同时受限时按 **Vixie cron 的 OR**（不是 spec 里对方实现的 AND）；
 * - IANA 时区；夏令时安全：秋季回拨重复的那一小时只触发一次，春季跳过的时刻顺延到跳变后触发一次。
 *
 * 为什么不自己写：对方手写版逐分钟扫描最长 366 天（稀有表达式吃 CPU）、回拨小时会触发两次、
 * 不支持名字。这些都是 cron 实现里最容易错的角落，用一个被广泛使用、带时区测试的库更稳。
 */
import { Cron } from 'croner';

const NICKNAMES = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);

export class CronError extends Error {
  constructor(readonly reason: 'invalidCron' | 'invalidTimezone', detail: string) {
    super(detail);
    this.name = 'CronError';
  }
}

export function normalizeCron(expression: unknown): string {
  const text = typeof expression === 'string' ? expression.trim().replace(/\s+/g, ' ') : '';
  if (!text || text.length > 120) throw new CronError('invalidCron', 'cron expression required');
  if (text.startsWith('@')) {
    if (!NICKNAMES.has(text.toLowerCase())) throw new CronError('invalidCron', text);
    return text.toLowerCase();
  }
  if (text.split(' ').length !== 5) throw new CronError('invalidCron', 'cron must have 5 fields');
  try {
    new Cron(text, { paused: true });
  } catch (error) {
    throw new CronError('invalidCron', (error as Error)?.message || text);
  }
  return text;
}

export function normalizeTimezone(value: unknown): string {
  const tz = typeof value === 'string' && value.trim() ? value.trim() : 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new CronError('invalidTimezone', tz);
  }
  return tz;
}

/** `after` 之后（不含）的下一次触发时刻；没有则 null。 */
export function nextOccurrence(expression: string, timezone: string, after: number): number | null {
  const cron = new Cron(expression, { paused: true, timezone });
  const next = cron.nextRun(new Date(after));
  return next ? next.getTime() : null;
}
