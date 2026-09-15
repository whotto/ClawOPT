// 定时频率构建器：预设 ↔ 5 段 cron 字符串的双向转换。认不出的表达式归为「自定义」。

export type Frequency =
  | { kind: 'everyMinute' }
  | { kind: 'every5Minutes' }
  | { kind: 'every30Minutes' }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'custom'; cron: string };

export const FREQUENCY_KINDS: Frequency['kind'][] = ['everyMinute', 'every5Minutes', 'every30Minutes', 'hourly', 'daily', 'weekly', 'monthly', 'custom'];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));

export function frequencyToCron(frequency: Frequency): string {
  switch (frequency.kind) {
    case 'everyMinute': return '* * * * *';
    case 'every5Minutes': return '*/5 * * * *';
    case 'every30Minutes': return '*/30 * * * *';
    case 'hourly': return `${clamp(frequency.minute, 0, 59)} * * * *`;
    case 'daily': return `${clamp(frequency.minute, 0, 59)} ${clamp(frequency.hour, 0, 23)} * * *`;
    case 'weekly': return `${clamp(frequency.minute, 0, 59)} ${clamp(frequency.hour, 0, 23)} * * ${clamp(frequency.weekday, 0, 6)}`;
    case 'monthly': return `${clamp(frequency.minute, 0, 59)} ${clamp(frequency.hour, 0, 23)} ${clamp(frequency.day, 1, 31)} * *`;
    default: return frequency.cron.trim();
  }
}

const INT = /^\d+$/;

export function cronToFrequency(cron: string): Frequency {
  const text = cron.trim().replace(/\s+/g, ' ');
  const fields = text.split(' ');
  if (text === '* * * * *') return { kind: 'everyMinute' };
  if (text === '*/5 * * * *') return { kind: 'every5Minutes' };
  if (text === '*/30 * * * *') return { kind: 'every30Minutes' };
  if (fields.length === 5) {
    const [minute, hour, dom, month, dow] = fields;
    if (INT.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') return { kind: 'hourly', minute: Number(minute) };
    if (INT.test(minute) && INT.test(hour) && month === '*') {
      if (dom === '*' && dow === '*') return { kind: 'daily', hour: Number(hour), minute: Number(minute) };
      if (dom === '*' && INT.test(dow) && Number(dow) <= 6) return { kind: 'weekly', weekday: Number(dow), hour: Number(hour), minute: Number(minute) };
      if (INT.test(dom) && dow === '*') return { kind: 'monthly', day: Number(dom), hour: Number(hour), minute: Number(minute) };
    }
  }
  return { kind: 'custom', cron: text };
}

export function defaultFrequency(kind: Frequency['kind'], previousCron: string): Frequency {
  switch (kind) {
    case 'hourly': return { kind, minute: 0 };
    case 'daily': return { kind, hour: 9, minute: 0 };
    case 'weekly': return { kind, weekday: 1, hour: 9, minute: 0 };
    case 'monthly': return { kind, day: 1, hour: 9, minute: 0 };
    case 'custom': return { kind, cron: previousCron };
    default: return { kind } as Frequency;
  }
}

/** 运行预算：不限 / 30 / 60 / 90 分钟 / 自定义（0.1..1440 分钟）→ timeout_ms。 */
export const BUDGET_PRESETS = [null, 30, 60, 90] as const;

export function budgetToTimeoutMs(minutes: number | null): number | null {
  if (minutes === null) return null;
  if (!Number.isFinite(minutes) || minutes < 0.1 || minutes > 1440) throw new Error('budget out of range');
  return Math.round(minutes * 60_000);
}
