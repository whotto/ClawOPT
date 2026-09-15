/**
 * 实时 WebSocket 通道的协议规则：鉴权、主题授权、事件带 id 与 topic、主题无人时直发发起者、
 * 心跳、登录失效后断开、慢消费者断开、接回快照。
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import {
  REALTIME_CLOSE_SLOW_CONSUMER,
  REALTIME_CLOSE_UNAUTHORIZED,
  RealtimeHub,
  attachRealtimeWebSocketServer,
  type RealtimeServerOptions,
} from '../src/core/realtime';

type Harness = {
  hub: RealtimeHub;
  url: string;
  auth: { ok: boolean };
  close: () => Promise<void>;
  server: ReturnType<typeof attachRealtimeWebSocketServer>;
};

const open: Harness[] = [];

async function startServer(overrides: Partial<RealtimeServerOptions> = {}): Promise<Harness> {
  const hub = new RealtimeHub();
  const auth = { ok: true };
  const httpServer = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const ws = attachRealtimeWebSocketServer(httpServer, {
    hub,
    authenticate: () => auth.ok,
    isHostAllowed: () => true,
    authorizeTopic: (topic) => !topic.endsWith(':forbidden'),
    snapshotTopic: (topic) => ({ topic, sessions: [] }),
    respondInteraction: (sessionKey, id, response) => ({ sessionKey, id, response, handled: false }),
    ...overrides,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}/ws`;
  const harness: Harness = {
    hub, url, auth, server: ws,
    close: async () => {
      await ws.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

type Client = { socket: WebSocket; messages: any[]; next: (predicate: (m: any) => boolean, timeoutMs?: number) => Promise<any>; closed: Promise<{ code: number }> };

function connect(url: string, options: WebSocket.ClientOptions = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const messages: any[] = [];
    const waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void }> = [];
    const closed = new Promise<{ code: number }>((r) => socket.on('close', (code) => r({ code })));
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    const next = (predicate: (m: any) => boolean, timeoutMs = 3000) => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<any>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`timeout; got ${JSON.stringify(messages)}`)), timeoutMs);
        waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); res(m); } });
      });
    };
    socket.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    socket.on('error', (error) => reject(error));
    socket.on('open', () => resolve({ socket, messages, next, closed }));
  });
}

describe('实时 WebSocket 通道', () => {
  it('未登录的升级请求直接 401，不升级', async () => {
    const h = await startServer();
    h.auth.ok = false;
    await expect(connect(h.url)).rejects.toThrow('HTTP 401');
  });

  it('连上先发 hello；订阅后事件带 id 与 topic；未授权主题报错不订阅', async () => {
    const h = await startServer();
    const client = await connect(h.url);
    const hello = await client.next((m) => m.type === 'hello');
    expect(hello.connectionId).toMatch(/[0-9a-f-]{36}/);

    client.socket.send(JSON.stringify({ type: 'subscribe', topic: 'session:forbidden', requestId: 1 }));
    expect(await client.next((m) => m.requestId === 1)).toMatchObject({ type: 'error', code: 'realtime.topicForbidden' });
    client.socket.send(JSON.stringify({ type: 'subscribe', topic: 'not-a-topic', requestId: 2 }));
    expect(await client.next((m) => m.requestId === 2)).toMatchObject({ type: 'error', code: 'realtime.invalidTopic' });

    client.socket.send(JSON.stringify({ type: 'subscribe', topic: 'session:s1', resume: true, requestId: 3 }));
    const subscribed = await client.next((m) => m.requestId === 3);
    expect(subscribed).toMatchObject({ type: 'subscribed', topic: 'session:s1', snapshot: { topic: 'session:s1', sessions: [] } });

    h.hub.publish({ topic: 'session:forbidden', type: 'x', payload: 1 });
    h.hub.publish({ topic: 'session:s1', type: 'chat.frame', payload: { frame: { type: 'delta' } }, runId: 'r1' });
    const event = await client.next((m) => m.type === 'event');
    expect(event).toMatchObject({ topic: 'session:s1', event: 'chat.frame', runId: 'r1', payload: { frame: { type: 'delta' } } });
    expect(typeof event.id).toBe('number');
    expect(client.messages.filter((m) => m.type === 'event')).toHaveLength(1);
    client.socket.close();
  });

  it('主题没人订阅时，事件直发给发起这次运行的连接；有人订阅时按主题发', async () => {
    const h = await startServer();
    const origin = await connect(h.url);
    const { connectionId } = await origin.next((m) => m.type === 'hello');
    h.hub.publish({ topic: 'session:s2', type: 'chat.frame', payload: 'early', origin: connectionId });
    expect(await origin.next((m) => m.type === 'event')).toMatchObject({ payload: 'early' });

    const other = await connect(h.url);
    other.socket.send(JSON.stringify({ type: 'subscribe', topic: 'session:s2', requestId: 'a' }));
    await other.next((m) => m.requestId === 'a');
    h.hub.publish({ topic: 'session:s2', type: 'chat.frame', payload: 'late', origin: connectionId });
    expect(await other.next((m) => m.type === 'event')).toMatchObject({ payload: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(origin.messages.filter((m) => m.type === 'event').map((m) => m.payload)).toEqual(['early']);
  });

  it('心跳：不回 pong 的连接被断开；登录失效的连接以 4401 断开', async () => {
    const h = await startServer({ heartbeatMs: 40 });
    const deaf = await connect(h.url, { autoPong: false });
    const alive = await connect(h.url);
    await deaf.closed;
    expect(h.server.connectionCount()).toBe(1);

    h.auth.ok = false;
    expect((await alive.closed).code).toBe(REALTIME_CLOSE_UNAUTHORIZED);
  });

  it('背压：发送缓冲超过上限的慢消费者被断开（4008）', async () => {
    const h = await startServer({ maxBufferedBytes: 1 });
    const client = await connect(h.url);
    client.socket.send(JSON.stringify({ type: 'subscribe', topic: 'room:g1', requestId: 1 }));
    await client.next((m) => m.requestId === 1);
    const big = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 8; i += 1) h.hub.publish({ topic: 'room:g1', type: 'room.frame', payload: big });
    expect((await client.closed).code).toBe(REALTIME_CLOSE_SLOW_CONSUMER);
  });

  it('交互答复经通道转给协调器', async () => {
    const h = await startServer();
    const client = await connect(h.url);
    client.socket.send(JSON.stringify({ type: 'interaction.respond', sessionKey: 's1', id: 'ap1', choice: 'once', requestId: 9 }));
    expect(await client.next((m) => m.requestId === 9)).toMatchObject({ type: 'result', result: { sessionKey: 's1', id: 'ap1', response: { choice: 'once' } } });
  });
});
