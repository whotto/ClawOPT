/**
 * 协调器版 WorkflowAgentRunner：工作流节点作为运行协调器里 `workflow` 表面的真实会话运行。
 *
 * - 引擎 → Runner → 协调器 → 适配器（脚本化，不起进程）整条链：节点输出、会话行、会话主题上的实时事件、业务总线上的 chat.run.*；
 * - OpenClaw 分支：网关会话键 / 专用连接 / 结束断开；
 * - 中止、超时、空输出；
 * - 审批自动应答（allow once / deny）落在协调器；
 * - 删运行时丢掉节点会话的通用行。
 */
import { describe, expect, it } from 'vitest';

import { EventBus, type BusEvent } from '../../src/core/events';
import { RealtimeHub, type RealtimeEvent } from '../../src/core/realtime';
import { RunCoordinator } from '../../src/runtime/coordinator';
import { defineCapabilities } from '../../src/runtime/contract';
import { createCoordinatorRunner, workflowSessionKey } from '../../src/automation/runner/coordinator-runner';
import type { AgentRunRequest } from '../../src/automation/ports';
import { MemoryRunStore, flush, scriptedAdapter, type RunControls } from '../helpers/scripted-adapter';
import { edge, node, setupEngine } from './helpers';
import { createWorkflowEngine } from '../../src/automation/workflow/engine';

const APPROVAL_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: false,
  approvals: true,
  clarify: false,
  hostCompression: false,
  nativeCompact: false,
  backgroundDelegation: false,
  images: false,
  mcpInjection: false,
  proxyMode: [],
});

function setup(options: { onStart?: (controls: RunControls) => void; approvals?: boolean; abortGraceMs?: number } = {}) {
  const hub = new RealtimeHub();
  const realtime: RealtimeEvent[] = [];
  hub.listen('test', (event) => realtime.push(event));
  const bus = new EventBus();
  const business: BusEvent[] = [];
  bus.subscribe('test', (event) => { business.push(event); });
  const store = new MemoryRunStore();
  const coordinator = new RunCoordinator({ hub, store, events: bus, abortGraceMs: options.abortGraceMs ?? 50, log: () => {} });
  const external = scriptedAdapter({ id: 'claude-code', onStart: options.onStart, capabilities: options.approvals ? APPROVAL_CAPABILITIES : undefined });
  const openclaw = scriptedAdapter({ id: 'openclaw', onStart: options.onStart });
  const connectionCalls: string[] = [];
  const deletedSessions: string[] = [];
  const runner = createCoordinatorRunner({
    runCoordinator: coordinator,
    openclawAdapter: openclaw.adapter,
    gatewayConnections: {
      getConnection: async (key: string) => { connectionCalls.push(`get:${key}`); return {} as any; },
      disconnectConnection: (key: string) => { connectionCalls.push(`disconnect:${key}`); },
    },
    connections: new Map(),
    db: { deleteRunSessionData: (key) => { deletedSessions.push(key); } },
    externalAdapters: { 'claude-code': () => external.adapter },
  });
  const request = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
    sessionId: 'sess-1',
    agentRef: { kind: 'external', id: 'claude-code', runtime: 'claude-code' },
    input: [{ type: 'text', text: 'reply ok' }],
    workspace: '/tmp/wf',
    timeoutMs: 60_000,
    autoApprove: 'once',
    signal: new AbortController().signal,
    ...overrides,
  });
  return { hub, realtime, business, store, coordinator, external, openclaw, runner, request, connectionCalls, deletedSessions };
}

describe('协调器版 WorkflowAgentRunner', () => {
  it('引擎 → Runner → 协调器：节点输出、workflow 表面会话行、会话主题实时事件、chat.run.completed 业务事件', async () => {
    const t = setup({ onStart: (run) => setTimeout(() => {
      run.emit({ type: 'response.output_text.delta', item_id: 'm1', delta: 'ok' });
      run.finish({ kind: 'completed', outputText: 'ok' });
    }, 5) });
    const base = setupEngine();
    const engine = createWorkflowEngine({
      defs: base.defs, runStore: base.runStore, runner: t.runner, directory: { list: () => [], availability: () => ({ available: true }), readSkill: () => null, listSkills: () => [] },
      resolveAttachment: () => null, publishEvent: () => {}, settings: base.settings, hub: base.hub, resolveWorkspace: () => '/tmp/wf',
    });
    const def = base.defs.create({ name: 'wf', workspace: null, nodes: [{ ...node('a'), data: { ...node('a').data, agent: { kind: 'external', id: 'claude-code', runtime: 'claude-code' }, input: 'reply ok' } }] as any, edges: [], viewport: null });
    const started = await engine.startRun(def.id, {});
    await engine.waitForRun(started.id);

    const run = base.runStore.getRun(started.id)!;
    const [execution] = base.runStore.evidence(started.id).nodeExecutions;
    expect(run.status).toBe('completed');
    expect(execution).toMatchObject({ status: 'completed', outputText: 'ok' });
    const sessionKey = workflowSessionKey(execution.sessionId!);
    expect(t.store.calls).toEqual([`ensure:${sessionKey}`, `ended:${sessionKey}:complete`]);
    expect(t.external.runs[0].context.request).toMatchObject({ sessionId: execution.sessionId, prompt: expect.stringContaining('reply ok'), workingDir: '/tmp/wf', resume: false });
    expect(t.realtime.filter((event) => event.topic === `session:${sessionKey}`).map((event) => event.type)).toEqual(['run.started', 'message.delta', 'run.completed']);
    expect(t.business.map((event) => event.type)).toEqual(['chat.run.started', 'chat.run.completed']);
    expect(t.business[1].payload).toMatchObject({ sessionId: sessionKey, surface: 'workflow', runtime: 'claude-code', text: 'ok' });
  });

  it('OpenClaw 分支：网关会话键与专用连接，结束后断开', async () => {
    const t = setup({ onStart: (run) => setTimeout(() => run.finish({ kind: 'completed', outputText: 'from gateway' }), 5) });
    const result = await t.runner.runAndWait(t.request({ agentRef: { kind: 'openclaw', id: 'main' } }));
    expect(result).toEqual({ ok: true, output: 'from gateway', sessionId: 'sess-1' });
    const request = t.openclaw.runs[0].context.request;
    expect(request).toMatchObject({ sessionId: 'agent:main:workflow:sess-1', agentId: 'main' });
    await request.getConnection();
    expect(await request.prepareMessage()).toEqual({ text: 'reply ok', attachments: [] });
    expect(t.connectionCalls).toEqual(['disconnect:workflow:sess-1', 'get:workflow:sess-1']);
  });

  it('中止、超时、空输出、没有适配器', async () => {
    const hang = setup({ abortGraceMs: 20 });
    const controller = new AbortController();
    const pending = hang.runner.runAndWait(hang.request({ signal: controller.signal }));
    await flush();
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: 'aborted' });
    expect(hang.external.runs[0].interrupts).toEqual(['user_stop']);

    const slow = setup();
    expect(await slow.runner.runAndWait(slow.request({ sessionId: 's-timeout', timeoutMs: 1 }))).toMatchObject({ ok: false, error: 'timeout', timedOut: true });
    expect(slow.external.runs[0].context.request.timeoutMs).toBe(1);

    const empty = setup({ onStart: (run) => setTimeout(() => run.finish({ kind: 'completed', outputText: '  ' }), 1) });
    expect(await empty.runner.runAndWait(empty.request())).toMatchObject({ ok: false, error: 'no assistant text returned' });

    const none = setup();
    expect(await none.runner.runAndWait(none.request({ agentRef: { kind: 'external', id: 'codex', runtime: 'codex' } }))).toMatchObject({ ok: false, error: 'runtime codex has no adapter' });

    const external = setup();
    const running = external.runner.runAndWait(external.request({ sessionId: 's-abort' }));
    await flush();
    await external.runner.abort('s-abort');
    expect(await running).toMatchObject({ ok: false, error: 'aborted' });
  });

  it('审批自动应答落在协调器：once 选「允许一次」，deny 或请求里没有 once 时拒绝', async () => {
    const ask = (choices: Array<'once' | 'session' | 'deny'>) => (run: RunControls) => setTimeout(async () => {
      run.emit({ type: 'approval.requested', request: { approvalId: `ap-${choices.join('-')}`, agentId: 'ext', title: 'Bash', choices, timeoutMs: 60_000 } });
      await flush();
      run.finish({ kind: 'completed', outputText: 'done' });
    }, 1);

    const once = setup({ approvals: true, onStart: ask(['once', 'deny']) });
    await once.runner.runAndWait(once.request());
    expect(once.external.runs[0].approvals).toEqual([{ id: 'ap-once-deny', decision: 'once' }]);
    expect(once.business.map((event) => event.type)).toContain('chat.approval.resolved');

    const deny = setup({ approvals: true, onStart: ask(['once', 'deny']) });
    await deny.runner.runAndWait(deny.request({ autoApprove: 'deny' }));
    expect(deny.external.runs[0].approvals).toEqual([{ id: 'ap-once-deny', decision: 'deny' }]);

    const noOnce = setup({ approvals: true, onStart: ask(['session', 'deny']) });
    await noOnce.runner.runAndWait(noOnce.request());
    expect(noOnce.external.runs[0].approvals).toEqual([{ id: 'ap-session-deny', decision: 'deny' }]);
  });

  it('删运行：Runner 删节点会话的通用行；引擎删运行时把节点会话交给 Runner', async () => {
    const t = setup();
    t.runner.discardSessions(['a', 'b']);
    expect(t.deletedSessions).toEqual(['workflow:a', 'workflow:b']);

    const base = setupEngine();
    const { run, evidence } = await base.run([node('x'), node('y')], [edge('x', 'y')]);
    await base.engine.deleteRun(run.workflowId, run.id);
    expect(base.runner.discarded.sort()).toEqual(evidence.nodeExecutions.map((exec) => exec.sessionId).sort());
  });
});
