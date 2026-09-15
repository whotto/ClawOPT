/**
 * 运行时适配器契约。
 *
 * ## 适配器只做三件事
 *
 * 1. 启动一次运行（构造命令 / 发请求）；
 * 2. 把运行时的原生输出**翻译**成规范事件（events.ts），经 `context.emit` 交出去；
 * 3. 提供控制钩子：中止、边界打断、状态、解决审批与澄清。
 *
 * 其余一切——会话行、run marker、陈旧事件丢弃、单会话单运行与排队、中止宽限、重放缓冲、
 * 工具调用原子落库、用量去重、终态顺序、审批注册表、工作区 diff 检查点——
 * **都在协调器里只写一次**（runtime/coordinator）。适配器里出现这些逻辑就是越界。
 *
 * ## 执行器可替换
 *
 * CLI 类适配器沿用「构造命令」与「执行命令」分离（adapters/_shared/cli-adapter.ts 与 process.ts）：执行器由工厂注入，
 * 本机子进程与将来的远程 relay 目标机是同一个接口，主机方案只是部署选项。
 */
import type { ProxyMode, RuntimeCapabilities } from './capabilities';
import type { AdapterEvent } from './events';
import type { SourceOfTruthTable } from './source-of-truth';

export type InterruptReason = 'user_stop' | 'replaced' | 'queue_insertion' | 'shutdown';

export interface InterruptResult {
  /** 运行时确认已经停下。false = 没在时限内确认，协调器照样释放本地状态。 */
  synced: boolean;
}

export type BoundaryInterruptResult =
  | { status: 'accepted' | 'already_pending' }
  | { status: 'unsupported'; reason: string }
  | { status: 'not_found' | 'run_mismatch' };

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';

export interface AdapterRunStatus {
  /** preparing：还没真正交给运行时（例如还在连网关、组装消息）。 */
  phase: 'preparing' | 'running' | 'finished';
  /** 运行时自己的 run id（网关的 runId、CLI 的会话 id）。 */
  nativeRunId?: string;
}

export type AdapterRunOutcome =
  | { kind: 'completed'; outputText?: string; stopReason?: string }
  | { kind: 'failed'; error: string; code?: string; stopReason?: string }
  | { kind: 'aborted'; reason: InterruptReason; synced: boolean; phase: 'preparing' | 'running' };

export interface AdapterRunContext<TRequest> {
  /** 协调器分配的 run id。用量的确定性 call id 以它或运行时原生 id 为底。 */
  readonly runId: string;
  readonly runMarker: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly request: TRequest;
  readonly proxyMode?: ProxyMode;
  /** 协调器中止这次运行时触发。适配器在每个 await 之后都该看一眼。 */
  readonly signal: AbortSignal;
  /** 交出一个规范事件。陈旧运行的事件会被协调器丢弃，适配器不必自己判断。 */
  emit(event: AdapterEvent): void;
}

export interface AdapterRunHandle {
  /** 运行结束（完成 / 失败 / 被中止）时 resolve；**不得 reject**，异常要翻译成 failed。 */
  readonly done: Promise<AdapterRunOutcome>;
  interrupt(reason: InterruptReason): Promise<InterruptResult>;
  status(): AdapterRunStatus;
  /** 能力声明 boundaryInterrupt 为 true 时必须提供。 */
  requestBoundaryInterrupt?(expectedRunId: string): Promise<BoundaryInterruptResult>;
  /** 能力声明 approvals 为 true 时必须提供；返回 false 表示这个 id 不归它。 */
  resolveApproval?(approvalId: string, decision: ApprovalDecision): boolean;
  /** 能力声明 clarify 为 true 时必须提供。 */
  resolveClarify?(clarifyId: string, response: string): boolean;
}

export interface AgentRuntimeAdapter<TRequest = unknown> {
  /** 与 `group_members.runtime` 同一套取值（'openclaw' / 'claude-code' / …）。 */
  readonly id: string;
  readonly capabilities: Readonly<RuntimeCapabilities>;
  readonly sourceOfTruth: Readonly<SourceOfTruthTable>;
  start(context: AdapterRunContext<TRequest>): AdapterRunHandle;
}

/**
 * 能力声明与控制钩子是否对得上。协调器在第一次用到某个适配器时检查一次：
 * 声明了 approvals 却不给 resolveApproval，审批请求就永远没人能解决，只能等超时拒绝。
 */
export function assertHandleMatchesCapabilities(adapter: AgentRuntimeAdapter<any>, handle: AdapterRunHandle): void {
  const missing: string[] = [];
  if (adapter.capabilities.boundaryInterrupt && !handle.requestBoundaryInterrupt) missing.push('requestBoundaryInterrupt');
  if (adapter.capabilities.approvals && !handle.resolveApproval) missing.push('resolveApproval');
  if (adapter.capabilities.clarify && !handle.resolveClarify) missing.push('resolveClarify');
  if (missing.length > 0) {
    throw new Error(`runtime adapter "${adapter.id}" declares capabilities without hooks: ${missing.join(', ')}`);
  }
}
