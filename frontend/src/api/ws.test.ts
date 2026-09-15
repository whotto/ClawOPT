/**
 * 实时通道客户端：抖动退避重连、重连后带 resume 重新订阅、旧 socket 的回调丢弃。
 * 用假 socket 与手动时钟，不连真服务。
 */
import { describe, expect, it } from 'vitest';
import { RECONNECT_MAX_MS, RealtimeClient, reconnectDelayMs, type WebSocketLike } from './ws';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: any[] = [];
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: { data: any }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  // ---- 服务端视角 ----
  accept(connectionId: string) { this.readyState = 1; this.onopen?.({}); this.deliver({ type: 'hello', connectionId, heartbeatMs: 25000 }); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const client = new RealtimeClient({
    url: () => 'ws://test/ws',
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    random: () => 0.5,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: (handle) => { const index = timers.indexOf(handle as any); if (index >= 0) timers.splice(index, 1); },
  });
  const runTimers = () => { for (const timer of timers.splice(0)) timer.fn(); };
  return { client, sockets, timers, runTimers };
}

describe('重连退避', () => {
  it('上限从 1 秒翻倍到 30 秒封顶，取值落在 [上限/2, 上限]', () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(500);
    expect(reconnectDelayMs(0, () => 1)).toBe(1000);
    expect(reconnectDelayMs(3, () => 1)).toBe(8000);
    expect(reconnectDelayMs(10, () => 1)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelayMs(10, () => 0)).toBe(RECONNECT_MAX_MS / 2);
  });
});

describe('RealtimeClient', () => {
  it('连上后订阅带 resume；断线按退避重连，重连后自动重新订阅并把快照交给订阅方', async () => {
    const { client, sockets, timers, runTimers } = harness();
    const snapshots: Array<{ snapshot: any; resubscribe: boolean }> = [];
    const events: any[] = [];
    const subscription = client.subscribe('session:s1', {
      onEvent: (event) => events.push(event),
      onSnapshot: (snapshot, info) => snapshots.push({ snapshot, resubscribe: info.resubscribe }),
    });
    sockets[0].accept('c1');
    const firstSubscribe = sockets[0].sent.find((m) => m.type === 'subscribe');
    expect(firstSubscribe).toMatchObject({ topic: 'session:s1', resume: true });
    sockets[0].deliver({ type: 'subscribed', topic: 'session:s1', requestId: firstSubscribe.requestId, snapshot: { n: 1 } });
    expect(await subscription.ready).toMatchObject({ ok: true, snapshot: { n: 1 } });
    sockets[0].deliver({ type: 'event', id: 1, topic: 'session:s1', event: 'chat.frame', payload: {}, at: 0 });
    expect(events).toHaveLength(1);

    sockets[0].drop();
    expect(timers.map((t) => t.ms)).toEqual([750]);
    runTimers();
    expect(sockets).toHaveLength(2);
    sockets[1].accept('c2');
    const resubscribe = sockets[1].sent.find((m) => m.type === 'subscribe');
    expect(resubscribe).toMatchObject({ topic: 'session:s1', resume: true });
    sockets[1].deliver({ type: 'subscribed', topic: 'session:s1', requestId: resubscribe.requestId, snapshot: { n: 2 } });
    expect(snapshots).toEqual([{ snapshot: { n: 1 }, resubscribe: false }, { snapshot: { n: 2 }, resubscribe: true }]);
    expect(await client.ready()).toBe('c2');
  });

  it('连续失败时退避逐次变长，成功连上后归零', () => {
    const { client, sockets, timers, runTimers } = harness();
    void client.ready();
    sockets[0].drop();
    expect(timers[0].ms).toBe(750);
    runTimers();
    sockets[1].drop();
    expect(timers[0].ms).toBe(1500);
    runTimers();
    sockets[2].accept('ok');
    sockets[2].drop();
    expect(timers[0].ms).toBe(750);
  });

  it('被替换掉的旧 socket 晚到的消息一律丢弃', () => {
    const { client, sockets, runTimers } = harness();
    const events: any[] = [];
    client.subscribe('room:g1', { onEvent: (event) => events.push(event) });
    sockets[0].accept('old');
    const stale = sockets[0];
    stale.drop();
    runTimers();
    sockets[1].accept('new');
    stale.deliver({ type: 'event', id: 9, topic: 'room:g1', event: 'room.frame', payload: 'stale', at: 0 });
    sockets[1].deliver({ type: 'event', id: 10, topic: 'room:g1', event: 'room.frame', payload: 'fresh', at: 0 });
    expect(events.map((event) => event.payload)).toEqual(['fresh']);
  });

  it('主动关闭后不再重连；取消最后一个监听时通知服务端退订', () => {
    const { client, sockets, timers } = harness();
    const subscription = client.subscribe('agent:main', { onEvent: () => {} });
    sockets[0].accept('c');
    subscription.unsubscribe();
    expect(sockets[0].sent[sockets[0].sent.length - 1]).toEqual({ type: 'unsubscribe', topic: 'agent:main' });
    client.close();
    expect(timers).toEqual([]);
  });
});
