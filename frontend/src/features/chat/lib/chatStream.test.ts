/**
 * 单聊流的两种来源给出同一串帧：WebSocket 形态下按消息 id 过滤、订阅确认前的帧不丢、
 * end 收尾、断线重连后「运行还在就补接回帧、不在就结束」。SSE 形态原样逐帧。
 */
import { describe, expect, it } from 'vitest';
import type { RealtimeClient, TopicListener } from '../../../api/ws';
import { openChatAttachStream, openChatTurnStream, readSseChatFrames } from './chatStream';

class FakeRealtime {
  listener: TopicListener | null = null;
  subscribedTopic = '';
  unsubscribed = false;
  ackSnapshot: any = { sessions: [{ activeRun: null, attach: [] }] };
  async ready() { return 'conn-1'; }
  subscribe(topic: string, listener: TopicListener) {
    this.subscribedTopic = topic;
    this.listener = listener;
    const snapshot = this.ackSnapshot;
    return {
      ready: Promise.resolve({ ok: true, snapshot }),
      unsubscribe: () => { this.unsubscribed = true; },
    };
  }
  frame(messageId: number, frame: Record<string, unknown>, end = false) {
    this.listener?.onEvent({ type: 'event', id: 1, topic: this.subscribedTopic, event: 'chat.frame', payload: { frame, end, messageId }, at: 0 });
  }
}

const collect = async (events: AsyncIterable<any>) => {
  const out: any[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('openChatTurnStream（WebSocket）', () => {
  it('先订阅后 POST；POST 回来之前到的帧也收着；只放行这条消息的帧；带 end 的帧收尾', async () => {
    const realtime = new FakeRealtime();
    let sentHeaders: Record<string, string> = {};
    const result = await openChatTurnStream({
      transport: 'ws',
      sessionId: 's1',
      client: () => realtime as unknown as RealtimeClient,
      post: async (headers) => {
        sentHeaders = headers;
        realtime.frame(99, { type: 'final', text: 'other message' }, true);
        realtime.frame(42, { type: 'delta', text: 'early' });
        return jsonResponse({ success: true, stream: 'ws', userMsgId: 41, assistantMsgId: 42 });
      },
    });
    expect(realtime.subscribedTopic).toBe('session:s1');
    expect(sentHeaders).toEqual({ 'X-ClawOPT-Stream': 'ws', 'X-ClawOPT-WS-Connection': 'conn-1' });
    if (result.ok !== true) throw new Error('expected ok');
    setTimeout(() => {
      realtime.frame(42, { type: 'final', text: 'done' }, true);
      realtime.frame(42, { type: 'final', text: 'after end' }, true);
    }, 0);
    expect(await collect(result.events)).toEqual([
      { type: 'ids', userMsgId: 41, assistantMsgId: 42 },
      { type: 'delta', text: 'early' },
      { type: 'final', text: 'done' },
    ]);
    expect(realtime.unsubscribed).toBe(true);
  });

  it('断线重连：快照里这条消息的运行还在 → 补接回帧继续；不在 → 结束（调用方回历史对账）', async () => {
    const realtime = new FakeRealtime();
    const result = await openChatTurnStream({
      transport: 'ws', sessionId: 's1', client: () => realtime as unknown as RealtimeClient,
      post: async () => jsonResponse({ userMsgId: 1, assistantMsgId: 2 }),
    });
    if (result.ok !== true) throw new Error('expected ok');
    setTimeout(() => {
      realtime.listener?.onSnapshot?.({ sessions: [{ activeRun: { meta: { messageId: 2 } }, attach: [{ type: 'chat.frame', payload: { frame: { type: 'final', text: 'resumed' } } }] }] }, { resubscribe: true });
      realtime.listener?.onSnapshot?.({ sessions: [{ activeRun: null, attach: [] }] }, { resubscribe: true });
    }, 0);
    expect(await collect(result.events)).toEqual([
      { type: 'ids', userMsgId: 1, assistantMsgId: 2 },
      { type: 'final', text: 'resumed' },
    ]);
  });

  it('实时通道连不上：超时后这一轮退回 SSE，不让发送按钮一直转圈', async () => {
    const stuck = { ready: () => new Promise<string>(() => {}), subscribe: () => { throw new Error('不该订阅'); } };
    let headers: Record<string, string> | null = null;
    const result = await openChatTurnStream({
      transport: 'ws', sessionId: 's1', readyTimeoutMs: 10,
      client: () => stuck as unknown as RealtimeClient,
      post: async (h) => { headers = h; return new Response('data: {"type":"final","text":"via sse"}\n\n'); },
    });
    expect(headers).toEqual({});
    if (result.ok !== true) throw new Error('expected ok');
    expect(await collect(result.events)).toEqual([{ type: 'final', text: 'via sse' }]);
  });

  it('HTTP 失败原样交还响应，不等帧', async () => {
    const realtime = new FakeRealtime();
    const result = await openChatTurnStream({
      transport: 'ws', sessionId: 's1', client: () => realtime as unknown as RealtimeClient,
      post: async () => new Response('{}', { status: 500 }),
    });
    expect(result.ok).toBe(false);
    expect(realtime.unsubscribed).toBe(true);
  });

  it('会话在忙、服务端把这一条排进队列：两种通道都回 queued，不当成失败、不等帧', async () => {
    const realtime = new FakeRealtime();
    const queuedBody = { success: true, queued: true, queueId: 'q-1', position: 2, clientTurnId: 'turn-abc123' };
    const overWs = await openChatTurnStream({
      transport: 'ws', sessionId: 's1', client: () => realtime as unknown as RealtimeClient,
      post: async () => jsonResponse(queuedBody),
    });
    expect(overWs).toEqual({ ok: 'queued', queued: { queueId: 'q-1', position: 2, clientTurnId: 'turn-abc123' } });
    expect(realtime.unsubscribed).toBe(true);
    const overSse = await openChatTurnStream({
      transport: 'sse', sessionId: 's1', client: () => realtime as unknown as RealtimeClient,
      post: async () => jsonResponse(queuedBody),
    });
    expect(overSse.ok).toBe('queued');
  });
});

describe('SSE 形态', () => {
  it('逐帧解析 data 行，跳过注释与坏行', async () => {
    const body = ':' + ' '.repeat(10) + '\n\ndata: {"type":"ids","userMsgId":1}\n\ndata: not json\n\ndata: {"type":"final","text":"x"}\n\n';
    const frames = await collect(readSseChatFrames(new Response(body)));
    expect(frames).toEqual([{ type: 'ids', userMsgId: 1 }, { type: 'final', text: 'x' }]);
  });

  it('openChatTurnStream 在 SSE 模式下不带额外请求头，也不碰实时通道', async () => {
    let headers: Record<string, string> | null = null;
    const result = await openChatTurnStream({
      transport: 'sse', sessionId: 's1',
      client: () => { throw new Error('SSE 模式不该用实时通道'); },
      post: async (h) => { headers = h; return new Response('data: {"type":"final"}\n\n'); },
    });
    expect(headers).toEqual({});
    if (result.ok !== true) throw new Error('expected ok');
    expect(await collect(result.events)).toEqual([{ type: 'final' }]);
  });
});

describe('openChatAttachStream（WebSocket）', () => {
  it('协调器里有运行：先给接回帧，再接着收；没有运行：退回原来的 HTTP 接回', async () => {
    const realtime = new FakeRealtime();
    realtime.ackSnapshot = { sessions: [{ activeRun: { meta: { messageId: 7 } }, attach: [
      { type: 'chat.frame', payload: { frame: { type: 'attached', messageId: 7 } } },
      { type: 'chat.frame', payload: { frame: { type: 'final', text: 'so far' } } },
    ] }] };
    const attached = await openChatAttachStream({
      transport: 'ws', sessionId: 's1', client: () => realtime as unknown as RealtimeClient,
      attachOverHttp: async () => { throw new Error('有运行时不该走 HTTP'); },
    });
    if (attached.kind !== 'events') throw new Error('expected events');
    setTimeout(() => realtime.frame(7, { type: 'final', text: 'so far and done' }, true), 0);
    expect(await collect(attached.events)).toEqual([
      { type: 'attached', messageId: 7 },
      { type: 'final', text: 'so far' },
      { type: 'final', text: 'so far and done' },
    ]);

    const idle = new FakeRealtime();
    const fallback = await openChatAttachStream({
      transport: 'ws', sessionId: 's2', client: () => idle as unknown as RealtimeClient,
      attachOverHttp: async () => jsonResponse({ active: false }),
    });
    expect(fallback).toEqual({ kind: 'inactive' });
    expect(idle.unsubscribed).toBe(true);
  });
});
