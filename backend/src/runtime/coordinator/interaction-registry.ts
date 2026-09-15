/**
 * 审批与澄清的待决注册表。
 *
 * ## 按 (会话, Agent) 排队，不是每会话一个
 *
 * 参考实现每会话只能挂一个待决请求，第二个直接自动拒绝——群里两个 Agent 同时要权限，
 * 后一个莫名其妙被拒。这里每个 (会话, Agent) 一条 FIFO：不同 Agent 互不阻塞，
 * 同一个 Agent 的请求按顺序一个一个问。
 *
 * ## 超时
 *
 * - 倒计时从请求**排到队首、真正展示给人**的那一刻开始算；排在后面等的时间不计入，
 *   否则排第二的请求一露面就已经超时。
 * - 审批超时 = 拒绝；澄清超时 = 以说明文字作答（不是错误，模型带着假设继续）。
 * - 断线重连时按 `deadline - now` 重算 `remaining_timeout_ms`，倒计时不会重置。
 * - 运行被中止 / 服务停机：该运行名下所有待决请求一律按拒绝 / 说明文字收尾。
 */
import type { ApprovalDecision, ApprovalRequestInput, ClarifyRequestInput } from '../contract';

export type InteractionKind = 'approval' | 'clarify';
export type InteractionEndReason = 'response' | 'timeout' | 'aborted' | 'shutdown';

export type ApprovalOutcome = { kind: 'approval'; decision: ApprovalDecision; reason: InteractionEndReason };
export type ClarifyOutcome = { kind: 'clarify'; response: string; reason: InteractionEndReason };
export type InteractionOutcome = ApprovalOutcome | ClarifyOutcome;

export interface PendingInteractionView {
  kind: InteractionKind;
  id: string;
  sessionKey: string;
  agentId: string;
  runId: string;
  request: ApprovalRequestInput | ClarifyRequestInput;
  queuedAt: number;
  /** 排到队首的时刻；还在排队时为 null。 */
  activatedAt: number | null;
  remainingTimeoutMs: number | null;
}

type Pending = {
  kind: InteractionKind;
  id: string;
  sessionKey: string;
  agentId: string;
  runId: string;
  request: ApprovalRequestInput | ClarifyRequestInput;
  queuedAt: number;
  activatedAt: number | null;
  deadline: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  settle: (outcome: InteractionOutcome) => void;
};

export type InteractionRegistryOptions = {
  now?: () => number;
  /** 请求排到队首（应该展示给人了）。 */
  onActivated?: (view: PendingInteractionView) => void;
  /** 请求结束（答复 / 超时 / 中止）。 */
  onResolved?: (view: PendingInteractionView, outcome: InteractionOutcome) => void;
};

export const APPROVAL_CHOICES: readonly ApprovalDecision[] = ['once', 'session', 'always', 'deny'];
export const CLARIFY_RESPONSE_MAX_CHARS = 20_000;

function timeoutText(timeoutMs: number): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60000));
  return `user did not respond within ${minutes}m`;
}

function endOutcome(pending: Pending, reason: Exclude<InteractionEndReason, 'response'>): InteractionOutcome {
  if (pending.kind === 'approval') return { kind: 'approval', decision: 'deny', reason };
  const text = reason === 'timeout'
    ? timeoutText(pending.request.timeoutMs)
    : reason === 'aborted' ? 'run was aborted before the user responded' : 'server is shutting down';
  return { kind: 'clarify', response: text, reason };
}

export class InteractionRegistry {
  private readonly queues = new Map<string, Pending[]>();
  private readonly byId = new Map<string, Pending>();
  private readonly now: () => number;

  constructor(private readonly options: InteractionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private queueKey(sessionKey: string, agentId: string): string {
    return `${sessionKey.length}:${sessionKey}:${agentId}`;
  }

  private view(pending: Pending): PendingInteractionView {
    return {
      kind: pending.kind,
      id: pending.id,
      sessionKey: pending.sessionKey,
      agentId: pending.agentId,
      runId: pending.runId,
      request: pending.request,
      queuedAt: pending.queuedAt,
      activatedAt: pending.activatedAt,
      remainingTimeoutMs: pending.deadline === null ? null : Math.max(0, pending.deadline - this.now()),
    };
  }

  requestApproval(sessionKey: string, runId: string, request: ApprovalRequestInput): Promise<ApprovalOutcome> {
    return this.enqueue('approval', request.approvalId, sessionKey, runId, request) as Promise<ApprovalOutcome>;
  }

  requestClarify(sessionKey: string, runId: string, request: ClarifyRequestInput): Promise<ClarifyOutcome> {
    return this.enqueue('clarify', request.clarifyId, sessionKey, runId, request) as Promise<ClarifyOutcome>;
  }

  private enqueue(
    kind: InteractionKind,
    id: string,
    sessionKey: string,
    runId: string,
    request: ApprovalRequestInput | ClarifyRequestInput,
  ): Promise<InteractionOutcome> {
    if (this.byId.has(id)) throw new Error(`interaction "${id}" is already pending`);
    return new Promise<InteractionOutcome>((resolve) => {
      const pending: Pending = {
        kind, id, sessionKey, agentId: request.agentId, runId, request,
        queuedAt: this.now(), activatedAt: null, deadline: null, timer: null,
        settle: resolve,
      };
      const key = this.queueKey(sessionKey, request.agentId);
      const queue = this.queues.get(key) ?? [];
      queue.push(pending);
      this.queues.set(key, queue);
      this.byId.set(id, pending);
      if (queue.length === 1) this.activate(pending);
    });
  }

  private activate(pending: Pending): void {
    pending.activatedAt = this.now();
    pending.deadline = pending.activatedAt + pending.request.timeoutMs;
    pending.timer = setTimeout(() => this.finish(pending, endOutcome(pending, 'timeout')), pending.request.timeoutMs);
    pending.timer.unref?.();
    this.options.onActivated?.(this.view(pending));
  }

  private finish(pending: Pending, outcome: InteractionOutcome): void {
    if (!this.byId.has(pending.id)) return;
    if (pending.timer) clearTimeout(pending.timer);
    const view = this.view(pending);
    this.byId.delete(pending.id);
    const key = this.queueKey(pending.sessionKey, pending.agentId);
    const queue = (this.queues.get(key) ?? []).filter((item) => item !== pending);
    if (queue.length === 0) this.queues.delete(key);
    else this.queues.set(key, queue);
    pending.settle(outcome);
    this.options.onResolved?.(view, outcome);
    const next = queue[0];
    if (next && next.activatedAt === null) this.activate(next);
  }

  /**
   * 人给出答复。必须同时对上会话与请求 id；还在排队（没展示过）的请求不接受答复。
   * 返回 `handled` = 这个 id 归本注册表；`resolved` = 答复被接受。
   */
  respond(sessionKey: string, id: string, response: { choice?: string; text?: string }): { handled: boolean; resolved: boolean; error?: string } {
    const pending = this.byId.get(id);
    if (!pending) return { handled: false, resolved: false, error: 'stale' };
    if (pending.sessionKey !== sessionKey) return { handled: true, resolved: false, error: 'sessionMismatch' };
    if (pending.activatedAt === null) return { handled: true, resolved: false, error: 'notActive' };
    if (pending.kind === 'approval') {
      const choice = response.choice as ApprovalDecision;
      const request = pending.request as ApprovalRequestInput;
      const allowed = APPROVAL_CHOICES.includes(choice) && request.choices.includes(choice);
      // 认不出的选项一律按拒绝收——宁可多问一次，不能把一个拼错的值当成「永久允许」。
      this.finish(pending, { kind: 'approval', decision: allowed ? choice : 'deny', reason: 'response' });
      return { handled: true, resolved: true };
    }
    const request = pending.request as ClarifyRequestInput;
    const text = String(response.text ?? response.choice ?? '').slice(0, CLARIFY_RESPONSE_MAX_CHARS);
    if (request.choices && text && !request.choices.includes(text) && response.choice !== undefined) {
      return { handled: true, resolved: false, error: 'invalidChoice' };
    }
    this.finish(pending, { kind: 'clarify', response: text, reason: 'response' });
    return { handled: true, resolved: true };
  }

  /** 运行结束或被中止：它名下的所有请求（含还在排队的）按中止收尾。 */
  cancelRun(runId: string): number {
    const affected = [...this.byId.values()].filter((pending) => pending.runId === runId);
    // 先摘掉排队中的，再结束队首——否则结束队首会把排队的那条激活，平白发一次「请求展示」。
    for (const pending of affected.filter((item) => item.activatedAt === null)) {
      this.finish(pending, endOutcome(pending, 'aborted'));
    }
    for (const pending of affected.filter((item) => item.activatedAt !== null)) {
      this.finish(pending, endOutcome(pending, 'aborted'));
    }
    return affected.length;
  }

  shutdown(): void {
    for (const pending of [...this.byId.values()]) this.finish(pending, endOutcome(pending, 'shutdown'));
  }

  /** 全部待决请求（含排队中的），按请求时间排。待办中心按用户过滤后列出。 */
  pendingAll(): PendingInteractionView[] {
    return [...this.byId.values()].sort((a, b) => a.queuedAt - b.queuedAt).map((pending) => this.view(pending));
  }

  pendingForSession(sessionKey: string): PendingInteractionView[] {
    return [...this.byId.values()].filter((pending) => pending.sessionKey === sessionKey).map((pending) => this.view(pending));
  }

  get size(): number {
    return this.byId.size;
  }
}
