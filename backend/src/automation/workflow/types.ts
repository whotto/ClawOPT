import type { WorkflowAgentRef } from '../ports';

export const ROUTES = ['success', 'failure', 'always'] as const;
export type Route = typeof ROUTES[number];

export const CONDITION_OPERATORS = [
  'equals', 'not_equals',
  'contains', 'not_contains',
  'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal',
  'in', 'not_in',
  'exists', 'not_exists',
] as const;
export type ConditionOperator = typeof CONDITION_OPERATORS[number];

export type EdgeCondition = { path: string; operator: ConditionOperator; value?: unknown };
export type FeedbackConfig = { maxIterations: number; loopId?: string };
export type EdgeOrchestration = { route: Route; condition?: EdgeCondition; feedback?: FeedbackConfig };

export type JoinMode = 'all' | 'any';

export type WorkflowAttachment = { name: string; url: string; mimeType?: string };

export type WorkflowNodeData = {
  title: string;
  agent: WorkflowAgentRef;
  input: string;
  skills: string[];
  attachments: WorkflowAttachment[];
  approvalRequired: boolean;
  orchestration: { join: JoinMode };
  model?: string;
};

export type WorkflowNode = {
  id: string;
  type: 'agent';
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data: WorkflowNodeData;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  data: { orchestration: EdgeOrchestration };
};

export type Viewport = { x: number; y: number; zoom: number };

export type CompiledLoop = {
  id: string;
  feedbackEdgeId: string;
  headerNodeId: string;
  latchNodeId: string;
  bodyNodeIds: string[];
  maxIterations: number;
  parentLoopId: string | null;
};

export type CompiledGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  loops: CompiledLoop[];
  startNodeIds: string[];
};

export type RunStatus = 'queued' | 'running' | 'completed' | 'completed_with_failures' | 'failed' | 'canceled';
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'completed_with_failures', 'failed', 'canceled']);

export type ExecutionStatus = 'queued' | 'running' | 'pending_approval' | 'completed' | 'failed' | 'approval_rejected' | 'canceled';
export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'approval_rejected', 'canceled']);

export type NodeRuntimeStatus = 'idle' | 'queued' | 'running' | 'pending_approval' | 'completed' | 'skipped' | 'failed' | 'approval_rejected' | 'canceled';

export type IterationStep = { loopId: string; iteration: number };
export type IterationPath = { scope: string | null; steps: IterationStep[] };

export type SourceOutcome = 'success' | 'failure' | 'skipped';
export type DecisionStatus = 'taken' | 'not_taken';
export type DecisionReason = 'route_not_matched' | 'condition_not_matched' | 'iteration_limit_reached' | null;

export type ConditionEvaluation = {
  status: 'matched' | 'not_matched';
  actual?: unknown;
  reason?: 'path_not_found' | 'type_mismatch' | null;
};

export type EdgeDecision = {
  status: DecisionStatus;
  reason: DecisionReason;
  evaluation?: ConditionEvaluation;
};

export type LoopEpochStatus = 'completed' | 'failed' | 'canceled' | 'timed_out' | 'approval_rejected';

export type TriggerSource = 'manual' | 'scheduled' | 'hook' | 'rerun';
