/**
 * P1b 单聊服务端队列走真实路由（假网关）：
 * - 会话正忙时 `queue: true` 的发送不打断当前轮，回 `{queued}`；行在出队时才落（顺序正确），用户消息回声带 clientTurnId；
 * - 状态快照带活跃运行（消息 id、开始时间）与队列；会话实时通道（SSE）先给 state 再转控制事件、不转正文帧；
 * - 取消排队项；「立即插入」立即打断当前轮（网关不支持边界打断），被打断的一轮终态 stop_reason = queue_insertion；
 * - 没带 queue 的旧客户端保持「新消息替换当前轮」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGatewayClient } from './helpers/fake-gateway';
import { pinFakeGateway, readSse, startAppHarness, waitUntil, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
beforeAll(async () => { h = await startAppHarness(); });
afterAll(async () => { await h.close(); });

let seq = 0;
function newSession() {
  const sessionId = `q-s${++seq}`;
  const gw = new FakeGatewayClient();
  h.ctx.sessionManager.createSession({ id: sessionId, name: 'Tester', agentId: 'main' });
  pinFakeGateway(h.ctx, sessionId, gw);
  return { sessionId, gw };
}

const post = (path: string, body: unknown) => fetch(`${h.baseUrl}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

type LiveFrame = Record<string, any>;
function openLive(sessionId: string) {
  const controller = new AbortController();
  const frames: LiveFrame[] = [];
  const ready = fetch(`${h.baseUrl}/api/chat/${sessionId}/events`, { signal: controller.signal }).then(async (response) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
        }
      } catch {}
    })();
  });
  return { frames, ready, close: () => controller.abort() };
}

describe('单聊服务端队列（真实路由）', () => {
  it('忙时排队：不打断当前轮；出队才落行、顺序正确；回声带 clientTurnId；实时通道只转控制事件', async () => {
    const { sessionId, gw } = newSession();
    const live = openLive(sessionId);
    await live.ready;
    await waitUntil(() => live.frames.some((f) => f.type === 'state'));

    const first = await post('/api/chat', { sessionId, message: 'first question', queue: true, clientTurnId: 'turn-first-1' });
    const firstStream = readSse(first);
    await waitUntil(() => gw.sent.length === 1);
    gw.delta('working on it');
    const abortsBeforeQueue = gw.aborts.length;

    const queued = await (await post('/api/chat', { sessionId, message: 'second question', queue: true, clientTurnId: 'turn-second-2' })).json() as any;
    expect(queued).toMatchObject({ success: true, queued: true, position: 1, clientTurnId: 'turn-second-2' });
    // 排队的消息还没进时间线
    expect(h.ctx.db.getMessages(sessionId).map((row: any) => row.content)).toHaveLength(2);

    const state = await (await fetch(`${h.baseUrl}/api/chat/${sessionId}/state`)).json() as any;
    expect(state.activeRun).toMatchObject({ kind: 'openclaw-run' });
    expect(typeof state.activeRun.messageId).toBe('number');
    expect(typeof state.activeRun.startedAt).toBe('number');
    expect(state.queue).toEqual([expect.objectContaining({ queueId: queued.queueId, display: 'second question', ref: 'turn-second-2' })]);
    expect(gw.aborts).toHaveLength(abortsBeforeQueue);

    gw.final('first answer');
    await firstStream.end();
    await waitUntil(() => gw.sent.length === 2);
    gw.final('second answer');
    await waitUntil(() => live.frames.filter((f) => f.event === 'run.completed').length === 2);

    const rows = h.ctx.db.getMessages(sessionId).map((row: any) => [row.role, row.content]);
    expect(rows).toEqual([
      ['user', 'first question'],
      ['assistant', 'first answer'],
      ['user', 'second question'],
      ['assistant', 'second answer'],
    ]);
    const echoes = live.frames.filter((f) => f.event === 'chat.user_message').map((f) => f.payload);
    expect(echoes.map((e) => [e.client_turn_id, e.content, e.queued])).toEqual([
      ['turn-first-1', 'first question', false],
      ['turn-second-2', 'second question', true],
    ]);
    const types = new Set(live.frames.filter((f) => f.type === 'event').map((f) => f.event));
    expect(types.has('chat.frame')).toBe(false);
    expect(types.has('run.queued')).toBe(true);
    const secondStarted = live.frames.find((f) => f.event === 'run.started' && f.payload.ref === 'turn-second-2');
    expect(secondStarted.payload.meta).toMatchObject({ messageId: echoes[1].assistant_message_id, userMessageId: echoes[1].user_message_id });
    live.close();
  }, 20000);

  it('取消排队项：从队列移除，不落任何行', async () => {
    const { sessionId, gw } = newSession();
    const first = readSse(await post('/api/chat', { sessionId, message: 'busy', queue: true }));
    await waitUntil(() => gw.sent.length === 1);
    const queued = await (await post('/api/chat', { sessionId, message: 'never mind', queue: true })).json() as any;
    const cancelled = await fetch(`${h.baseUrl}/api/chat/${sessionId}/queue/${queued.queueId}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    expect((await fetch(`${h.baseUrl}/api/chat/${sessionId}/queue/${queued.queueId}`, { method: 'DELETE' })).status).toBe(404);
    gw.final('done');
    await first.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gw.sent).toHaveLength(1);
    expect(h.ctx.db.getMessages(sessionId).map((row: any) => row.content)).toEqual(['busy', 'done']);
  }, 20000);

  it('立即插入：当前轮被立即打断（stop_reason = queue_insertion，不当错误落库），插入的那一条接着开始', async () => {
    const { sessionId, gw } = newSession();
    const live = openLive(sessionId);
    await live.ready;
    const first = readSse(await post('/api/chat', { sessionId, message: 'long task', queue: true }));
    await waitUntil(() => gw.sent.length === 1);
    gw.delta('partial output');
    await post('/api/chat', { sessionId, message: 'later', queue: true });
    const urgent = await (await post('/api/chat', { sessionId, message: 'urgent', queue: true })).json() as any;

    const inserted = await (await post(`/api/chat/${sessionId}/queue/${urgent.queueId}/insert`, {})).json() as any;
    expect(inserted).toMatchObject({ success: true, status: 'immediate' });
    await first.end();
    await waitUntil(() => gw.sent.length === 2);
    expect(String(gw.sent[1].message)).toContain('urgent');

    await waitUntil(() => live.frames.some((f) => f.event === 'queue.insertion.updated' && f.payload.cleared));
    const aborted = live.frames.find((f) => f.event === 'run.aborted');
    expect(aborted.payload).toMatchObject({ interrupted: true, stop_reason: 'queue_insertion', interruption_mode: 'immediate' });
    const phases = live.frames.filter((f) => f.event === 'queue.insertion.updated').map((f) => f.payload.phase ?? `cleared:${f.payload.reason}`);
    expect(phases).toEqual(['requesting', 'stopping_current_turn', 'starting_queued_message', 'cleared:started']);
    const firstAssistant = h.ctx.db.getMessages(sessionId).find((row: any) => row.role !== 'user');
    expect(firstAssistant).toMatchObject({ role: 'assistant', content: 'partial output' });
    gw.final('urgent answer');
    live.close();
  }, 20000);

  it('没带 queue 的旧客户端：新消息仍替换当前轮', async () => {
    const { sessionId, gw } = newSession();
    const first = readSse(await post('/api/chat', { sessionId, message: 'old client first' }));
    await waitUntil(() => gw.sent.length === 1);
    const second = readSse(await post('/api/chat', { sessionId, message: 'old client second' }));
    await first.end();
    await waitUntil(() => gw.sent.length === 2);
    gw.final('second reply');
    await second.end();
    expect(h.ctx.runCoordinator.snapshot(sessionId).queue).toEqual([]);
  }, 20000);
});
