/**
 * P1b 运行控制：出队时才落行（beforeStart）、队列引用 id、「立即插入」状态机（generation 令牌、strict / immediate、
 * 取消与硬停止）。适配器是脚本化的，协调逻辑全在协调器里。
 */
import { describe, expect, it } from 'vitest';
import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime';
import {
  defineCapabilities,
  NATIVE_ONLY_SOURCE_OF_TRUTH,
  type AdapterRunOutcome,
  type AgentRuntimeAdapter,
  type BoundaryInterruptResult,
} from '../src/runtime/contract';
import { RunCoordinator, type RunProjector, type RunSubmission } from '../src/runtime/coordinator';
import { MemoryRunStore, PLAIN_CAPABILITIES, flush, scriptedAdapter, type RunControls } from './helpers/scripted-adapter';

const BOUNDARY_CAPABILITIES = defineCapabilities({ ...PLAIN_CAPABILITIES, boundaryInterrupt: true });

function setup(options: { boundary?: boolean } = {}) {
  const hub = new RealtimeHub();
  const store = new MemoryRunStore();
  const events: RealtimeEvent[] = [];
  hub.listen('test', (event) => events.push(event));
  const coordinator = new RunCoordinator({ hub, store, abortGraceMs: 200, log: () => {} });
  const boundaryRequests: Array<{ expectedRunId: string; resolve: (result: BoundaryInterruptResult) => void }> = [];
  const scripted = scriptedAdapter({ capabilities: options.boundary ? BOUNDARY_CAPABILITIES : PLAIN_CAPABILITIES });
  const adapter: AgentRuntimeAdapter<any> = options.boundary
    ? {
      ...scripted.adapter,
      start(context) {
        const handle = scripted.adapter.start(context);
        return {
          ...handle,
          requestBoundaryInterrupt: (expectedRunId: string) => new Promise<BoundaryInterruptResult>((resolve) => {
            boundaryRequests.push({ expectedRunId, resolve });
          }),
        };
      },
    }
    : scripted.adapter;
  const submission = (overrides: Partial<RunSubmission<any>> = {}): RunSubmission<any> => ({
    sessionKey: 's1',
    surface: 'chat',
    topics: ['session:s1'],
    agentId: 'main',
    adapter,
    request: {},
    projector: (): RunProjector => ({ onEvent: () => {}, finish: () => ({ messageId: 1 }) }),
    ...overrides,
  });
  const insertionEvents = () => events.filter((e) => e.type === 'queue.insertion.updated').map((e) => e.payload as Record<string, any>);
  return { hub, events, coordinator, scripted, submission, boundaryRequests, insertionEvents };
}

const completed: AdapterRunOutcome = { kind: 'completed', outputText: 'ok' };
const lastRun = (runs: RunControls[]) => runs[runs.length - 1];

describe('beforeStart 与队列引用', () => {
  it('排队的提交在出队那一刻才调用 beforeStart，返回的 meta 进 run.started；ref 出现在队列视图与 run.started 里', async () => {
    const { coordinator, scripted, submission, events } = setup();
    const calls: string[] = [];
    await coordinator.submit(submission({ beforeStart: () => { calls.push('first'); return { meta: { messageId: 10 } }; } }), 'queue');
    await flush();
    const queued = await coordinator.submit(submission({ ref: 'turn-2', display: 'second', beforeStart: () => { calls.push('second'); return { meta: { messageId: 20 } }; } }), 'queue');
    expect(queued.status).toBe('queued');
    expect(calls).toEqual(['first']);
    expect(coordinator.snapshot('s1').queue).toEqual([expect.objectContaining({ display: 'second', ref: 'turn-2' })]);

    scripted.runs[0].finish(completed);
    await flush();
    expect(calls).toEqual(['first', 'second']);
    const started = events.filter((e) => e.type === 'run.started').map((e) => e.payload as any);
    expect(started[0].meta).toMatchObject({ messageId: 10 });
    expect(started[1]).toMatchObject({ ref: 'turn-2', meta: { messageId: 20 }, queue_id: (queued as any).queueId });
  });

  it('beforeStart 抛错：这一轮按失败收尾（before_start_failed），会话继续出队下一条', async () => {
    const { coordinator, scripted, submission, events } = setup();
    await coordinator.submit(submission(), 'queue');
    await flush();
    const broken = await coordinator.submit(submission({ beforeStart: () => { throw new Error('db down'); } }), 'queue');
    await coordinator.submit(submission({ display: 'third' }), 'queue');
    scripted.runs[0].finish(completed);
    const terminal = await (broken as any).completion;
    expect(terminal.outcome).toMatchObject({ kind: 'failed', stopReason: 'before_start_failed' });
    await flush();
    expect(scripted.runs).toHaveLength(2);
    expect(events.some((e) => e.type === 'run.failed' && (e.payload as any).stop_reason === 'before_start_failed')).toBe(true);
    expect(coordinator.isBusy('s1')).toBe(true);
  });
});

describe('立即插入：immediate', () => {
  it('不支持边界打断的运行时：requesting → stopping_current_turn → starting_queued_message → 清除；终态标 interruption_mode', async () => {
    const { coordinator, scripted, submission, events, insertionEvents } = setup();
    await coordinator.submit(submission(), 'queue');
    await flush();
    await coordinator.submit(submission({ display: 'later' }), 'queue');
    const urgent = await coordinator.submit(submission({ display: 'urgent', ref: 'u' }), 'queue') as any;

    const result = await coordinator.insertNow('s1', urgent.queueId);
    expect(result).toMatchObject({ status: 'immediate' });
    await flush();
    await flush();

    expect(insertionEvents().map((p) => p.cleared ? `cleared:${p.reason}` : p.phase)).toEqual([
      'requesting', 'stopping_current_turn', 'starting_queued_message', 'cleared:started',
    ]);
    const aborted = events.find((e) => e.type === 'run.aborted')!.payload as any;
    expect(aborted).toMatchObject({ interrupted: true, stop_reason: 'queue_insertion', interruption_mode: 'immediate' });
    expect((events.filter((e) => e.type === 'run.started')[1].payload as any).ref).toBe('u');
    expect(coordinator.queueInsertion('s1')).toBeNull();
    expect(coordinator.snapshot('s1').queue.map((q) => q.display)).toEqual(['later']);
    expect(scripted.runs).toHaveLength(2);
  });

  it('同一会话已有别的插入在进行：回 already_pending，不动队列', async () => {
    const { coordinator, submission, boundaryRequests } = setup({ boundary: true });
    await coordinator.submit(submission(), 'queue');
    await flush();
    const a = await coordinator.submit(submission({ display: 'a' }), 'queue') as any;
    const b = await coordinator.submit(submission({ display: 'b' }), 'queue') as any;
    void coordinator.insertNow('s1', b.queueId);
    await flush();
    expect(boundaryRequests).toHaveLength(1);
    const second = await coordinator.insertNow('s1', a.queueId);
    expect(second.status).toBe('already_pending');
    expect(coordinator.snapshot('s1').queue.map((q) => q.display)).toEqual(['b', 'a']);
  });

  it('用户点停止（硬停止）取消进行中的插入，reason = hard_stop', async () => {
    const { coordinator, submission, insertionEvents } = setup({ boundary: true });
    await coordinator.submit(submission(), 'queue');
    await flush();
    const q = await coordinator.submit(submission({ display: 'x' }), 'queue') as any;
    void coordinator.insertNow('s1', q.queueId);
    await flush();
    await coordinator.abort('s1', 'user_stop');
    expect(insertionEvents().at(-1)).toMatchObject({ cleared: true, reason: 'hard_stop' });
  });

  it('取消插入目标那一条排队项：插入随之清除，reason = cancelled', async () => {
    const { coordinator, submission, insertionEvents } = setup({ boundary: true });
    await coordinator.submit(submission(), 'queue');
    await flush();
    const q = await coordinator.submit(submission({ display: 'x' }), 'queue') as any;
    void coordinator.insertNow('s1', q.queueId);
    await flush();
    expect(coordinator.cancelQueued('s1', q.queueId)).toBe(true);
    expect(insertionEvents().at(-1)).toMatchObject({ cleared: true, reason: 'cancelled' });
    expect(coordinator.queueInsertion('s1')).toBeNull();
  });
});

describe('立即插入：strict（边界打断）与 generation 令牌', () => {
  it('运行时接受边界打断：waiting_for_tool_batch，运行照常完成后终态 interrupted + strict，随后插入项开始', async () => {
    const { coordinator, scripted, submission, events, boundaryRequests, insertionEvents } = setup({ boundary: true });
    await coordinator.submit(submission(), 'queue');
    await flush();
    const q = await coordinator.submit(submission({ display: 'now' }), 'queue') as any;
    const pending = coordinator.insertNow('s1', q.queueId);
    await flush();
    expect(boundaryRequests[0].expectedRunId).toBe(scripted.runs[0].context.runId);
    boundaryRequests[0].resolve({ status: 'accepted' });
    expect(await pending).toMatchObject({ status: 'strict' });
    expect(scripted.runs[0].interrupts).toEqual([]);

    scripted.runs[0].finish({ kind: 'completed', outputText: 'batch done', stopReason: 'boundary_interrupt' });
    await flush();
    const terminal = events.find((e) => e.type === 'run.completed')!.payload as any;
    expect(terminal).toMatchObject({ interrupted: true, stop_reason: 'queue_insertion', interruption_mode: 'strict' });
    expect(insertionEvents().map((p) => p.cleared ? `cleared:${p.reason}` : p.phase)).toEqual([
      'requesting', 'waiting_for_tool_batch', 'starting_queued_message', 'cleared:started',
    ]);
    expect(scripted.runs).toHaveLength(2);
  });

  it('边界打断结果回来时插入已被取消：旧结果丢弃——不设 stop_reason、不中止当前运行', async () => {
    const { coordinator, scripted, submission, events, boundaryRequests } = setup({ boundary: true });
    await coordinator.submit(submission(), 'queue');
    await flush();
    const q = await coordinator.submit(submission({ display: 'x' }), 'queue') as any;
    const pending = coordinator.insertNow('s1', q.queueId);
    await flush();
    coordinator.cancelQueued('s1', q.queueId);
    boundaryRequests[0].resolve({ status: 'unsupported', reason: 'late' });
    await pending;
    await flush();
    expect(scripted.runs[0].interrupts).toEqual([]);
    expect(coordinator.isBusy('s1')).toBe(true);
    lastRun(scripted.runs).finish(completed);
    await flush();
    const terminal = events.find((e) => e.type === 'run.completed')!.payload as any;
    expect(terminal).toMatchObject({ interrupted: false, stop_reason: null, interruption_mode: null });
  });

  it('运行时回 unsupported：退回立即中止', async () => {
    const { coordinator, scripted, submission, boundaryRequests, insertionEvents } = setup({ boundary: true });
    await coordinator.submit(submission(), 'queue');
    await flush();
    const q = await coordinator.submit(submission({ display: 'x' }), 'queue') as any;
    const pending = coordinator.insertNow('s1', q.queueId);
    await flush();
    boundaryRequests[0].resolve({ status: 'unsupported', reason: 'no tool batch' });
    expect(await pending).toMatchObject({ status: 'immediate' });
    await flush();
    expect(scripted.runs[0].interrupts).toEqual(['queue_insertion']);
    expect(insertionEvents().map((p) => p.phase ?? p.reason)).toContain('stopping_current_turn');
  });

  it('断线接回快照带插入状态与队列引用', async () => {
    const { coordinator, submission } = setup({ boundary: true });
    await coordinator.submit(submission(), 'queue');
    await flush();
    const q = await coordinator.submit(submission({ display: 'x', ref: 'r-1' }), 'queue') as any;
    void coordinator.insertNow('s1', q.queueId);
    await flush();
    const snapshot = coordinator.snapshot('s1');
    expect(snapshot.insertion).toMatchObject({ queueId: q.queueId, phase: 'requesting', guarantee: 'strict' });
    expect(snapshot.queue[0]).toMatchObject({ ref: 'r-1' });
    expect(snapshot.replay.some((e) => e.type === 'queue.insertion.updated')).toBe(true);
  });
});
