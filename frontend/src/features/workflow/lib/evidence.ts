// 运行证据的纯函数：合并增量、当前轮次过滤（重跑只看最新一次）、节点 / 边的回放状态、三个页签的投影。

import { TERMINAL_RUN_STATUSES, type EdgeEvaluation, type IterationPath, type LoopEpoch, type NodeExecution, type NodeStatus, type RunEvidence, type RunRecord, type RunStatus, type WfEdge } from './types';

export const emptyEvidence = (): RunEvidence => ({ nodeExecutions: [], edgeEvaluations: [], loopEpochs: [] });

/** 合并增量：节点执行按 id 覆盖（状态会变），判定与循环轮次只追加（按 id 去重）。结果按 sequence 排序。 */
export function mergeEvidence(base: RunEvidence, delta: RunEvidence): RunEvidence {
  const execs = new Map(base.nodeExecutions.map((row) => [row.id, row]));
  for (const row of delta.nodeExecutions) execs.set(row.id, row);
  const evals = new Map(base.edgeEvaluations.map((row) => [row.id, row]));
  for (const row of delta.edgeEvaluations) evals.set(row.id, row);
  const epochs = new Map(base.loopEpochs.map((row) => [row.id, row]));
  for (const row of delta.loopEpochs) epochs.set(row.id, row);
  const bySeq = <T extends { sequence: number }>(rows: T[]) => rows.sort((a, b) => a.sequence - b.sequence);
  return {
    nodeExecutions: bySeq([...execs.values()]),
    edgeEvaluations: bySeq([...evals.values()]),
    loopEpochs: bySeq([...epochs.values()]),
  };
}

export function maxSeq(evidence: RunEvidence): number {
  return Math.max(0, ...evidence.nodeExecutions.map((row) => row.updatedSeq), ...evidence.edgeEvaluations.map((row) => row.sequence), ...evidence.loopEpochs.map((row) => row.sequence));
}

/**
 * 当前轮次：只看运行最近一次开始（重跑会刷新 startedAt）之后的证据。
 * 例外：本轮执行实际消费了的更早判定（重跑时保留的上游边界边）也留下——它说明了这一轮拿到的上游上下文从哪来。
 */
export function currentEpoch(run: Pick<RunRecord, 'startedAt'>, evidence: RunEvidence): RunEvidence {
  const nodeExecutions = evidence.nodeExecutions.filter((row) => row.createdAt >= run.startedAt);
  const consumed = new Set(nodeExecutions.flatMap((row) => row.consumedEdgeEvaluationIds));
  return {
    nodeExecutions,
    edgeEvaluations: evidence.edgeEvaluations.filter((row) => row.evaluatedAt >= run.startedAt || consumed.has(row.id)),
    loopEpochs: evidence.loopEpochs.filter((row) => row.startedAt >= run.startedAt || row.finishedAt >= run.startedAt),
  };
}

export const isRunLive = (status: RunStatus | string) => !TERMINAL_RUN_STATUSES.includes(status as RunStatus);

/** 回放时的节点状态：运行活着用实时状态；否则用最新一次执行；没有执行但入边都没走通 = 跳过。 */
export function replayNodeStatus(
  nodeId: string,
  run: Pick<RunRecord, 'status'>,
  evidence: RunEvidence,
  liveStatuses: Record<string, NodeStatus> | null,
): NodeStatus {
  if (liveStatuses && isRunLive(run.status) && liveStatuses[nodeId]) return liveStatuses[nodeId];
  const execs = evidence.nodeExecutions.filter((row) => row.nodeId === nodeId);
  const latest = execs[execs.length - 1];
  if (latest) return latest.status === 'queued' ? 'queued' : latest.status;
  const incoming = evidence.edgeEvaluations.filter((row) => row.targetNodeId === nodeId);
  if (incoming.length && incoming.every((row) => row.status === 'not_taken')) return 'skipped';
  return isRunLive(run.status) ? 'queued' : 'idle';
}

export type EdgePlayback = 'idle' | 'inactive' | 'flowing' | 'completed' | 'failed' | 'failed-flowing';

export function edgePlayback(edge: WfEdge, run: Pick<RunRecord, 'status'>, evidence: RunEvidence, targetStatus: NodeStatus): EdgePlayback {
  const rows = evidence.edgeEvaluations.filter((row) => row.edgeId === edge.id);
  if (!rows.length) return 'idle';
  const taken = rows.filter((row) => row.status === 'taken');
  if (!taken.length) return 'inactive';
  const failed = taken.some((row) => row.sourceOutcome === 'failure') || ['failed', 'approval_rejected', 'canceled'].includes(targetStatus);
  const flowing = ['queued', 'running', 'pending_approval'].includes(targetStatus) && isRunLive(run.status);
  if (failed) return flowing ? 'failed-flowing' : 'failed';
  return flowing ? 'flowing' : 'completed';
}

export type EvidenceRow =
  | { kind: 'edge'; sequence: number; consumed: boolean; row: EdgeEvaluation }
  | { kind: 'node'; sequence: number; row: NodeExecution }
  | { kind: 'loop'; sequence: number; row: LoopEpoch };

/** 三个页签：实际路径（被消费或走通的边）/ 其他判定（没走通的边 + 异常节点 + 循环）/ 循环。 */
export function evidenceTabs(evidence: RunEvidence) {
  const consumed = new Set(evidence.nodeExecutions.flatMap((row) => row.consumedEdgeEvaluationIds));
  const edges: EvidenceRow[] = evidence.edgeEvaluations.map((row) => ({ kind: 'edge', sequence: row.sequence, consumed: consumed.has(row.id), row }));
  const exceptional: EvidenceRow[] = evidence.nodeExecutions
    .filter((row) => ['failed', 'approval_rejected', 'canceled'].includes(row.status))
    .map((row) => ({ kind: 'node', sequence: row.sequence, row }));
  const loops: EvidenceRow[] = evidence.loopEpochs.map((row) => ({ kind: 'loop', sequence: row.sequence, row }));
  const sort = (rows: EvidenceRow[]) => rows.sort((a, b) => a.sequence - b.sequence);
  return {
    actual: sort(edges.filter((row) => row.kind === 'edge' && (row.consumed || row.row.status === 'taken'))),
    other: sort([...edges.filter((row) => row.kind === 'edge' && !row.consumed && row.row.status === 'not_taken'), ...exceptional, ...loops]),
    loops: sort([...loops]),
  };
}

/** `审稿#2 / 细节#0`，重跑的执行前缀一个标记。 */
export function formatIterationPath(path: IterationPath, loopTitle: (loopId: string) => string, rerunLabel: string): string {
  const steps = path.steps.map((step) => `${loopTitle(step.loopId)}#${step.iteration + 1}`).join(' / ');
  if (path.scope?.startsWith('rerun:')) return steps ? `${rerunLabel} · ${steps}` : rerunLabel;
  return steps;
}

/** 条件实际值里的业务字段：decision / failed_gate / reason 一类，回放时单独亮出来。 */
export function businessProjection(actual: unknown): { decision?: string; gate?: string; reason?: string } | null {
  let value = actual;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pickText = (...keys: string[]) => keys.map((key) => record[key]).find((item) => typeof item === 'string') as string | undefined;
  const reasons = Array.isArray(record.blocking_reasons) ? record.blocking_reasons.filter((item) => typeof item === 'string').join('; ') : undefined;
  const projection = { decision: pickText('decision'), gate: pickText('failed_gate'), reason: pickText('reason', 'root_cause', 'message', 'error') ?? reasons };
  return projection.decision || projection.gate || projection.reason ? projection : null;
}
