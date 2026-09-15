/**
 * 经真实 RunCoordinator 跑一次适配器：仲裁、用量去重、工具卡落库都在协调器里，
 * 所以「同轮双路事件不重复」必须对着协调器验，不能只看适配器吐了什么。
 */
import { RealtimeHub, type RealtimeEvent } from '../../../../src/core/realtime';
import type { AgentRuntimeAdapter, CanonicalEvent, ProxyMode } from '../../../../src/runtime/contract';
import { RunCoordinator } from '../../../../src/runtime/coordinator';
import type { CodingAgentRunRequest } from '../../../../src/runtime/adapters/_shared/types';
import { MemoryRunStore } from '../../../helpers/scripted-adapter';

export async function submitThroughCoordinator(
  adapter: AgentRuntimeAdapter<CodingAgentRunRequest>,
  request: CodingAgentRunRequest,
  proxyMode: ProxyMode,
) {
  const hub = new RealtimeHub();
  const realtime: RealtimeEvent[] = [];
  hub.listen('adapter-test', (event) => realtime.push(event));
  const store = new MemoryRunStore();
  const coordinator = new RunCoordinator({ hub, store, log: () => {} });
  const projected: CanonicalEvent[] = [];
  const submitted = await coordinator.submit({
    sessionKey: 'session:s1',
    surface: 'chat',
    topics: ['session:s1'],
    agentId: 'agent-1',
    adapter,
    request,
    proxyMode,
    projector: () => ({ onEvent: (event) => projected.push(event), finish: (outcome) => ({ output: outcome.kind === 'completed' ? outcome.outputText : undefined }) }),
  }, 'reject');
  if (submitted.status !== 'started') throw new Error(`submit ${submitted.status}`);
  return { coordinator, store, realtime, projected, submitted, runId: submitted.run.runId };
}

export function toolStartedIds(realtime: RealtimeEvent[]): string[] {
  return realtime.filter((e) => e.type === 'tool.started').map((e) => (e.payload as any).call_id);
}

export function deltaText(realtime: RealtimeEvent[]): string {
  return realtime.filter((e) => e.type === 'message.delta').map((e) => (e.payload as any).delta).join('');
}
