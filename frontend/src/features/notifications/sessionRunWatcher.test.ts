import { describe, expect, it } from 'vitest';
import type { RealtimeEventMessage, TopicListener } from '../../api/ws';
import { watchSessionRuns } from './sessionRunWatcher';

function fakeRealtime(options: { reject?: string[]; never?: boolean } = {}) {
  const listeners = new Map<string, TopicListener>();
  const unsubscribed: string[] = [];
  return {
    listeners,
    unsubscribed,
    subscribe(topic: string, listener: TopicListener) {
      listeners.set(topic, listener);
      const ready = options.never ? new Promise<{ ok: boolean }>(() => {}) : Promise.resolve({ ok: !options.reject?.includes(topic) });
      return { ready, unsubscribe: () => { unsubscribed.push(topic); listeners.delete(topic); } };
    },
  };
}

const event = (topic: string, type: string, runId: string, payload: any = {}): RealtimeEventMessage => ({ type: 'event', id: 1, topic, event: type, payload, runId, at: 0 });

function manualTimers() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
  };
}

describe('会话运行观察', () => {
  it('订阅 agent:<id>，按 Agent 映射回会话；只转交生命周期事件', async () => {
    const realtime = fakeRealtime();
    const seen: string[] = [];
    const timers = manualTimers();
    watchSessionRuns([{ sessionId: 's1', agentId: 'main' }, { sessionId: 's2', agentId: 'ext-cc' }], {
      onStarted: (sessionId, runId) => seen.push(`start ${sessionId} ${runId}`),
      onTerminal: (sessionId, type, _payload, runId) => seen.push(`${type} ${sessionId} ${runId}`),
      onActivity: () => seen.push('activity'),
    }, { realtime, ...timers });
    expect([...realtime.listeners.keys()]).toEqual(['agent:main', 'agent:ext-cc']);
    realtime.listeners.get('agent:main')!.onEvent(event('agent:main', 'run.started', 'r1'));
    realtime.listeners.get('agent:main')!.onEvent(event('agent:main', 'message.delta', 'r1'));
    realtime.listeners.get('agent:ext-cc')!.onEvent(event('agent:ext-cc', 'run.completed', 'r2'));
    // 快照回调不是事件：重放不交给提醒
    realtime.listeners.get('agent:main')!.onSnapshot?.({ sessions: [{ replay: [event('agent:main', 'run.completed', 'r0')] }] }, { resubscribe: true });
    expect(seen).toEqual(['start s1 r1', 'run.completed s2 r2']);
  });

  it('有主题被拒：整体退回轮询，退订全部主题', async () => {
    const realtime = fakeRealtime({ reject: ['agent:other'] });
    const timers = manualTimers();
    const transports: string[] = [];
    let fetched = 0;
    watchSessionRuns([{ sessionId: 's1', agentId: 'main' }, { sessionId: 's2', agentId: 'other' }], {
      onStarted: () => {}, onTerminal: () => {}, onActivity: () => {}, onTransport: (t) => transports.push(t),
    }, { realtime, ...timers, fetchActivity: async () => { fetched += 1; return []; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transports).toEqual(['poll']);
    expect(realtime.unsubscribed.sort()).toEqual(['agent:main', 'agent:other']);
    expect(fetched).toBe(1);
  });

  it('5 秒没确认也退回轮询；会话超过主题上限直接轮询', async () => {
    const realtime = fakeRealtime({ never: true });
    const timers = manualTimers();
    const transports: string[] = [];
    watchSessionRuns([{ sessionId: 's1', agentId: 'main' }], {
      onStarted: () => {}, onTerminal: () => {}, onActivity: () => {}, onTransport: (t) => transports.push(t),
    }, { realtime, ...timers, fetchActivity: async () => [] });
    timers.timers[0].fn();
    expect(transports).toEqual(['poll']);

    const many = Array.from({ length: 4 }, (_, i) => ({ sessionId: `s${i}`, agentId: `a${i}` }));
    const second = fakeRealtime();
    const transports2: string[] = [];
    watchSessionRuns(many, { onStarted: () => {}, onTerminal: () => {}, onActivity: () => {}, onTransport: (t) => transports2.push(t) }, { realtime: second, ...manualTimers(), maxTopics: 3, fetchActivity: async () => [] });
    expect(second.listeners.size).toBe(0);
    expect(transports2).toEqual(['poll']);
  });
});
