/**
 * 运行状态广播。只推**增量**：运行时状态（很小）+ 自上次推送以来新增 / 变更的证据行。
 *
 * 话题名是 `workflow:<id>`，现在经 SSE 投递（`GET /api/workflows/:id/events`）；
 * 协调器的鉴权 WebSocket 落地后，只要把 `subscribe` 的调用方从 SSE 路由换成 WS 话题订阅即可，
 * 这里的增量计算与话题命名不变。
 */
import type { RunEvidence, RunStore } from './run-store';
import type { NodeRuntimeStatus } from './types';

export type RuntimeStatus = {
  workflowId: string;
  runId: string | null;
  status: string;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  error: string | null;
  errorCode: string | null;
  evidenceSeq: number;
  nodeStatuses: Record<string, NodeRuntimeStatus>;
  pendingApprovals: Array<{ nodeId: string; executionId: string }>;
};

export type HubMessage =
  | { type: 'status'; topic: string; status: RuntimeStatus }
  | { type: 'evidence'; topic: string; runId: string; sinceSeq: number; seq: number; evidence: RunEvidence };

export const workflowTopic = (workflowId: string) => `workflow:${workflowId}`;

type Listener = { send: (message: HubMessage) => void; seqByRun: Map<string, number> };

export function createStatusHub(runStore: RunStore) {
  const statuses = new Map<string, RuntimeStatus>();
  const listeners = new Map<string, Set<Listener>>();

  function deliver(listener: Listener, status: RuntimeStatus) {
    const topic = workflowTopic(status.workflowId);
    try {
      listener.send({ type: 'status', topic, status });
      if (!status.runId) return;
      const since = listener.seqByRun.get(status.runId) ?? 0;
      const evidence = runStore.evidenceSince(status.runId, since);
      const seq = Math.max(
        since,
        ...evidence.nodeExecutions.map((row) => row.updatedSeq),
        ...evidence.edgeEvaluations.map((row) => row.sequence),
        ...evidence.loopEpochs.map((row) => row.sequence),
      );
      listener.seqByRun.set(status.runId, seq);
      if (evidence.nodeExecutions.length || evidence.edgeEvaluations.length || evidence.loopEpochs.length) {
        listener.send({ type: 'evidence', topic, runId: status.runId, sinceSeq: since, seq, evidence });
      }
    } catch (error) {
      console.warn('[WorkflowHub] delivery failed:', (error as Error)?.message);
    }
  }

  return {
    get(workflowId: string): RuntimeStatus | null {
      return statuses.get(workflowId) ?? null;
    },

    all(): RuntimeStatus[] {
      return [...statuses.values()];
    },

    update(status: RuntimeStatus): void {
      statuses.set(status.workflowId, status);
      for (const listener of listeners.get(status.workflowId) ?? []) deliver(listener, status);
    },

    forget(workflowId: string): void {
      statuses.delete(workflowId);
    },

    /** `since` 让断线重连的客户端从自己已有的序号续上，而不是重收整次运行。 */
    subscribe(workflowId: string, send: (message: HubMessage) => void, since?: { runId: string; seq: number }): () => void {
      const listener: Listener = { send, seqByRun: new Map(since ? [[since.runId, since.seq]] : []) };
      if (!listeners.has(workflowId)) listeners.set(workflowId, new Set());
      listeners.get(workflowId)!.add(listener);
      const current = statuses.get(workflowId);
      if (current) deliver(listener, current);
      return () => {
        listeners.get(workflowId)?.delete(listener);
      };
    },

    listenerCount(workflowId: string): number {
      return listeners.get(workflowId)?.size ?? 0;
    },
  };
}

export type StatusHub = ReturnType<typeof createStatusHub>;
