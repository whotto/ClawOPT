// 与后端 `backend/src/automation/workflow/types.ts` 同形。改一边要改另一边（接口契约）。

export type AgentRef = { kind: 'openclaw' | 'external'; id: string; runtime?: string };
export type Route = 'success' | 'failure' | 'always';
export const ROUTES: Route[] = ['success', 'failure', 'always'];
export const CONDITION_OPERATORS = [
  'equals', 'not_equals', 'contains', 'not_contains',
  'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal',
  'in', 'not_in', 'exists', 'not_exists',
] as const;
export type ConditionOperator = typeof CONDITION_OPERATORS[number];
export type EdgeCondition = { path: string; operator: ConditionOperator; value?: unknown };
export type EdgeOrchestration = { route: Route; condition?: EdgeCondition; feedback?: { maxIterations: number; loopId?: string } };
export type Attachment = { name: string; url: string; mimeType?: string };

export type WorkflowNodeData = {
  title: string;
  agent: AgentRef;
  input: string;
  skills: string[];
  attachments: Attachment[];
  approvalRequired: boolean;
  orchestration: { join: 'all' | 'any' };
  model?: string;
};

export type WfNode = { id: string; type: 'agent'; position: { x: number; y: number }; width?: number; height?: number; data: WorkflowNodeData };
export type WfEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  data: { orchestration: EdgeOrchestration };
};
export type Viewport = { x: number; y: number; zoom: number };

export type WorkflowSummary = { id: string; name: string; nodeCount: number; edgeCount: number; updatedAt: number };
export type WorkflowDefinition = { id: string; name: string; workspace: string | null; nodes: WfNode[]; edges: WfEdge[]; viewport: Viewport | null; updatedAt: number };

export type RunStatus = 'queued' | 'running' | 'completed' | 'completed_with_failures' | 'failed' | 'canceled';
export const TERMINAL_RUN_STATUSES: RunStatus[] = ['completed', 'completed_with_failures', 'failed', 'canceled'];
export type NodeStatus = 'idle' | 'queued' | 'running' | 'pending_approval' | 'completed' | 'skipped' | 'failed' | 'approval_rejected' | 'canceled';

export type IterationPath = { scope: string | null; steps: Array<{ loopId: string; iteration: number }> };

export type CompiledLoop = { id: string; feedbackEdgeId: string; headerNodeId: string; latchNodeId: string; bodyNodeIds: string[]; maxIterations: number; parentLoopId: string | null };

export type RunRecord = {
  id: string;
  workflowId: string;
  status: RunStatus;
  startNodeIds: string[];
  snapshotNodes?: WfNode[];
  snapshotEdges?: WfEdge[];
  compiledLoops: CompiledLoop[];
  requestedTimeoutMs: number | null;
  deadlineAt: number | null;
  maxConcurrency: number;
  triggerSource: 'manual' | 'scheduled' | 'hook' | 'rerun';
  evidenceSeq: number;
  error: string | null;
  errorCode: string | null;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
};

export type NodeExecution = {
  id: string;
  nodeId: string;
  executionId: string;
  iterationPath: IterationPath;
  consumedEdgeEvaluationIds: string[];
  sessionId: string | null;
  status: 'queued' | 'running' | 'pending_approval' | 'completed' | 'failed' | 'approval_rejected' | 'canceled';
  error: string | null;
  sequence: number;
  updatedSeq: number;
  remainingTimeoutMsAtStart: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
};

export type EdgeEvaluation = {
  id: string;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceExecutionId: string | null;
  iterationPath: IterationPath;
  sourceOutcome: 'success' | 'failure' | 'skipped';
  status: 'taken' | 'not_taken';
  route: Route;
  reason: 'route_not_matched' | 'condition_not_matched' | 'iteration_limit_reached' | null;
  orchestration: EdgeOrchestration;
  conditionEvaluation: { status: 'matched' | 'not_matched'; actual?: unknown; reason?: string | null } | null;
  sequence: number;
  evaluatedAt: number;
};

export type LoopEpoch = {
  id: string;
  loopId: string;
  iteration: number;
  iterationPath: IterationPath;
  status: 'completed' | 'failed' | 'canceled' | 'timed_out' | 'approval_rejected';
  exitReason: string | null;
  sequence: number;
  startedAt: number;
  finishedAt: number;
};

export type RunEvidence = { nodeExecutions: NodeExecution[]; edgeEvaluations: EdgeEvaluation[]; loopEpochs: LoopEpoch[] };

export type RuntimeStatus = {
  workflowId: string;
  runId: string | null;
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  errorCode: string | null;
  evidenceSeq: number;
  nodeStatuses: Record<string, NodeStatus>;
  pendingApprovals: Array<{ nodeId: string; executionId: string }>;
};

export type AgentEntry = { ref: AgentRef; name: string; available: boolean; reason?: string; skills: string[] };

export type Transcript = {
  executionId: string;
  nodeId: string;
  sessionId: string | null;
  agent: { kind: string | null; id: string | null };
  status: string;
  prompt: string | null;
  output: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export type ScheduleRecord = {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  input: string | null;
  startNodeIds: string[];
  timeoutMs: number | null;
  lastScheduledAt: number | null;
  nextRunAt: number | null;
  lastRunId: string | null;
  lastError: string | null;
};

export type HookRecord = {
  id: string;
  name: string;
  enabled: boolean;
  startNodeIds: string[];
  timeoutMs: number | null;
  lastTriggeredAt: number | null;
  lastRunId: string | null;
  hasSecret: boolean;
};
