/**
 * 运行状态广播。只推**增量**：运行时状态（很小）+ 自上次推送以来新增 / 变更的证据行。
 *
 * 两条投递：
 * - **WebSocket（主）**：`publish` 把增量发进实时中枢的 `workflow:<id>` 主题（`workflow.status` / `workflow.evidence`）。
 *   中枢是广播，没有逐订阅者状态，所以增量游标是**主题级**的一份；新订阅者先拿 `snapshot()`（当前状态 + 当前运行的全部证据），
 *   之后的增量与快照可能重叠——客户端按行键合并（`mergeEvidence`），重叠无害。
 *   待审批集合一变，另发一条不带内容的 `approvals:workflows` / `workflow.approvals.changed`，待办中心据此重新拉自己看得见的列表。
 * - **SSE（兜底）**：`subscribe` 的逐监听者增量（`GET /api/workflows/:id/events`，`since` 续传），WebSocket 不可用时前端退回这里。
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
export const WORKFLOW_APPROVALS_TOPIC = 'approvals:workflows';

export type StatusHubOptions = {
  /** 发进实时中枢（WS 主题）。缺省 = 只有 SSE 监听者。 */
  publish?: (topic: string, type: string, payload: unknown) => void;
  /**
   * 主题有没有 WS 订阅者（实时中枢的订阅计数）。给了且为 false 时跳过这一主题的负载计算（读增量证据、拼消息），
   * 只把主题级游标推到 `status.evidenceSeq`——之后有人订阅先拿 resume 快照，增量从当前序号接着算，
   * 不会补发一大段早就在快照里的证据。缺省 = 一律当作有订阅者（单测与旧装配行为不变）。
   */
  hasSubscribers?: (topic: string) => boolean;
};

type Listener = { send: (message: HubMessage) => void; seqByRun: Map<string, number> };

export function createStatusHub(runStore: RunStore, options: StatusHubOptions = {}) {
  const statuses = new Map<string, RuntimeStatus>();
  const listeners = new Map<string, Set<Listener>>();
  const publish = options.publish;
  const hasSubscribers = options.hasSubscribers ?? (() => true);
  /** 主题级的增量游标：所有 WS 订阅者共用。 */
  const broadcast: Listener | null = publish
    ? {
      send: (message) => publish(message.topic, message.type === 'status' ? 'workflow.status' : 'workflow.evidence', message),
      seqByRun: new Map(),
    }
    : null;
  const approvalsKey = (status: RuntimeStatus | null | undefined) => JSON.stringify(status?.pendingApprovals ?? []);

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
      const previous = statuses.get(status.workflowId);
      statuses.set(status.workflowId, status);
      for (const listener of listeners.get(status.workflowId) ?? []) deliver(listener, status);
      if (broadcast && publish) {
        if (hasSubscribers(workflowTopic(status.workflowId))) deliver(broadcast, status);
        else if (status.runId) broadcast.seqByRun.set(status.runId, status.evidenceSeq);
        // 运行结束后游标不再用得上：不让它随运行次数无限增长。
        if (status.runId && status.finishedAt !== null) broadcast.seqByRun.delete(status.runId);
        if (approvalsKey(previous) !== approvalsKey(status)) publish(WORKFLOW_APPROVALS_TOPIC, 'workflow.approvals.changed', {});
      }
    },

    forget(workflowId: string): void {
      const previous = statuses.get(workflowId);
      statuses.delete(workflowId);
      if (publish && approvalsKey(previous) !== approvalsKey(null)) publish(WORKFLOW_APPROVALS_TOPIC, 'workflow.approvals.changed', {});
    },

    /** WS 订阅（带 resume）时的快照：当前状态 + 当前运行的全部证据与最大序号。 */
    snapshot(workflowId: string): { status: RuntimeStatus | null; runId: string | null; evidence: RunEvidence | null } {
      const status = statuses.get(workflowId) ?? null;
      const runId = status?.runId ?? null;
      return { status, runId, evidence: runId ? runStore.evidence(runId) : null };
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
