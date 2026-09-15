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
  /** 心跳复查与升级时解析出的身份；`ok=false` 等同令牌失效。`grants` 是这个用户能看的主题。 */
  auth: { ok: boolean; user: string; grants: Set<string> | null };
  close: () => Promise<void>;
  server: ReturnType<typeof attachRealtimeWebSocketServer>;
};

const open: Harness[] = [];

type TestIdentity = { user: string; grants: Set<string> | null };

async function startServer(overrides: Partial<RealtimeServerOptions<TestIdentity>> = {}): Promise<Harness> {
  const hub = new RealtimeHub();
  const auth: Harness['auth'] = { ok: true, user: 'owner', grants: null };
  const httpServer = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const ws = attachRealtimeWebSocketServer<TestIdentity>(httpServer, {
    hub,
    // 每次调用都按当前状态重新解析（心跳复查走同一个函数），模拟用户被停用 / 授权被收回。
    authenticate: () => (auth.ok ? { user: auth.user, grants: auth.grants ? new Set(auth.grants) : null } : null),
    isHostAllowed: () => true,
    authorizeTopic: (topic, identity) => !topic.endsWith(':forbidden') && (identity.grants === null || identity.grants.has(topic)),
    snapshotTopic: (topic) => ({ topic, sessions: [] }),
    respondInteraction: (sessionKey, id, response, identity) => ({ sessionKey, id, response, user: identity.user, handled: false }),
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
    expect(await client.next((m) => m.requestId === 9)).toMatchObject({ type: 'result', result: { sessionKey: 's1', id: 'ap1', response: { choice: 'once' }, user: 'owner' } });
  });

  it('按身份授权：订阅判的是这个连接的用户；直发发起者也按发起者的身份判', async () => {
    const h = await startServer();
    h.auth.user = 'member';
    h.auth.grants = new Set(['session:mine']);
    const member = await connect(h.url);
    const { connectionId } = await member.next((m) => m.type === 'hello');
    member.socket.send(JSON.stringify({ type: 'subscribe', topic: 'session:others', requestId: 1 }));
    expect(await member.next((m) => m.requestId === 1)).toMatchObject({ type: 'error', code: 'realtime.topicForbidden', topic: 'session:others' });
    member.socket.send(JSON.stringify({ type: 'subscribe', topic: 'session:mine', requestId: 2 }));
    expect(await member.next((m) => m.requestId === 2)).toMatchObject({ type: 'subscribed' });

    // 发起者兜底直发：发起者看不见的主题不直发。
    h.hub.publish({ topic: 'session:others', type: 'chat.frame', payload: 'leak', origin: connectionId });
    h.hub.publish({ topic: 'session:mine', type: 'chat.frame', payload: 'ok', origin: connectionId });
    expect(await member.next((m) => m.type === 'event')).toMatchObject({ payload: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(member.messages.filter((m) => m.type === 'event').map((m) => m.payload)).toEqual(['ok']);
  });

  it('心跳复查：授权被收回的主题退订并回 topicRevoked，之后收不到事件；用户被停用则 4401', async () => {
    const h = await startServer({ heartbeatMs: 40 });
    h.auth.grants = new Set(['session:a', 'session:b']);
    const client = await connect(h.url);
    client.socket.send(JSON.stringify({ type: 'subscribe', topic: 'session:a', requestId: 1 }));
    client.socket.send(JSON.stringify({ type: 'subscribe', topic: 'session:b', requestId: 2 }));
    await client.next((m) => m.requestId === 2);

    h.auth.grants = new Set(['session:b']);
    expect(await client.next((m) => m.code === 'realtime.topicRevoked')).toMatchObject({ topic: 'session:a' });
    expect(h.server.subscriberCount('session:a')).toBe(0);
    h.hub.publish({ topic: 'session:a', type: 'x', payload: 'revoked' });
    h.hub.publish({ topic: 'session:b', type: 'x', payload: 'still' });
    expect(await client.next((m) => m.type === 'event')).toMatchObject({ payload: 'still' });
    expect(client.messages.filter((m) => m.type === 'event').map((m) => m.payload)).toEqual(['still']);

    h.auth.ok = false;
    expect((await client.closed).code).toBe(REALTIME_CLOSE_UNAUTHORIZED);
  });
});
