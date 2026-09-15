/**
 * 运行协调器的义务，逐条对应 spec 01 §3.2–§3.4（清单见 run-coordinator.ts 头注释）。
 * 适配器是脚本化的（helpers/scripted-adapter.ts），不含任何协调逻辑。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime';
import { emptyUsage, type AdapterRunOutcome } from '../src/runtime/contract';
import {
  INTERRUPTED_TOOL_OUTPUT,
  InteractionRegistry,
  ReplayBuffer,
  RunCoordinator,
  ToolCallGroups,
  snapshotRequest,
  type RunProjector,
  type RunSubmission,
} from '../src/runtime/coordinator';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';

function setup(options: { hangOnInterrupt?: boolean; abortGraceMs?: number; replayLimit?: number } = {}) {
  const hub = new RealtimeHub();
  const store = new MemoryRunStore();
  const events: RealtimeEvent[] = [];
  hub.listen('test', (event) => events.push(event));
  const coordinator = new RunCoordinator({ hub, store, abortGraceMs: options.abortGraceMs ?? 200, replayLimit: options.replayLimit, log: () => {} });
  const scripted = scriptedAdapter({ hangOnInterrupt: options.hangOnInterrupt });
  const seen: Array<{ runMarker: string; type: string }> = [];
  const submission = (overrides: Partial<RunSubmission<any>> = {}): RunSubmission<any> => ({
    sessionKey: 's1',
    surface: 'chat',
    topics: ['session:s1', 'agent:main'],
    agentId: 'main',
    adapter: scripted.adapter,
    request: { model: 'm-1' },
    projector: (run): RunProjector => ({
      onEvent: (event) => seen.push({ runMarker: run.runMarker, type: event.type }),
      finish: (outcome) => {
        run.publish('surface.final', { kind: outcome.kind });
        return { messageId: 42, output: outcome.kind === 'completed' ? outcome.outputText : undefined };
      },
    }),
    ...overrides,
  });
  return { hub, store, events, coordinator, scripted, seen, submission };
}

const completed = (text = 'ok'): AdapterRunOutcome => ({ kind: 'completed', outputText: text });

afterEach(() => { vi.useRealTimers(); });

describe('会话行与 run marker', () => {
  it('每次运行确保会话行、分配新的 marker；队列空时写结束标记', async () => {
    const { coordinator, store, scripted, submission, events } = setup();
    const first = await coordinator.submit(submission(), 'reject');
    expect(first.status).toBe('started');
    await flush();
    scripted.runs[0].finish(completed());
    const t1 = await (first as any).completion;
    const second = await coordinator.submit(submission(), 'reject');
    await flush();
    scripted.runs[1].finish(completed());
    const t2 = await (second as any).completion;

    expect(t1.runMarker).not.toBe(t2.runMarker);
    expect(store.calls).toEqual(['ensure:s1', 'ended:s1:complete', 'ensure:s1', 'ended:s1:complete']);
    const started = events.filter((e) => e.type === 'run.started');
    expect(started.map((e) => e.topic)).toEqual(['session:s1', 'agent:main', 'session:s1', 'agent:main']);
    expect(events.every((e) => typeof e.id === 'number' && e.id > 0 && typeof e.topic === 'string')).toBe(true);
  });
});

describe('陈旧事件', () => {
  it('被替换的运行之后再 emit 的事件一律丢弃，投影器看不见', async () => {
    const { coordinator, scripted, submission, seen } = setup({ hangOnInterrupt: true, abortGraceMs: 20 });
    await coordinator.submit(submission(), 'reject');
    await flush();
    const oldRun = scripted.runs[0];
    oldRun.emit({ type: 'response.output_text.delta', item_id: 'm', delta: 'old-1' });

    // 旧运行卡死不响应 interrupt：宽限期后被强制收尾，新运行接管会话。
    const replaced = await coordinator.submit(submission(), 'replace');
    expect(replaced.status).toBe('started');
    await flush();
    oldRun.emit({ type: 'response.output_text.delta', item_id: 'm', delta: 'old-late' });
    scripted.runs[1].emit({ type: 'response.output_text.delta', item_id: 'm', delta: 'new-1' });

    const markers = new Set(seen.map((s) => s.runMarker));
    expect(markers.size).toBe(2);
    expect(seen.filter((s) => s.runMarker === oldRun.context.runMarker)).toHaveLength(1);
    expect(coordinator.droppedEventCounts().stale).toBe(1);
  });
});

describe('单会话单运行与服务端队列', () => {
  it('忙时 reject 返回当前运行；queue 按 FIFO 出队，终态里带 queue_remaining', async () => {
    const { coordinator, scripted, submission, events } = setup();
    await coordinator.submit(submission(), 'queue');
    await flush();
    expect((await coordinator.submit(submission(), 'reject')).status).toBe('rejected');
    const q1 = await coordinator.submit(submission({ display: 'second' }), 'queue');
    const q2 = await coordinator.submit(submission({ display: 'third' }), 'queue');
    expect(q1).toMatchObject({ status: 'queued', position: 1 });
    expect(q2).toMatchObject({ status: 'queued', position: 2 });

    scripted.runs[0].finish(completed('a'));
    await flush();
    const firstTerminal = events.find((e) => e.type === 'run.completed' && e.topic === 'session:s1')!;
    expect((firstTerminal.payload as any).queue_remaining).toBe(2);
    expect(scripted.runs).toHaveLength(2);
    scripted.runs[1].finish(completed('b'));
    await flush();
    scripted.runs[2].finish(completed('c'));
    const last = await (q2 as any).completion;
    expect(last.queueRemaining).toBe(0);
    expect(events.filter((e) => e.type === 'run.queued' && (e.payload as any).dequeued_queue_id).map((e) => (e.payload as any).dequeued_queue_id))
      .toEqual([(q1 as any).queueId, (q2 as any).queueId]);
  });

  it('快照语义：入队后改原请求，出队运行拿到的仍是入队时的配置', async () => {
    const { coordinator, scripted, submission } = setup();
    await coordinator.submit(submission(), 'queue');
    const request = { model: 'model-at-enqueue', nested: { effort: 'high' } };
    await coordinator.submit(submission({ request }), 'queue');
    request.model = 'changed-later';
    request.nested.effort = 'low';
    scripted.runs[0].finish(completed());
    await flush();
    await flush();
    expect(scripted.runs[1].context.request).toEqual({ model: 'model-at-enqueue', nested: { effort: 'high' } });
  });

  it('取消排队项：它的 completion 按未开始即取消收尾，不会挂着', async () => {
    const { coordinator, submission } = setup();
    await coordinator.submit(submission(), 'queue');
    const queued = await coordinator.submit(submission(), 'queue') as any;
    expect(coordinator.cancelQueued('s1', queued.queueId)).toBe(true);
    const terminal = await queued.completion;
    expect(terminal.outcome).toMatchObject({ kind: 'aborted', phase: 'preparing' });
    expect(coordinator.snapshot('s1').queue).toEqual([]);
  });

  it('立即插入：挪到队首并立即打断当前运行，终态标 queue_insertion', async () => {
    const { coordinator, scripted, submission, events } = setup();
    await coordinator.submit(submission(), 'queue');
    await flush();
    await coordinator.submit(submission({ display: 'later' }), 'queue');
    const urgent = await coordinator.submit(submission({ display: 'urgent' }), 'queue') as any;
    expect(await coordinator.insertNow('s1', urgent.queueId)).toEqual({ status: 'immediate' });
    await flush();
    await flush();
    const aborted = events.find((e) => e.type === 'run.aborted' && e.topic === 'session:s1')!;
    expect(aborted.payload).toMatchObject({ interrupted: true, stop_reason: 'queue_insertion', queue_remaining: 2 });
    expect(scripted.runs[1].context.request).toEqual({ model: 'm-1' });
    expect(coordinator.snapshot('s1').queue.map((q) => q.display)).toEqual(['later']);
  });

  it('snapshotRequest 深拷贝数据、保留函数引用', () => {
    const fn = () => 1;
    const copy = snapshotRequest({ a: [1, { b: 2 }], fn });
    expect(copy.fn).toBe(fn);
    expect(copy.a).toEqual([1, { b: 2 }]);
  });
});

describe('中止与宽限', () => {
  it('运行时确认停下：abort.started → run.aborted（synced），会话回到空闲', async () => {
    const { coordinator, scripted, submission, events } = setup();
    await coordinator.submit(submission(), 'reject');
    await flush();
    const result = await coordinator.abort('s1', 'user_stop');
    expect(result).toEqual({ aborted: true, synced: true, ignored: false });
    expect(scripted.runs[0].interrupts).toEqual(['user_stop']);
    expect(scripted.runs[0].context.signal.aborted).toBe(true);
    const types = events.filter((e) => e.topic === 'session:s1').map((e) => e.type);
    expect(types.slice(types.indexOf('abort.started'))).toEqual(['abort.started', 'surface.final', 'run.aborted']);
    expect(coordinator.isBusy('s1')).toBe(false);
  });

  it('运行时不响应：宽限期到点发 abort.timeout，按未确认强制收尾，本地状态照样释放', async () => {
    const { coordinator, submission, events } = setup({ hangOnInterrupt: true, abortGraceMs: 30 });
    await coordinator.submit(submission(), 'reject');
    await flush();
    const result = await coordinator.abort('s1', 'user_stop');
    expect(result).toEqual({ aborted: true, synced: false, ignored: false });
    expect(events.map((e) => e.type)).toContain('abort.timeout');
    expect(coordinator.isBusy('s1')).toBe(false);
  });

  it('没有运行时 abort 被忽略', async () => {
    const { coordinator } = setup();
    expect(await coordinator.abort('nope', 'user_stop')).toEqual({ aborted: false, synced: false, ignored: true });
  });
});

describe('终态顺序', () => {
  it('终态事件发出时状态已清空：同步再提交一轮直接开始；投影器的终帧先于 run.completed', async () => {
    const { hub, coordinator, scripted, submission, events } = setup();
    let busyAtTerminal: boolean | null = null;
    let resubmitted: Promise<any> | null = null;
    hub.listen('resubmit-on-terminal', (event) => {
      if (event.type !== 'run.completed' || event.topic !== 'session:s1' || resubmitted) return;
      busyAtTerminal = coordinator.isBusy('s1');
      resubmitted = coordinator.submit(submission(), 'reject');
    });
    await coordinator.submit(submission(), 'reject');
    await flush();
    scripted.runs[0].finish(completed());
    await flush();
    expect(busyAtTerminal).toBe(false);
    expect((await resubmitted!).status).toBe('started');
    const sessionTypes = events.filter((e) => e.topic === 'session:s1').map((e) => e.type);
    expect(sessionTypes.indexOf('surface.final')).toBeLessThan(sessionTypes.indexOf('run.completed'));
    const terminal = events.find((e) => e.type === 'run.completed')!;
    expect(terminal.payload).toMatchObject({ message_id: 42, output: 'ok', queue_remaining: 0 });
  });

  it('队列不空时不写结束标记', async () => {
    const { coordinator, scripted, submission, store } = setup();
    await coordinator.submit(submission(), 'queue');
    await coordinator.submit(submission(), 'queue');
    await flush();
    scripted.runs[0].finish(completed());
    await flush();
    expect(store.calls.filter((c) => c.startsWith('ended'))).toEqual([]);
    scripted.runs[1].finish({ kind: 'failed', error: 'x' });
    await flush();
    expect(store.calls.filter((c) => c.startsWith('ended'))).toEqual(['ended:s1:error']);
  });
});

describe('用量去重', () => {
  it('同一个 call id 重复上报只记一次；估算值不记', async () => {
    const { coordinator, scripted, submission, store, events } = setup();
    await coordinator.submit(submission(), 'reject');
    await flush();
    const usage = { ...emptyUsage('turn-1:call:0'), inputTokens: 10, outputTokens: 5 };
    scripted.runs[0].emit({ type: 'usage.reported', usage });
    scripted.runs[0].emit({ type: 'usage.reported', usage });
    scripted.runs[0].emit({ type: 'usage.reported', usage: { ...emptyUsage('turn-1:call:1'), estimated: true } });
    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]).toMatchObject({ callId: 'turn-1:call:0', source: 'scripted', agentId: 'main', inputTokens: 10 });
    expect(events.filter((e) => e.type === 'usage.updated')).toHaveLength(1);
  });
});

describe('工具调用原子落库', () => {
  it('并行调用：两条结果都到齐才整组写入', async () => {
    const { coordinator, scripted, submission, store } = setup();
    await coordinator.submit(submission(), 'reject');
    await flush();
    const run = scripted.runs[0];
    run.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'a', name: 'Read', arguments: '{}' } });
    run.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc2', call_id: 'b', name: 'Grep', arguments: '{}' } });
    run.emit({ type: 'response.output_item.done', item: { type: 'function_call_output', id: 'o1', call_id: 'a', output: 'A' } });
    expect(store.toolCallBatches).toHaveLength(0);
    run.emit({ type: 'response.output_item.done', item: { type: 'function_call_output', id: 'o2', call_id: 'b', output: 'B' } });
    expect(store.toolCallBatches.map((batch) => batch.map((c) => c.callId))).toEqual([['a', 'b']]);
    expect(store.toolCallBatches[0].every((c) => c.runMarker === run.context.runMarker)).toBe(true);
  });

  it('运行中止时缺结果的调用补 interrupted 再落库——库里没有「有调用没结果」', async () => {
    const { coordinator, scripted, submission, store } = setup();
    await coordinator.submit(submission(), 'reject');
    await flush();
    scripted.runs[0].emit({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'a', name: 'Bash', arguments: '{"cmd":"sleep 100"}' } });
    await coordinator.abort('s1', 'user_stop');
    expect(store.toolCallBatches).toHaveLength(1);
    expect(store.toolCallBatches[0][0]).toMatchObject({ callId: 'a', status: 'interrupted', output: INTERRUPTED_TOOL_OUTPUT });
  });

  it('ToolCallGroups：顺序调用各成一组；重复调用与无主结果被拒', () => {
    const batches: string[][] = [];
    const groups = new ToolCallGroups((calls) => batches.push(calls.map((c) => c.callId)));
    groups.addCall('a', 'Read', '{}');
    groups.addOutput('a', 'A', 'completed');
    groups.addCall('b', 'Read', '{}');
    expect(groups.addCall('b', 'Read', '{}')).toBe(false);
    expect(groups.addOutput('zzz', 'x', 'completed')).toBe(false);
    groups.addOutput('b', 'B', 'failed');
    expect(batches).toEqual([['a'], ['b']]);
  });
});

describe('重放缓冲', () => {
  it('有上限：超出丢最旧并计数；replace 键只留最新；可按键移除', () => {
    const buffer = new ReplayBuffer(3);
    const ev = (id: number, type = 't') => ({ id, topic: 'session:s', type, payload: id, at: 0 });
    buffer.push(ev(1), { mode: 'append' });
    buffer.push(ev(2, 'approval'), { mode: 'replace', key: 'approval:x' });
    buffer.push(ev(3), { mode: 'append' });
    buffer.push(ev(4, 'approval'), { mode: 'replace', key: 'approval:x' });
    buffer.push(ev(5), { mode: 'skip' });
    expect(buffer.snapshot().map((e) => e.id)).toEqual([1, 3, 4]);
    buffer.push(ev(6), { mode: 'append' });
    expect(buffer.snapshot().map((e) => e.id)).toEqual([3, 4, 6]);
    expect(buffer.dropped).toBe(1);
    buffer.remove('approval:x');
    expect(buffer.snapshot().map((e) => e.id)).toEqual([3, 6]);
  });

  it('协调器的会话快照带回运行中的工具事件，新运行开始时清空', async () => {
    const { coordinator, scripted, submission } = setup({ replayLimit: 2 });
    await coordinator.submit(submission(), 'reject');
    await flush();
    for (const id of ['a', 'b', 'c']) {
      scripted.runs[0].emit({ type: 'response.output_item.added', item: { type: 'function_call', id, call_id: id, name: 'Read', arguments: '{}' } });
    }
    const snap = coordinator.snapshot('s1');
    expect(snap.activeRun?.runMarker).toBe(scripted.runs[0].context.runMarker);
    expect(snap.replay.map((e) => (e.payload as any).call_id)).toEqual(['b', 'c']);
    expect(snap.replayDropped).toBe(2);
  });
});

describe('审批与澄清注册表', () => {
  it('按 (会话, Agent) 排队：不同 Agent 同时待决，同一 Agent 先进先出', () => {
    const activated: string[] = [];
    const registry = new InteractionRegistry({ onActivated: (view) => activated.push(view.id) });
    const req = (approvalId: string, agentId: string) => ({ approvalId, agentId, title: 't', choices: ['once', 'deny'] as const, timeoutMs: 60_000 });
    void registry.requestApproval('room:g', 'run-1', req('a1', 'alice'));
    void registry.requestApproval('room:g', 'run-2', req('b1', 'bob'));
    void registry.requestApproval('room:g', 'run-1', req('a2', 'alice'));
    expect(activated).toEqual(['a1', 'b1']);
    expect(registry.respond('room:g', 'a2', { choice: 'once' })).toMatchObject({ handled: true, resolved: false, error: 'notActive' });
    expect(registry.respond('room:g', 'a1', { choice: 'once' })).toEqual({ handled: true, resolved: true });
    expect(activated).toEqual(['a1', 'b1', 'a2']);
    registry.shutdown();
  });

  it('超时即拒绝；重连时剩余时间按请求时刻重算；会话对不上不接受答复；认不出的选项按拒绝', async () => {
    vi.useFakeTimers();
    const registry = new InteractionRegistry({ now: () => Date.now() });
    const outcome = registry.requestApproval('s1', 'run-1', { approvalId: 'x', agentId: 'a', title: 't', choices: ['once', 'session', 'deny'], timeoutMs: 1000 });
    vi.advanceTimersByTime(400);
    expect(registry.pendingForSession('s1')[0].remainingTimeoutMs).toBe(600);
    expect(registry.respond('other-session', 'x', { choice: 'once' })).toMatchObject({ resolved: false, error: 'sessionMismatch' });
    vi.advanceTimersByTime(600);
    await expect(outcome).resolves.toEqual({ kind: 'approval', decision: 'deny', reason: 'timeout' });

    const second = registry.requestApproval('s1', 'run-1', { approvalId: 'y', agentId: 'a', title: 't', choices: ['once', 'deny'], timeoutMs: 1000 });
    registry.respond('s1', 'y', { choice: 'always' });
    await expect(second).resolves.toEqual({ kind: 'approval', decision: 'deny', reason: 'response' });

    const clarify = registry.requestClarify('s1', 'run-1', { clarifyId: 'q', agentId: 'a', question: '?', choices: null, timeoutMs: 120_000 });
    vi.advanceTimersByTime(120_000);
    await expect(clarify).resolves.toEqual({ kind: 'clarify', response: 'user did not respond within 2m', reason: 'timeout' });
  });

  it('协调器接线：适配器发审批请求 → 发 approval.requested → 人答复 → 适配器收到决定；运行中止时未答复的按拒绝', async () => {
    const { coordinator, scripted, submission, events } = setup();
    await coordinator.submit(submission(), 'reject');
    await flush();
    const run = scripted.runs[0];
    run.emit({ type: 'approval.requested', request: { approvalId: 'ap1', agentId: 'main', title: 'rm -rf', choices: ['once', 'deny'], timeoutMs: 60_000 } });
    run.emit({ type: 'approval.requested', request: { approvalId: 'ap2', agentId: 'main', title: 'push', choices: ['once', 'deny'], timeoutMs: 60_000 } });
    const requested = events.filter((e) => e.type === 'approval.requested');
    expect(requested.map((e) => (e.payload as any).id)).toEqual(['ap1']);
    expect((requested[0].payload as any).remaining_timeout_ms).toBe(60_000);
    expect(coordinator.snapshot('s1').pendingInteractions.map((p) => p.id)).toEqual(['ap1', 'ap2']);

    expect(coordinator.respondInteraction('s1', 'ap1', { choice: 'once' })).toEqual({ handled: true, resolved: true });
    await flush();
    expect(run.approvals).toEqual([{ id: 'ap1', decision: 'once' }]);

    await coordinator.abort('s1', 'user_stop');
    expect(events.filter((e) => e.type === 'approval.resolved').map((e) => [(e.payload as any).id, (e.payload as any).reason]))
      .toEqual([['ap1', 'response'], ['ap2', 'aborted']]);
    expect(coordinator.snapshot('s1').pendingInteractions).toEqual([]);
  });
});
