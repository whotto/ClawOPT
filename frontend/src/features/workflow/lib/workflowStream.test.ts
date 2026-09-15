/**
 * 工作流状态流与待办中心的通道选择：WS 主题为主，订阅被拒 / 超时退回 SSE（状态流）或轮询（待办）。
 */
import { describe, expect, it } from 'vitest';
import type { TopicListener } from '../../../api/ws';
import { subscribeWorkflowStream, watchPendingApprovals } from './workflowStream';

function fakeRealtime(result: { ok: boolean; snapshot?: any } | 'never') {
  const state = { topic: '', listener: null as TopicListener | null, unsubscribed: 0 };
  return {
    state,
    subscribe(topic: string, listener: TopicListener) {
      state.topic = topic;
      state.listener = listener;
      const ready = result === 'never' ? new Promise<any>(() => {}) : Promise.resolve(result);
      if (result !== 'never' && result.ok) queueMicrotask(() => listener.onSnapshot?.(result.snapshot, { resubscribe: false }));
      return { ready, unsubscribe: () => { state.unsubscribed += 1; } };
    },
  };
}

function manualTimers() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (handle: unknown) => { if (handle) (handle as { cleared: boolean }).cleared = true; },
    fire: () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn(); },
  };
}

function fakeSse() {
  const opened: Array<{ workflowId: string; since?: unknown; listeners: Record<string, (event: any) => void>; closed: boolean }> = [];
  return {
    opened,
    open: (workflowId: string, since?: unknown) => {
      const source = { workflowId, since, listeners: {} as Record<string, (event: any) => void>, closed: false };
      opened.push(source);
      return {
        addEventListener: (type: string, fn: (event: any) => void) => { source.listeners[type] = fn; },
        close: () => { source.closed = true; },
      } as any;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const status = (runId: string) => ({ workflowId: 'wf', runId, status: 'running' }) as any;
const evidence = { nodeExecutions: [{ id: 'e1' }], edgeEvaluations: [], loopEpochs: [] } as any;

describe('subscribeWorkflowStream', () => {
  it('WS：订阅 workflow:<id>，快照与增量都走同一组回调，不开 SSE', async () => {
    const realtime = fakeRealtime({ ok: true, snapshot: { workflow: { status: status('r1'), runId: 'r1', evidence } } });
    const sse = fakeSse();
    const timers = manualTimers();
    const seen: string[] = [];
    const stop = subscribeWorkflowStream('wf', {
      onStatus: (s) => seen.push(`status:${s.runId}`),
      onEvidence: (runId, e) => seen.push(`evidence:${runId}:${e.nodeExecutions.length}`),
      onTransport: (transport) => seen.push(`transport:${transport}`),
    }, { realtime, openSse: sse.open, ...timers });
    await flush();
    realtime.state.listener!.onEvent({ type: 'event', id: 1, topic: 'workflow:wf', event: 'workflow.status', payload: { status: status('r2') }, at: 0 });
    realtime.state.listener!.onEvent({ type: 'event', id: 2, topic: 'workflow:wf', event: 'workflow.evidence', payload: { runId: 'r2', evidence }, at: 0 });
    timers.fire();
    expect(realtime.state.topic).toBe('workflow:wf');
    expect(seen).toEqual(['status:r1', 'evidence:r1:1', 'transport:ws', 'status:r2', 'evidence:r2:1']);
    expect(sse.opened).toHaveLength(0);
    stop();
    expect(realtime.state.unsubscribed).toBe(1);
  });

  it('WS 订阅被拒：立刻退回 SSE，带续传序号；之后 WS 上的事件不再处理', async () => {
    const realtime = fakeRealtime({ ok: false });
    const sse = fakeSse();
    const seen: string[] = [];
    const stop = subscribeWorkflowStream('wf', { onStatus: (s) => seen.push(`status:${s.runId}`), onEvidence: () => {}, onTransport: (t) => seen.push(t) }, {
      realtime, openSse: sse.open, since: () => ({ runId: 'r1', seq: 7 }), ...manualTimers(),
    });
    await flush();
    expect(sse.opened).toMatchObject([{ workflowId: 'wf', since: { runId: 'r1', seq: 7 } }]);
    sse.opened[0].listeners.status({ data: JSON.stringify({ type: 'status', status: status('r1') }) });
    realtime.state.listener!.onEvent({ type: 'event', id: 1, topic: 'workflow:wf', event: 'workflow.status', payload: { status: status('ws') }, at: 0 });
    expect(seen).toEqual(['sse', 'status:r1']);
    stop();
    expect(sse.opened[0].closed).toBe(true);
  });

  it('WS 5 秒没确认：退回 SSE', async () => {
    const realtime = fakeRealtime('never');
    const sse = fakeSse();
    const timers = manualTimers();
    subscribeWorkflowStream('wf', { onStatus: () => {}, onEvidence: () => {} }, { realtime, openSse: sse.open, ...timers });
    expect(timers.timers[0].ms).toBe(5000);
    timers.fire();
    expect(sse.opened).toHaveLength(1);
    expect(realtime.state.unsubscribed).toBe(1);
  });
});

describe('watchPendingApprovals', () => {
  it('WS：订阅成功拉一次，每条提醒再拉一次，不轮询', async () => {
    const realtime = fakeRealtime({ ok: true, snapshot: {} });
    const timers = manualTimers();
    let calls = 0;
    const transports: string[] = [];
    const stop = watchPendingApprovals(() => { calls += 1; }, { realtime, ...timers, onTransport: (t) => transports.push(t) });
    await flush();
    expect(realtime.state.topic).toBe('approvals:workflows');
    expect(calls).toBe(1);
    realtime.state.listener!.onEvent({ type: 'event', id: 1, topic: 'approvals:workflows', event: 'workflow.approvals.changed', payload: {}, at: 0 });
    expect(calls).toBe(2);
    timers.fire();
    expect(calls).toBe(2);
    expect(transports).toEqual(['ws']);
    stop();
  });

  it('订阅不到：退回轮询', async () => {
    const realtime = fakeRealtime({ ok: false });
    const timers = manualTimers();
    let calls = 0;
    const stop = watchPendingApprovals(() => { calls += 1; }, { realtime, ...timers, pollMs: 5000 });
    await flush();
    expect(calls).toBe(1);
    timers.fire();
    expect(calls).toBe(2);
    stop();
  });
});
