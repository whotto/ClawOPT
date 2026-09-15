/**
 * 同一条单聊运行走 WebSocket 通道（前端开关打开时的形态），以及群聊帧两条通道同源。
 *
 * - POST 带 `X-ClawOPT-Stream: ws` 时立刻回 JSON（消息 id），帧从 `session:<id>` 主题走，负载带 messageId；
 * - 帧内容与 SSE 通道逐帧相同（都来自协调器发进实时中枢的同一串 chat.frame）；
 * - 客户端中途断线：新连接带 resume 订阅，快照里有接回帧（attached + 当前文本）与重放缓冲，之后继续收到终帧；
 * - 群聊引擎的事件经中枢同时到达 SSE 客户端与 WebSocket 订阅者。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakeGatewayClient } from './helpers/fake-gateway';
import { pinFakeGateway, readSse, startAppHarness, waitUntil, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
beforeAll(async () => { h = await startAppHarness({ attachRealtime: true }); });
afterAll(async () => { await h.close(); });

type WsClient = {
  socket: WebSocket;
  connectionId: string;
  messages: any[];
  next: (predicate: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
  request: (message: Record<string, unknown>) => Promise<any>;
};

let requestSeq = 0;
async function connectWs(): Promise<WsClient> {
  const socket = new WebSocket(`${h.baseUrl.replace('http', 'ws')}/ws`);
  const messages: any[] = [];
  const waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void }> = [];
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
  const next = (predicate: (m: any) => boolean, timeoutMs = 5000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ws timeout; got ${JSON.stringify(messages).slice(0, 2000)}`)), timeoutMs);
      waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };
  await new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject); });
  const hello = await next((m) => m.type === 'hello');
  const request = (message: Record<string, unknown>) => {
    const requestId = ++requestSeq;
    socket.send(JSON.stringify({ ...message, requestId }));
    return next((m) => m.requestId === requestId);
  };
  return { socket, connectionId: hello.connectionId, messages, next, request };
}

let sessionSeq = 0;
function newSession() {
  const sessionId = `ws-s${++sessionSeq}`;
  const gw = new FakeGatewayClient();
  h.ctx.sessionManager.createSession({ id: sessionId, name: 'Tester', agentId: 'main' });
  pinFakeGateway(h.ctx, sessionId, gw);
  return { sessionId, gw };
}

const postWs = (path: string, body: unknown, connectionId: string) => fetch(`${h.baseUrl}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-clawopt-stream': 'ws', 'x-clawopt-ws-connection': connectionId },
  body: JSON.stringify(body),
});

const chatFrames = (client: WsClient, messageId: number) => client.messages
  .filter((m) => m.type === 'event' && m.event === 'chat.frame' && m.payload.messageId === messageId)
  .map((m) => m.payload.frame);

describe('单聊运行走 WebSocket', () => {
  it('POST 立刻回 JSON，帧按消息 id 从主题走；终帧与 SSE 通道同形；库与历史接口一致', async () => {
    const { sessionId, gw } = newSession();
    const client = await connectWs();
    expect(await client.request({ type: 'subscribe', topic: `session:${sessionId}`, resume: true })).toMatchObject({ type: 'subscribed' });

    const response = await postWs('/api/chat', { sessionId, message: 'hello over ws' }, client.connectionId);
    expect(response.headers.get('content-type')).toContain('application/json');
    const ids = await response.json() as any;
    expect(ids).toMatchObject({ success: true, stream: 'ws' });

    await waitUntil(() => gw.sent.length === 1);
    gw.delta('Hello');
    gw.final('Hello over ws');
    await client.next((m) => m.type === 'event' && m.event === 'run.completed' && m.topic === `session:${sessionId}`);

    expect(chatFrames(client, ids.assistantMsgId)).toEqual([
      { type: 'delta', text: 'Hello', process_content: '', process_streaming: false },
      { type: 'final', text: 'Hello over ws', process_content: '', process_streaming: false },
      { type: 'final', text: 'Hello over ws', process_content: '', process_streaming: false },
    ]);
    const events = client.messages.filter((m) => m.type === 'event');
    expect(events.every((m) => typeof m.id === 'number' && m.topic === `session:${sessionId}`)).toBe(true);
    expect(events.find((m) => m.event === 'chat.frame' && m.payload.end === true)?.payload.frame.type).toBe('final');

    const history = await (await fetch(`${h.baseUrl}/api/history/${sessionId}`)).json() as any;
    expect(history.messages.map((m: any) => [m.id, m.role, m.content])).toEqual([
      [ids.userMsgId, 'user', 'hello over ws'],
      [ids.assistantMsgId, 'assistant', 'Hello over ws'],
    ]);
    client.socket.close();
  }, 20000);

  it('还没订阅主题就发起：帧直发给发起连接，不丢', async () => {
    const { sessionId, gw } = newSession();
    const client = await connectWs();
    const ids = await (await postWs('/api/chat', { sessionId, message: 'no subscription yet' }, client.connectionId)).json() as any;
    await waitUntil(() => gw.sent.length === 1);
    gw.final('delivered anyway');
    await client.next((m) => m.type === 'event' && m.event === 'chat.frame' && m.payload.end === true);
    expect(chatFrames(client, ids.assistantMsgId).at(-1)).toEqual({ type: 'final', text: 'delivered anyway', process_content: '', process_streaming: false });
    client.socket.close();
  }, 20000);

  it('断线重连：新连接带 resume 订阅，快照给出接回帧与重放缓冲，之后继续收到终帧', async () => {
    const { sessionId, gw } = newSession();
    const first = await connectWs();
    await first.request({ type: 'subscribe', topic: `session:${sessionId}` });
    const ids = await (await postWs('/api/chat', { sessionId, message: 'long answer' }, first.connectionId)).json() as any;
    await waitUntil(() => gw.sent.length === 1);
    gw.delta('part one');
    await first.next((m) => m.type === 'event' && m.event === 'chat.frame' && m.payload.frame.type === 'delta');
    first.socket.terminate();

    gw.delta('part one, part two');
    const second = await connectWs();
    const subscribed = await second.request({ type: 'subscribe', topic: `session:${sessionId}`, resume: true });
    const [snapshot] = subscribed.snapshot.sessions;
    expect(snapshot.activeRun).toMatchObject({ runtime: 'openclaw', phase: 'running', meta: { messageId: ids.assistantMsgId } });
    expect(snapshot.attach.map((e: any) => e.payload.frame)).toEqual([
      { type: 'attached', messageId: ids.assistantMsgId, agentId: 'main', agentName: 'Tester', modelUsed: 'fake/model-1' },
      { type: 'final', text: 'part one, part two', process_content: '', process_streaming: false },
    ]);
    // 重放缓冲里 chat.frame 只留最新一条（快照语义），run.started 也在。
    expect(snapshot.replay.filter((e: any) => e.type === 'chat.frame').map((e: any) => e.payload.frame.text)).toEqual(['part one, part two']);
    expect(snapshot.replay.some((e: any) => e.type === 'run.started')).toBe(true);

    gw.final('part one, part two, done');
    const terminal = await second.next((m) => m.type === 'event' && m.event === 'chat.frame' && m.payload.end === true);
    expect(terminal.payload.frame).toEqual({ type: 'final', text: 'part one, part two, done', process_content: '', process_streaming: false });
    second.socket.close();
  }, 20000);

  it('未授权的主题订阅不到（不存在的会话）', async () => {
    const client = await connectWs();
    expect(await client.request({ type: 'subscribe', topic: 'session:does-not-exist' })).toMatchObject({ type: 'error', code: 'realtime.topicForbidden' });
    client.socket.close();
  });
});

describe('群聊帧两条通道同源', () => {
  it('引擎事件经实时中枢同时到达群聊 SSE 客户端与 WebSocket 订阅者，帧形状相同', async () => {
    const groupId = 'ws-room-1';
    h.ctx.db.saveGroupChat({ id: groupId, name: 'Room', description: '', system_prompt: '', max_chain_depth: 6, position: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const client = await connectWs();
    await client.request({ type: 'subscribe', topic: `room:${groupId}` });
    const controller = new AbortController();
    const sse = readSse(await fetch(`${h.baseUrl}/api/groups/${groupId}/events`, { signal: controller.signal }));
    await sse.waitFor((f) => f.type === 'connected');
    await waitUntil(() => (h.ctx.rooms.groupSSEClients.get(groupId)?.size ?? 0) === 1);

    const info = { groupId, id: 7, sender_type: 'agent', sender_id: 'ext:claude-code:eng', sender_name: 'Eng', content: 'streaming', process_content: '', process_streaming: true };
    h.ctx.rooms.groupChatEngine.emit('delta', info);
    const sseFrame = await sse.waitFor((f) => f.type === 'delta');
    const wsEvent = await client.next((m) => m.type === 'event' && m.event === 'room.frame');
    expect(wsEvent.payload).toEqual(sseFrame);
    expect(sseFrame).toMatchObject({ type: 'delta', id: 7, content: 'streaming', sender_id: 'ext:claude-code:eng' });
    controller.abort();
    client.socket.close();
  }, 20000);
});
