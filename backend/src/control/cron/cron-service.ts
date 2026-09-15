/**
 * 定时任务：`openclaw cron *` 的控制面。
 *
 * 任务存在引擎里（网关的 cron 存储），ClawOPT 不另存一份——另存就是影子状态。
 * 编辑走「读当前 → 比版本号 → `cron edit` 打补丁」，版本号只算配置字段（不含 `state` 里
 * 每跑一次就变的 nextRunAt / lastRunAt），否则任务一跑编辑器就报冲突。
 */
import { computeRevision } from '../../core/http';
import type { OpenClawCliRunner } from '../../openclaw';
import { AGENT_ID_PATTERN, ControlInputError, optionalString, requireString } from '../shared/control-http';
import {
  cronToPreset,
  formatEveryDuration,
  parseEveryDuration,
  presetToCron,
  type SchedulePreset,
} from './cron-schedule';

export type CronScheduleInput =
  | { mode: 'preset'; preset: SchedulePreset; tz?: string | null }
  | { mode: 'every'; every: string }
  | { mode: 'at'; at: string };

export type CronDeliveryInput = { mode: 'none' } | { mode: 'announce'; channel: string; to?: string | null };

export type CronJobInput = {
  name: string;
  description?: string | null;
  agentId?: string | null;
  message: string;
  schedule: CronScheduleInput;
  enabled?: boolean;
  sessionTarget?: 'isolated' | 'main';
  delivery?: CronDeliveryInput;
  model?: string | null;
};

export type CronJobView = {
  id: string;
  name: string;
  description: string | null;
  agentId: string | null;
  enabled: boolean;
  schedule: {
    kind: string;
    expr: string | null;
    tz: string | null;
    every: string | null;
    at: string | null;
    preset: SchedulePreset | null;
  };
  sessionTarget: string | null;
  payloadKind: string | null;
  message: string | null;
  delivery: { mode: string; channel: string | null; to: string | null };
  model: string | null;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  revision: string;
};

export type CronRunView = {
  runId: string | null;
  status: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  durationMs: number | null;
  error: string | null;
  summary: string | null;
};

const TZ_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/;
const CHANNEL_PATTERN = /^(last|[a-z0-9][a-z0-9_-]{0,39})$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;
const MODEL_PATTERN = /^[A-Za-z0-9_.:/@+-]{1,200}$/;

type Raw = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const obj = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});

/** 参与版本号的配置字段：去掉 state / status / updatedAtMs / nextRunAtMs——它们每次运行都会变。 */
export function cronJobConfig(raw: Raw): Raw {
  const { state: _state, status: _status, updatedAtMs: _updated, nextRunAtMs: _next, ...config } = raw;
  return config;
}

export function cronJobRevision(raw: Raw): string {
  return computeRevision(cronJobConfig(raw));
}

export function normalizeCronJob(raw: Raw): CronJobView {
  const schedule = obj(raw.schedule);
  const payload = obj(raw.payload);
  const delivery = obj(raw.delivery);
  const state = obj(raw.state);
  const kind = str(schedule.kind) ?? 'unknown';
  const expr = str(schedule.expr);
  const everyMs = num(schedule.everyMs);
  const atMs = num(schedule.atMs);
  return {
    id: String(raw.id ?? ''),
    name: str(raw.name) ?? String(raw.id ?? ''),
    description: str(raw.description),
    agentId: str(raw.agentId),
    enabled: raw.enabled !== false,
    schedule: {
      kind,
      expr,
      tz: str(schedule.tz),
      every: everyMs !== null ? formatEveryDuration(everyMs) : null,
      at: str(schedule.at) ?? (atMs !== null ? new Date(atMs).toISOString() : null),
      preset: kind === 'cron' && expr ? cronToPreset(expr) : null,
    },
    sessionTarget: str(raw.sessionTarget),
    payloadKind: str(payload.kind),
    message: str(payload.message) ?? str(payload.text),
    delivery: { mode: str(delivery.mode) ?? 'none', channel: str(delivery.channel), to: str(delivery.to) },
    model: str(payload.model) ?? str(raw.model),
    nextRunAtMs: num(state.nextRunAtMs) ?? num(raw.nextRunAtMs),
    lastRunAtMs: num(state.lastRunAtMs) ?? num(state.lastRunAt),
    lastStatus: str(state.lastStatus) ?? str(state.lastRunStatus),
    lastError: str(state.lastError) ?? str(state.lastErrorMessage),
    createdAtMs: num(raw.createdAtMs),
    updatedAtMs: num(raw.updatedAtMs),
    revision: cronJobRevision(raw),
  };
}

export function normalizeCronRun(raw: Raw): CronRunView {
  const started = num(raw.startedAtMs) ?? num(raw.startedAt) ?? num(raw.ts);
  const finished = num(raw.finishedAtMs) ?? num(raw.endedAtMs) ?? num(raw.finishedAt);
  return {
    runId: str(raw.runId) ?? str(raw.id),
    status: str(raw.status) ?? str(raw.outcome),
    startedAtMs: started,
    finishedAtMs: finished,
    durationMs: num(raw.durationMs) ?? (started !== null && finished !== null ? finished - started : null),
    error: str(raw.error) ?? str(raw.errorMessage),
    summary: str(raw.summary) ?? str(raw.text) ?? str(raw.message),
  };
}

export function assertJobId(id: unknown): string {
  return requireString(id, 'cron.invalidJobId', { pattern: JOB_ID_PATTERN });
}

/** 输入 → `cron add` / `cron edit` 的参数。校验失败抛 ControlInputError（400）。 */
export function buildCronArgs(input: CronJobInput, mode: 'add' | 'edit'): string[] {
  const args: string[] = [];
  args.push('--name', requireString(input?.name, 'cron.invalidName', { max: 200 }));

  const description = optionalString(input.description, 'cron.invalidDescription', { max: 1000 });
  if (description) args.push('--description', description);

  const agentId = optionalString(input.agentId, 'cron.invalidAgent', { pattern: AGENT_ID_PATTERN });
  if (agentId) args.push('--agent', agentId);
  else if (mode === 'edit') args.push('--clear-agent');

  args.push('--message', requireString(input.message, 'cron.invalidMessage', { max: 20_000, allowNewlines: true }));

  const schedule = input.schedule;
  if (schedule?.mode === 'preset') {
    let expr: string;
    try {
      expr = presetToCron(schedule.preset);
    } catch {
      throw new ControlInputError('cron.invalidSchedule');
    }
    args.push('--cron', expr);
    const tz = optionalString(schedule.tz, 'cron.invalidTimezone', { pattern: TZ_PATTERN });
    if (tz) args.push('--tz', tz);
  } else if (schedule?.mode === 'every') {
    const every = typeof schedule.every === 'string' ? schedule.every.trim() : '';
    if (parseEveryDuration(every) === null) throw new ControlInputError('cron.invalidSchedule');
    args.push('--every', every);
  } else if (schedule?.mode === 'at') {
    const at = typeof schedule.at === 'string' ? schedule.at.trim() : '';
    if (!at || Number.isNaN(Date.parse(at))) throw new ControlInputError('cron.invalidSchedule');
    args.push('--at', new Date(at).toISOString());
  } else {
    throw new ControlInputError('cron.invalidSchedule');
  }

  const sessionTarget = input.sessionTarget ?? 'isolated';
  if (sessionTarget !== 'isolated' && sessionTarget !== 'main') throw new ControlInputError('cron.invalidSessionTarget');
  args.push('--session', sessionTarget);

  const delivery = input.delivery ?? { mode: 'none' };
  if (delivery.mode === 'none') {
    args.push('--no-deliver');
  } else if (delivery.mode === 'announce') {
    args.push('--announce', '--channel', requireString(delivery.channel, 'cron.invalidDelivery', { pattern: CHANNEL_PATTERN }));
    const to = optionalString(delivery.to, 'cron.invalidDelivery', { max: 200 });
    if (to) args.push('--to', to);
    else if (mode === 'edit') args.push('--clear-to');
  } else {
    throw new ControlInputError('cron.invalidDelivery');
  }

  const model = optionalString(input.model, 'cron.invalidModel', { pattern: MODEL_PATTERN });
  if (model) args.push('--model', model);
  else if (mode === 'edit') args.push('--clear-model');

  if (mode === 'add') {
    if (input.enabled === false) args.push('--disabled');
  } else if (typeof input.enabled === 'boolean') {
    args.push(input.enabled ? '--enable' : '--disable');
  }
  return args;
}

export function createCronService(deps: { openclawCli: OpenClawCliRunner }) {
  const cli = deps.openclawCli;

  async function status() {
    return cli.runJson<Raw>(['cron', 'status', '--json']);
  }

  async function listJobs(): Promise<CronJobView[]> {
    const raw = await cli.runJson<Raw>(['cron', 'list', '--all', '--json']);
    const jobs = Array.isArray(raw.jobs) ? raw.jobs : Array.isArray(raw) ? raw as unknown[] : [];
    return jobs.map((job) => normalizeCronJob(obj(job))).filter((job) => job.id);
  }

  async function getRaw(id: string): Promise<Raw> {
    return obj(await cli.runJson(['cron', 'get', assertJobId(id)]));
  }

  async function getJob(id: string): Promise<CronJobView> {
    return normalizeCronJob(await getRaw(id));
  }

  async function createJob(input: CronJobInput): Promise<CronJobView> {
    const raw = await cli.runJson<Raw>(['cron', 'add', ...buildCronArgs(input, 'add'), '--json'], { mutating: true });
    return normalizeCronJob(raw);
  }

  async function updateJob(id: string, input: CronJobInput): Promise<CronJobView> {
    const raw = await cli.runJson<Raw>(['cron', 'edit', assertJobId(id), ...buildCronArgs(input, 'edit')], { mutating: true });
    return normalizeCronJob(raw);
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    await cli.run(['cron', enabled ? 'enable' : 'disable', assertJobId(id)], { mutating: true });
  }

  async function runNow(id: string): Promise<{ runId: string | null; enqueued: boolean }> {
    const { stdout } = await cli.run(['cron', 'run', assertJobId(id)], { mutating: true });
    try {
      const parsed = JSON.parse(stdout.trim()) as Raw;
      return { runId: str(parsed.runId), enqueued: parsed.enqueued !== false };
    } catch {
      return { runId: null, enqueued: true };
    }
  }

  async function removeJob(id: string): Promise<void> {
    await cli.run(['cron', 'rm', assertJobId(id), '--json'], { mutating: true });
  }

  async function listRuns(id: string, limit = 50): Promise<CronRunView[]> {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit) || 50));
    const raw = await cli.runJson<Raw>(['cron', 'runs', '--id', assertJobId(id), '--limit', String(safeLimit)]);
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    return entries.map((entry) => normalizeCronRun(obj(entry)));
  }

  return { status, listJobs, getRaw, getJob, createJob, updateJob, setEnabled, runNow, removeJob, listRuns };
}

export type CronService = ReturnType<typeof createCronService>;
