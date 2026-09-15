/**
 * 协调器是业务事件（出站 Webhook 的来源）的唯一发布点。
 *
 * 迁移前 `ActiveRunManager` 只在 OpenClaw 单聊里发 `chat.run.*`；P1a 删掉它之后，发布点收到协调器，
 * 覆盖所有表面（单聊、群聊外部成员、工作流节点）与所有运行时。这里验：
 * - 运行开始 / 完成 / 失败 / 中止各发一次，负载带 Webhook 映射需要的字段；
 * - 工具调用开始与结果、审批请求与答复也发；
 * - 事件经 Webhook 服务的总线订阅真的进 outbox（端到端到入队为止）。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { EventBus, type BusEvent } from '../src/core/events';
import { RealtimeHub } from '../src/core/realtime';
import { RunCoordinator, type RunSubmission } from '../src/runtime/coordinator';
import { buildWebhookPayload, WEBHOOK_EVENT_TYPES } from '../src/automation/webhooks/webhook-events';
import { createWebhookService } from '../src/automation/webhooks/webhook-service';
import { createWebhookStore } from '../src/automation/webhooks/webhook-store';
import { memoryDb, waitFor } from './automation/helpers';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';
import { CODEX_CAPABILITIES, CODEX_SOURCE_OF_TRUTH } from '../src/runtime/adapters/codex';
import { runExternalChatTurn } from '../src/collab/sessions/external-chat-turn';

function setup() {
  const bus = new EventBus();
  const received: BusEvent[] = [];
  bus.subscribe('test', (event) => { received.push(event); });
  const coordinator = new RunCoordinator({ hub: new RealtimeHub(), store: new MemoryRunStore(), events: bus, abortGraceMs: 50, log: () => {} });
  const scripted = scriptedAdapter({ id: 'claude-code' });
  const submission = (overrides: Partial<RunSubmission<any>> = {}): RunSubmission<any> => ({
    sessionKey: 'room:g1:member:m1',
    surface: 'room',
    topics: ['room:g1', 'agent:ext:claude-code:cc'],
    agentId: 'ext:claude-code:cc',
    title: 'CC',
    adapter: scripted.adapter,
    request: {},
    projector: () => ({ onEvent: () => {}, finish: (outcome) => ({ messageId: 7, output: outcome.kind === 'completed' ? outcome.outputText : undefined }) }),
    ...overrides,
  });
  return { bus, received, coordinator, scripted, submission };
}

describe('协调器发业务事件', () => {
  it('一次完成的运行：chat.run.started → chat.tool.* → chat.run.completed，负载带映射需要的字段', async () => {
    const { coordinator, scripted, submission, received } = setup();
    const submitted = await coordinator.submit(submission(), 'reject');
    await flush();
    const run = scripted.runs[0];
    run.emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'Bash', arguments: '{}' } } as any);
    run.emit({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc2', call_id: 'c2', name: 'Read', arguments: '{}' } } as any);
    run.emit({ type: 'response.output_item.done', output_index: 2, item: { type: 'function_call_output', id: 'o1', call_id: 'c1', output: 'ok' } } as any);
    run.emit({ type: 'response.output_item.done', output_index: 3, item: { type: 'function_call_output', id: 'o2', call_id: 'c2', output: 'boom', status: 'failed' } } as any);
    run.finish({ kind: 'completed', outputText: 'done' });
    const terminal = await (submitted as any).completion;

    expect(received.map((event) => event.type)).toEqual([
      'chat.run.started',
      'chat.tool.started',
      'chat.tool.started',
      'chat.tool.completed',
      'chat.tool.failed',
      'chat.run.completed',
    ]);
    const base = { sessionId: 'room:g1:member:m1', runId: terminal.runId, agentId: 'ext:claude-code:cc', agentName: 'CC', runtime: 'claude-code', surface: 'room' };
    expect(received[0].payload).toMatchObject(base);
    expect(received[3].payload).toMatchObject({ ...base, callId: 'c1', toolName: 'Bash' });
    // 结果事件不带工具名：协调器按 call id 补上。
    expect(received[4].payload).toMatchObject({ ...base, callId: 'c2', toolName: 'Read' });
    expect(received[5].payload).toMatchObject({ ...base, text: 'done' });

    // 每个事件都能映射成 Webhook 负载，id 稳定且互不相同。
    const payloads = received.map((event) => buildWebhookPayload(event.type, event.payload as Record<string, unknown>, event.publishedAt, true));
    expect(payloads.every(Boolean)).toBe(true);
    expect(new Set(payloads.map((payload) => payload!.id)).size).toBe(payloads.length);
    expect(payloads[5]).toMatchObject({ source: 'chat', subject: { session_id: 'room:g1:member:m1', run_id: terminal.runId }, summary: { status: 'completed', runtime: 'claude-code', surface: 'room' }, message: { text: 'done' } });
    expect(payloads[4]).toMatchObject({ subject: { call_id: 'c2' }, summary: { status: 'failed', tool_name: 'Read' } });
    for (const event of received) expect(WEBHOOK_EVENT_TYPES as readonly string[]).toContain(event.type);
  });

  it('失败与中止各发一次终态；审批请求与答复也发', async () => {
    const { coordinator, scripted, submission, received } = setup();
    await coordinator.submit(submission({ sessionKey: 's-fail' }), 'reject');
    await flush();
    scripted.runs[0].finish({ kind: 'failed', error: 'x', code: 'external.exit' });
    await flush();

    await coordinator.submit(submission({ sessionKey: 's-abort' }), 'reject');
    await flush();
    scripted.runs[1].emit({ type: 'approval.requested', request: { approvalId: 'ap1', agentId: 'ext:claude-code:cc', title: 'rm', choices: ['once', 'deny'], timeoutMs: 60_000 } });
    expect(coordinator.respondInteraction('s-abort', 'ap1', { choice: 'once' })).toMatchObject({ resolved: true });
    await coordinator.abort('s-abort', 'user_stop');

    const types = received.map((event) => `${event.type}@${(event.payload as any).sessionId}`);
    expect(types).toEqual([
      'chat.run.started@s-fail',
      'chat.run.failed@s-fail',
      'chat.run.started@s-abort',
      'chat.approval.requested@s-abort',
      'chat.approval.resolved@s-abort',
      'chat.run.aborted@s-abort',
    ]);
    expect(received[1].payload).toMatchObject({ errorCode: 'external.exit' });
    expect(received[4].payload).toMatchObject({ approvalId: 'ap1', decision: 'once', reason: 'response' });
    expect(buildWebhookPayload('chat.approval.resolved', received[4].payload as any, 1, false)).toMatchObject({ subject: { approval_id: 'ap1' }, summary: { decision: 'once' } });
  });

  it('scoped 两路（代理 + 原生）同一个工具与正文：业务事件各只发一次', async () => {
    const { received, coordinator, submission } = setup();
    const codex = scriptedAdapter({ id: 'codex', capabilities: CODEX_CAPABILITIES, sourceOfTruth: CODEX_SOURCE_OF_TRUTH });
    await coordinator.submit(submission({ sessionKey: 's-scoped', surface: 'chat', adapter: codex.adapter, proxyMode: 'scoped' }), 'reject');
    const run = codex.runs[0];
    for (const channel of ['proxy', 'native'] as const) {
      run.emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: `fc-${channel}`, call_id: 'c1', name: 'exec_command', arguments: '{}' } } as any, channel);
      run.emit({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call_output', id: `o-${channel}`, call_id: 'c1', output: 'ok' } } as any, channel);
    }
    run.finish({ kind: 'completed', outputText: 'done' });
    await flush();
    await flush();
    expect(received.map((event) => event.type)).toEqual(['chat.run.started', 'chat.tool.started', 'chat.tool.completed', 'chat.run.completed']);
    expect(received[0].payload).toMatchObject({ runtime: 'codex', surface: 'chat' });
  });

  it('外部运行时单聊（Pi）经协调器：chat.run.started / completed 带 surface chat、runtime、会话 Agent', async () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribe('test', (event) => { received.push(event); });
    const hub = new RealtimeHub();
    const coordinator = new RunCoordinator({ hub, store: new MemoryRunStore(), events: bus, log: () => {} });
    const pi = scriptedAdapter({ id: 'pi', onStart: (run) => setTimeout(() => run.finish({ kind: 'completed', outputText: 'pi says hi' }), 1) });
    const session: any = { id: 'pi-1', name: 'Pi', agentId: 'pi-1', position: 0, created_at: 0, updated_at: 0, external_runtime: 'pi', external_config: '{"mode":"global"}', external_session_id: '33333333-3333-4333-8333-333333333333', external_session_resumable: 0 };
    const sessions = new Map([[session.id, session]]);
    await runExternalChatTurn({
      db: { updateMessage: () => {}, updateMessageEnvelope: () => {}, deleteMessage: () => {}, setChatMessagesRunMarker: () => {}, getSession: (id: string) => sessions.get(id), saveSession: (row: any) => sessions.set(row.id, row) } as any,
      configManager: { getConfig: () => ({ language: 'en' }) } as any,
      realtime: hub,
      runCoordinator: coordinator,
      createAdapter: () => pi.adapter,
      defaultWorkspace: () => '/tmp/pi',
    }, { session, transport: 'ws', res: {} as any, sink: { frame: () => {}, end: () => {} } as any, prompt: 'hi', assistantMessageId: 2, runMarkerMessageIds: [1, 2], agentName: 'Pi' });
    expect(received.map((event) => event.type)).toEqual(['chat.run.started', 'chat.run.completed']);
    expect(received[1].payload).toMatchObject({ sessionId: 'pi-1', surface: 'chat', runtime: 'pi', agentId: 'pi-1', agentName: 'Pi' });
    expect(buildWebhookPayload('chat.run.completed', received[1].payload as Record<string, unknown>, received[1].publishedAt, false)).toMatchObject({ subject: { session_id: 'pi-1' } });
  });

  it('端到端到 outbox：协调器运行完成 → 总线 → Webhook 服务入队 chat.run.completed', async () => {
    const { bus, coordinator, scripted, submission } = setup();
    const delivered: string[] = [];
    const store = createWebhookStore(memoryDb());
    const service = createWebhookService({
      store,
      resolver: async () => [{ address: '127.0.0.1', family: 4 as const }],
      deliver: async (req: any) => { delivered.push(req.eventType); return { ok: true, status: 200, retryable: false, error: null, deliveryId: 'd', durationMs: 1 }; },
      receiverSecret: () => 'receiver',
      backendPort: () => 3170,
    });
    const endpoint = store.saveEndpoint({ name: 'a', url: 'http://127.0.0.1/a', secret: null, eventTypes: ['chat.run.completed'], enabled: true, includeContent: false, allowPrivateNetwork: true, maxRetries: 3 });
    service.attach(bus);
    await coordinator.submit(submission(), 'reject');
    await flush();
    scripted.runs[0].finish({ kind: 'completed', outputText: 'ok' });
    await waitFor(() => delivered.length === 1);
    await service.idle();
    expect(delivered).toEqual(['chat.run.completed']);
    expect(store.stats(endpoint.id)).toMatchObject({ delivered: 1 });
  });

  it('装配：应用上下文把业务总线交给协调器（漏了这一格，Webhook 静默收不到任何 chat.* 事件）', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'bootstrap', 'context.ts'), 'utf-8');
    expect(source).toMatch(/new RunCoordinator\(\{[^}]*\bevents\b[^}]*\}\)/);
  });
});
