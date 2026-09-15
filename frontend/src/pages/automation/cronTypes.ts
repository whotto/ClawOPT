// 定时任务的前端类型与展示辅助。预设 ↔ cron 表达式的换算只在后端做（backend/src/control/cron/cron-schedule.ts），
// 前端提交预设对象、展示后端认出的预设，不自己解析表达式。

export type SchedulePreset =
  | { kind: 'everyMinutes'; minutes: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekdays: number[]; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'custom'; expr: string };

export type CronJob = {
  id: string;
  name: string;
  description: string | null;
  agentId: string | null;
  enabled: boolean;
  schedule: { kind: string; expr: string | null; tz: string | null; every: string | null; at: string | null; preset: SchedulePreset | null };
  sessionTarget: string | null;
  payloadKind: string | null;
  message: string | null;
  delivery: { mode: string; channel: string | null; to: string | null };
  model: string | null;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: string | null;
  lastError: string | null;
  revision: string;
};

export type CronRun = {
  runId: string | null;
  status: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  durationMs: number | null;
  error: string | null;
  summary: string | null;
};

export type ScheduleMode = SchedulePreset['kind'] | 'every' | 'at';

/** 表单状态：所有模式的字段并存，切换模式不丢已填的值。 */
export type ScheduleForm = {
  mode: ScheduleMode;
  minutes: number;
  hour: number;
  minute: number;
  weekdays: number[];
  day: number;
  expr: string;
  every: string;
  at: string;
  tz: string;
};

export const DEFAULT_SCHEDULE_FORM: ScheduleForm = {
  mode: 'daily', minutes: 15, hour: 9, minute: 0, weekdays: [1], day: 1, expr: '0 9 * * *', every: '30m', at: '', tz: '',
};

export function scheduleFormFromJob(job: CronJob): ScheduleForm {
  const form = { ...DEFAULT_SCHEDULE_FORM, tz: job.schedule.tz ?? '' };
  const preset = job.schedule.preset;
  if (job.schedule.kind === 'every' && job.schedule.every) return { ...form, mode: 'every', every: job.schedule.every };
  if (job.schedule.kind === 'at' && job.schedule.at) return { ...form, mode: 'at', at: job.schedule.at.slice(0, 16) };
  if (!preset) return { ...form, mode: 'custom', expr: job.schedule.expr ?? '' };
  switch (preset.kind) {
    case 'everyMinutes': return { ...form, mode: preset.kind, minutes: preset.minutes };
    case 'hourly': return { ...form, mode: preset.kind, minute: preset.minute };
    case 'daily': return { ...form, mode: preset.kind, hour: preset.hour, minute: preset.minute };
    case 'weekly': return { ...form, mode: preset.kind, hour: preset.hour, minute: preset.minute, weekdays: preset.weekdays };
    case 'monthly': return { ...form, mode: preset.kind, hour: preset.hour, minute: preset.minute, day: preset.day };
    default: return { ...form, mode: 'custom', expr: preset.expr };
  }
}

/** 表单 → 提交给后端的 schedule 对象。 */
export function scheduleInputFromForm(form: ScheduleForm): Record<string, unknown> {
  const tz = form.tz.trim() || null;
  switch (form.mode) {
    case 'every': return { mode: 'every', every: form.every.trim() };
    case 'at': return { mode: 'at', at: form.at ? new Date(form.at).toISOString() : '' };
    case 'everyMinutes': return { mode: 'preset', preset: { kind: 'everyMinutes', minutes: form.minutes }, tz };
    case 'hourly': return { mode: 'preset', preset: { kind: 'hourly', minute: form.minute }, tz };
    case 'daily': return { mode: 'preset', preset: { kind: 'daily', hour: form.hour, minute: form.minute }, tz };
    case 'weekly': return { mode: 'preset', preset: { kind: 'weekly', weekdays: form.weekdays, hour: form.hour, minute: form.minute }, tz };
    case 'monthly': return { mode: 'preset', preset: { kind: 'monthly', day: form.day, hour: form.hour, minute: form.minute }, tz };
    default: return { mode: 'preset', preset: { kind: 'custom', expr: form.expr.trim() }, tz };
  }
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 列表里的一句话调度描述。 */
export function describeSchedule(job: CronJob, t: (key: string, options?: Record<string, unknown>) => string): string {
  const { schedule } = job;
  if (schedule.kind === 'every' && schedule.every) return t('control.cron.describe.every', { every: schedule.every });
  if (schedule.kind === 'at' && schedule.at) return t('control.cron.describe.at', { at: new Date(schedule.at).toLocaleString() });
  const preset = schedule.preset;
  if (!preset) return schedule.expr ?? schedule.kind;
  const time = 'hour' in preset ? `${pad(preset.hour)}:${pad(preset.minute)}` : '';
  switch (preset.kind) {
    case 'everyMinutes': return t('control.cron.describe.everyMinutes', { count: preset.minutes });
    case 'hourly': return t('control.cron.describe.hourly', { minute: pad(preset.minute) });
    case 'daily': return t('control.cron.describe.daily', { time });
    case 'weekly': return t('control.cron.describe.weekly', { days: preset.weekdays.map((day) => t(`control.cron.weekday.${day}`)).join(' / '), time });
    case 'monthly': return t('control.cron.describe.monthly', { day: preset.day, time });
    default: return t('control.cron.describe.custom', { expr: preset.expr });
  }
}
