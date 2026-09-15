/**
 * 定时任务的「预设 ↔ cron 表达式」往返。
 *
 * 界面给六种写法（每 N 分钟 / 每小时 / 每天 / 每周 / 每月 / 自定义），落到引擎的一律是
 * 5 段 cron 表达式。读回来时再按同一张表认出预设——**认不出就是自定义**，绝不把一个
 * 手写的表达式「近似」成某个预设（那会在保存时悄悄改掉用户的调度）。
 *
 * 往返性质由 `test/cron-schedule.test.ts` 逐预设校验：presetToCron → cronToPreset → presetToCron 不变。
 * 表只在后端这一份：前端提交预设对象，后端换算；列表接口把认出的预设一起回给前端，前端不自己解析表达式。
 */

export type SchedulePreset =
  | { kind: 'everyMinutes'; minutes: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekdays: number[]; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'custom'; expr: string };

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function parseIntStrict(text: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(text)) return null;
  const value = Number(text);
  // `05` 与 `5` 同义但字面量不同，同样按自定义处理，保住用户的写法。
  return value >= min && value <= max && String(value) === text ? value : null;
}

/** 允许的字符与段数。更细的语义交给引擎校验（它会拒绝非法表达式并给出原因）。 */
export function isPlausibleCronExpr(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (!/^[0-9A-Za-z*/,\-?#LW ]+$/.test(trimmed)) return false;
  const fields = trimmed.split(/\s+/);
  return fields.length === 5 || fields.length === 6;
}

export function presetToCron(preset: SchedulePreset): string {
  switch (preset.kind) {
    case 'everyMinutes':
      if (!isInt(preset.minutes, 1, 59)) throw new RangeError('minutes');
      return preset.minutes === 1 ? '* * * * *' : `*/${preset.minutes} * * * *`;
    case 'hourly':
      if (!isInt(preset.minute, 0, 59)) throw new RangeError('minute');
      return `${preset.minute} * * * *`;
    case 'daily':
      if (!isInt(preset.hour, 0, 23) || !isInt(preset.minute, 0, 59)) throw new RangeError('time');
      return `${preset.minute} ${preset.hour} * * *`;
    case 'weekly': {
      if (!isInt(preset.hour, 0, 23) || !isInt(preset.minute, 0, 59)) throw new RangeError('time');
      const days = [...new Set(preset.weekdays)].sort((a, b) => a - b);
      if (days.length === 0 || days.some((day) => !isInt(day, 0, 6))) throw new RangeError('weekdays');
      return `${preset.minute} ${preset.hour} * * ${days.join(',')}`;
    }
    case 'monthly':
      if (!isInt(preset.day, 1, 31) || !isInt(preset.hour, 0, 23) || !isInt(preset.minute, 0, 59)) throw new RangeError('date');
      return `${preset.minute} ${preset.hour} ${preset.day} * *`;
    case 'custom':
      if (!isPlausibleCronExpr(preset.expr)) throw new RangeError('expr');
      return preset.expr.trim().split(/\s+/).join(' ');
    default:
      throw new RangeError('kind');
  }
}

export function cronToPreset(expr: string): SchedulePreset {
  const normalized = expr.trim().split(/\s+/).join(' ');
  const fields = normalized.split(' ');
  const custom: SchedulePreset = { kind: 'custom', expr: normalized };
  if (fields.length !== 5) return custom;
  const [minute, hour, day, month, weekday] = fields;
  if (month !== '*') return custom;

  if (hour === '*' && day === '*' && weekday === '*') {
    if (minute === '*') return { kind: 'everyMinutes', minutes: 1 };
    const step = /^\*\/(\d{1,2})$/.exec(minute);
    if (step) {
      const minutes = Number(step[1]);
      // `*/1` 与 `*` 同义，但字面量不同：认成预设会在保存时改写用户的写法。
      return minutes >= 2 && minutes <= 59 && step[1] === String(minutes) ? { kind: 'everyMinutes', minutes } : custom;
    }
    const exact = parseIntStrict(minute, 0, 59);
    return exact === null ? custom : { kind: 'hourly', minute: exact };
  }

  const m = parseIntStrict(minute, 0, 59);
  const h = parseIntStrict(hour, 0, 23);
  if (m === null || h === null) return custom;

  if (day === '*' && weekday === '*') return { kind: 'daily', hour: h, minute: m };

  if (day === '*' && /^[0-6](,[0-6])*$/.test(weekday)) {
    const days = weekday.split(',').map(Number);
    const canonical = [...new Set(days)].sort((a, b) => a - b);
    // 只认规范写法（升序、不重复）；否则往返会把用户的字面量改写掉。
    return canonical.join(',') === weekday ? { kind: 'weekly', weekdays: canonical, hour: h, minute: m } : custom;
  }

  if (weekday === '*') {
    const d = parseIntStrict(day, 1, 31);
    return d === null ? custom : { kind: 'monthly', day: d, hour: h, minute: m };
  }

  return custom;
}

/** `10m` / `2h` / `1d` / `30s` → 毫秒；不认识返回 null。 */
export function parseEveryDuration(text: string): number | null {
  const match = /^(\d{1,6})(s|m|h|d)$/.exec(text.trim());
  if (!match) return null;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
  const value = Number(match[1]) * unit;
  return value > 0 ? value : null;
}

/** 毫秒 → 最简的 `Nd` / `Nh` / `Nm` / `Ns`。 */
export function formatEveryDuration(ms: number): string {
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}
