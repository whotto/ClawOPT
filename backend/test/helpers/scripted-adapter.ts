/**
 * 协调器用例用的脚本化适配器与内存存储。
 *
 * 适配器本身不含任何协调逻辑：测试拿到 `controls` 后手动 emit 事件、决定何时结束，
 * 协调器的每一条义务都在它之外被验证。
 */
import {
  defineCapabilities,
  NATIVE_ONLY_SOURCE_OF_TRUTH,
  type AdapterEvent,
  type AdapterRunContext,
  type AdapterRunHandle,
  type AdapterRunOutcome,
  type AgentRuntimeAdapter,
  type CanonicalEvent,
  type InterruptReason,
  type RuntimeCapabilities,
  type SourceOfTruthTable,
} from '../../src/runtime/contract';
import type { PersistedToolCall, RunStore, SessionUsageRow } from '../../src/runtime/coordinator';

export const PLAIN_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: false,
  approvals: false,
  clarify: false,
  hostCompression: false,
  nativeCompact: false,
  backgroundDelegation: false,
  images: false,
  mcpInjection: false,
  proxyMode: [],
});

export type RunControls = {
  context: AdapterRunContext<any>;
  emit: (event: CanonicalEvent, channel?: AdapterEvent['channel']) => void;
  finish: (outcome: AdapterRunOutcome) => void;
  interrupts: InterruptReason[];
  approvals: Array<{ id: string; decision: string }>;
  clarifies: Array<{ id: string; response: string }>;
};

export function scriptedAdapter(options: {
  id?: string;
  capabilities?: RuntimeCapabilities;
  sourceOfTruth?: SourceOfTruthTable;
  /** interrupt 时不自动结束（模拟卡死的运行时）。 */
  hangOnInterrupt?: boolean;
  onStart?: (controls: RunControls) => void;
} = {}) {
  const runs: RunControls[] = [];
  const adapter: AgentRuntimeAdapter<any> = {
    id: options.id ?? 'scripted',
    capabilities: options.capabilities ?? PLAIN_CAPABILITIES,
    sourceOfTruth: options.sourceOfTruth ?? NATIVE_ONLY_SOURCE_OF_TRUTH,
    start(context) {
      let resolveDone!: (outcome: AdapterRunOutcome) => void;
      let finished = false;
      const done = new Promise<AdapterRunOutcome>((resolve) => { resolveDone = resolve; });
      const controls: RunControls = {
        context,
        emit: (event, channel = 'native') => context.emit({ channel, event }),
        finish: (outcome) => { if (!finished) { finished = true; resolveDone(outcome); } },
        interrupts: [],
        approvals: [],
        clarifies: [],
      };
      runs.push(controls);
      const handle: AdapterRunHandle = {
        done,
        status: () => ({ phase: finished ? 'finished' : 'running' }),
        interrupt: async (reason) => {
          controls.interrupts.push(reason);
          if (!options.hangOnInterrupt) controls.finish({ kind: 'aborted', reason, synced: true, phase: 'running' });
          return { synced: !options.hangOnInterrupt };
        },
        resolveApproval: (id, decision) => { controls.approvals.push({ id, decision }); return true; },
        resolveClarify: (id, response) => { controls.clarifies.push({ id, response }); return true; },
      };
      options.onStart?.(controls);
      return handle;
    },
  };
  return { adapter, runs };
}

export class MemoryRunStore implements RunStore {
  calls: string[] = [];
  sessions = new Map<string, { runCount: number; endedReason: string | null }>();
  toolCallBatches: PersistedToolCall[][] = [];
  usage: SessionUsageRow[] = [];
  private usageKeys = new Set<string>();

  ensureRunSession(input: { sessionKey: string }): void {
    this.calls.push(`ensure:${input.sessionKey}`);
    const row = this.sessions.get(input.sessionKey);
    this.sessions.set(input.sessionKey, { runCount: (row?.runCount ?? 0) + 1, endedReason: null });
  }

  markRunSessionEnded(sessionKey: string, reason: string): void {
    this.calls.push(`ended:${sessionKey}:${reason}`);
    const row = this.sessions.get(sessionKey);
    if (row) row.endedReason = reason;
  }

  persistToolCalls(calls: PersistedToolCall[]): void {
    this.calls.push(`tools:${calls.map((call) => call.callId).join(',')}`);
    this.toolCallBatches.push(calls);
  }

  recordSessionUsage(row: SessionUsageRow): boolean {
    const key = `${row.sessionKey}|${row.callId}|${row.source}`;
    if (row.callId && this.usageKeys.has(key)) return false;
    if (row.callId) this.usageKeys.add(key);
    this.usage.push(row);
    return true;
  }
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
