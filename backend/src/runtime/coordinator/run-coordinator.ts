/**
 * 运行协调器：spec 01 §3.2–§3.4 的义务在这里只实现一次。
 *
 * | 义务 | 落点 |
 * |---|---|
 * | 会话行确保 / 重开 | `startRun` → `store.ensureRunSession` |
 * | 每次运行一个 run marker | `startRun` |
 * | 陈旧事件丢弃 | `emitFor` 里比对 `state.active === run` |
 * | 单会话单运行 + 服务端队列（快照语义） | `submit` 的 BusyPolicy + `SessionRunQueue` |
 * | 中止 + 宽限超时 | `abort` |
 * | 重放缓冲（有界） | `SessionState.replay` |
 * | 工具调用与结果原子落库 | `ToolCallGroups` → `store.persistToolCalls` |
 * | 用量按确定性 call id 去重 | `usage.reported` → `store.recordSessionUsage` |
 * | 终态顺序：先清状态再发终态；队列空才写结束标记；出队 | `finalize` |
 * | 审批 / 澄清（按 Agent 排队、超时即拒绝、重连剩余时间） | `InteractionRegistry` |
 * | 工作区 diff 检查点缝 | `WorkspaceCheckpointer` |
 * | 事实来源仲裁 | `acceptsAdapterEvent` |
 * | 业务事件（出站 Webhook 的来源） | `publishBus`：`chat.run.*` / `chat.tool.*` / `chat.approval.*`，覆盖所有表面与运行时 |
 *
 * 适配器只翻译事件；投影器（各表面自己的）只管自己的消息行与帧形状。
 */
import { randomBytes, randomUUID } from 'crypto';

import type { EventBus } from '../../core/events';
import type { RealtimeEvent, RealtimeHub } from '../../core/realtime';
import {
  acceptsAdapterEvent,
  assertHandleMatchesCapabilities,
  facetOf,
  type AdapterEvent,
  type AdapterRunHandle,
  type AdapterRunOutcome,
  type ApprovalRequestInput,
  type BoundaryInterruptResult,
  type InterruptReason,
  type WorkspaceRunChangeSummary,
} from '../contract';
import { InteractionRegistry, type InteractionOutcome, type PendingInteractionView } from './interaction-registry';
import { ReplayBuffer, type ReplayPolicy } from './replay-buffer';
import { SessionRunQueue, snapshotRequest } from './run-queue';
import { ToolCallGroups } from './tool-call-groups';
import { TurnTextArbiter } from './turn-text-arbiter';
import {
  NOOP_WORKSPACE_CHECKPOINTER,
  type AbortResult,
  type BusyPolicy,
  type ProjectorFinish,
  type RunProjector,
  type RunStore,
  type RunSubmission,
  type RunTerminal,
  type RunView,
  type SessionSnapshot,
  type SubmitResult,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointer,
  type InsertNowResult,
  type QueueInsertionView,
  RUN_APPROVALS_TOPIC,
  type PendingApprovalView,
} from './types';

export const DEFAULT_ABORT_GRACE_MS = 5000;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type QueuedPayload = { submission: RunSubmission<any>; completion: Deferred<RunTerminal> };

type ActiveRun = {
  runId: string;
  runMarker: string;
  submission: RunSubmission<any>;
  startedAt: number;
  controller: AbortController;
  handle: AdapterRunHandle | null;
  projector: RunProjector | null;
  checkpoint: WorkspaceCheckpoint | null;
  toolGroups: ToolCallGroups;
  textByItem: Map<string, string>;
  /** call id → 工具名（结果事件常不带工具名，业务事件要带）。 */
  toolNames: Map<string, string>;
  /** 两路都收文本 / 推理时按轮次与段比对（不按 item id，两路的 id 永远对不上）。 */
  textArbiter: TurnTextArbiter;
  reasoningArbiter: TurnTextArbiter;
  nativeSessionId: string | null;
  aborting: boolean;
  abortReason: InterruptReason | null;
  terminalHandled: boolean;
  deferPublishing: boolean;
  deferred: Array<() => void>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  stopReason: string | null;
  /** 被「立即插入」让出时用的是哪种保证（终态负载的 `interruption_mode`）。 */
  insertionGuarantee: 'strict' | 'immediate' | null;
  completion: Deferred<RunTerminal>;
  droppedEvents: number;
};

type SessionState = {
  sessionKey: string;
  active: ActiveRun | null;
  queue: SessionRunQueue<QueuedPayload>;
  replay: ReplayBuffer;
  /** 「立即插入」状态机（至多一个）。 */
  insertion: QueueInsertionView | null;
};

/** 立即插入被取消 / 结束的原因（`queue.insertion.updated` 的 reason）。 */
export type QueueInsertionEndReason = 'started' | 'cancelled' | 'hard_stop' | 'run_mismatch' | 'queue_empty';

export const QUEUE_INSERTION_EVENT = 'queue.insertion.updated';

export type RunCoordinatorOptions = {
  hub: RealtimeHub;
  store: RunStore;
  checkpointer?: WorkspaceCheckpointer;
  /**
   * 业务事件总线（可选）。运行开始 / 完成 / 失败 / 中止、工具调用开始与结果、审批请求与答复都在这里发一次——
   * 迁移前 `ActiveRunManager` 只在 OpenClaw 单聊里发 `chat.run.*`，群聊外部成员与工作流节点都漏掉了。
   */
  events?: Pick<EventBus, 'publish'>;
  replayLimit?: number;
  abortGraceMs?: number;
  log?: (message: string) => void;
};

function outcomeEndReason(outcome: AdapterRunOutcome): 'complete' | 'error' | 'abort' {
  if (outcome.kind === 'completed') return 'complete';
  if (outcome.kind === 'failed') return 'error';
  return 'abort';
}

function terminalEventType(outcome: AdapterRunOutcome): 'run.completed' | 'run.failed' | 'run.aborted' {
  if (outcome.kind === 'completed') return 'run.completed';
  if (outcome.kind === 'failed') return 'run.failed';
  return 'run.aborted';
}

export function createRunMarker(now = Date.now()): string {
  return `run-${now.toString(36)}-${randomBytes(4).toString('hex')}`;
}

export class RunCoordinator {
  private readonly sessions = new Map<string, SessionState>();
  /** 还没终态的运行（按 run id）。只给「交互答复比运行状态先清掉」这种边角查业务事件上下文用。 */
  private readonly runsById = new Map<string, ActiveRun>();
  private readonly hub: RealtimeHub;
  private readonly store: RunStore;
  private readonly checkpointer: WorkspaceCheckpointer;
  private readonly events: Pick<EventBus, 'publish'> | null;
  private readonly replayLimit?: number;
  private readonly abortGraceMs: number;
  private readonly log: (message: string) => void;
  readonly interactions: InteractionRegistry;
  /** 被陈旧检查或仲裁丢掉的事件数（诊断与守卫用）。 */
  private droppedTotal = { stale: 0, arbitration: 0, duplicate: 0 };

  constructor(options: RunCoordinatorOptions) {
    this.hub = options.hub;
    this.store = options.store;
    this.checkpointer = options.checkpointer ?? NOOP_WORKSPACE_CHECKPOINTER;
    this.events = options.events ?? null;
    this.replayLimit = options.replayLimit;
    this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.log = options.log ?? ((message) => console.warn(message));
    this.interactions = new InteractionRegistry({
      onActivated: (view) => {
        this.publishInteraction(view, 'requested');
        this.notifyPendingChanged(view);
        this.autoAnswerInteraction(view);
      },
      onResolved: (view, outcome) => {
        this.publishInteraction(view, 'resolved', outcome);
        this.notifyPendingChanged(view);
      },
    });
  }

  // ---------------------------------------------------------------- 状态

  private state(sessionKey: string): SessionState {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = { sessionKey, active: null, queue: new SessionRunQueue(), replay: new ReplayBuffer(this.replayLimit), insertion: null };
      this.sessions.set(sessionKey, state);
    }
    return state;
  }

  /** 空闲、无排队、无待决交互的会话状态直接丢掉——参考实现的会话状态表从不淘汰，进程活多久涨多久。 */
  private maybeEvict(state: SessionState): void {
    if (state.active || state.queue.size > 0) return;
    if (this.interactions.pendingForSession(state.sessionKey).length > 0) return;
    if (this.sessions.get(state.sessionKey) === state) this.sessions.delete(state.sessionKey);
  }

  private view(run: ActiveRun): RunView {
    const status = run.handle?.status() ?? { phase: 'preparing' as const };
    return {
      runId: run.runId,
      runMarker: run.runMarker,
      sessionKey: run.submission.sessionKey,
      agentId: run.submission.agentId,
      runtime: run.submission.adapter.id,
      startedAt: run.startedAt,
      phase: run.terminalHandled ? 'finished' : status.phase,
      nativeRunId: status.nativeRunId,
      aborting: run.aborting,
      meta: run.submission.meta ?? {},
    };
  }

  getActiveRun(sessionKey: string): RunView | null {
    const run = this.sessions.get(sessionKey)?.active;
    return run ? this.view(run) : null;
  }

  isBusy(sessionKey: string): boolean {
    return !!this.sessions.get(sessionKey)?.active;
  }

  activeRuns(): RunView[] {
    return [...this.sessions.values()].filter((state) => state.active).map((state) => this.view(state.active!));
  }

  droppedEventCounts(): { stale: number; arbitration: number; duplicate: number } {
    return { ...this.droppedTotal };
  }

  // ---------------------------------------------------------------- 发布

  private publish(run: ActiveRun, type: string, payload: unknown, options: { topic?: string; allTopics?: boolean; replay?: ReplayPolicy } = {}): void {
    const send = () => {
      const topics = options.allTopics ? run.submission.topics : [options.topic ?? run.submission.topics[0]];
      for (const topic of topics) {
        const event = this.hub.publish({
          topic,
          type,
          payload,
          runId: run.runId,
          runMarker: run.runMarker,
          origin: run.submission.origin,
        });
        if (topic === run.submission.topics[0] && options.replay) {
          this.sessions.get(run.submission.sessionKey)?.replay.push(event, options.replay);
        }
      }
    };
    if (run.deferPublishing) run.deferred.push(send);
    else send();
  }

  /**
   * 业务总线上的运行事实。负载字段是出站 Webhook 映射（`automation/webhooks/webhook-events.ts`）的输入：
   * `sessionId`（协调器会话键）、`runId`、`agentId`、`agentName`、`runtime`、`surface`，外加各事件自己的字段。
   * 总线本身按消费者隔离故障；这里再兜一层，发布方永远不因下游出错而受影响。
   */
  private publishBus(type: string, run: ActiveRun, extra: Record<string, unknown> = {}): void {
    if (!this.events) return;
    const { submission } = run;
    try {
      this.events.publish(type, {
        sessionId: submission.sessionKey,
        runId: run.runId,
        runMarker: run.runMarker,
        agentId: submission.agentId,
        agentName: submission.title ?? null,
        runtime: submission.adapter.id,
        surface: submission.surface,
        ...extra,
      });
    } catch (error) {
      this.log(`[RunCoordinator] business event ${type} failed: ${(error as Error)?.name}`);
    }
  }

  private publishInteraction(view: PendingInteractionView, phase: 'requested' | 'resolved', outcome?: InteractionOutcome): void {
    const state = this.sessions.get(view.sessionKey);
    const run = state?.active && state.active.runId === view.runId ? state.active : null;
    const type = `${view.kind}.${phase}`;
    const payload = phase === 'requested'
      ? { id: view.id, agent_id: view.agentId, run_id: view.runId, request: view.request, requested_at: view.activatedAt, remaining_timeout_ms: view.remainingTimeoutMs }
      : { id: view.id, agent_id: view.agentId, run_id: view.runId, resolved: outcome?.reason === 'response', reason: outcome?.reason, outcome };
    const replayKey = `${view.kind}:${view.id}`;
    if (view.kind === 'approval' && this.events) {
      const runForBus = run ?? this.runsById.get(view.runId) ?? null;
      const extra = {
        approvalId: view.id,
        ...(phase === 'resolved' ? { decision: outcome?.kind === 'approval' ? outcome.decision : null, reason: outcome?.reason ?? null } : {}),
      };
      if (runForBus) this.publishBus(`chat.approval.${phase}`, runForBus, extra);
    }
    if (run) {
      this.publish(run, type, payload, { replay: phase === 'requested' ? { mode: 'replace', key: replayKey } : undefined });
      if (phase === 'resolved') state!.replay.remove(replayKey);
      return;
    }
    // 运行已经不在（请求比它的运行活得久的边角情况）：没有运行上下文，发到请求时记下的主题。
    const topic = this.interactionTopics.get(view.id);
    if (topic) this.hub.publish({ topic, type, payload, runId: view.runId });
    state?.replay.remove(replayKey);
    if (phase === 'resolved') this.interactionTopics.delete(view.id);
  }

  /**
   * 无人值守的运行（`submission.autoApprove`）：审批请求一排到队首就自动作答。
   * 放到微任务里答——此刻还在注册表的激活回调里，同步答复会重入注册表。
   * 答复照常经注册表，`approval.requested` / `approval.resolved` 帧与业务事件一个不少，转录里看得见。
   */
  private autoAnswerInteraction(view: PendingInteractionView): void {
    if (view.kind !== 'approval') return;
    const policy = this.runsById.get(view.runId)?.submission.autoApprove;
    if (!policy) return;
    const choices = (view.request as { choices?: ReadonlyArray<string> }).choices ?? [];
    const choice = policy === 'once' && choices.includes('once') ? 'once' : 'deny';
    queueMicrotask(() => {
      const result = this.interactions.respond(view.sessionKey, view.id, { choice });
      if (!result.resolved) this.log(`[RunCoordinator] auto-approval (${choice}) not applied for ${view.id}: ${result.error ?? 'unknown'}`);
    });
  }

  /**
   * 待决审批集合变了：在 `approvals:runs` 主题发一条**不带内容**的提醒（`run.approvals.changed`），
   * 待办中心与聊天里的审批卡据此经 HTTP 重新拉自己看得见的列表（`GET /api/run-approvals`，按用户过滤）。
   * 无人值守（`autoApprove`）的运行不提醒——它的请求一露面就被自动答掉。
   */
  private notifyPendingChanged(view: PendingInteractionView): void {
    if (view.kind !== 'approval') return;
    if (this.runsById.get(view.runId)?.submission.autoApprove) return;
    this.hub.publish({ topic: RUN_APPROVALS_TOPIC, type: 'run.approvals.changed', payload: {} });
  }

  /**
   * 等人答复的审批（排到队首的；无人值守运行的除外），带上表面、运行时与 Agent 名，给待办中心与聊天审批卡用。
   * 调用方负责按用户过滤（`ResourceAccess.canAccessRunSession`）。
   */
  pendingApprovals(): PendingApprovalView[] {
    return this.interactions.pendingAll()
      .filter((view) => view.kind === 'approval' && view.activatedAt !== null)
      .flatMap((view) => {
        const submission = this.runsById.get(view.runId)?.submission;
        if (!submission || submission.autoApprove) return [];
        const request = view.request as ApprovalRequestInput;
        return [{
          id: view.id,
          sessionKey: view.sessionKey,
          runId: view.runId,
          agentId: view.agentId,
          agentName: submission.title ?? null,
          surface: submission.surface,
          runtime: submission.adapter.id,
          title: request.title,
          description: request.description ?? null,
          command: request.command ?? null,
          choices: [...request.choices],
          remainingTimeoutMs: view.remainingTimeoutMs,
        }];
      });
  }

  /** 交互请求 id → 发起它的运行的主题。 */
  private readonly interactionTopics = new Map<string, string>();

  private requestInteraction(run: ActiveRun, event: Extract<AdapterEvent['event'], { type: 'approval.requested' | 'clarify.requested' }>): void {
    const id = event.type === 'approval.requested' ? event.request.approvalId : event.request.clarifyId;
    this.interactionTopics.set(id, run.submission.topics[0]);
    try {
      if (event.type === 'approval.requested') {
        this.interactions.requestApproval(run.submission.sessionKey, run.runId, event.request).then((outcome) => {
          this.interactionTopics.delete(id);
          if (!run.terminalHandled) run.handle?.resolveApproval?.(id, outcome.decision);
        });
      } else {
        this.interactions.requestClarify(run.submission.sessionKey, run.runId, event.request).then((outcome) => {
          this.interactionTopics.delete(id);
          if (!run.terminalHandled) run.handle?.resolveClarify?.(id, outcome.response);
        });
      }
    } catch (error) {
      // 同一个 id 重复请求：运行时串了。按拒绝回给它，不把异常抛回适配器的事件回调里。
      this.log(`[RunCoordinator] interaction request rejected (${id}): ${(error as Error)?.message}`);
      if (event.type === 'approval.requested') run.handle?.resolveApproval?.(id, 'deny');
      else run.handle?.resolveClarify?.(id, '');
    }
  }

  // ---------------------------------------------------------------- 提交

  async submit<TRequest>(submission: RunSubmission<TRequest>, policy: BusyPolicy): Promise<SubmitResult> {
    let state = this.state(submission.sessionKey);
    if (state.active) {
      if (policy === 'reject') return { status: 'rejected', reason: 'busy', activeRun: this.view(state.active) };
      if (policy === 'replace') {
        await this.abort(submission.sessionKey, 'replaced');
        // 旧运行收尾时空闲的会话状态会被淘汰，必须重新取，不能沿用 await 之前的引用。
        state = this.state(submission.sessionKey);
      }
    }
    // replace 之后如果队列里的下一条已经顶上来，新的这一条只能排队——两轮不能并发。
    if (state.active) {
      const completion = deferred<RunTerminal>();
      const queueId = randomUUID();
      const snapshot = { ...submission, request: snapshotRequest(submission.request), meta: snapshotRequest(submission.meta) };
      const position = state.queue.enqueue({ queueId, payload: { submission: snapshot, completion }, display: submission.display ?? null, ref: submission.ref ?? null });
      this.publish(state.active, 'run.queued', { queue_length: state.queue.size, queued: state.queue.view() }, { replay: { mode: 'replace', key: 'queue' } });
      return { status: 'queued', queueId, position, completion: completion.promise };
    }
    const completion = deferred<RunTerminal>();
    const run = this.startRun(state, submission, completion, null);
    return { status: 'started', run: this.view(run), completion: completion.promise };
  }

  private startRun(state: SessionState, submission: RunSubmission<any>, completion: Deferred<RunTerminal>, dequeuedQueueId: string | null): ActiveRun {
    const run: ActiveRun = {
      runId: randomUUID(),
      runMarker: createRunMarker(),
      submission,
      startedAt: Date.now(),
      controller: new AbortController(),
      handle: null,
      projector: null,
      checkpoint: null,
      toolGroups: null as unknown as ToolCallGroups,
      textByItem: new Map(),
      toolNames: new Map(),
      textArbiter: new TurnTextArbiter(),
      reasoningArbiter: new TurnTextArbiter(),
      nativeSessionId: null,
      aborting: false,
      abortReason: null,
      terminalHandled: false,
      deferPublishing: false,
      deferred: [],
      graceTimer: null,
      stopReason: null,
      insertionGuarantee: null,
      completion,
      droppedEvents: 0,
    };
    run.toolGroups = new ToolCallGroups((calls) => this.store.persistToolCalls(calls.map((call) => ({
      ...call,
      sessionKey: submission.sessionKey,
      runId: run.runId,
      runMarker: run.runMarker,
    }))));
    state.active = run;
    state.replay.clear();
    this.runsById.set(run.runId, run);

    try {
      this.store.ensureRunSession({
        sessionKey: submission.sessionKey,
        surface: submission.surface,
        runtime: submission.adapter.id,
        agentId: submission.agentId,
        title: submission.title,
      });
    } catch (error) {
      this.log(`[RunCoordinator] ensureRunSession failed for ${submission.sessionKey}: ${(error as Error)?.message}`);
    }

    let projectorError: unknown = null;
    let startFailureReason = 'projector_failed';
    if (submission.beforeStart) {
      try {
        const prepared = submission.beforeStart();
        if (prepared?.meta) submission.meta = { ...(submission.meta ?? {}), ...prepared.meta };
      } catch (error) {
        projectorError = error;
        startFailureReason = 'before_start_failed';
      }
    }
    if (!projectorError) try {
      run.projector = submission.projector({
        runId: run.runId,
        runMarker: run.runMarker,
        sessionKey: submission.sessionKey,
        primaryTopic: submission.topics[0],
        startedAt: run.startedAt,
        publish: (type, payload, options) => this.publish(run, type, payload, { topic: options?.topic, replay: options?.replay }),
        adapterStatus: () => run.handle?.status() ?? { phase: 'preparing' },
      });
    } catch (error) {
      // 投影器都建不起来（例如写库失败）：这一轮不启动，但会话必须回到空闲——不能让一次异常把会话永久占住。
      projectorError = error;
    }

    this.publish(run, 'run.started', {
      run_id: run.runId,
      run_marker: run.runMarker,
      session_key: run.submission.sessionKey,
      runtime: submission.adapter.id,
      agent_id: submission.agentId,
      queue_id: dequeuedQueueId,
      queue_length: state.queue.size,
      ref: submission.ref ?? null,
      meta: submission.meta ?? {},
    }, { allTopics: true, replay: { mode: 'replace', key: 'run.started' } });
    this.publishBus('chat.run.started', run, { queueId: dequeuedQueueId });

    if (projectorError) {
      this.log(`[RunCoordinator] ${startFailureReason} for ${submission.sessionKey}: ${(projectorError as Error)?.message}`);
      void this.finalize(run, { kind: 'failed', error: (projectorError as Error)?.message || String(projectorError), stopReason: startFailureReason });
      return run;
    }
    void this.launch(run);
    return run;
  }

  private async launch(run: ActiveRun): Promise<void> {
    const { submission } = run;
    try {
      run.checkpoint = await this.checkpointer.begin({
        sessionKey: submission.sessionKey,
        runId: run.runId,
        runMarker: run.runMarker,
        workspacePath: submission.workspacePath,
      });
    } catch (error) {
      this.log(`[RunCoordinator] workspace checkpoint failed for ${submission.sessionKey}: ${(error as Error)?.message}`);
      run.checkpoint = null;
    }
    if (run.terminalHandled) return;
    if (run.controller.signal.aborted) {
      await this.finalize(run, { kind: 'aborted', reason: run.abortReason ?? 'user_stop', synced: true, phase: 'preparing' });
      return;
    }

    let handle: AdapterRunHandle;
    try {
      handle = submission.adapter.start({
        runId: run.runId,
        runMarker: run.runMarker,
        sessionKey: submission.sessionKey,
        agentId: submission.agentId,
        request: submission.request,
        proxyMode: submission.proxyMode,
        signal: run.controller.signal,
        emit: (event) => this.emitFor(run, event),
      });
      assertHandleMatchesCapabilities(submission.adapter, handle);
    } catch (error) {
      await this.finalize(run, { kind: 'failed', error: (error as Error)?.message || String(error) });
      return;
    }
    run.handle = handle;
    handle.done.then(
      (outcome) => this.finalize(run, outcome),
      (error) => this.finalize(run, { kind: 'failed', error: (error as Error)?.message || String(error) }),
    );
  }

  // ---------------------------------------------------------------- 流式

  private emitFor(run: ActiveRun, adapterEvent: AdapterEvent): void {
    const state = this.sessions.get(run.submission.sessionKey);
    // 陈旧检查：这次运行已经不再占有会话（被中止、被新运行替换、已终态），它的事件一律丢弃。
    if (!state || state.active !== run || run.terminalHandled) {
      this.droppedTotal.stale += 1;
      run.droppedEvents += 1;
      return;
    }
    const { adapter, proxyMode } = run.submission;
    const twoWayText = adapter.sourceOfTruth.text.length > 1;
    // 两路文本的段边界要在仲裁之前记：代理那一路的工具事件在工具维度上会被丢，但它仍是这一路「正文分段」的边界。
    if (twoWayText && facetOf(adapterEvent.event) === 'tools') {
      run.textArbiter.boundary(adapterEvent.channel);
      run.reasoningArbiter.boundary(adapterEvent.channel);
    }
    if (!acceptsAdapterEvent(adapter.sourceOfTruth, proxyMode, adapterEvent)) {
      this.droppedTotal.arbitration += 1;
      return;
    }

    const event = adapterEvent.event;
    switch (event.type) {
      case 'response.output_text.delta': {
        let delta = event.delta;
        if (twoWayText) {
          // 按轮次与段比对两路（turn-text-arbiter.ts），不按 item id：两路的 id 永远不同，按 id 分桶会把短文本拼两遍。
          delta = run.textArbiter.accept(adapterEvent.channel, delta);
          if (!delta) {
            this.droppedTotal.duplicate += 1;
            return;
          }
        }
        run.textByItem.set(event.item_id, (run.textByItem.get(event.item_id) ?? '') + delta);
        this.publish(run, 'message.delta', { item_id: event.item_id, delta });
        this.forward(run, delta === event.delta ? event : { ...event, delta });
        return;
      }
      case 'response.output_text.snapshot':
        run.textByItem.set(event.item_id, event.text);
        this.publish(run, 'message.snapshot', { item_id: event.item_id, text: event.text, authoritative: event.authoritative });
        break;
      case 'response.reasoning.delta': {
        let delta = event.delta;
        if (twoWayText) {
          delta = run.reasoningArbiter.accept(adapterEvent.channel, delta);
          if (!delta) {
            this.droppedTotal.duplicate += 1;
            return;
          }
        }
        this.publish(run, 'reasoning.delta', { item_id: event.item_id, delta });
        this.forward(run, delta === event.delta ? event : { ...event, delta });
        return;
      }
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = event.item;
        if (item.type === 'function_call') {
          if (event.type === 'response.output_item.added') {
            if (!run.toolGroups.addCall(item.call_id, item.name, item.arguments)) {
              this.droppedTotal.duplicate += 1;
              return;
            }
            this.publish(run, 'tool.started', { call_id: item.call_id, name: item.name, arguments: item.arguments }, { replay: { mode: 'append' } });
            run.toolNames.set(item.call_id, item.name);
            this.publishBus('chat.tool.started', run, { callId: item.call_id, toolName: item.name });
          } else {
            run.toolGroups.updateArguments(item.call_id, item.arguments);
          }
        } else if (item.type === 'function_call_output') {
          const status = item.status === 'failed' ? 'failed' : 'completed';
          if (!run.toolGroups.addOutput(item.call_id, item.output, status, { name: item.name, arguments: item.arguments })) {
            this.droppedTotal.duplicate += 1;
            return;
          }
          this.publish(run, status === 'failed' ? 'tool.failed' : 'tool.completed', { call_id: item.call_id, output: item.output }, { replay: { mode: 'append' } });
          this.publishBus(status === 'failed' ? 'chat.tool.failed' : 'chat.tool.completed', run, { callId: item.call_id, toolName: item.name ?? run.toolNames.get(item.call_id) ?? null });
        }
        break;
      }
      case 'response.function_call.updated':
        run.toolGroups.updateArguments(event.call_id, event.arguments);
        this.publish(run, 'tool.updated', { call_id: event.call_id, name: event.name, arguments: event.arguments });
        break;
      case 'usage.reported': {
        const usage = event.usage;
        // 估算值不落库：没有真实计数时宁可空着。
        if (usage.estimated) return;
        let inserted = false;
        try {
          inserted = this.store.recordSessionUsage({
            sessionKey: run.submission.sessionKey,
            callId: usage.callId,
            source: adapter.id,
            agentId: run.submission.agentId,
            scope: usage.scope,
            purpose: usage.purpose ?? null,
            model: usage.model ?? null,
            provider: usage.provider ?? null,
            apiCalls: usage.apiCalls,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            reasoningTokens: usage.reasoningTokens,
            costUsd: usage.costUsd ?? null,
          });
        } catch (error) {
          this.log(`[RunCoordinator] usage record failed: ${(error as Error)?.message}`);
        }
        if (inserted) this.publish(run, 'usage.updated', usage, { replay: { mode: 'replace', key: 'usage' } });
        break;
      }
      case 'approval.requested':
      case 'clarify.requested':
        this.requestInteraction(run, event);
        break;
      case 'runtime.native_session':
        run.nativeSessionId = event.nativeSessionId;
        break;
      case 'session.command':
        this.publish(run, 'session.command', event.result, { replay: { mode: 'append' } });
        break;
      case 'plan.updated':
        this.publish(run, 'plan.updated', event.plan, { replay: { mode: 'replace', key: 'plan' } });
        break;
      default:
        break;
    }
    this.forward(run, event);
  }

  private forward(run: ActiveRun, event: AdapterEvent['event']): void {
    try {
      run.projector?.onEvent(event);
    } catch (error) {
      this.log(`[RunCoordinator] projector failed on ${event.type} for ${run.submission.sessionKey}: ${(error as Error)?.message}`);
    }
  }

  // ---------------------------------------------------------------- 终态

  private async finalize(run: ActiveRun, outcome: AdapterRunOutcome): Promise<void> {
    if (run.terminalHandled) return;
    run.terminalHandled = true;
    if (run.graceTimer) clearTimeout(run.graceTimer);
    const state = this.sessions.get(run.submission.sessionKey)!;

    // 1. 没凑齐结果的工具调用补上 interrupted 后落库。
    try {
      run.toolGroups.flush();
    } catch (error) {
      this.log(`[RunCoordinator] tool call flush failed: ${(error as Error)?.message}`);
    }

    // 2. 投影器落最终消息；它这时推的帧延后到状态清理之后。
    run.deferPublishing = true;
    let projection: ProjectorFinish = {};
    try {
      projection = run.projector?.finish(outcome) ?? {};
    } catch (error) {
      this.log(`[RunCoordinator] projector finish failed for ${run.submission.sessionKey}: ${(error as Error)?.message}`);
    }

    // 3. 工作区 diff（此时已知最终消息 id）。
    let workspaceChange: WorkspaceRunChangeSummary | null = null;
    if (run.checkpoint) {
      try {
        workspaceChange = await this.checkpointer.complete(run.checkpoint, { messageId: projection.messageId ?? null, outcome });
      } catch (error) {
        this.log(`[RunCoordinator] workspace diff failed: ${(error as Error)?.message}`);
      }
    }

    // 4. 这次运行名下还没答复的审批 / 澄清按中止收尾。
    this.interactions.cancelRun(run.runId);

    // 5. 先清状态，再发终态：终态的消费方若同步地再提交一轮，看到的必须是空闲。
    if (state.active === run) state.active = null;
    const queueRemaining = state.queue.size;
    run.deferPublishing = false;
    for (const send of run.deferred.splice(0)) send();
    if (workspaceChange) this.publish(run, 'workspace.diff.completed', workspaceChange);

    const stopReason = run.stopReason ?? (outcome.kind === 'aborted' ? outcome.reason : outcome.stopReason) ?? null;
    this.publish(run, terminalEventType(outcome), {
      run_id: run.runId,
      run_marker: run.runMarker,
      session_key: run.submission.sessionKey,
      message_id: projection.messageId ?? null,
      output: projection.output ?? (outcome.kind === 'completed' ? outcome.outputText ?? null : null),
      error: projection.error ?? (outcome.kind === 'failed' ? outcome.error : null),
      synced: outcome.kind === 'aborted' ? outcome.synced : undefined,
      interrupted: outcome.kind === 'aborted' || run.stopReason === 'queue_insertion',
      stop_reason: stopReason,
      interruption_mode: run.stopReason === 'queue_insertion' ? run.insertionGuarantee : null,
      queue_remaining: queueRemaining,
      workspace_run_change: workspaceChange,
    }, { allTopics: true });
    this.runsById.delete(run.runId);
    if (outcome.kind === 'completed') {
      this.publishBus('chat.run.completed', run, { text: projection.output ?? outcome.outputText ?? '', stopReason });
    } else if (outcome.kind === 'failed') {
      this.publishBus('chat.run.failed', run, { errorCode: outcome.code ?? null, stopReason });
    } else {
      this.publishBus('chat.run.aborted', run, { reason: outcome.reason, synced: outcome.synced, stopReason });
    }

    // 6. 队列空才写结束标记；否则出队下一条。
    if (queueRemaining === 0) {
      try {
        this.store.markRunSessionEnded(run.submission.sessionKey, outcomeEndReason(outcome));
      } catch (error) {
        this.log(`[RunCoordinator] markRunSessionEnded failed: ${(error as Error)?.message}`);
      }
    }

    run.completion.resolve({
      runId: run.runId,
      runMarker: run.runMarker,
      sessionKey: run.submission.sessionKey,
      outcome,
      projection,
      queueRemaining,
      workspaceChange,
      nativeSessionId: run.nativeSessionId,
    });

    if (queueRemaining > 0 && !state.active) {
      const next = state.queue.shift()!;
      const topic = next.payload.submission.topics[0];
      if (state.insertion?.queueId === next.queueId) {
        // 插入的那一条轮到了：先报 starting_queued_message，再清掉状态机。
        this.publishInsertion(state, topic, { ...state.insertion, phase: 'starting_queued_message' });
        this.clearInsertion(state, topic, 'started');
      } else if (state.insertion) {
        // 插入目标不在队首（边角情况）：状态机没有意义了。
        this.clearInsertion(state, topic, 'run_mismatch');
      }
      this.hub.publish({
        topic,
        type: 'run.queued',
        payload: { queue_length: state.queue.size, dequeued_queue_id: next.queueId, queued: state.queue.view() },
      });
      this.startRun(state, next.payload.submission, next.payload.completion, next.queueId);
    } else {
      if (state.insertion) this.clearInsertion(state, run.submission.topics[0], 'queue_empty');
      this.maybeEvict(state);
    }
  }

  // ---------------------------------------------------------------- 控制

  /**
   * 中止会话当前运行。先发 `abort.started`，让适配器停；宽限期内没停下来，
   * 发 `abort.timeout` 并按「未确认」强制收尾——本地状态必须释放，不能让一个卡死的运行时锁住会话。
   */
  async abort(sessionKey: string, reason: InterruptReason, options: { graceMs?: number } = {}): Promise<AbortResult> {
    const state = this.sessions.get(sessionKey);
    const run = state?.active;
    if (!run) return { aborted: false, synced: false, ignored: true };
    // 硬停止（用户点停止、停机、被新运行替换）取消进行中的插入；插入自己发起的中止不算。
    if (reason !== 'queue_insertion' && state?.insertion) this.clearInsertion(state, run.submission.topics[0], 'hard_stop');
    if (!run.terminalHandled && !run.aborting) {
      run.aborting = true;
      run.abortReason = reason;
      const graceMs = options.graceMs ?? run.submission.abortGraceMs ?? this.abortGraceMs;
      this.publish(run, 'abort.started', { run_id: run.runId, reason, grace_ms: graceMs }, { allTopics: true, replay: { mode: 'replace', key: 'abort' } });
      run.controller.abort(reason);
      run.graceTimer = setTimeout(() => {
        if (run.terminalHandled) return;
        this.publish(run, 'abort.timeout', { run_id: run.runId, synced: false }, { replay: { mode: 'replace', key: 'abort' } });
        const phase = run.handle?.status().phase === 'preparing' || !run.handle ? 'preparing' : 'running';
        void this.finalize(run, { kind: 'aborted', reason, synced: false, phase });
      }, graceMs);
      run.graceTimer.unref?.();
      if (run.handle) {
        run.handle.interrupt(reason).catch((error) => {
          this.log(`[RunCoordinator] interrupt failed for ${sessionKey}: ${(error as Error)?.message}`);
        });
      }
    }
    const terminal = await run.completion.promise;
    return {
      aborted: terminal.outcome.kind === 'aborted',
      synced: terminal.outcome.kind === 'aborted' ? terminal.outcome.synced : true,
      ignored: false,
      outcome: terminal.outcome,
    };
  }

  /** 中止订阅了某个主题的所有运行（群聊停止：房间里所有外部成员）。 */
  async abortTopic(topic: string, reason: InterruptReason): Promise<AbortResult[]> {
    const keys = [...this.sessions.values()]
      .filter((state) => state.active?.submission.topics.includes(topic))
      .map((state) => state.sessionKey);
    return Promise.all(keys.map((key) => this.abort(key, reason)));
  }

  cancelQueued(sessionKey: string, queueId: string): boolean {
    const state = this.sessions.get(sessionKey);
    const cancelled = state?.queue.cancel(queueId)?.payload;
    if (!state || !cancelled) return false;
    // 被取消的那一条从没开始过：按「未开始即取消」收尾，等它的调用方不会永远挂着。
    cancelled.completion.resolve({
      runId: '',
      runMarker: '',
      sessionKey,
      outcome: { kind: 'aborted', reason: 'user_stop', synced: true, phase: 'preparing' },
      projection: {},
      queueRemaining: state.queue.size,
      workspaceChange: null,
      nativeSessionId: null,
    });
    if (state.insertion?.queueId === queueId) this.clearInsertion(state, cancelled.submission.topics[0], 'cancelled');
    this.hub.publish({ topic: cancelled.submission.topics[0], type: 'run.queued', payload: { queue_length: state.queue.size, queued: state.queue.view(), cancelled_queue_id: queueId } });
    this.maybeEvict(state);
    return true;
  }

  /** 发一次插入状态（重放缓冲按键替换：重连只需要最新的阶段；清掉时从缓冲移除）。 */
  private publishInsertion(state: SessionState, topic: string, insertion: QueueInsertionView | null, reason?: QueueInsertionEndReason): void {
    const payload = insertion
      ? {
        generation: insertion.generation,
        queue_id: insertion.queueId,
        run_id: insertion.runId,
        runtime: insertion.runtime,
        phase: insertion.phase,
        guarantee: insertion.guarantee,
        requested_at: insertion.requestedAt,
        cleared: false,
      }
      : { cleared: true, reason: reason ?? null };
    const event = this.hub.publish({ topic, type: QUEUE_INSERTION_EVENT, payload, runId: state.active?.runId });
    if (insertion) state.replay.push(event, { mode: 'replace', key: QUEUE_INSERTION_EVENT });
    else state.replay.remove(QUEUE_INSERTION_EVENT);
  }

  private setInsertion(state: SessionState, topic: string, insertion: QueueInsertionView): void {
    state.insertion = insertion;
    this.publishInsertion(state, topic, insertion);
  }

  private clearInsertion(state: SessionState, topic: string, reason: QueueInsertionEndReason): void {
    if (!state.insertion) return;
    state.insertion = null;
    this.publishInsertion(state, topic, null, reason);
  }

  /** 当前插入状态（没有为 null）。 */
  queueInsertion(sessionKey: string): QueueInsertionView | null {
    return this.sessions.get(sessionKey)?.insertion ?? null;
  }

  /**
   * 「立即插入」（spec 01 §2.7）：把某条排队项挪到队首，再让当前运行尽快让出。
   *
   * - 声明了 `boundaryInterrupt` 的运行时：请求边界打断（等当前这批工具跑完，`strict`），阶段 `waiting_for_tool_batch`；
   *   运行时回 `unsupported` 或抛错时退回立即中止（用户要的是「现在就发」）；
   * - 其余：立即中止（杀进程 / 停网关 run，`immediate`），阶段 `stopping_current_turn`；
   * - 同一会话至多一个插入：已有别的插入在进行时回 `already_pending`（界面上插入箭头此时禁用）；
   * - **generation 令牌**：边界打断是异步的，结果回来时若状态机已经被取消 / 换成别的请求 / 运行已经换人，
   *   结果一律丢弃——不许拿旧结果去动一个新运行。
   * 被让出的运行终态带 `interrupted: true`、`stop_reason: queue_insertion`、`interruption_mode`；界面不当错误显示。
   */
  async insertNow(sessionKey: string, queueId: string): Promise<InsertNowResult> {
    const state = this.sessions.get(sessionKey);
    if (!state || !state.queue.has(queueId)) return { status: 'not_found' };
    if (state.insertion && state.insertion.queueId !== queueId) return { status: 'already_pending', insertion: state.insertion };
    if (state.insertion) return { status: state.insertion.guarantee, generation: state.insertion.generation };
    state.queue.moveToFront(queueId);
    const run = state.active;
    const generation = randomUUID();
    if (!run || run.terminalHandled || run.aborting) {
      // 两轮之间的空档或当前运行已在停：队首就是它，出队时直接开始。
      return { status: 'started', generation };
    }
    const topic = run.submission.topics[0];
    const canBoundary = !!(run.submission.adapter.capabilities.boundaryInterrupt && run.handle?.requestBoundaryInterrupt);
    const base: QueueInsertionView = {
      generation,
      queueId,
      runId: run.runId,
      runtime: run.submission.adapter.id,
      phase: 'requesting',
      guarantee: canBoundary ? 'strict' : 'immediate',
      requestedAt: Date.now(),
    };
    this.setInsertion(state, topic, base);
    const stillCurrent = () => state.insertion?.generation === generation && state.active === run && !run.terminalHandled;

    if (canBoundary) {
      let result: BoundaryInterruptResult | null = null;
      try {
        result = await run.handle!.requestBoundaryInterrupt!(run.runId);
      } catch (error) {
        this.log(`[RunCoordinator] boundary interrupt failed for ${sessionKey}: ${(error as Error)?.message}`);
      }
      if (!stillCurrent()) {
        // 令牌过期：插入被取消、运行已经结束或被替换。旧结果不许再动任何东西。
        return { status: 'started', generation };
      }
      if (result?.status === 'accepted' || result?.status === 'already_pending') {
        run.stopReason = 'queue_insertion';
        run.insertionGuarantee = 'strict';
        this.setInsertion(state, topic, { ...base, phase: 'waiting_for_tool_batch' });
        return { status: 'strict', generation };
      }
      if (result?.status === 'not_found' || result?.status === 'run_mismatch') {
        this.clearInsertion(state, topic, 'run_mismatch');
        return { status: 'started', generation };
      }
      // unsupported / 异常：退回立即中止。
    }

    run.stopReason = 'queue_insertion';
    run.insertionGuarantee = 'immediate';
    this.setInsertion(state, topic, { ...base, guarantee: 'immediate', phase: 'stopping_current_turn' });
    void this.abort(sessionKey, 'queue_insertion');
    return { status: 'immediate', generation };
  }

  respondInteraction(sessionKey: string, id: string, response: { choice?: string; text?: string }) {
    return this.interactions.respond(sessionKey, id, response);
  }

  // ---------------------------------------------------------------- 接回

  /** 断线重连时补给订阅者的全部状态：运行视图、重放缓冲、队列、待决交互（剩余时间已重算）、接回快照帧。 */
  snapshot(sessionKey: string): SessionSnapshot {
    const state = this.sessions.get(sessionKey);
    const run = state?.active ?? null;
    const attach: RealtimeEvent[] = [];
    if (run?.projector?.attachSnapshot) {
      for (const frame of run.projector.attachSnapshot()) {
        attach.push({ id: 0, topic: run.submission.topics[0], type: frame.type, payload: frame.payload, at: Date.now(), runId: run.runId, runMarker: run.runMarker });
      }
    }
    return {
      sessionKey,
      activeRun: run ? this.view(run) : null,
      replay: state?.replay.snapshot() ?? [],
      replayDropped: state?.replay.dropped ?? 0,
      queue: state?.queue.view() ?? [],
      insertion: state?.insertion ?? null,
      pendingInteractions: this.interactions.pendingForSession(sessionKey).map((view) => ({
        kind: view.kind,
        id: view.id,
        agentId: view.agentId,
        runId: view.runId,
        request: view.request,
        remainingTimeoutMs: view.remainingTimeoutMs,
      })),
      attach,
    };
  }

  /** 所有「主题列表里含这个主题」的会话快照。WS 订阅 room:<id> 时用它补齐房间里每个成员的运行。 */
  snapshotTopic(topic: string): SessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((state) => state.active?.submission.topics.includes(topic))
      .map((state) => this.snapshot(state.sessionKey));
  }

  async shutdown(graceMs = 2000): Promise<void> {
    const keys = [...this.sessions.values()].filter((state) => state.active).map((state) => state.sessionKey);
    await Promise.all(keys.map((key) => this.abort(key, 'shutdown', { graceMs })));
    this.interactions.shutdown();
  }
}
