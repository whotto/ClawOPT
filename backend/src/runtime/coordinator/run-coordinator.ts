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
 *
 * 适配器只翻译事件；投影器（各表面自己的）只管自己的消息行与帧形状。
 */
import { randomBytes, randomUUID } from 'crypto';

import type { RealtimeEvent, RealtimeHub } from '../../core/realtime';
import {
  acceptsAdapterEvent,
  assertHandleMatchesCapabilities,
  dedupeAppendedText,
  type AdapterEvent,
  type AdapterRunHandle,
  type AdapterRunOutcome,
  type InterruptReason,
  type WorkspaceRunChangeSummary,
} from '../contract';
import { InteractionRegistry, type InteractionOutcome, type PendingInteractionView } from './interaction-registry';
import { ReplayBuffer, type ReplayPolicy } from './replay-buffer';
import { SessionRunQueue, snapshotRequest } from './run-queue';
import { ToolCallGroups } from './tool-call-groups';
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
  nativeSessionId: string | null;
  aborting: boolean;
  abortReason: InterruptReason | null;
  terminalHandled: boolean;
  deferPublishing: boolean;
  deferred: Array<() => void>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  stopReason: string | null;
  completion: Deferred<RunTerminal>;
  droppedEvents: number;
};

type SessionState = {
  sessionKey: string;
  active: ActiveRun | null;
  queue: SessionRunQueue<QueuedPayload>;
  replay: ReplayBuffer;
};

export type RunCoordinatorOptions = {
  hub: RealtimeHub;
  store: RunStore;
  checkpointer?: WorkspaceCheckpointer;
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
  private readonly hub: RealtimeHub;
  private readonly store: RunStore;
  private readonly checkpointer: WorkspaceCheckpointer;
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
    this.replayLimit = options.replayLimit;
    this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.log = options.log ?? ((message) => console.warn(message));
    this.interactions = new InteractionRegistry({
      onActivated: (view) => this.publishInteraction(view, 'requested'),
      onResolved: (view, outcome) => this.publishInteraction(view, 'resolved', outcome),
    });
  }

  // ---------------------------------------------------------------- 状态

  private state(sessionKey: string): SessionState {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = { sessionKey, active: null, queue: new SessionRunQueue(), replay: new ReplayBuffer(this.replayLimit) };
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

  private publishInteraction(view: PendingInteractionView, phase: 'requested' | 'resolved', outcome?: InteractionOutcome): void {
    const state = this.sessions.get(view.sessionKey);
    const run = state?.active && state.active.runId === view.runId ? state.active : null;
    const type = `${view.kind}.${phase}`;
    const payload = phase === 'requested'
      ? { id: view.id, agent_id: view.agentId, run_id: view.runId, request: view.request, requested_at: view.activatedAt, remaining_timeout_ms: view.remainingTimeoutMs }
      : { id: view.id, agent_id: view.agentId, run_id: view.runId, resolved: outcome?.reason === 'response', reason: outcome?.reason, outcome };
    const replayKey = `${view.kind}:${view.id}`;
    if (run) {
      this.publish(run, type, payload, { replay: phase === 'requested' ? { mode: 'replace', key: replayKey } : undefined });
      if (phase === 'resolved') state!.replay.remove(replayKey);
      return;
    }
    // 运行已经结束（中止收尾时）：没有运行上下文，直接发到会话主题。
    this.hub.publish({ topic: `session:${view.sessionKey}`, type, payload, runId: view.runId });
    state?.replay.remove(replayKey);
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
      const position = state.queue.enqueue({ queueId, payload: { submission: snapshot, completion }, display: submission.display ?? null });
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
      nativeSessionId: null,
      aborting: false,
      abortReason: null,
      terminalHandled: false,
      deferPublishing: false,
      deferred: [],
      graceTimer: null,
      stopReason: null,
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

    run.projector = submission.projector({
      runId: run.runId,
      runMarker: run.runMarker,
      sessionKey: submission.sessionKey,
      primaryTopic: submission.topics[0],
      startedAt: run.startedAt,
      publish: (type, payload, options) => this.publish(run, type, payload, { topic: options?.topic, replay: options?.replay }),
      adapterStatus: () => run.handle?.status() ?? { phase: 'preparing' },
    });

    this.publish(run, 'run.started', {
      run_id: run.runId,
      run_marker: run.runMarker,
      runtime: submission.adapter.id,
      agent_id: submission.agentId,
      queue_id: dequeuedQueueId,
      queue_length: state.queue.size,
      meta: submission.meta ?? {},
    }, { allTopics: true, replay: { mode: 'replace', key: 'run.started' } });

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
    if (!acceptsAdapterEvent(adapter.sourceOfTruth, proxyMode, adapterEvent)) {
      this.droppedTotal.arbitration += 1;
      return;
    }

    const event = adapterEvent.event;
    switch (event.type) {
      case 'response.output_text.delta': {
        let delta = event.delta;
        if (adapter.sourceOfTruth.text.length > 1) {
          delta = dedupeAppendedText(run.textByItem.get(event.item_id) ?? '', delta);
          if (!delta) return;
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
      case 'response.reasoning.delta':
        this.publish(run, 'reasoning.delta', { item_id: event.item_id, delta: event.delta });
        break;
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
        this.interactions.requestApproval(run.submission.sessionKey, run.runId, event.request).then((outcome) => {
          if (!run.terminalHandled) run.handle?.resolveApproval?.(event.request.approvalId, outcome.decision);
        });
        break;
      case 'clarify.requested':
        this.interactions.requestClarify(run.submission.sessionKey, run.runId, event.request).then((outcome) => {
          if (!run.terminalHandled) run.handle?.resolveClarify?.(event.request.clarifyId, outcome.response);
        });
        break;
      case 'runtime.native_session':
        run.nativeSessionId = event.nativeSessionId;
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
      message_id: projection.messageId ?? null,
      output: projection.output ?? (outcome.kind === 'completed' ? outcome.outputText ?? null : null),
      error: projection.error ?? (outcome.kind === 'failed' ? outcome.error : null),
      synced: outcome.kind === 'aborted' ? outcome.synced : undefined,
      interrupted: outcome.kind === 'aborted' || run.stopReason === 'queue_insertion',
      stop_reason: stopReason,
      queue_remaining: queueRemaining,
      workspace_run_change: workspaceChange,
    }, { allTopics: true });

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
      this.hub.publish({
        topic: next.payload.submission.topics[0],
        type: 'run.queued',
        payload: { queue_length: state.queue.size, dequeued_queue_id: next.queueId, queued: state.queue.view() },
      });
      this.startRun(state, next.payload.submission, next.payload.completion, next.queueId);
    } else {
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
    this.hub.publish({ topic: cancelled.submission.topics[0], type: 'run.queued', payload: { queue_length: state.queue.size, queued: state.queue.view(), cancelled_queue_id: queueId } });
    this.maybeEvict(state);
    return true;
  }

  /**
   * 「立即插入」：把某条排队项挪到队首，再让当前运行尽快让出。
   * 支持边界打断的运行时等当前这批工具跑完（strict），其余直接中止（immediate）。
   * 插入的完整状态机（generation 令牌、阶段事件、前端插入箭头）留给 P1b。
   */
  async insertNow(sessionKey: string, queueId: string): Promise<{ status: 'not_found' | 'strict' | 'immediate' | 'started' }> {
    const state = this.sessions.get(sessionKey);
    if (!state || !state.queue.moveToFront(queueId)) return { status: 'not_found' };
    const run = state.active;
    if (!run) return { status: 'started' };
    run.stopReason = 'queue_insertion';
    if (run.submission.adapter.capabilities.boundaryInterrupt && run.handle?.requestBoundaryInterrupt) {
      const result = await run.handle.requestBoundaryInterrupt(run.runId);
      if (result.status === 'accepted' || result.status === 'already_pending') return { status: 'strict' };
    }
    void this.abort(sessionKey, 'queue_insertion');
    return { status: 'immediate' };
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
