/**
 * 工作流节点 × 真审批运行时（Pi、Hermes）：`autoApprove: 'once'` 经协调器真的答到运行时进程上。
 *
 * 适配器是真的（Pi RPC 驱动、Hermes ACP 驱动），进程是脚本化的假进程：Pi 发 `extension_ui_request confirm`，
 * Hermes 回放真实录制的 `session/request_permission`。验：Runner → 协调器 → 审批注册表自动答「允许一次」→
 * 驱动写回 Pi 的 `confirmed: true` / Hermes 的 `allow_once`；节点完成；业务事件带 `chat.approval.requested|resolved`；
 * 待办列表（`pendingApprovals`）里从不出现无人值守运行的请求。
 */
import { describe, expect, it } from 'vitest';

import { EventBus, type BusEvent } from '../../src/core/events';
import { RealtimeHub, type RealtimeEvent } from '../../src/core/realtime';
import { RunCoordinator } from '../../src/runtime/coordinator';
import { createPiAdapter } from '../../src/runtime/adapters/pi';
import { createHermesAdapter } from '../../src/runtime/adapters/hermes';
import { createCoordinatorRunner } from '../../src/automation/runner/coordinator-runner';
import type { AgentRunRequest } from '../../src/automation/ports';
import { MemoryRunStore } from '../helpers/scripted-adapter';
import { flushMicrotasks, harness } from '../runtime/adapters/_helpers/harness';
import { loadAcpFixture, replayAcp, type AcpReplay } from '../runtime/adapters/_helpers/acp';

function setup(createAdapter: (runtime: string) => any) {
  const hub = new RealtimeHub();
  const realtime: RealtimeEvent[] = [];
  hub.listen('test', (event) => realtime.push(event));
  const bus = new EventBus();
  const business: BusEvent[] = [];
  bus.subscribe('test', (event) => { business.push(event); });
  const coordinator = new RunCoordinator({ hub, store: new MemoryRunStore(), events: bus, log: () => {} });
  const runner = createCoordinatorRunner({
    runCoordinator: coordinator,
    openclawAdapter: null as any,
    gatewayConnections: { getConnection: async () => ({}) as any, disconnectConnection: () => {} },
    connections: new Map(),
    db: { deleteRunSessionData: () => {} },
    runtimePlatform: { createAdapter },
  });
  const request = (runtime: string, over: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
    sessionId: `node-${runtime}`,
    agentRef: { kind: 'external', id: runtime, runtime },
    input: [{ type: 'text', text: 'delete the junk dir' }],
    workspace: '/work/project',
    timeoutMs: 60_000,
    autoApprove: 'once',
    signal: new AbortController().signal,
    owner: { workflowId: 'wf1', nodeId: 'n1' },
    ...over,
  });
  return { coordinator, runner, request, realtime, business };
}

const writes = (stdin: string) => stdin.split('\n').filter(Boolean).map((line) => JSON.parse(line));

describe('工作流节点的真审批自动应答', () => {
  it('Pi：confirm → 协调器自动答 once → 驱动写回 confirmed: true；节点完成；待办列表不出现', async () => {
    const h = harness();
    const t = setup((runtime) => (runtime === 'pi' ? createPiAdapter(h.deps) : null));
    const pending = t.runner.runAndWait(t.request('pi'));
    const proc = await h.exec.next();
    proc.line({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Run rm -rf ./junk?', timeout: 30_000 });
    for (let i = 0; i < 50 && !writes(proc.stdin).some((m) => m.type === 'extension_ui_response'); i += 1) {
      expect(t.coordinator.pendingApprovals()).toEqual([]);
      await flushMicrotasks(1);
    }
    expect(writes(proc.stdin).find((m) => m.type === 'extension_ui_response')).toEqual({ type: 'extension_ui_response', id: 'ui-1', confirmed: true });
    proc.line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'deleted' } });
    proc.line({ type: 'agent_settled' });
    proc.close(0);
    const result = await pending;
    expect(result).toMatchObject({ ok: true });
    expect(t.business.map((event) => event.type)).toEqual(expect.arrayContaining(['chat.approval.requested', 'chat.approval.resolved']));
    expect(t.business.find((event) => event.type === 'chat.approval.resolved')!.payload).toMatchObject({ runtime: 'pi', surface: 'workflow', decision: 'once' });
    expect(t.realtime.filter((event) => event.topic === 'approvals:runs')).toEqual([]);
  });

  it('Hermes：真实录制的权限请求 → 自动答 once → ACP 回 allow_once', async () => {
    const replays: AcpReplay[] = [];
    const fixture = loadAcpFixture('hermes', 'real-tool-allow-acp.jsonl');
    const h = harness({ executorOptions: { onLaunch: (proc) => { replays.push(replayAcp(proc, fixture)); } } });
    const t = setup((runtime) => (runtime === 'hermes' ? createHermesAdapter(h.deps) : null));
    const pending = t.runner.runAndWait(t.request('hermes'));
    const proc = await h.exec.next();
    for (let i = 0; i < 400 && !(replays[0]?.answers.length); i += 1) await flushMicrotasks(1);
    expect(replays[0].answers[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    for (let i = 0; i < 400 && !proc.stdinEnded; i += 1) await flushMicrotasks(1);
    proc.close(0);
    const result = await pending;
    expect(t.business.find((event) => event.type === 'chat.approval.resolved')!.payload).toMatchObject({ runtime: 'hermes', decision: 'once' });
    expect(result).toMatchObject({ ok: true, sessionId: 'node-hermes' });
  });
});
