/**
 * 终端 WebSocket 客户端：URL 不带凭据、首条消息是票据、断线后重取票据并按偏移接回、重复输出去重、没权限不再重连。
 */
import { describe, expect, it } from 'vitest';
import type { WebSocketLike } from './ws';
import { TerminalSocketClient } from './terminal';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: any[] = [];
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: { data: any }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  accept() { this.readyState = 1; this.onopen?.({}); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

const last = <T,>(list: T[]): T | undefined => list[list.length - 1];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(tickets: Array<string | null>) {
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  const written: string[] = [];
  const replays: Array<{ data: string; reset: boolean }> = [];
  const states: string[] = [];
  const client = new TerminalSocketClient({
    onState: (state) => states.push(state),
    onReplay: (_id, data, info) => replays.push({ data, reset: info.reset }),
    onOutput: (_id, data) => written.push(data),
  }, {
    url: () => 'ws://host/ws/terminal',
    createSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    fetchTicket: async () => tickets.shift() ?? null,
    random: () => 0.5,
    setTimer: (fn) => { timers.push(fn); return fn; },
    clearTimer: () => undefined,
  });
  return { client, sockets, timers, written, replays, states };
}

describe('终端客户端', () => {
  it('URL 不带票据；连上后第一条消息是 auth', async () => {
    const h = harness(['t1']);
    h.client.connect();
    await flush();
    expect(h.sockets[0].url).toBe('ws://host/ws/terminal');
    h.sockets[0].accept();
    expect(h.sockets[0].sent[0]).toEqual({ type: 'auth', ticket: 't1' });
  });

  it('断线：重取新票据重连，对开着的会话按已写到的偏移接回；重复的输出不写两遍', async () => {
    const h = harness(['t1', 't2']);
    h.client.connect();
    await flush();
    const first = h.sockets[0];
    first.accept();
    first.deliver({ type: 'ready', sessions: [], shells: [] });
    h.client.create('sh', 80, 24);
    first.deliver({ type: 'created', session: { id: 's1' } });
    first.deliver({ type: 'attached', session: { id: 's1' }, start: 0, end: 0, truncated: false, data: '' });
    first.deliver({ type: 'output', sessionId: 's1', end: 5, data: 'hello' });
    first.drop();
    expect(h.timers).toHaveLength(1);
    h.timers.shift()!();
    await flush();
    const second = h.sockets[1];
    second.accept();
    expect(second.sent[0]).toEqual({ type: 'auth', ticket: 't2' });
    second.deliver({ type: 'ready', sessions: [{ id: 's1' }], shells: [] });
    expect(second.sent[1]).toMatchObject({ type: 'attach', sessionId: 's1', sinceOffset: 5 });
    second.deliver({ type: 'attached', session: { id: 's1' }, start: 5, end: 8, truncated: false, data: ' ok' });
    expect(last(h.replays)).toEqual({ data: ' ok', reset: false });
    // 重复到达的旧输出（end 不超过已写到的 8）丢掉。
    second.deliver({ type: 'output', sessionId: 's1', end: 8, data: ' ok' });
    second.deliver({ type: 'output', sessionId: 's1', end: 10, data: '!!' });
    expect(h.written).toEqual(['hello', '!!']);
  });

  it('缓冲已被挤掉（truncated）：重放前清屏', async () => {
    const h = harness(['t1']);
    h.client.connect();
    await flush();
    h.sockets[0].accept();
    h.sockets[0].deliver({ type: 'ready', sessions: [{ id: 's1' }], shells: [] });
    h.client.attach('s1');
    h.sockets[0].deliver({ type: 'attached', session: { id: 's1' }, start: 0, end: 4, truncated: false, data: 'abcd' });
    expect(last(h.replays)?.reset).toBe(true);
    h.client.attach('s1');
    h.sockets[0].deliver({ type: 'attached', session: { id: 's1' }, start: 100, end: 120, truncated: true, data: 'x' });
    expect(last(h.replays)?.reset).toBe(true);
  });

  it('取不到票据（没权限）：不连、不重连', async () => {
    const h = harness([null]);
    h.client.connect();
    await flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
    expect(last(h.states)).toBe('unauthorized');
  });
});
