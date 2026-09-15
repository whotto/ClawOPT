/**
 * 工作流定时计划。
 *
 * - **触发占位表**：`<scheduleId>:<scheduledAtMs>` 做主键，insert-or-fail 抢占——多进程共享一个库也只触发一次。
 * - **错过即跳过**：到期时刻比现在早超过 60 秒（服务停过），记一条 skipped 事件，不补跑。
 * - **重叠即跳过**：工作流已有活跃运行，记 skipped。
 * - **触发时重新校验**：工作流还在、Agent 仍可用（引擎预检）；当前没有多用户，所以不做属主权限复核。
 * - 只在 cron / 时区 / 启用状态变了才重算下一次（spec 里任何 PATCH 都重算，改个名字就把下一次推迟了）。
 */
import type Database from 'better-sqlite3';

import { AutomationError, SCHEDULE_ERROR, WORKFLOW_ERROR, notFound } from '../shared/errors';
import { clampInt, newId, parseJson, uniqueStrings } from '../shared/util';
import type { DefinitionStore } from '../workflow/definition-store';
import type { WorkflowEngine } from '../workflow/engine';
import { CronError, nextOccurrence, normalizeCron, normalizeTimezone } from './cron';

export const SCHEDULE_TICK_MS = 15_000;
export const MISFIRE_GRACE_MS = 60_000;

export type ScheduleRecord = {
  id: string;
  workflowId: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  input: string | null;
  startNodeIds: string[];
  timeoutMs: number | null;
  lastScheduledAt: number | null;
  nextRunAt: number | null;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ScheduleEvent = {
  id: string;
  scheduleId: string;
  workflowId: string;
  triggerIdentity: string | null;
  scheduledAt: number | null;
  kind: 'triggered' | 'skipped' | 'failed';
  reason: string | null;
  runId: string | null;
  createdAt: number;
};

const fromRow = (row: any): ScheduleRecord => ({
  id: row.id,
  workflowId: row.workflow_id,
  name: row.name,
  cron: row.cron,
  timezone: row.timezone,
  enabled: row.enabled === 1,
  input: row.input,
  startNodeIds: parseJson(row.start_node_ids_json, []),
  timeoutMs: row.timeout_ms,
  lastScheduledAt: row.last_scheduled_at,
  nextRunAt: row.next_run_at,
  lastRunId: row.last_run_id,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const eventFromRow = (row: any): ScheduleEvent => ({
  id: row.id,
  scheduleId: row.schedule_id,
  workflowId: row.workflow_id,
  triggerIdentity: row.trigger_identity,
  scheduledAt: row.scheduled_at,
  kind: row.kind,
  reason: row.reason,
  runId: row.run_id,
  createdAt: row.created_at,
});

export function createScheduleService(deps: {
  db: Database.Database;
  defs: DefinitionStore;
  engine: WorkflowEngine;
  now?: () => number;
}) {
  const { db, defs, engine } = deps;
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let ticking: Promise<void> | null = null;

  const get = (id: string): ScheduleRecord | null => {
    const row = db.prepare('SELECT * FROM workflow_schedules WHERE id = ?').get(id);
    return row ? fromRow(row) : null;
  };

  function wrapCron<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof CronError) {
        const code = error.reason === 'invalidCron' ? SCHEDULE_ERROR.invalidCron : SCHEDULE_ERROR.invalidTimezone;
        throw new AutomationError(400, code, error.message);
      }
      throw error;
    }
  }

  function parseStartNodes(workflowId: string, value: unknown): string[] {
    const ids = uniqueStrings(value);
    const def = defs.get(workflowId);
    if (!def) throw notFound(WORKFLOW_ERROR.notFound, workflowId);
    for (const id of ids) {
      if (!def.nodes.some((node) => node.id === id)) {
        throw new AutomationError(400, SCHEDULE_ERROR.invalidBody, `unknown start node ${id}`, { field: 'start_node_ids' });
      }
    }
    return ids;
  }

  function parseTimeout(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const ms = Number(value);
    if (!Number.isInteger(ms) || ms < 1_000 || ms > 86_400_000) {
      throw new AutomationError(400, SCHEDULE_ERROR.invalidBody, 'timeout_ms out of range', { field: 'timeout_ms' });
    }
    return ms;
  }

  function addEvent(schedule: ScheduleRecord, event: Omit<ScheduleEvent, 'id' | 'scheduleId' | 'workflowId' | 'createdAt'>) {
    db.prepare(`INSERT INTO workflow_schedule_events (id, schedule_id, workflow_id, trigger_identity, scheduled_at, kind, reason, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId(), schedule.id, schedule.workflowId, event.triggerIdentity, event.scheduledAt, event.kind, event.reason, event.runId, now());
    // 事件日志只留每个计划最近 200 条
    db.prepare(`DELETE FROM workflow_schedule_events WHERE schedule_id = ? AND id NOT IN
      (SELECT id FROM workflow_schedule_events WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 200)`).run(schedule.id, schedule.id);
  }

  function saveFire(id: string, patch: { nextRunAt: number | null; lastScheduledAt?: number; lastRunId?: string | null; lastError?: string | null }) {
    db.prepare(`UPDATE workflow_schedules SET next_run_at = ?, last_scheduled_at = COALESCE(?, last_scheduled_at),
        last_run_id = CASE WHEN ? THEN ? ELSE last_run_id END,
        last_error = CASE WHEN ? THEN ? ELSE last_error END
      WHERE id = ?`).run(
      patch.nextRunAt, patch.lastScheduledAt ?? null,
      patch.lastRunId !== undefined ? 1 : 0, patch.lastRunId ?? null,
      patch.lastError !== undefined ? 1 : 0, patch.lastError ?? null,
      id,
    );
  }

  /** 抢占某一次触发。返回 false 表示别的进程 / 上一轮已经领走。 */
  function claim(scheduleId: string, scheduledAt: number): boolean {
    return db.prepare('INSERT OR IGNORE INTO workflow_schedule_triggers (identity, schedule_id, scheduled_at, claimed_at) VALUES (?, ?, ?, ?)')
      .run(`${scheduleId}:${scheduledAt}`, scheduleId, scheduledAt, now()).changes === 1;
  }

  async function fire(schedule: ScheduleRecord): Promise<void> {
    const at = now();
    if (schedule.nextRunAt === null) {
      saveFire(schedule.id, { nextRunAt: nextOccurrence(schedule.cron, schedule.timezone, at) });
      return;
    }
    const due = schedule.nextRunAt;
    if (due > at) return;
    const identity = `${schedule.id}:${due}`;
    const following = nextOccurrence(schedule.cron, schedule.timezone, Math.max(at, due));
    if (!claim(schedule.id, due)) {
      saveFire(schedule.id, { nextRunAt: following });
      return;
    }
    const base = { triggerIdentity: identity, scheduledAt: due };
    if (at - due > MISFIRE_GRACE_MS) {
      addEvent(schedule, { ...base, kind: 'skipped', reason: 'misfire', runId: null });
      saveFire(schedule.id, { nextRunAt: following });
      return;
    }
    if (!defs.get(schedule.workflowId)) {
      addEvent(schedule, { ...base, kind: 'failed', reason: WORKFLOW_ERROR.notFound, runId: null });
      saveFire(schedule.id, { nextRunAt: following, lastError: WORKFLOW_ERROR.notFound });
      return;
    }
    try {
      const run = await engine.startRun(schedule.workflowId, {
        input: schedule.input,
        startNodeIds: schedule.startNodeIds.length ? schedule.startNodeIds : undefined,
        timeoutMs: schedule.timeoutMs,
        triggerSource: 'scheduled',
        scheduledAt: due,
      });
      addEvent(schedule, { ...base, kind: 'triggered', reason: null, runId: run.id });
      saveFire(schedule.id, { nextRunAt: following, lastScheduledAt: due, lastRunId: run.id, lastError: null });
    } catch (error) {
      const code = error instanceof AutomationError ? error.code : 'schedules.fireFailed';
      const overlap = code === WORKFLOW_ERROR.alreadyRunning;
      addEvent(schedule, { ...base, kind: overlap ? 'skipped' : 'failed', reason: overlap ? 'overlap' : code, runId: null });
      saveFire(schedule.id, { nextRunAt: following, lastError: overlap ? undefined : code });
    }
  }

  async function tick(): Promise<void> {
    const schedules = (db.prepare('SELECT * FROM workflow_schedules WHERE enabled = 1').all()).map(fromRow);
    for (const schedule of schedules) {
      try {
        await fire(schedule);
      } catch (error) {
        console.warn(`[Schedules] tick failed for ${schedule.id}:`, (error as Error)?.message);
      }
    }
    db.prepare('DELETE FROM workflow_schedule_triggers WHERE claimed_at < ?').run(now() - 7 * 24 * 3600 * 1000);
  }

  return {
    tick,
    claim,

    list(workflowId: string): ScheduleRecord[] {
      return db.prepare('SELECT * FROM workflow_schedules WHERE workflow_id = ? ORDER BY created_at ASC').all(workflowId).map(fromRow);
    },

    get(workflowId: string, id: string): ScheduleRecord {
      const schedule = get(id);
      if (!schedule || schedule.workflowId !== workflowId) throw notFound(SCHEDULE_ERROR.notFound, id);
      return schedule;
    },

    events(workflowId: string, id: string, limit = 50): ScheduleEvent[] {
      this.get(workflowId, id);
      return db.prepare('SELECT * FROM workflow_schedule_events WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(id, clampInt(limit, 1, 200, 50)).map(eventFromRow);
    },

    create(workflowId: string, body: Record<string, unknown>): ScheduleRecord {
      const cron = wrapCron(() => normalizeCron(body.cron));
      const timezone = wrapCron(() => normalizeTimezone(body.timezone));
      const startNodeIds = parseStartNodes(workflowId, body.start_node_ids ?? body.startNodeIds);
      const timeoutMs = parseTimeout(body.timeout_ms ?? body.timeoutMs);
      const enabled = body.enabled !== false;
      const id = newId();
      const at = now();
      db.prepare(`INSERT INTO workflow_schedules (id, workflow_id, name, cron, timezone, enabled, input, start_node_ids_json, timeout_ms,
          next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, workflowId, typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '', cron, timezone, enabled ? 1 : 0,
        typeof body.input === 'string' && body.input ? body.input.slice(0, 100_000) : null, JSON.stringify(startNodeIds), timeoutMs,
        enabled ? nextOccurrence(cron, timezone, at) : null, at, at,
      );
      return get(id)!;
    },

    update(workflowId: string, id: string, body: Record<string, unknown>): ScheduleRecord {
      const current = this.get(workflowId, id);
      const cron = body.cron !== undefined ? wrapCron(() => normalizeCron(body.cron)) : current.cron;
      const timezone = body.timezone !== undefined ? wrapCron(() => normalizeTimezone(body.timezone)) : current.timezone;
      const enabled = body.enabled !== undefined ? body.enabled === true : current.enabled;
      const startNodeIds = (body.start_node_ids ?? body.startNodeIds) !== undefined
        ? parseStartNodes(workflowId, body.start_node_ids ?? body.startNodeIds) : current.startNodeIds;
      const timeoutMs = (body.timeout_ms ?? body.timeoutMs) !== undefined ? parseTimeout(body.timeout_ms ?? body.timeoutMs) : current.timeoutMs;
      const timingChanged = cron !== current.cron || timezone !== current.timezone || enabled !== current.enabled;
      const nextRunAt = !enabled ? null : timingChanged || current.nextRunAt === null ? nextOccurrence(cron, timezone, now()) : current.nextRunAt;
      db.prepare(`UPDATE workflow_schedules SET name = ?, cron = ?, timezone = ?, enabled = ?, input = ?, start_node_ids_json = ?,
          timeout_ms = ?, next_run_at = ?, updated_at = ? WHERE id = ?`).run(
        body.name !== undefined ? String(body.name).trim().slice(0, 120) : current.name,
        cron, timezone, enabled ? 1 : 0,
        body.input !== undefined ? (typeof body.input === 'string' && body.input ? body.input.slice(0, 100_000) : null) : current.input,
        JSON.stringify(startNodeIds), timeoutMs, nextRunAt, now(), id,
      );
      return get(id)!;
    },

    remove(workflowId: string, id: string): void {
      this.get(workflowId, id);
      db.prepare('DELETE FROM workflow_schedule_events WHERE schedule_id = ?').run(id);
      db.prepare('DELETE FROM workflow_schedules WHERE id = ?').run(id);
    },

    deleteForWorkflow(workflowId: string): void {
      db.prepare('DELETE FROM workflow_schedule_events WHERE workflow_id = ?').run(workflowId);
      db.prepare('DELETE FROM workflow_schedules WHERE workflow_id = ?').run(workflowId);
    },

    start(): void {
      if (timer) return;
      const run = () => {
        if (ticking) return;
        ticking = tick().finally(() => { ticking = null; });
      };
      run();
      timer = setInterval(run, SCHEDULE_TICK_MS);
      timer.unref?.();
    },

    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      await ticking;
    },
  };
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
