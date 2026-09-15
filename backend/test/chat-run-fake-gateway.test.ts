/**
 * 单聊运行链路的端到端对账（假网关）。
 *
 * ## 为什么先有这份用例
 *
 * P1a 要把单聊运行链路迁到运行协调器之下，并要求**用户可见行为不变**。
 * 这份用例是在迁移**之前**、对着 v1.8.0 的实现录下来的：SSE 帧的逐帧形状、
 * `chat_messages` 行、`/api/history/:sessionId` 的返回、网关收到的 abort——迁移后逐项不变才算过。
 *
 * ## 五处对账里能在这里验的
 *
 * - JSONL 原始终态 / `chat.history`：假网关的历史就是网关视角的终态；
 * - `chat_messages`：直接读库；
 * - `/api/history/:sessionId`：真 HTTP；
 * - 页面 DOM：前端不在这里，SSE 帧就是 DOM 的输入（`final` 帧文本 = 气泡文本）。
 * 真网关 + 真页面的五处一致仍需真机验证（本机 OpenClaw 没配模型服务商），见 P1a 报告 TODO。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGatewayClient } from './helpers/fake-gateway';
import { pinFakeGateway, readSse, startAppHarness, waitUntil, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
beforeAll(async () => { h = await startAppHarness(); });
afterAll(async () => { await h.close(); });

const post = (path: string, body: unknown) => fetch(`${h.baseUrl}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let sessionSeq = 0;
function newSession(): { sessionId: string; gw: FakeGatewayClient } {
  const sessionId = `fake-s${++sessionSeq}`;
  const gw = new FakeGatewayClient();
  h.ctx.sessionManager.createSession({ id: sessionId, name: 'Tester', agentId: 'main' });
  pinFakeGateway(h.ctx, sessionId, gw);
  return { sessionId, gw };
}

const waitSent = (gw: FakeGatewayClient, count = 1) => waitUntil(() => gw.sent.length >= count);
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = (sessionId: string) => h.ctx.db.getMessages(sessionId, 50).map((row: any) => ({
  id: row.id,
  parent_id: row.parent_id,
  role: row.role,
  content: row.content,
  process_content: row.process_content,
  process_streaming: row.process_streaming,
  model_used: row.model_used,
  agent_id: row.agent_id,
  agent_name: row.agent_name,
}));
const history = async (sessionId: string) => (await (await fetch(`${h.baseUrl}/api/history/${sessionId}`)).json()) as any;

const TOOL_START_LINE = '- 正在打开文件：/tmp/a';
const TOOL_DONE_LINES = `${TOOL_START_LINE}\n- 文件读取已完成：/tmp/a`;

describe('单聊运行：发送 → 流式 → 工具 → 终态', () => {
  it('SSE 帧、库、历史接口、网关订阅逐项一致', async () => {
    const { sessionId, gw } = newSession();
    const sse = readSse(await post('/api/chat', { sessionId, message: 'hello' }));
    await waitSent(gw);
    expect(gw.sent[0]).toMatchObject({ sessionKey: `agent:main:chat:${sessionId}`, message: 'hello', agentId: 'main' });

    gw.delta('Hel');
    gw.delta('Hello wor');
    gw.tool('start', 'read', { id: 't1', args: { path: '/tmp/a' } });
    await sse.waitFor((f) => f.process_streaming === true);

    const active = await (await fetch(`${h.baseUrl}/api/chat/${sessionId}/active-run`)).json() as any;
    expect(active.active).toBe(true);
    expect(active.runState).toMatchObject({ active: true, runId: 'gw-run-1', agentId: 'main', kind: 'openclaw-run' });
    const [, assistantRow] = rows(sessionId);
    expect(active.runState.messageId).toBe(assistantRow.id);

    // 断线重连：另一个客户端中途接回，先拿到当前快照，再跟着收后续帧。
    const attach = readSse(await fetch(`${h.baseUrl}/api/chat/attach/${sessionId}`));
    await attach.waitFor((f) => f.type === 'final');

    gw.tool('result', 'read', { id: 't1', args: { path: '/tmp/a' } });
    gw.final('Hello world');
    await sse.end();
    await attach.end();

    const [userRow, finalAssistantRow] = rows(sessionId);
    expect(sse.frames).toEqual([
      { type: 'ids', userMsgId: userRow.id, assistantMsgId: finalAssistantRow.id },
      { type: 'attached', messageId: finalAssistantRow.id, agentId: 'main', agentName: 'Tester', modelUsed: 'fake/model-1' },
      { type: 'delta', text: 'Hel', process_content: '', process_streaming: false },
      { type: 'delta', text: 'Hello wor', process_content: '', process_streaming: false },
      { type: 'delta', text: 'Hello wor', process_content: TOOL_START_LINE, process_streaming: true },
      { type: 'delta', text: 'Hello wor', process_content: TOOL_DONE_LINES, process_streaming: false },
      { type: 'final', text: 'Hello world', process_content: TOOL_DONE_LINES, process_streaming: false },
      { type: 'final', text: 'Hello world', process_content: TOOL_DONE_LINES, process_streaming: false },
    ]);
    expect(attach.frames).toEqual([
      { type: 'attached', messageId: finalAssistantRow.id, agentId: 'main', agentName: 'Tester', modelUsed: 'fake/model-1' },
      { type: 'final', text: 'Hello wor', process_content: TOOL_START_LINE, process_streaming: true },
      { type: 'delta', text: 'Hello wor', process_content: TOOL_DONE_LINES, process_streaming: false },
      { type: 'final', text: 'Hello world', process_content: TOOL_DONE_LINES, process_streaming: false },
      { type: 'final', text: 'Hello world', process_content: TOOL_DONE_LINES, process_streaming: false },
    ]);

    expect(rows(sessionId)).toEqual([
      { id: userRow.id, parent_id: null, role: 'user', content: 'hello', process_content: null, process_streaming: 0, model_used: null, agent_id: null, agent_name: null },
      { id: finalAssistantRow.id, parent_id: userRow.id, role: 'assistant', content: 'Hello world', process_content: TOOL_DONE_LINES, process_streaming: 0, model_used: 'fake/model-1', agent_id: 'main', agent_name: 'Tester' },
    ]);

    const api = await history(sessionId);
    expect(api.messages.map((m: any) => [m.id, m.role, m.content, m.process_content, m.process_streaming])).toEqual([
      [userRow.id, 'user', 'hello', null, false],
      [finalAssistantRow.id, 'assistant', 'Hello world', TOOL_DONE_LINES, false],
    ]);

    // 五处对账：网关终态 = 最后一帧 = 库 = 历史接口。
    const gatewayTerminal = gw.history[gw.history.length - 1] as any;
    expect(gatewayTerminal.content[0].text).toBe('Hello world');
    expect(sse.frames[sse.frames.length - 1].text).toBe('Hello world');
    expect(finalAssistantRow.content).toBe('Hello world');
    expect(api.messages[1].content).toBe('Hello world');

    // 发送前清理孤儿 run 一次；会话事件订阅有借有还。
    expect(gw.aborts).toEqual([{ sessionKey: `agent:main:chat:${sessionId}`, runId: undefined }]);
    expect(gw.subscribeCount).toBe(1);
    expect(gw.unsubscribeCount).toBe(1);

    const after = await (await fetch(`${h.baseUrl}/api/chat/attach/${sessionId}`)).json();
    expect(after).toEqual({ active: false });
  }, 20000);
});

describe('单聊运行：中止', () => {
  it('运行中停止：推一帧当前文本的 final 并收尾，库里留下半截，网关收到 abort', async () => {
    const { sessionId, gw } = newSession();
    const sse = readSse(await post('/api/chat', { sessionId, message: 'long task' }));
    await waitSent(gw);
    gw.delta('partial answer');
    await sse.waitFor((f) => f.type === 'delta');

    const stop = await (await post('/api/chat/stop', { sessionId })).json();
    await sse.end();

    const [userRow, assistantRow] = rows(sessionId);
    expect(stop).toEqual({ success: true, aborted: true, runIds: [] });
    expect(sse.frames).toEqual([
      { type: 'ids', userMsgId: userRow.id, assistantMsgId: assistantRow.id },
      { type: 'attached', messageId: assistantRow.id, agentId: 'main', agentName: 'Tester', modelUsed: 'fake/model-1' },
      { type: 'delta', text: 'partial answer', process_content: '', process_streaming: false },
      { type: 'final', text: 'partial answer', process_content: '', process_streaming: false },
    ]);
    expect(assistantRow).toMatchObject({ role: 'assistant', content: 'partial answer', process_content: null, process_streaming: 0 });
    const key = `agent:main:chat:${sessionId}`;
    expect(gw.aborts).toEqual([
      { sessionKey: key, runId: undefined },   // 发送前清孤儿
      { sessionKey: key, runId: 'gw-run-1' },  // 停当前 run
      { sessionKey: key, runId: undefined },   // stop 路由再清一遍孤儿
    ]);
    expect(await (await fetch(`${h.baseUrl}/api/chat/${sessionId}/active-run`)).json()).toMatchObject({ active: false });
  }, 20000);

  it('准备阶段停止：只收尾不推帧，占位的助手行被删掉，晚到的网关 run 被 abort', async () => {
    const { sessionId, gw } = newSession();
    let release!: () => void;
    gw.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const sse = readSse(await post('/api/chat', { sessionId, message: 'prep' }));
    await sse.waitFor((f) => f.type === 'attached');

    const stop = await (await post('/api/chat/stop', { sessionId })).json();
    expect(stop).toEqual({ success: true, aborted: true, runIds: [] });
    release();
    await sse.end();
    await waitUntil(() => gw.aborts.some((a) => a.runId === 'gw-run-1'));

    const [userRow] = rows(sessionId);
    expect(sse.frames.map((f) => f.type)).toEqual(['ids', 'attached']);
    expect(rows(sessionId)).toEqual([expect.objectContaining({ id: userRow.id, role: 'user', content: 'prep' })]);
  }, 20000);

  it('上一轮还在跑时发新消息：旧流以当前文本收尾，新一轮照常完成', async () => {
    const { sessionId, gw } = newSession();
    const first = readSse(await post('/api/chat', { sessionId, message: 'first' }));
    await waitSent(gw);
    gw.delta('first partial');
    await first.waitFor((f) => f.type === 'delta');

    const second = readSse(await post('/api/chat', { sessionId, message: 'second' }));
    await first.end();
    expect(first.frames[first.frames.length - 1]).toEqual({ type: 'final', text: 'first partial', process_content: '', process_streaming: false });

    await waitSent(gw, 2);
    gw.delta('second answer');
    gw.final('second answer');
    await second.end();
    expect(second.frames[second.frames.length - 1]).toEqual({ type: 'final', text: 'second answer', process_content: '', process_streaming: false });

    expect(rows(sessionId).map((r: any) => [r.role, r.content])).toEqual([
      ['user', 'first'],
      ['assistant', 'first partial'],
      ['user', 'second'],
      ['assistant', 'second answer'],
    ]);
  }, 20000);
});

describe('单聊运行：失败与断线', () => {
  it('网关报错：推 error 帧，助手行改写成系统错误行', async () => {
    const { sessionId, gw } = newSession();
    const sse = readSse(await post('/api/chat', { sessionId, message: 'boom' }));
    await waitSent(gw);
    gw.failRun('provider exploded');
    await sse.end();

    const [userRow, errorRow] = rows(sessionId);
    expect(sse.frames).toEqual([
      { type: 'ids', userMsgId: userRow.id, assistantMsgId: errorRow.id },
      { type: 'attached', messageId: errorRow.id, agentId: 'main', agentName: 'Tester', modelUsed: 'fake/model-1' },
      { type: 'error', text: '❌ Error: provider exploded', process_content: '', process_streaming: false, messageCode: 'chat.runError', rawDetail: 'provider exploded', role: 'system' },
    ]);
    expect(errorRow).toMatchObject({ role: 'system', content: '❌ Error: provider exploded', agent_id: 'system', agent_name: 'System', model_used: 'fake/model-1' });
    const api = await history(sessionId);
    expect(api.messages[1]).toMatchObject({ role: 'system', messageCode: 'chat.runError', rawDetail: 'provider exploded' });
    expect(gw.aborts.map((a) => a.runId)).toEqual([undefined, 'gw-run-1']);
  }, 20000);

  it('发送方中途断开：运行不受影响，终态照常落库，之后接回得到 inactive、历史是全文', async () => {
    const { sessionId, gw } = newSession();
    const controller = new AbortController();
    const sse = readSse(await fetch(`${h.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'keep going' }),
      signal: controller.signal,
    }));
    await waitSent(gw);
    gw.delta('streamed part');
    await sse.waitFor((f) => f.type === 'delta');
    controller.abort();
    await sse.end();
    await tick();

    // 断开期间：运行仍在，接回能拿到当前快照。
    const attach = readSse(await fetch(`${h.baseUrl}/api/chat/attach/${sessionId}`));
    await attach.waitFor((f) => f.type === 'final');
    expect(attach.frames[1]).toEqual({ type: 'final', text: 'streamed part', process_content: '', process_streaming: false });

    gw.final('streamed part and the rest');
    await attach.end();
    expect(attach.frames[attach.frames.length - 1]).toEqual({ type: 'final', text: 'streamed part and the rest', process_content: '', process_streaming: false });

    expect(await (await fetch(`${h.baseUrl}/api/chat/attach/${sessionId}`)).json()).toEqual({ active: false });
    const api = await history(sessionId);
    expect(api.messages[1]).toMatchObject({ role: 'assistant', content: 'streamed part and the rest', process_streaming: false });
  }, 20000);
});

describe('单聊运行：重新生成', () => {
  it('替换最新一轮的回复，帧形状与发送一致', async () => {
    const { sessionId, gw } = newSession();
    const first = readSse(await post('/api/chat', { sessionId, message: 'question' }));
    await waitSent(gw);
    gw.final('answer v1');
    await first.end();
    const [userRow, v1Row] = rows(sessionId);

    const regen = readSse(await post('/api/chat/regenerate', { sessionId, message: 'question', parentId: userRow.id, targetMessageId: v1Row.id }));
    await waitSent(gw, 2);
    gw.delta('answer v2');
    gw.final('answer v2');
    await regen.end();

    const after = rows(sessionId);
    expect(after.map((r: any) => [r.role, r.content, r.parent_id])).toEqual([
      ['user', 'question', null],
      ['assistant', 'answer v2', userRow.id],
    ]);
    expect(regen.frames).toEqual([
      { type: 'ids', userMsgId: userRow.id, assistantMsgId: after[1].id },
      { type: 'attached', messageId: after[1].id, agentId: 'main', agentName: 'Tester', modelUsed: 'fake/model-1' },
      { type: 'delta', text: 'answer v2', process_content: '', process_streaming: false },
      // chat.final 的文本与已推的 delta 相同：不再单独推一帧非终态 final，只有收尾那一帧。
      { type: 'final', text: 'answer v2', process_content: '', process_streaming: false },
    ]);
  }, 20000);
});

/**
 * 迁移后新增、迁移前没有的东西：协调器写的通用事实。
 * 上面七个场景证明「用户可见的不变」，这里证明「协调器真的在这条链路上」。
 */
describe('单聊运行经协调器：通用事实落库', () => {
  it('会话行、run marker、网关终态用量（按网关 run 去重）、工具调用与结果都落库', async () => {
    const { sessionId, gw } = newSession();
    const sse = readSse(await post('/api/chat', { sessionId, message: 'with tools' }));
    await waitSent(gw);
    gw.tool('start', 'read', { id: 't1', args: { path: '/tmp/a' } });
    gw.tool('result', 'read', { id: 't1', args: { path: '/tmp/a' } });
    // 漏收开始事件的结果：迁移前也会写一行进度，迁移后同样不丢，并补成一条完整的工具调用记录。
    gw.tool('result', 'exec', { id: 't2', args: { command: 'ls' } });
    const usage = { input: 120, output: 30, cacheRead: 5, cacheWrite: 0, cost: { total: 0.002 } };
    gw.final('done with tools', gw.lastRun(), { usage, model: 'fake/model-1' });
    // 同一个终态事件网关重推一次：用量仍只记一次。
    gw.emit('chat.final', { sessionKey: gw.lastRun().sessionKey, runId: gw.lastRun().runId, text: 'done with tools', message: { role: 'assistant', content: [{ type: 'text', text: 'done with tools' }], usage } });
    await sse.end();

    const db = h.ctx.db;
    expect(db.getRunSession(sessionId)).toMatchObject({ surface: 'chat', runtime: 'openclaw', agent_id: 'main', end_reason: 'complete' });
    // 分页读取只选展示用的列；run_marker 直接查表。
    const [userRow, assistantRow] = db.db.prepare('SELECT id, run_marker, process_content FROM chat_messages WHERE session_key = ? ORDER BY id').all(sessionId);
    expect(userRow.run_marker).toMatch(/^run-/);
    expect(assistantRow.run_marker).toBe(userRow.run_marker);
    expect(db.listSessionUsage(sessionId).map((row: any) => [row.run_id, row.source, row.input_tokens, row.output_tokens, row.cost_usd])).toEqual([
      [`openclaw:agent:main:chat:${sessionId}:gw-run-1`, 'openclaw', 120, 30, 0.002],
    ]);
    expect(db.listRunToolCalls(sessionId).map((row: any) => [row.call_id, row.name, row.status, row.run_marker])).toEqual([
      ['t1', 'read', 'completed', userRow.run_marker],
      ['t2', 'exec', 'completed', userRow.run_marker],
    ]);
    expect(assistantRow.process_content).toContain('- ');
  }, 20000);

  it('运行中的会话在协调器里可见；结束后淘汰，不留状态', async () => {
    const { sessionId, gw } = newSession();
    const sse = readSse(await post('/api/chat', { sessionId, message: 'observe' }));
    await waitSent(gw);
    const run = h.ctx.runCoordinator.getActiveRun(sessionId);
    expect(run).toMatchObject({ runtime: 'openclaw', agentId: 'main', phase: 'running', nativeRunId: 'gw-run-1' });
    gw.final('bye');
    await sse.end();
    expect(h.ctx.runCoordinator.getActiveRun(sessionId)).toBeNull();
    expect(h.ctx.runCoordinator.snapshot(sessionId).replay).toEqual([]);
  }, 20000);
});
