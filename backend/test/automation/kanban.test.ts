/**
 * 原生看板：状态迁移守卫（409 + messageCode）、派活经 Runner、人工完成覆盖、重启恢复、批量、依赖环。
 */
import { describe, expect, it } from 'vitest';

import { createKanbanService, MOVE_TRANSITIONS } from '../../src/automation/kanban/kanban-service';
import { createKanbanStore, DEFAULT_BOARD_ID, KANBAN_STATUSES } from '../../src/automation/kanban/kanban-store';
import { createScriptedRunner, currentTaskOf } from '../../src/automation/runner/fake-runner';
import type { AgentRunResult } from '../../src/automation/ports';
import { directory, memoryDb, waitFor } from './helpers';

function setup(handler: (task: string, req: any) => AgentRunResult | Promise<AgentRunResult> = (task, req) => ({ ok: true, output: `done: ${task.slice(0, 20)}`, sessionId: req.sessionId })) {
  const db = memoryDb();
  const store = createKanbanStore(db);
  const runner = createScriptedRunner((req) => handler(currentTaskOf(req), req));
  const kanban = createKanbanService({ store, runner, directory: directory(), defaultWorkspace: () => '/tmp/kanban-test' });
  const task = (body: Record<string, unknown> = {}) => kanban.createTask(DEFAULT_BOARD_ID, { title: 'Write report', assignee: { kind: 'openclaw', id: 'main' }, ...body });
  return { db, store, runner, kanban, task };
}

describe('迁移守卫', () => {
  it('move 只允许表里的迁移；不允许的 409 kanban.invalidTransition 并带 from', () => {
    const { kanban, task } = setup();
    const t = task();
    expect(kanban.act(t.id, 'move', { status: 'ready' }).status).toBe('ready');
    expect(() => kanban.act(t.id, 'move', { status: 'done' })).toThrow(expect.objectContaining({ status: 409, code: 'kanban.invalidTransition', params: { from: 'ready', action: 'move:done' } }));
    expect(() => kanban.act(t.id, 'move', { status: 'running' })).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('running 只能由派活进入：迁移表里没有任何状态能 move 到 running', () => {
    for (const status of KANBAN_STATUSES) expect(MOVE_TRANSITIONS[status]).not.toContain('running');
  });

  it('block 需要原因；unblock 只从 blocked / scheduled', () => {
    const { kanban, task } = setup();
    const t = task({ status: 'ready' });
    expect(() => kanban.act(t.id, 'block', {})).toThrow(expect.objectContaining({ status: 400, code: 'kanban.reasonRequired' }));
    expect(kanban.act(t.id, 'block', { reason: 'waiting on data' }).status).toBe('blocked');
    expect(kanban.act(t.id, 'unblock', {}).status).toBe('ready');
    expect(() => kanban.act(t.id, 'unblock', {})).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('complete 只从 running / ready / blocked / review；todo 不行', () => {
    const { kanban, task } = setup();
    const t = task();
    expect(() => kanban.act(t.id, 'complete', {})).toThrow(expect.objectContaining({ status: 409 }));
    kanban.act(t.id, 'move', { status: 'ready' });
    expect(kanban.act(t.id, 'complete', { summary: 'by hand' })).toMatchObject({ status: 'done', result: 'by hand' });
  });

  it('条件更新防并发：读到之后状态被别人改掉，迁移失败 409', () => {
    const { kanban, store, task } = setup();
    const t = task();
    // 服务读到的是 blocked（陈旧），真实状态已被并发改成 archived
    const realGet = store.getTask.bind(store);
    let stale = true;
    store.getTask = (id: string) => {
      const current = realGet(id);
      if (stale && current) { stale = false; return { ...current, status: 'blocked' }; }
      return current;
    };
    store.transition(t.id, ['todo'], 'archived');
    expect(() => kanban.act(t.id, 'unblock', {})).toThrow(expect.objectContaining({ status: 409 }));
    expect(realGet(t.id)!.status).toBe('archived');
  });

  it('未知任务 404；未知动作 400', () => {
    const { kanban, task } = setup();
    expect(() => kanban.act('nope', 'archive', {})).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => kanban.act(task().id, 'teleport', {})).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('派活', () => {
  it('ready → running → review，结果写回任务，留一条运行记录；提示词带任务与评论', async () => {
    const { kanban, task, runner } = setup();
    const t = task({ status: 'ready', body: 'Quarterly numbers' });
    kanban.comment(t.id, { body: 'use the new template', author: 'lead' });
    expect(kanban.act(t.id, 'dispatch', {}).status).toBe('running');
    await kanban.waitForDispatch(t.id);
    const detail = kanban.detail(t.id);
    expect(detail.task.status).toBe('review');
    expect(detail.task.result).toContain('done:');
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ status: 'completed', agentId: 'main' });
    const prompt = (runner.calls[0].input[0] as any).text;
    expect(prompt).toContain('Title: Write report');
    expect(prompt).toContain('lead: use the new template');
    expect(detail.events.map((event) => event.kind)).toEqual(['created', 'dispatched', 'run_completed']);
  });

  it('派活失败 → blocked，运行记录 failed', async () => {
    const { kanban, task } = setup((_task, req) => ({ ok: false, output: '', error: 'agent crashed', sessionId: req.sessionId }));
    const t = task({ status: 'ready' });
    kanban.act(t.id, 'dispatch', {});
    await kanban.waitForDispatch(t.id);
    const detail = kanban.detail(t.id);
    expect(detail.task.status).toBe('blocked');
    expect(detail.runs[0]).toMatchObject({ status: 'failed', error: 'agent crashed' });
  });

  it('没有负责人 → 409；不是 ready → 409；Agent 不可用 → 409', () => {
    const { kanban, task, store, runner } = setup();
    const noAssignee = kanban.createTask(DEFAULT_BOARD_ID, { title: 'x', status: 'ready' });
    expect(() => kanban.act(noAssignee.id, 'dispatch', {})).toThrow(expect.objectContaining({ status: 409, code: 'kanban.assigneeRequired' }));
    expect(() => kanban.act(task().id, 'dispatch', {})).toThrow(expect.objectContaining({ status: 409, code: 'kanban.invalidTransition' }));
    const unavailable = createKanbanService({ store, runner, directory: directory({ availability: () => ({ available: false, reason: 'no' }) }), defaultWorkspace: () => '/tmp' });
    expect(() => unavailable.act(task({ status: 'ready' }).id, 'dispatch', {})).toThrow(expect.objectContaining({ status: 409, code: 'workflows.agentUnavailable' }));
  });

  it('人工完成覆盖正在跑的派活：运行先落 canceled 再中止，迟到的结果写不回任务', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const { kanban, task, runner } = setup(async (_task, req) => { await gate; return { ok: true, output: 'late result', sessionId: req.sessionId }; });
    // 故意让 runner 无视中止：模拟子进程没被打断
    const original = runner.runAndWait.bind(runner);
    (runner as any).runAndWait = (req: any) => original({ ...req, signal: new AbortController().signal });
    const t = task({ status: 'ready' });
    kanban.act(t.id, 'dispatch', {});
    await waitFor(() => runner.calls.length === 1);
    expect(kanban.act(t.id, 'complete', { summary: 'operator override' })).toMatchObject({ status: 'done', result: 'operator override' });
    expect(runner.aborted).toHaveLength(1);
    finish();
    await kanban.waitForDispatch(t.id);
    const detail = kanban.detail(t.id);
    expect(detail.task).toMatchObject({ status: 'done', result: 'operator override' });
    expect(detail.runs[0].status).toBe('canceled');
  });

  it('运行中不能改负责人', async () => {
    const { kanban, task } = setup(() => new Promise(() => undefined));
    const t = task({ status: 'ready' });
    kanban.act(t.id, 'dispatch', {});
    expect(() => kanban.updateTask(t.id, { assignee: { kind: 'openclaw', id: 'other' } })).toThrow(expect.objectContaining({ status: 409 }));
    kanban.act(t.id, 'reclaim', {});
    expect(kanban.detail(t.id).task.status).toBe('ready');
  });

  it('重启恢复：上个进程里在跑的派活标 failed，任务退回 blocked', () => {
    const { store, task, db } = setup();
    const t = task({ status: 'ready' });
    store.transition(t.id, ['ready'], 'running');
    store.createRun(t.id, { kind: 'openclaw', id: 'main' }, 'sess');
    const restarted = createKanbanStore(db);
    expect(restarted.recoverRunning()).toBe(1);
    expect(restarted.getTask(t.id)!.status).toBe('blocked');
    expect(restarted.runs(t.id)[0]).toMatchObject({ status: 'failed', error: 'server restarted' });
  });
});

describe('批量与依赖', () => {
  it('批量 ≤100，逐条执行逐条回报（不合法的那条失败，其余照常）', () => {
    const { kanban, task } = setup();
    const ready = task({ status: 'ready' });
    const todo = task();
    const result = kanban.bulk({ ids: [ready.id, todo.id, 'ghost'], status: 'done' });
    expect(result.results).toEqual([
      { id: ready.id, ok: true },
      { id: todo.id, ok: false, errorCode: 'kanban.invalidTransition' },
      { id: 'ghost', ok: false, errorCode: 'kanban.taskNotFound' },
    ]);
    expect(() => kanban.bulk({ ids: Array.from({ length: 101 }, (_, i) => `t${i}`), archive: true })).toThrow(expect.objectContaining({ code: 'kanban.bulkTooLarge' }));
  });

  it('批量：archive 与 status 二选一；批量改负责人；批量 blocked 需要原因', () => {
    const { kanban, task } = setup();
    const a = task({ status: 'ready' });
    expect(() => kanban.bulk({ ids: [a.id], archive: true, status: 'done' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(kanban.bulk({ ids: [a.id], assignee: { kind: 'external', id: 'claude-code' } }).results[0].ok).toBe(true);
    expect(kanban.detail(a.id).task.assignee).toEqual({ kind: 'external', id: 'claude-code' });
    expect(kanban.bulk({ ids: [a.id], status: 'blocked' }).results[0]).toMatchObject({ ok: false, errorCode: 'kanban.reasonRequired' });
    expect(kanban.bulk({ ids: [a.id], status: 'blocked', reason: 'x' }).results[0].ok).toBe(true);
    expect(kanban.bulk({ ids: [a.id], status: 'ready' }).results[0].ok).toBe(true);
  });

  it('父子依赖：禁止自连与成环', () => {
    const { kanban, task } = setup();
    const a = task();
    const b = task();
    const c = task();
    kanban.link({ parent_id: a.id, child_id: b.id });
    kanban.link({ parent_id: b.id, child_id: c.id });
    expect(() => kanban.link({ parent_id: c.id, child_id: a.id })).toThrow(expect.objectContaining({ status: 409, code: 'kanban.linkCycle' }));
    expect(() => kanban.link({ parent_id: a.id, child_id: a.id })).toThrow(expect.objectContaining({ code: 'kanban.linkCycle' }));
    expect(kanban.detail(b.id)).toMatchObject({ parents: [a.id], children: [c.id] });
  });

  it('默认看板不能归档；看板计数', () => {
    const { kanban, task } = setup();
    task();
    task({ status: 'ready' });
    expect(() => kanban.updateBoard(DEFAULT_BOARD_ID, { archived: true })).toThrow(expect.objectContaining({ code: 'kanban.defaultBoardProtected' }));
    expect(kanban.listBoards()[0]).toMatchObject({ id: DEFAULT_BOARD_ID, total: 2, counts: { todo: 1, ready: 1 } });
  });

  it('按状态、负责人、关键字过滤', () => {
    const { kanban, task } = setup();
    task({ title: 'alpha' });
    task({ title: 'beta', status: 'ready', assignee: { kind: 'openclaw', id: 'writer' } });
    expect(kanban.listTasks(DEFAULT_BOARD_ID, { status: 'ready' }).map((t) => t.title)).toEqual(['beta']);
    expect(kanban.listTasks(DEFAULT_BOARD_ID, { assignee: 'writer' }).map((t) => t.title)).toEqual(['beta']);
    expect(kanban.listTasks(DEFAULT_BOARD_ID, { q: 'alp' }).map((t) => t.title)).toEqual(['alpha']);
  });
});
