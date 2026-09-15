/**
 * P1b 任务计划卡：运行时发的计划 / TodoWrite / update_plan → 步骤；每次更新 revision + 1；终态重发把 in_progress 退回 pending
 * 并写上结局；只查本会话。
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime';
import { RunCoordinator } from '../src/runtime/coordinator';
import {
  finalizePlanSteps, stepsFromPlanEvent, stepsFromPlanTool, TASK_PLAN_EVENT, TaskPlanStore, withTaskPlans,
} from '../src/collab/sessions/task-plans';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';

describe('计划来源映射', () => {
  it('plan.updated：字符串条目与 ACP 形状（content + status）；认不出返回 null', () => {
    expect(stepsFromPlanEvent({ entries: ['读代码', { content: '改测试', status: 'in_progress' }, { title: '发版', status: 'completed' }] })).toEqual([
      { text: '读代码', status: 'pending' },
      { text: '改测试', status: 'in_progress' },
      { text: '发版', status: 'completed' },
    ]);
    expect(stepsFromPlanEvent({ nope: 1 })).toBeNull();
    expect(stepsFromPlanEvent({ entries: [] })).toBeNull();
  });

  it('Claude Code TodoWrite 与 Codex update_plan；其他工具不是计划', () => {
    expect(stepsFromPlanTool('TodoWrite', JSON.stringify({ todos: [{ content: 'a', status: 'completed', activeForm: 'A-ing' }, { content: 'b', status: 'in_progress' }] })))
      .toEqual([{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }]);
    expect(stepsFromPlanTool('update_plan', JSON.stringify({ plan: [{ step: 'x', status: 'pending' }] }))).toEqual([{ text: 'x', status: 'pending' }]);
    expect(stepsFromPlanTool('Bash', JSON.stringify({ command: 'ls' }))).toBeNull();
    expect(stepsFromPlanTool('TodoWrite', 'not json')).toBeNull();
  });

  it('终态：in_progress 退回 pending，写上结局', () => {
    const steps = [{ text: 'a', status: 'completed' as const }, { text: 'b', status: 'in_progress' as const }];
    expect(finalizePlanSteps(steps, { kind: 'aborted', reason: 'user_stop', synced: true, phase: 'running' })).toEqual({
      executionState: 'interrupted',
      steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }],
    });
    expect(finalizePlanSteps(steps, { kind: 'completed' }).executionState).toBe('completed');
  });
});

describe('投影器包装经协调器', () => {
  it('每次更新 revision + 1 并发帧；终态重发；查询只看本会话', async () => {
    const db = new Database(':memory:');
    const store = new TaskPlanStore(db);
    const hub = new RealtimeHub();
    const events: RealtimeEvent[] = [];
    hub.listen('t', (event) => events.push(event));
    const coordinator = new RunCoordinator({ hub, store: new MemoryRunStore(), log: () => {} });
    const scripted = scriptedAdapter();
    const submitted = await coordinator.submit({
      sessionKey: 's1', surface: 'chat', topics: ['session:s1'], agentId: 'a', adapter: scripted.adapter, request: {},
      projector: (run) => withTaskPlans(store, run, () => 42, { onEvent: () => {}, finish: () => ({ messageId: 42 }) }),
    }, 'queue');
    await flush();
    const run = scripted.runs[0];
    run.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: 'i1', call_id: 'c1', name: 'TodoWrite', arguments: JSON.stringify({ todos: [{ content: 'a', status: 'in_progress' }] }) } });
    run.emit({ type: 'plan.updated', plan: { entries: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } });
    run.finish({ kind: 'aborted', reason: 'user_stop', synced: true, phase: 'running' });
    await (submitted as any).completion;

    const planEvents = events.filter((e) => e.type === TASK_PLAN_EVENT).map((e) => e.payload as any);
    expect(planEvents.map((p) => [p.revision, p.executionState])).toEqual([[1, 'running'], [2, 'running'], [3, 'interrupted']]);
    expect(planEvents[2].steps).toEqual([{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }]);
    expect(store.listForMessages('s1', [42])).toEqual([expect.objectContaining({ revision: 3, executionState: 'interrupted', messageId: 42 })]);
    expect(store.listForMessages('s2', [42])).toEqual([]);
    store.deleteBySession('s1');
    expect(store.listForMessages('s1', [42])).toEqual([]);
  });
});
