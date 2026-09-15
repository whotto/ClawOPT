/**
 * 规范事件：适配器唯一允许产出的东西。
 *
 * 形状沿 OpenAI Responses 流（`response.*` + output item），理由很实际：
 * Codex、代理 tee、Claude Code 的 stream-json 都能无损翻译成它，而协调器只写一套归约。
 * 在 Responses 之外只加了三类扩展，每一类都说明了为什么 Responses 表达不了：
 *
 * - `response.output_text.snapshot`：OpenClaw 网关推的是**累计快照**而不是增量，
 *   而且终态文本可能比已推的快照短（网关会剥掉内部标记）。硬转成增量会丢掉「权威替换」这层语义。
 * - `response.function_call.updated`：网关的工具 `update` 阶段只刷新参数、不结束调用。
 * - 控制事件（用量、审批、澄清、计划、工作区 diff、原生会话 id）：它们不属于任何一个 output item。
 *
 * 每个事件都带 `channel`：同一轮次可能同时从 CLI 输出与本地代理 tee 两路到达，
 * 协调器按适配器声明的事实来源表（source-of-truth.ts）只收一路。
 */

/** 事件从哪一路来。native = 运行时自己的输出流（CLI stdout、RPC、网关事件）；proxy = 本地模型代理 tee。 */
export type RuntimeChannel = 'native' | 'proxy';

export type MessageItem = { type: 'message'; id: string; role: 'assistant'; text?: string };
export type FunctionCallItem = { type: 'function_call'; id: string; call_id: string; name: string; arguments: string };
export type FunctionCallOutputItem = {
  type: 'function_call_output';
  id: string;
  call_id: string;
  output: string;
  status?: 'completed' | 'failed';
};
export type ReasoningItem = { type: 'reasoning'; id: string; text?: string };
export type OutputItem = MessageItem | FunctionCallItem | FunctionCallOutputItem | ReasoningItem;

/** 一次计费调用的用量。`callId` 必须是**确定性**的：重放同一次调用得到同一个 id，才能去重。 */
export interface UsageReport {
  callId: string;
  scope: 'model_call' | 'run';
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  apiCalls: number;
  costUsd?: number;
  /** 估算值不落库（缺真实计数时宁可空着，不编数字）。 */
  estimated?: boolean;
  purpose?: string;
}

export interface ApprovalRequestInput {
  approvalId: string;
  /** 发起请求的 Agent。审批队列按 (会话, Agent) 分，不是每会话一个。 */
  agentId: string;
  title: string;
  description?: string;
  command?: string;
  choices: ReadonlyArray<'once' | 'session' | 'always' | 'deny'>;
  timeoutMs: number;
}

export interface ClarifyRequestInput {
  clarifyId: string;
  agentId: string;
  question: string;
  choices: readonly string[] | null;
  timeoutMs: number;
}

export interface WorkspaceRunChangeSummary {
  changeId: string;
  files: Array<{ path: string; changeType: 'added' | 'modified' | 'deleted' | 'renamed'; additions: number; deletions: number }>;
  truncated: boolean;
}

export type ResponseEvent =
  | { type: 'response.created'; response_id: string; model?: string }
  | { type: 'response.output_item.added'; item: OutputItem }
  | { type: 'response.output_item.done'; item: OutputItem }
  | { type: 'response.output_text.delta'; item_id: string; delta: string }
  | { type: 'response.output_text.snapshot'; item_id: string; text: string; authoritative: boolean }
  | { type: 'response.output_text.done'; item_id: string; text: string }
  | { type: 'response.reasoning.delta'; item_id: string; delta: string }
  | { type: 'response.function_call_arguments.delta'; item_id: string; call_id: string; delta: string }
  | { type: 'response.function_call.updated'; call_id: string; name: string; arguments: string }
  | { type: 'response.completed'; response_id: string; output_text?: string; stop_reason?: string }
  | { type: 'response.failed'; response_id: string; error: { message: string; code?: string } };

export type ControlEvent =
  | { type: 'usage.reported'; usage: UsageReport }
  | { type: 'approval.requested'; request: ApprovalRequestInput }
  | { type: 'clarify.requested'; request: ClarifyRequestInput }
  | { type: 'plan.updated'; plan: unknown }
  | { type: 'workspace.diff'; change: WorkspaceRunChangeSummary }
  | { type: 'runtime.init'; model?: string; runtimeVersion?: string }
  | { type: 'runtime.native_session'; nativeSessionId: string };

export type CanonicalEvent = ResponseEvent | ControlEvent;

export interface AdapterEvent {
  channel: RuntimeChannel;
  event: CanonicalEvent;
}

/** 事件属于哪个「事实维度」。仲裁表按维度声明哪一路说了算。 */
export type EventFacet = 'text' | 'tools' | 'terminal' | 'usage' | 'control';

export function facetOf(event: CanonicalEvent): EventFacet {
  switch (event.type) {
    case 'response.output_text.delta':
    case 'response.output_text.snapshot':
    case 'response.output_text.done':
    case 'response.reasoning.delta':
    case 'response.created':
      return 'text';
    case 'response.output_item.added':
    case 'response.output_item.done':
      return event.item.type === 'message' || event.item.type === 'reasoning' ? 'text' : 'tools';
    case 'response.function_call_arguments.delta':
    case 'response.function_call.updated':
      return 'tools';
    case 'response.completed':
    case 'response.failed':
      return 'terminal';
    case 'usage.reported':
      return 'usage';
    default:
      return 'control';
  }
}

export function emptyUsage(callId: string, scope: UsageReport['scope'] = 'model_call'): UsageReport {
  return {
    callId,
    scope,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    apiCalls: 1,
  };
}
