/**
 * 运行与证据仓储。**终态不可逆在这一层强制**，不靠服务层记得检查：
 *
 * - 运行一旦 completed / completed_with_failures / failed / canceled，状态更新一律无效
 *   （唯一例外是重跑的显式重置 `resetForRerun`，带乐观并发条件）；
 * - 节点执行同理，终态之后改不动；
 * - 终态运行上**不许追加证据**。例外只有「收尾型」循环轮次（非 completed 状态），
 *   它记录的是「这一轮为什么没跑完」，属于终态的一部分。
 *
 * 三张证据表共用运行行上的 `evidence_seq`：每次追加在同一个事务里 +1 并取回，
 * 天然全序、天然与终态检查原子（`UPDATE ... WHERE status NOT IN 终态 RETURNING`）。
 */
import type Database from 'better-sqlite3';

import { newId, parseJson } from '../shared/util';
import {
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
  type CompiledLoop,
  type ConditionEvaluation,
  type DecisionReason,
  type DecisionStatus,
  type EdgeOrchestration,
  type ExecutionStatus,
  type IterationPath,
  type LoopEpochStatus,
  type Route,
  type RunStatus,
  type SourceOutcome,
  type TriggerSource,
  type WorkflowEdge,
  type WorkflowNode,
} from './types';

const TERMINAL_RUN_SQL = `('${[...TERMINAL_RUN_STATUSES].join("','")}')`;
const TERMINAL_EXEC_SQL = `('${[...TERMINAL_EXECUTION_STATUSES].join("','")}')`;

export type RunRecord = {
  id: string;
  workflowId: string;
  workspace: string | null;
  status: RunStatus;
  startNodeIds: string[];
  input: string | null;
  /** 运行输入覆盖作用于哪些节点（首次运行的开始节点）。重跑改写开始节点但不改它。 */
  inputStartNodeIds: string[];
  snapshotNodes: WorkflowNode[];
  snapshotEdges: WorkflowEdge[];
  compiledLoops: CompiledLoop[];
  requestedTimeoutMs: number | null;
  deadlineAt: number | null;
  maxConcurrency: number;
  triggerSource: TriggerSource;
  scheduledAt: number | null;
  evidenceSeq: number;
  error: string | null;
  errorCode: string | null;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
};

export type NodeExecutionRecord = {
  id: string;
  runId: string;
  nodeId: string;
  executionId: string;
  iterationPath: IterationPath;
  consumedEdgeEvaluationIds: string[];
  sessionId: string | null;
  agentKind: string | null;
  agentId: string | null;
  status: ExecutionStatus;
  promptText: string | null;
  outputText: string | null;
  error: string | null;
  sequence: number;
  updatedSeq: number;
  remainingTimeoutMsAtStart: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
};

export type EdgeEvaluationRecord = {
  id: string;
  runId: string;
  edgeId: string;
  sourceNodeId: string;
  sourceExecutionId: string | null;
  targetNodeId: string;
  iterationPath: IterationPath;
  sourceOutcome: SourceOutcome;
  status: DecisionStatus;
  route: Route;
  reason: DecisionReason;
  orchestration: EdgeOrchestration;
  conditionEvaluation: ConditionEvaluation | null;
  sequence: number;
  evaluatedAt: number;
};

export type LoopEpochRecord = {
  id: string;
  runId: string;
  loopId: string;
  iteration: number;
  iterationPath: IterationPath;
  status: LoopEpochStatus;
  exitReason: string | null;
  sequence: number;
  startedAt: number;
  finishedAt: number;
};

export type RunEvidence = {
  nodeExecutions: NodeExecutionRecord[];
  edgeEvaluations: EdgeEvaluationRecord[];
  loopEpochs: LoopEpochRecord[];
};

export class TerminalRunError extends Error {
  constructor(runId: string) {
    super(`workflow run ${runId} is terminal; evidence is sealed`);
    this.name = 'TerminalRunError';
  }
}

const runFromRow = (row: any): RunRecord => ({
  id: row.id,
  workflowId: row.workflow_id,
  workspace: row.workspace,
  status: row.status,
  startNodeIds: parseJson(row.start_node_ids_json, []),
  input: row.input,
  inputStartNodeIds: parseJson(row.input_start_node_ids_json, []),
  snapshotNodes: parseJson(row.snapshot_nodes_json, []),
  snapshotEdges: parseJson(row.snapshot_edges_json, []),
  compiledLoops: parseJson(row.compiled_loops_json, []),
  requestedTimeoutMs: row.requested_timeout_ms,
  deadlineAt: row.deadline_at,
  maxConcurrency: row.max_concurrency,
  triggerSource: row.trigger_source,
  scheduledAt: row.scheduled_at,
  evidenceSeq: row.evidence_seq,
  error: row.error,
  errorCode: row.error_code,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  createdAt: row.created_at,
});

const execFromRow = (row: any): NodeExecutionRecord => ({
  id: row.id,
  runId: row.run_id,
  nodeId: row.node_id,
  executionId: row.execution_id,
  iterationPath: parseJson(row.iteration_path_json, { scope: null, steps: [] }),
  consumedEdgeEvaluationIds: parseJson(row.consumed_edge_evaluation_ids_json, []),
  sessionId: row.session_id,
  agentKind: row.agent_kind,
  agentId: row.agent_id,
  status: row.status,
  promptText: row.prompt_text,
  outputText: row.output_text,
  error: row.error,
  sequence: row.sequence,
  updatedSeq: row.updated_seq,
  remainingTimeoutMsAtStart: row.remaining_timeout_ms_at_start,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  createdAt: row.created_at,
});

const evalFromRow = (row: any): EdgeEvaluationRecord => ({
  id: row.id,
  runId: row.run_id,
  edgeId: row.edge_id,
  sourceNodeId: row.source_node_id,
  sourceExecutionId: row.source_execution_id,
  targetNodeId: row.target_node_id,
  iterationPath: parseJson(row.iteration_path_json, { scope: null, steps: [] }),
  sourceOutcome: row.source_outcome,
  status: row.status,
  route: row.route,
  reason: row.reason,
  orchestration: parseJson(row.orchestration_json, { route: 'success' }),
  conditionEvaluation: parseJson(row.condition_evaluation_json, null),
  sequence: row.sequence,
  evaluatedAt: row.evaluated_at,
});

const epochFromRow = (row: any): LoopEpochRecord => ({
  id: row.id,
  runId: row.run_id,
  loopId: row.loop_id,
  iteration: row.iteration,
  iterationPath: parseJson(row.iteration_path_json, { scope: null, steps: [] }),
  status: row.status,
  exitReason: row.exit_reason,
  sequence: row.sequence,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export function createRunStore(db: Database.Database, now: () => number = Date.now) {
  const bumpChecked = db.prepare(`UPDATE workflow_runs SET evidence_seq = evidence_seq + 1 WHERE id = ? AND status NOT IN ${TERMINAL_RUN_SQL} RETURNING evidence_seq`);
  const bumpAny = db.prepare('UPDATE workflow_runs SET evidence_seq = evidence_seq + 1 WHERE id = ? RETURNING evidence_seq');

  function nextSeq(runId: string, allowTerminal = false): number {
    const row = (allowTerminal ? bumpAny : bumpChecked).get(runId) as { evidence_seq: number } | undefined;
    if (!row) throw new TerminalRunError(runId);
    return row.evidence_seq;
  }

  const store = {
    createRun(input: Omit<RunRecord, 'evidenceSeq' | 'error' | 'errorCode' | 'finishedAt' | 'createdAt' | 'id'> & { id?: string }): RunRecord {
      const id = input.id ?? newId();
      db.prepare(`INSERT INTO workflow_runs (id, workflow_id, workspace, status, start_node_ids_json, input, input_start_node_ids_json, snapshot_nodes_json,
          snapshot_edges_json, compiled_loops_json, requested_timeout_ms, deadline_at, max_concurrency, trigger_source, scheduled_at,
          evidence_seq, started_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
        id, input.workflowId, input.workspace, input.status, JSON.stringify(input.startNodeIds), input.input, JSON.stringify(input.inputStartNodeIds),
        JSON.stringify(input.snapshotNodes), JSON.stringify(input.snapshotEdges), JSON.stringify(input.compiledLoops),
        input.requestedTimeoutMs, input.deadlineAt, input.maxConcurrency, input.triggerSource, input.scheduledAt,
        input.startedAt, now(),
      );
      return store.getRun(id)!;
    },

    getRun(id: string): RunRecord | null {
      const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id);
      return row ? runFromRow(row) : null;
    },

    listRuns(workflowId: string, limit: number): RunRecord[] {
      return (db.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC, started_at DESC LIMIT ?').all(workflowId, limit)).map(runFromRow);
    },

    activeRunForWorkflow(workflowId: string): RunRecord | null {
      const row = db.prepare(`SELECT * FROM workflow_runs WHERE workflow_id = ? AND status NOT IN ${TERMINAL_RUN_SQL} LIMIT 1`).get(workflowId);
      return row ? runFromRow(row) : null;
    },

    listActiveRuns(): RunRecord[] {
      return db.prepare(`SELECT * FROM workflow_runs WHERE status NOT IN ${TERMINAL_RUN_SQL}`).all().map(runFromRow);
    },

    /** 终态粘滞：已终态返回 false，什么都不改。 */
    setRunStatus(runId: string, status: RunStatus, extra: { error?: string | null; errorCode?: string | null } = {}): boolean {
      const finishedAt = TERMINAL_RUN_STATUSES.has(status) ? now() : null;
      const result = db.prepare(`UPDATE workflow_runs SET status = ?, error = COALESCE(?, error), error_code = COALESCE(?, error_code),
          finished_at = COALESCE(?, finished_at)
        WHERE id = ? AND status NOT IN ${TERMINAL_RUN_SQL}`).run(status, extra.error ?? null, extra.errorCode ?? null, finishedAt, runId);
      return result.changes > 0;
    },

    /**
     * 重跑的显式重置：只在「还是预检时看到的那一版」时成功（状态、开始、结束三者都没变），
     * 并发的两次重跑只有一个赢。
     */
    resetForRerun(runId: string, expected: Pick<RunRecord, 'status' | 'startedAt' | 'finishedAt'>, next: {
      startedAt: number; deadlineAt: number | null; requestedTimeoutMs: number | null; maxConcurrency: number; startNodeIds: string[];
    }): boolean {
      const result = db.prepare(`UPDATE workflow_runs SET status = 'running', started_at = ?, deadline_at = ?, requested_timeout_ms = ?,
          max_concurrency = ?, start_node_ids_json = ?, trigger_source = 'rerun', error = NULL, error_code = NULL, finished_at = NULL
        WHERE id = ? AND status = ? AND started_at = ? AND finished_at IS ?`).run(
        next.startedAt, next.deadlineAt, next.requestedTimeoutMs, next.maxConcurrency, JSON.stringify(next.startNodeIds),
        runId, expected.status, expected.startedAt, expected.finishedAt,
      );
      return result.changes > 0;
    },

    insertExecution(input: {
      runId: string; workflowId: string; nodeId: string; executionId: string; iterationPath: IterationPath;
      consumedEdgeEvaluationIds: string[]; sessionId: string; agentKind: string; agentId: string; status: ExecutionStatus;
      promptText: string; remainingTimeoutMsAtStart: number | null;
    }): NodeExecutionRecord {
      const id = newId();
      db.transaction(() => {
        const seq = nextSeq(input.runId);
        const at = now();
        db.prepare(`INSERT INTO workflow_node_executions (id, run_id, workflow_id, node_id, execution_id, iteration_path_json,
            consumed_edge_evaluation_ids_json, session_id, agent_kind, agent_id, status, prompt_text, sequence, updated_seq,
            remaining_timeout_ms_at_start, started_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, input.runId, input.workflowId, input.nodeId, input.executionId, JSON.stringify(input.iterationPath),
          JSON.stringify(input.consumedEdgeEvaluationIds), input.sessionId, input.agentKind, input.agentId, input.status,
          input.promptText, seq, seq, input.remainingTimeoutMsAtStart, at, at,
        );
      })();
      return store.getExecution(input.runId, input.executionId)!;
    },

    getExecution(runId: string, executionId: string): NodeExecutionRecord | null {
      const row = db.prepare('SELECT * FROM workflow_node_executions WHERE run_id = ? AND execution_id = ?').get(runId, executionId);
      return row ? execFromRow(row) : null;
    },

    /** 节点执行状态更新：执行已终态、或运行已终态，都返回 false。 */
    updateExecution(runId: string, executionId: string, patch: { status: ExecutionStatus; outputText?: string | null; error?: string | null }): boolean {
      let changed = false;
      try {
        db.transaction(() => {
          const current = db.prepare('SELECT status FROM workflow_node_executions WHERE run_id = ? AND execution_id = ?').get(runId, executionId) as { status: string } | undefined;
          if (!current || TERMINAL_EXECUTION_STATUSES.has(current.status)) return;
          const seq = nextSeq(runId);
          const finishedAt = TERMINAL_EXECUTION_STATUSES.has(patch.status) ? now() : null;
          db.prepare(`UPDATE workflow_node_executions SET status = ?, output_text = COALESCE(?, output_text), error = COALESCE(?, error),
              updated_seq = ?, finished_at = COALESCE(?, finished_at)
            WHERE run_id = ? AND execution_id = ? AND status NOT IN ${TERMINAL_EXEC_SQL}`).run(
            patch.status, patch.outputText ?? null, patch.error ?? null, seq, finishedAt, runId, executionId,
          );
          changed = true;
        })();
      } catch (error) {
        if (error instanceof TerminalRunError) return false;
        throw error;
      }
      return changed;
    },

    /** 把运行里所有未终态的节点执行一次性收尾（停止、到期、重启恢复共用）。 */
    closeActiveExecutions(runId: string, status: ExecutionStatus, error: string): string[] {
      const rows = db.prepare(`SELECT execution_id FROM workflow_node_executions WHERE run_id = ? AND status NOT IN ${TERMINAL_EXEC_SQL}`).all(runId) as Array<{ execution_id: string }>;
      const closed: string[] = [];
      for (const row of rows) {
        if (store.updateExecution(runId, row.execution_id, { status, error })) closed.push(row.execution_id);
      }
      return closed;
    },

    appendEdgeEvaluation(input: {
      runId: string; workflowId: string; edge: WorkflowEdge; sourceExecutionId: string | null; iterationPath: IterationPath;
      sourceOutcome: SourceOutcome; status: DecisionStatus; reason: DecisionReason; conditionEvaluation?: ConditionEvaluation;
    }): EdgeEvaluationRecord {
      const id = newId();
      db.transaction(() => {
        const seq = nextSeq(input.runId);
        db.prepare(`INSERT INTO workflow_edge_evaluations (id, run_id, workflow_id, edge_id, source_node_id, source_execution_id,
            target_node_id, iteration_path_json, source_outcome, status, route, reason, orchestration_json, condition_evaluation_json,
            sequence, evaluated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, input.runId, input.workflowId, input.edge.id, input.edge.source, input.sourceExecutionId, input.edge.target,
          JSON.stringify(input.iterationPath), input.sourceOutcome, input.status, input.edge.data.orchestration.route,
          input.reason, JSON.stringify(input.edge.data.orchestration),
          input.conditionEvaluation ? safeJson(input.conditionEvaluation) : null, seq, now(),
        );
      })();
      return evalFromRow(db.prepare('SELECT * FROM workflow_edge_evaluations WHERE id = ?').get(id));
    },

    appendLoopEpoch(input: {
      runId: string; workflowId: string; loopId: string; iteration: number; iterationPath: IterationPath;
      status: LoopEpochStatus; exitReason: string | null; startedAt: number;
    }): LoopEpochRecord {
      const id = newId();
      db.transaction(() => {
        const seq = nextSeq(input.runId, input.status !== 'completed');
        db.prepare(`INSERT OR IGNORE INTO workflow_loop_epochs (id, run_id, workflow_id, loop_id, iteration, iteration_path_json, status,
            exit_reason, sequence, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, input.runId, input.workflowId, input.loopId, input.iteration, JSON.stringify(input.iterationPath), input.status,
          input.exitReason, seq, input.startedAt, now(),
        );
      })();
      const row = db.prepare('SELECT * FROM workflow_loop_epochs WHERE run_id = ? AND loop_id = ? AND iteration_path_json = ?')
        .get(input.runId, input.loopId, JSON.stringify(input.iterationPath));
      return epochFromRow(row);
    },

    evidence(runId: string): RunEvidence {
      return store.evidenceSince(runId, 0);
    },

    /** 增量：updated_seq / sequence 大于 since 的行。实时推送只推这些。 */
    evidenceSince(runId: string, since: number): RunEvidence {
      return {
        nodeExecutions: db.prepare('SELECT * FROM workflow_node_executions WHERE run_id = ? AND updated_seq > ? ORDER BY sequence').all(runId, since).map(execFromRow),
        edgeEvaluations: db.prepare('SELECT * FROM workflow_edge_evaluations WHERE run_id = ? AND sequence > ? ORDER BY sequence').all(runId, since).map(evalFromRow),
        loopEpochs: db.prepare('SELECT * FROM workflow_loop_epochs WHERE run_id = ? AND sequence > ? ORDER BY sequence').all(runId, since).map(epochFromRow),
      };
    },

    /** 每个节点最新（sequence 最大）的一次执行。 */
    latestExecutions(runId: string): Map<string, NodeExecutionRecord> {
      const rows = db.prepare('SELECT * FROM workflow_node_executions WHERE run_id = ? ORDER BY sequence').all(runId).map(execFromRow);
      const out = new Map<string, NodeExecutionRecord>();
      for (const row of rows) out.set(row.nodeId, row);
      return out;
    },

    /** 某个节点某次执行之后，出边的最新判定。 */
    latestEdgeEvaluations(runId: string): Map<string, EdgeEvaluationRecord> {
      const rows = db.prepare('SELECT * FROM workflow_edge_evaluations WHERE run_id = ? ORDER BY sequence').all(runId).map(evalFromRow);
      const out = new Map<string, EdgeEvaluationRecord>();
      for (const row of rows) out.set(row.edgeId, row);
      return out;
    },

    deleteRun(runId: string): void {
      db.transaction(() => {
        db.prepare('DELETE FROM workflow_edge_evaluations WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM workflow_loop_epochs WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM workflow_node_executions WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(runId);
      })();
    },

    runIdsForWorkflow(workflowId: string): string[] {
      return (db.prepare('SELECT id FROM workflow_runs WHERE workflow_id = ?').all(workflowId) as Array<{ id: string }>).map((row) => row.id);
    },

    pendingApprovalExecutions(): Array<NodeExecutionRecord & { workflowId: string }> {
      const rows = db.prepare(`SELECT e.*, e.workflow_id AS wf FROM workflow_node_executions e
        JOIN workflow_runs r ON r.id = e.run_id
        WHERE e.status = 'pending_approval' AND r.status NOT IN ${TERMINAL_RUN_SQL}`).all() as any[];
      return rows.map((row) => ({ ...execFromRow(row), workflowId: row.wf }));
    },
  };
  return store;
}

/** 条件实际值可能是任意 JSON；超大时截断，避免证据表被一次输出撑爆。 */
function safeJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= 16_000) return text;
  const clone = { ...(value as Record<string, unknown>) };
  clone.actual = typeof clone.actual === 'string' ? `${(clone.actual as string).slice(0, 8000)}…` : '[truncated]';
  return JSON.stringify(clone);
}

export type RunStore = ReturnType<typeof createRunStore>;
