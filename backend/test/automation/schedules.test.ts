/**
 * 定时计划：标准 cron（OR 语义、名字、昵称）、时区与夏令时、触发占位去重、错过即跳过、重叠即跳过、触发时重新校验。
 */
import { describe, expect, it } from 'vitest';

import { nextOccurrence, normalizeCron, normalizeTimezone } from '../../src/automation/schedules/cron';
import { createScheduleService, MISFIRE_GRACE_MS } from '../../src/automation/schedules/schedule-service';
import { node, setupEngine } from './helpers';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('cron 语义', () => {
  it('日与周同时受限时是 OR（Vixie），不是 AND', () => {
    // 每月 13 号 或 每个周五
    let at = Date.parse('2026-01-01T00:00:00Z');
    const fires: string[] = [];
    for (let i = 0; i < 4; i++) {
      at = nextOccurrence('0 0 13 * 5', 'UTC', at)!;
      fires.push(iso(at)!.slice(0, 10));
    }
    expect(fires).toEqual(['2026-01-02', '2026-01-09', '2026-01-13', '2026-01-16']);
  });

  it('允许英文名与昵称', () => {
    expect(normalizeCron('0 9 * JAN MON-FRI')).toBe('0 9 * JAN MON-FRI');
    expect(normalizeCron('@Daily')).toBe('@daily');
    expect(iso(nextOccurrence('@daily', 'UTC', Date.parse('2026-03-01T10:00:00Z')))).toBe('2026-03-02T00:00:00.000Z');
  });

  it('非法表达式与时区拒绝；秒字段（6 段）拒绝', () => {
    expect(() => normalizeCron('61 * * * *')).toThrow();
    expect(() => normalizeCron('* * * *')).toThrow();
    expect(() => normalizeCron('0 * * * * *')).toThrow();
    expect(() => normalizeCron('@sometimes')).toThrow();
    expect(() => normalizeTimezone('Mars/Olympus')).toThrow();
    expect(normalizeTimezone('')).toBe('UTC');
  });

  it('秋季回拨：重复的 01:30 只触发一次', () => {
    const fires: string[] = [];
    let at = Date.parse('2026-10-31T12:00:00Z');
    for (let i = 0; i < 3; i++) {
      at = nextOccurrence('30 1 * * *', 'America/New_York', at)!;
      fires.push(iso(at)!);
    }
    expect(fires).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z']);
  });

  it('春季跳变：不存在的 02:30 顺延触发一次，不丢一天也不重复', () => {
    const fires: string[] = [];
    let at = Date.parse('2026-03-07T12:00:00Z');
    for (let i = 0; i < 3; i++) {
      at = nextOccurrence('30 2 * * *', 'America/New_York', at)!;
      fires.push(iso(at)!.slice(0, 10));
    }
    expect(fires).toEqual(['2026-03-08', '2026-03-09', '2026-03-10']);
  });

  it('时区生效：上海每天 09:00 = UTC 01:00', () => {
    expect(iso(nextOccurrence('0 9 * * *', 'Asia/Shanghai', Date.parse('2026-05-01T02:00:00Z')))).toBe('2026-05-02T01:00:00.000Z');
  });
});

describe('计划服务', () => {
  function setup(handler?: Parameters<typeof setupEngine>[0]['handler']) {
    const clock = { now: Date.parse('2026-06-01T00:00:00Z') };
    const t = setupEngine({ handler });
    const schedules = createScheduleService({ db: t.db, defs: t.defs, engine: t.engine, now: () => clock.now });
    const def = t.create([node('a')]);
    return { t, schedules, def, clock };
  }

  it('创建时算出下一次；到点触发一次并记 triggered 事件', async () => {
    const { t, schedules, def, clock } = setup();
    const schedule = schedules.create(def.id, { cron: '*/5 * * * *', timezone: 'UTC', input: 'scheduled input' });
    expect(iso(schedule.nextRunAt)).toBe('2026-06-01T00:05:00.000Z');
    clock.now = schedule.nextRunAt! + 1_000;
    await schedules.tick();
    const [event] = schedules.events(def.id, schedule.id);
    expect(event).toMatchObject({ kind: 'triggered', scheduledAt: schedule.nextRunAt });
    await t.engine.waitForRun(event.runId!);
    expect(t.runStore.getRun(event.runId!)).toMatchObject({ triggerSource: 'scheduled', scheduledAt: schedule.nextRunAt, input: 'scheduled input' });
    expect(iso(schedules.get(def.id, schedule.id).nextRunAt)).toBe('2026-06-01T00:10:00.000Z');
  });

  it('触发占位去重：同一时刻只能被领一次（模拟两个进程）', () => {
    const { schedules, def } = setup();
    const schedule = schedules.create(def.id, { cron: '*/5 * * * *' });
    expect(schedules.claim(schedule.id, 123)).toBe(true);
    expect(schedules.claim(schedule.id, 123)).toBe(false);
    expect(schedules.claim(schedule.id, 124)).toBe(true);
  });

  it('两个服务实例共享一个库并发 tick：只触发一次运行', async () => {
    const { t, schedules, def, clock } = setup();
    const other = createScheduleService({ db: t.db, defs: t.defs, engine: t.engine, now: () => clock.now });
    const schedule = schedules.create(def.id, { cron: '*/5 * * * *' });
    clock.now = schedule.nextRunAt! + 500;
    await Promise.all([schedules.tick(), other.tick()]);
    const triggered = schedules.events(def.id, schedule.id).filter((event) => event.kind === 'triggered');
    expect(triggered).toHaveLength(1);
    // 另一个进程领不到占位，连 skipped 事件都不该写（写了说明它越过了占位、撞上了重叠检查）
    expect(schedules.events(def.id, schedule.id)).toHaveLength(1);
    expect(t.runStore.listRuns(def.id, 10)).toHaveLength(1);
    await t.engine.waitForRun(triggered[0].runId!);
  });

  it('错过即跳过：服务停过、到期超过 60 秒 → skipped(misfire)，不补跑', async () => {
    const { t, schedules, def, clock } = setup();
    const schedule = schedules.create(def.id, { cron: '0 * * * *' });
    clock.now = schedule.nextRunAt! + MISFIRE_GRACE_MS + 1;
    await schedules.tick();
    expect(schedules.events(def.id, schedule.id)[0]).toMatchObject({ kind: 'skipped', reason: 'misfire' });
    expect(t.runStore.listRuns(def.id, 10)).toEqual([]);
    expect(schedules.get(def.id, schedule.id).nextRunAt!).toBeGreaterThan(clock.now);
  });

  it('重叠即跳过：上一次还在跑 → skipped(overlap)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { t, schedules, def, clock } = setup(async (req) => { await gate; return { ok: true, output: 'x', sessionId: req.sessionId }; });
    const running = await t.engine.startRun(def.id);
    const schedule = schedules.create(def.id, { cron: '*/5 * * * *' });
    clock.now = schedule.nextRunAt! + 1;
    await schedules.tick();
    expect(schedules.events(def.id, schedule.id)[0]).toMatchObject({ kind: 'skipped', reason: 'overlap' });
    release();
    await t.engine.waitForRun(running.id);
  });

  it('触发时重新校验：Agent 已不可用 → failed 事件并记 last_error', async () => {
    const clock = { now: Date.parse('2026-06-01T00:00:00Z') };
    let available = true;
    const t = setupEngine({ directory: { list: () => [], availability: () => (available ? { available: true } : { available: false, reason: 'gone' }), readSkill: () => null, listSkills: () => [] } });
    const schedules = createScheduleService({ db: t.db, defs: t.defs, engine: t.engine, now: () => clock.now });
    const def = t.create([node('a')]);
    const schedule = schedules.create(def.id, { cron: '*/5 * * * *' });
    available = false;
    clock.now = schedule.nextRunAt! + 1;
    await schedules.tick();
    expect(schedules.events(def.id, schedule.id)[0]).toMatchObject({ kind: 'failed', reason: 'workflows.agentUnavailable' });
    expect(schedules.get(def.id, schedule.id).lastError).toBe('workflows.agentUnavailable');
  });

  it('只有改 cron / 时区 / 启用状态才重算下一次；改名字不推迟', () => {
    const { schedules, def, clock } = setup();
    const schedule = schedules.create(def.id, { cron: '0 * * * *' });
    clock.now += 30 * 60 * 1000;
    expect(schedules.update(def.id, schedule.id, { name: 'renamed' }).nextRunAt).toBe(schedule.nextRunAt);
    expect(schedules.update(def.id, schedule.id, { enabled: false }).nextRunAt).toBeNull();
    expect(schedules.update(def.id, schedule.id, { enabled: true }).nextRunAt).toBe(Date.parse('2026-06-01T01:00:00Z'));
    expect(iso(schedules.update(def.id, schedule.id, { cron: '45 * * * *' }).nextRunAt)).toBe('2026-06-01T00:45:00.000Z');
  });

  it('开始节点必须存在于已保存的定义；超时范围校验；非法 cron 400', () => {
    const { schedules, def } = setup();
    expect(() => schedules.create(def.id, { cron: '* * * * *', start_node_ids: ['ghost'] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => schedules.create(def.id, { cron: '* * * * *', timeout_ms: 10 })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => schedules.create(def.id, { cron: 'nope' })).toThrow(expect.objectContaining({ status: 400, code: 'schedules.invalidCron' }));
    expect(() => schedules.create(def.id, { cron: '* * * * *', timezone: 'Nowhere/City' })).toThrow(expect.objectContaining({ code: 'schedules.invalidTimezone' }));
  });

  it('工作流被删：到点记 failed(workflows.notFound)', async () => {
    const { t, schedules, def, clock } = setup();
    const schedule = schedules.create(def.id, { cron: '*/5 * * * *' });
    t.defs.delete(def.id);
    clock.now = schedule.nextRunAt! + 1;
    await schedules.tick();
    expect((t.db.prepare('SELECT kind, reason FROM workflow_schedule_events WHERE schedule_id = ?').get(schedule.id) as any)).toEqual({ kind: 'failed', reason: 'workflows.notFound' });
  });
});
