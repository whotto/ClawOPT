/**
 * 协调器的输入、输出与端口。
 *
 * 协调器不认识任何具体的表（chat_messages / group_messages）：
 * - 通用的运行事实（会话行、工具调用、用量）经 `RunStore` 端口写进通用表；
 * - 表面相关的消息行由各表面的**投影器**（RunProjector）写，投影器同时决定推给前端的帧长什么样。
 */
import type { RealtimeEvent } from '../../core/realtime';
import type {
  AdapterRunOutcome,
  AgentRuntimeAdapter,
  CanonicalEvent,
  InterruptReason,
  ProxyMode,
  WorkspaceRunChangeSummary,
} from '../contract';
import type { ReplayPolicy } from './replay-buffer';
import type { ToolCallRecord } from './tool-call-groups';

export type RunSurface = 'chat' | 'room';
export type RunEndReason = 'complete' | 'error' | 'abort';

export interface RunSessionInput {
  sessionKey: string;
  surface: RunSurface;
  runtime: string;
  agentId: string;
  title?: string;
}

export interface SessionUsageRow {
  sessionKey: string;
  callId: string;
  source: string;
  agentId: string;
  scope: 'model_call' | 'run';
  purpose: string | null;
  model: string | null;
  provider: string | null;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
}

export interface PersistedToolCall extends ToolCallRecord {
  sessionKey: string;
  runId: string;
  runMarker: string;
}

export interface RunStore {
  /** 建会话行或重开（清掉 ended_at），刷新 last_active。 */
  ensureRunSession(input: RunSessionInput): void;
  /** 只在队列为空时调用。 */
  markRunSessionEnded(sessionKey: string, reason: RunEndReason): void;
  /** 同一组工具调用在一个事务里写。 */
  persistToolCalls(calls: PersistedToolCall[]): void;
  /** 按 (session_key, call_id, source) 去重；返回是否真的插入了。 */
  recordSessionUsage(row: SessionUsageRow): boolean;
}

export interface WorkspaceCheckpoint {
  readonly token: unknown;
}

/**
 * 每次运行的工作区 diff 检查点（P1b 实现，这里只定缝）。
 * begin 在交给运行时之前调用；complete 在投影器落完最终消息（知道 message id）之后调用。
 */
export interface WorkspaceCheckpointer {
  begin(input: { sessionKey: string; runId: string; runMarker: string; workspacePath?: string }): Promise<WorkspaceCheckpoint | null>;
  complete(checkpoint: WorkspaceCheckpoint, input: { messageId: string | number | null; outcome: AdapterRunOutcome }): Promise<WorkspaceRunChangeSummary | null>;
}

export const NOOP_WORKSPACE_CHECKPOINTER: WorkspaceCheckpointer = {
  begin: async () => null,
  complete: async () => null,
};

/** 投影器看到的运行视图。 */
export interface ProjectorRunContext {
  readonly runId: string;
  readonly runMarker: string;
  readonly sessionKey: string;
  readonly primaryTopic: string;
  readonly startedAt: number;
  /** 推一个表面事件（例如单聊的 legacy SSE 帧）。终态阶段推的事件会延后到状态清理之后才真正发出。 */
  publish(type: string, payload: unknown, options?: { replay?: ReplayPolicy; topic?: string }): void;
  /** 适配器的当前状态（phase / 原生 run id）。 */
  adapterStatus(): { phase: 'preparing' | 'running' | 'finished'; nativeRunId?: string };
}

export interface ProjectorFinish {
  messageId?: string | number | null;
  output?: string;
  error?: string;
}

export interface RunProjector {
  onEvent(event: CanonicalEvent): void;
  finish(outcome: AdapterRunOutcome): ProjectorFinish;
  /** 新接入的订阅者要先拿到的「当前状态」帧（不进重放缓冲，直接给那一个订阅者）。 */
  attachSnapshot?(): Array<{ type: string; payload: unknown }>;
}

export interface RunSubmission<TRequest = unknown> {
  sessionKey: string;
  surface: RunSurface;
  /** 第一个是主题（投影器事件默认发到这里），其余只收运行生命周期事件（例如 agent:<id>）。 */
  topics: [string, ...string[]];
  agentId: string;
  title?: string;
  adapter: AgentRuntimeAdapter<TRequest>;
  request: TRequest;
  proxyMode?: ProxyMode;
  projector: (run: ProjectorRunContext) => RunProjector;
  /** 发起这次运行的 WebSocket 连接 id。 */
  origin?: string;
  workspacePath?: string;
  /** 队列面板上显示的文字；null 表示不在队列面板展示（系统续跑）。 */
  display?: string | null;
  /** 表面自己的附加信息（messageId 等），原样出现在运行视图里。 */
  meta?: Record<string, unknown>;
  /** 这个运行时中止的宽限（缺省用协调器的默认值）。OpenClaw 的 chat.abort 自己就有 5 秒时限。 */
  abortGraceMs?: number;
}

export type BusyPolicy = 'queue' | 'replace' | 'reject';

export interface RunView {
  runId: string;
  runMarker: string;
  sessionKey: string;
  agentId: string;
  runtime: string;
  startedAt: number;
  phase: 'preparing' | 'running' | 'finished';
  nativeRunId?: string;
  aborting: boolean;
  meta: Record<string, unknown>;
}

export interface RunTerminal {
  runId: string;
  runMarker: string;
  sessionKey: string;
  outcome: AdapterRunOutcome;
  projection: ProjectorFinish;
  queueRemaining: number;
  workspaceChange: WorkspaceRunChangeSummary | null;
  nativeSessionId: string | null;
}

export type SubmitResult =
  | { status: 'started'; run: RunView; completion: Promise<RunTerminal> }
  | { status: 'queued'; queueId: string; position: number; completion: Promise<RunTerminal> }
  | { status: 'rejected'; reason: 'busy'; activeRun: RunView };

export interface AbortResult {
  aborted: boolean;
  synced: boolean;
  ignored: boolean;
  /** 被中止那次运行的结局（没有运行时为 undefined）；表面据此区分「准备阶段就停了」与「运行中停下」。 */
  outcome?: AdapterRunOutcome;
}

export interface SessionSnapshot {
  sessionKey: string;
  activeRun: RunView | null;
  replay: RealtimeEvent[];
  replayDropped: number;
  queue: Array<{ queueId: string; position: number; display: string | null; enqueuedAt: number }>;
  pendingInteractions: Array<{
    kind: 'approval' | 'clarify';
    id: string;
    agentId: string;
    runId: string;
    request: unknown;
    remainingTimeoutMs: number | null;
  }>;
  attach: RealtimeEvent[];
}

export type { InterruptReason };
