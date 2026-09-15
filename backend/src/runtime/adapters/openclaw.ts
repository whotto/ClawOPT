/**
 * OpenClaw 网关运行时适配器（单聊）。
 *
 * 迁移自 v1.8.0 的 `ActiveRunManager` 与 `/api/chat` 路由里的网关准备段。**判定逻辑逐行保留**：
 * 完成探针（agent.wait + chat.history 对账）、终态文本快照保护、网关断线重连探针、10 分钟空闲超时、
 * 失败后的 best-effort abort 与重试——这些全是从事故里长出来的，五处对账纪律守着它们。
 *
 * 变的只是职责切分：
 * - 这里只和网关说话，把网关事件翻译成规范事件（累计快照、工具调用、用量），决定运行的结局；
 * - 消息行怎么写、帧长什么样（过程标签拆分、工具进度文案、路径改写）在单聊投影器里
 *   （collab/sessions/openclaw-chat-projection.ts）；
 * - 会话单运行、中止宽限、陈旧事件、终态顺序、用量去重在协调器里。
 *
 * 为了在两边做同样的快照保护，适配器与投影器各持一份 rawText 镜像，并对**同一串事件**执行
 * **同一组** `selectPreferredTextSnapshot` 调用——事件里带的是原始候选文本，不是算好的结果。
 */
import { normalizeCliText, selectPreferredTextSnapshot } from '../../core/util';
import {
  OPENCLAW_CHAT_ABORT_TIMEOUT_MS,
  OPENCLAW_CHAT_HISTORY_PROBE_LIMIT,
  abortOpenClawSessionRuns,
  buildOpenClawChatSessionKey,
  extractSettledAssistantOutcome,
  getHistorySnapshot,
  getHistoryTailActivity,
  getUnknownHistorySnapshot,
  isRecoverableGatewayDisconnectDetail,
  resolveChatFinalTextSnapshot,
  scheduleOpenClawSessionAbortRetry,
  shouldPreferSettledAssistantText,
  type ChatHistorySnapshot,
  type GatewayChatClient,
} from '../../openclaw';
import {
  NATIVE_ONLY_SOURCE_OF_TRUTH,
  defineCapabilities,
  type AdapterRunContext,
  type AdapterRunHandle,
  type AdapterRunOutcome,
  type AgentRuntimeAdapter,
  type CanonicalEvent,
  type InterruptReason,
  type UsageReport,
} from '../contract';

export const OPENCLAW_STREAM_COMPLETION_PROBE_DELAY_MS = 400;
export const OPENCLAW_STREAM_COMPLETION_WAIT_TIMEOUT_MS = 1500;
export const OPENCLAW_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS = 30000;
export const OPENCLAW_HISTORY_COMPLETION_SETTLE_POLL_MS = 500;
export const OPENCLAW_FINAL_EVENT_SETTLE_GRACE_MS = 1500;
export const OPENCLAW_EMPTY_COMPLETION_RETRY_WINDOW_MS = 5 * 60 * 1000;
export const OPENCLAW_HISTORY_ACTIVITY_GRACE_MS = 2 * 60 * 1000;
export const OPENCLAW_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS = 1000;
export const OPENCLAW_GATEWAY_RECONNECT_PROBE_RETRY_DELAY_MS = 3000;
export const OPENCLAW_RUN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** 协调器中止 OpenClaw 运行的宽限：chat.abort 自己有 5 秒时限，再多给 1 秒收尾。 */
export const OPENCLAW_ABORT_GRACE_MS = OPENCLAW_CHAT_ABORT_TIMEOUT_MS + 1000;

export const OPENCLAW_IDLE_TIMEOUT_STOP_REASON = 'idle_timeout';
/** 空闲超时时一个字都没收到：用这句话收尾（有文本时用已收到的文本）。 */
export const OPENCLAW_IDLE_TIMEOUT_WITHOUT_TEXT = 'Response timed out (no connection).';

export const OPENCLAW_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: true,
  nativeFork: false,
  approvals: false,
  clarify: false,
  hostCompression: false,
  nativeCompact: true,
  backgroundDelegation: false,
  images: true,
  mcpInjection: false,
  proxyMode: [],
});

export interface OpenClawChatRunRequest {
  /** ClawOPT 的会话 id。 */
  sessionId: string;
  agentId: string;
  /** 取网关连接（带缓存与重连）。 */
  getConnection: () => Promise<GatewayChatClient>;
  /** 组装真正发给网关的消息（附件、文档工具语境……是表面自己的事）。 */
  prepareMessage: () => Promise<{ text: string; attachments: { type: string; mimeType: string; content: string }[] }>;
  /** 断线后重连成功：把客户端放回连接表。 */
  onGatewayReconnected: (client: GatewayChatClient) => void;
}

/** 网关工具事件的原始字段（`session.tool`）。 */
type SessionToolPayload = { sessionKey?: string; parentSessionKey?: string; runId?: string; data?: any };

function readUsage(message: any, callId: string): UsageReport | null {
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const n = (...values: unknown[]) => {
    for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value;
    return 0;
  };
  const input = n(usage.input, usage.inputTokens, usage.input_tokens);
  const output = n(usage.output, usage.outputTokens, usage.output_tokens);
  if (input === 0 && output === 0) return null;
  const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost.total : usage.cost;
  return {
    callId,
    scope: 'run',
    model: typeof message?.model === 'string' ? message.model : undefined,
    provider: typeof message?.provider === 'string' ? message.provider : undefined,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: n(usage.cacheRead, usage.cache_read_input_tokens),
    cacheWriteTokens: n(usage.cacheWrite, usage.cache_creation_input_tokens),
    reasoningTokens: n(usage.reasoning, usage.reasoningTokens),
    apiCalls: 1,
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined,
  };
}

class OpenClawGatewayRun {
  phase: 'preparing' | 'running' | 'finished' = 'preparing';
  private client: GatewayChatClient | null = null;
  private gatewayRunId = '';
  private finalSessionKey = '';
  private historySnapshot: ChatHistorySnapshot = getUnknownHistorySnapshot();
  private sessionEventsSubscribed = false;
  private rawText = '';
  private finalEventText: string | undefined;
  private finalEventGeneration = 0;
  private settledCalibrationGeneration = 0;
  private latestFinalEventAt: number | undefined;
  private firstCompletionWaitResolvedAt: number | undefined;
  private lastObservedHistoryLength = 0;
  private lastObservedHistorySignature = '';
  private lastObservedHistoryActivityAt: number | undefined;
  private pendingErrorDetail: string | undefined;
  private idleTimeout: NodeJS.Timeout | undefined;
  private completionProbeTimer: NodeJS.Timeout | undefined;
  private completionProbeInFlight = false;
  private completionProbePending = false;
  private gatewayReconnectTimer: NodeJS.Timeout | undefined;
  private gatewayReconnectInFlight = false;
  private listeners: Array<[string, (...args: any[]) => void]> = [];
  private settle!: (outcome: AdapterRunOutcome) => void;
  readonly done: Promise<AdapterRunOutcome>;

  constructor(private readonly context: AdapterRunContext<OpenClawChatRunRequest>) {
    this.done = new Promise<AdapterRunOutcome>((resolve) => { this.settle = resolve; });
  }

  private emit(event: CanonicalEvent): void {
    this.context.emit({ channel: 'native', event });
  }

  get nativeRunId(): string | undefined {
    return this.gatewayRunId || undefined;
  }

  private get request(): OpenClawChatRunRequest {
    return this.context.request;
  }

  private finish(outcome: AdapterRunOutcome): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    this.cleanup();
    this.settle(outcome);
  }

  // ------------------------------------------------------------ 准备

  async start(): Promise<void> {
    const { sessionId, agentId } = this.request;
    const { signal } = this.context;
    let sessionEventsClient: GatewayChatClient | null = null;
    try {
      const client = await this.request.getConnection();
      sessionEventsClient = client;
      if (signal.aborted) return;
      const expectedSessionKey = buildOpenClawChatSessionKey(sessionId, agentId);
      await abortOpenClawSessionRuns(client, expectedSessionKey, `session ${sessionId} before send`);
      if (signal.aborted) return;
      try {
        await client.subscribeSessionEvents();
        this.sessionEventsSubscribed = true;
      } catch (error) {
        console.warn(`[chat] Failed to subscribe session events for session ${sessionId}:`, error);
      }
      const outgoingMessage = await this.request.prepareMessage();
      if (signal.aborted) return;

      this.historySnapshot = await client.getChatHistory(expectedSessionKey, OPENCLAW_CHAT_HISTORY_PROBE_LIMIT)
        .then((history) => getHistorySnapshot(history))
        .catch(() => getUnknownHistorySnapshot());
      if (signal.aborted) return;

      const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
        sessionKey: sessionId,
        message: outgoingMessage.text,
        agentId,
        attachments: outgoingMessage.attachments,
      });
      if (signal.aborted) {
        // 准备阶段就被停了，但网关已经收下这一轮：把它停掉，停不掉就排重试。
        try {
          const abortResult = await client.abortChat({ sessionKey: finalSessionKey, runId, timeoutMs: OPENCLAW_CHAT_ABORT_TIMEOUT_MS });
          if (!abortResult.aborted) {
            scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${sessionId}`);
          }
        } catch {
          scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${sessionId}`);
        }
        return;
      }

      this.attachRun(client, runId, finalSessionKey);
    } catch (error: any) {
      if (this.sessionEventsSubscribed && sessionEventsClient && this.phase !== 'running') {
        this.sessionEventsSubscribed = false;
        void sessionEventsClient.unsubscribeSessionEvents().catch((unsubscribeError) => {
          console.warn(`[chat] Failed to unsubscribe session events for session ${sessionId}:`, unsubscribeError);
        });
      }
      if (signal.aborted || this.phase === 'finished') return;
      const rawDetail = typeof error?.rawDetail === 'string' && error.rawDetail.trim()
        ? error.rawDetail.trim()
        : (typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : '');
      const code = typeof error?.messageCode === 'string' && error.messageCode.trim() ? error.messageCode.trim() : undefined;
      this.finish({ kind: 'failed', error: rawDetail, code, stopReason: 'preparation_failed' });
    } finally {
      // 准备阶段被停：订阅要还回去（真正开始运行后由 cleanup 负责）。
      if (signal.aborted && this.phase === 'preparing' && this.sessionEventsSubscribed && sessionEventsClient) {
        this.sessionEventsSubscribed = false;
        void sessionEventsClient.unsubscribeSessionEvents().catch(() => {});
      }
    }
  }

  // ------------------------------------------------------------ 运行

  private attachRun(client: GatewayChatClient, runId: string, finalSessionKey: string): void {
    this.client = client;
    this.gatewayRunId = runId;
    this.finalSessionKey = finalSessionKey;
    this.phase = 'running';
    this.lastObservedHistoryLength = this.historySnapshot.length;
    this.lastObservedHistorySignature = this.historySnapshot.latestSignature;
    this.emit({ type: 'response.created', response_id: runId });
    this.resetIdleTimeout();

    const on = (event: string, listener: (...args: any[]) => void) => {
      client.on(event, listener);
      this.listeners.push([event, listener]);
    };

    on('chat.delta', (data: { sessionKey: string; runId: string; text: string }) => {
      if (!this.matchesRunEvent(data.sessionKey, data.runId)) return;
      this.resetIdleTimeout();
      if (!this.applyRawText(data.text)) return;
      this.emit({ type: 'response.output_text.snapshot', item_id: this.gatewayRunId, text: data.text, authoritative: false });
    });

    on('chat.final', (data: { sessionKey: string; runId: string; text: string; message: any }) => {
      if (!this.matchesRunEvent(data.sessionKey, data.runId)) return;
      const finalEventObservedAt = Date.now();
      const terminalFinalText = resolveChatFinalTextSnapshot(data.text, data.message);
      if (terminalFinalText) {
        this.finalEventText = selectPreferredTextSnapshot(this.finalEventText, terminalFinalText, { allowShorterReplacement: true });
        this.applyRawText(terminalFinalText, { allowShorterReplacement: true });
        this.latestFinalEventAt = finalEventObservedAt;
        this.finalEventGeneration += 1;
        this.emit({ type: 'response.output_text.snapshot', item_id: this.gatewayRunId, text: terminalFinalText, authoritative: true });
        const usage = readUsage(data.message, `openclaw:${this.finalSessionKey}:${this.gatewayRunId}`);
        if (usage) this.emit({ type: 'usage.reported', usage });
      } else if (data.text) {
        this.applyRawText(data.text);
        this.emit({ type: 'response.output_text.snapshot', item_id: this.gatewayRunId, text: data.text, authoritative: false });
      }
      this.resetIdleTimeout();
      this.scheduleCompletionProbe(0);
    });

    on('chat.aborted', (data: { sessionKey: string; runId: string; text: string }) => {
      if (!this.matchesRunEvent(data.sessionKey, data.runId)) return;
      if (data.text) {
        this.applyRawText(data.text);
        this.emit({ type: 'response.output_text.snapshot', item_id: this.gatewayRunId, text: data.text, authoritative: false });
      }
      this.scheduleCompletionProbe(0);
    });

    on('chat.error', (data: { sessionKey: string; runId: string; error: string }) => {
      if (!this.matchesRunEvent(data.sessionKey, data.runId)) return;
      const detail = normalizeCliText(data.error) || 'Unknown stream error';
      this.resetIdleTimeout();
      if (isRecoverableGatewayDisconnectDetail(detail)) {
        this.scheduleGatewayReconnectProbe();
        this.scheduleCompletionProbe(OPENCLAW_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
        return;
      }
      this.pendingErrorDetail = detail;
      this.scheduleCompletionProbe(0);
    });

    on('session.tool', (payload: SessionToolPayload) => {
      const isRelevant = payload.runId === this.gatewayRunId
        || this.matchesRunEvent(payload.sessionKey || '', payload.runId)
        || payload.parentSessionKey === this.finalSessionKey;
      if (!isRelevant) return;

      const eventData = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? payload.data as Record<string, unknown>
        : {};
      const toolName = typeof eventData.name === 'string' && eventData.name.trim() ? eventData.name.trim() : 'tool';
      const toolCallId = typeof eventData.toolCallId === 'string' && eventData.toolCallId.trim()
        ? eventData.toolCallId.trim()
        : `${payload.runId || this.gatewayRunId}:${toolName}`;
      const phase = typeof eventData.phase === 'string' ? eventData.phase.trim() : '';
      const args = eventData.args === undefined ? '' : (() => {
        try { return JSON.stringify(eventData.args); } catch { return ''; }
      })();

      if (phase === 'start') {
        this.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: toolCallId, call_id: toolCallId, name: toolName, arguments: args } });
      } else if (phase === 'update') {
        this.emit({ type: 'response.function_call.updated', call_id: toolCallId, name: toolName, arguments: args });
      } else if (phase === 'result') {
        this.emit({
          type: 'response.output_item.done',
          item: {
            type: 'function_call_output',
            id: `out_${toolCallId}`,
            call_id: toolCallId,
            name: toolName,
            arguments: args,
            output: '',
            status: eventData.isError === true ? 'failed' : 'completed',
          },
        });
      } else {
        return;
      }
      this.resetIdleTimeout();
    });

    on('disconnected', () => {
      this.scheduleGatewayReconnectProbe();
      this.scheduleCompletionProbe(OPENCLAW_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
    });

    this.scheduleCompletionProbe();
  }

  private applyRawText(candidateText?: string | null, options?: { allowShorterReplacement?: boolean }): boolean {
    const nextRawText = selectPreferredTextSnapshot(this.rawText, candidateText, options);
    const changed = nextRawText !== this.rawText;
    this.rawText = nextRawText;
    return changed;
  }

  private matchesRunEvent(sessionKey: string, runId?: string | null): boolean {
    if (runId && runId !== this.gatewayRunId) return false;
    const { sessionId } = this.request;
    return sessionKey === this.finalSessionKey
      || sessionKey === sessionId
      || sessionKey.endsWith(`:${sessionId}`)
      || sessionKey.includes(`:chat:${sessionId}`);
  }

  private get isCurrent(): boolean {
    return this.phase === 'running';
  }

  private resetIdleTimeout(): void {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);
    this.idleTimeout = setTimeout(() => {
      if (!this.isCurrent) return;
      const finalText = this.rawText || OPENCLAW_IDLE_TIMEOUT_WITHOUT_TEXT;
      this.abortUnderlyingRunBestEffort('idle timeout');
      this.finish({ kind: 'completed', outputText: finalText, stopReason: OPENCLAW_IDLE_TIMEOUT_STOP_REASON });
    }, OPENCLAW_RUN_IDLE_TIMEOUT_MS);
  }

  private scheduleGatewayReconnectProbe(delay = OPENCLAW_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS): void {
    if (!this.isCurrent || !this.client) return;
    if (this.gatewayReconnectTimer) clearTimeout(this.gatewayReconnectTimer);
    this.gatewayReconnectTimer = setTimeout(() => {
      this.gatewayReconnectTimer = undefined;
      if (!this.isCurrent || this.gatewayReconnectInFlight || !this.client) return;
      const client = this.client;
      this.gatewayReconnectInFlight = true;
      void client.connect()
        .then(async () => {
          if (!this.isCurrent) return;
          this.request.onGatewayReconnected(client);
          if (isRecoverableGatewayDisconnectDetail(this.pendingErrorDetail)) {
            this.pendingErrorDetail = undefined;
          }
          if (this.sessionEventsSubscribed) {
            try {
              await client.subscribeSessionEvents();
            } catch (error) {
              console.warn(`[chat] Failed to resubscribe session events after gateway reconnect for session ${this.request.sessionId}:`, error);
            }
          }
          this.scheduleCompletionProbe(0);
        })
        .catch((error) => {
          if (!this.isCurrent) return;
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[chat] Waiting for gateway reconnect for session ${this.request.sessionId}, run ${this.gatewayRunId}: ${detail}`);
          this.scheduleGatewayReconnectProbe(OPENCLAW_GATEWAY_RECONNECT_PROBE_RETRY_DELAY_MS);
        })
        .finally(() => {
          this.gatewayReconnectInFlight = false;
        });
    }, delay);
    this.gatewayReconnectTimer.unref?.();
  }

  private scheduleCompletionProbe(delay = OPENCLAW_STREAM_COMPLETION_PROBE_DELAY_MS): void {
    if (!this.isCurrent) return;
    this.completionProbePending = true;
    if (this.completionProbeTimer) clearTimeout(this.completionProbeTimer);
    this.completionProbeTimer = setTimeout(() => {
      this.completionProbeTimer = undefined;
      if (this.completionProbeInFlight) return;
      this.completionProbePending = false;
      void this.probeCompletion();
    }, delay);
  }

  private async probeCompletion(): Promise<void> {
    if (!this.isCurrent || this.completionProbeInFlight || !this.client) return;
    const client = this.client;
    this.completionProbeInFlight = true;
    const probeFinalGeneration = this.finalEventGeneration;
    const pendingErrorDetail = normalizeCliText(this.pendingErrorDetail) || '';

    try {
      await client.waitForRun(this.gatewayRunId, OPENCLAW_STREAM_COMPLETION_WAIT_TIMEOUT_MS);
      if (this.firstCompletionWaitResolvedAt === undefined) {
        this.firstCompletionWaitResolvedAt = Date.now();
      }
      if (!this.isCurrent) return;

      const hasFinalEventText = () => !!this.finalEventText?.trim();
      let completedOutput = selectPreferredTextSnapshot(this.rawText, this.finalEventText, {
        allowShorterReplacement: hasFinalEventText(),
      });
      let settledErrorDetail = '';
      let shouldRetryForEmptyCompletion = false;
      let bestSettledAssistantText = '';
      const visibleFinalGraceDeadline = probeFinalGeneration > 0
        && completedOutput.trim()
        && this.latestFinalEventAt !== undefined
        ? this.latestFinalEventAt + OPENCLAW_FINAL_EVENT_SETTLE_GRACE_MS
        : null;
      try {
        const historyProbeStartedAt = Date.now();
        while ((Date.now() - historyProbeStartedAt) < OPENCLAW_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS) {
          const history = await client.getChatHistory(this.finalSessionKey, OPENCLAW_CHAT_HISTORY_PROBE_LIMIT);
          if (!this.isCurrent) return;
          const historyTailActivity = getHistoryTailActivity(history, this.historySnapshot);
          if (
            historyTailActivity.hasChanges
            && (
              historyTailActivity.length !== this.lastObservedHistoryLength
              || historyTailActivity.latestSignature !== this.lastObservedHistorySignature
            )
          ) {
            this.lastObservedHistoryLength = historyTailActivity.length;
            this.lastObservedHistorySignature = historyTailActivity.latestSignature;
            this.lastObservedHistoryActivityAt = Date.now();
            this.resetIdleTimeout();
          }
          const settledAssistantOutcome = extractSettledAssistantOutcome(history, this.historySnapshot);
          if (settledAssistantOutcome.kind === 'error') {
            settledErrorDetail = settledAssistantOutcome.error;
            break;
          }
          if (settledAssistantOutcome.kind === 'text') {
            bestSettledAssistantText = settledAssistantOutcome.text;
            const settledMatchesCurrent = settledAssistantOutcome.text.trim() === completedOutput.trim();
            if (shouldPreferSettledAssistantText(completedOutput, settledAssistantOutcome.text)) {
              completedOutput = selectPreferredTextSnapshot(completedOutput, settledAssistantOutcome.text);
              break;
            }
            if (settledMatchesCurrent) {
              break;
            }
          }

          if (visibleFinalGraceDeadline !== null) {
            const remainingVisibleFinalGraceMs = visibleFinalGraceDeadline - Date.now();
            if (remainingVisibleFinalGraceMs <= 0) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(OPENCLAW_HISTORY_COMPLETION_SETTLE_POLL_MS, remainingVisibleFinalGraceMs)));
            continue;
          }

          await new Promise((resolve) => setTimeout(resolve, OPENCLAW_HISTORY_COMPLETION_SETTLE_POLL_MS));
        }

        if (settledErrorDetail) {
          this.failRun(settledErrorDetail);
          return;
        }

        if (shouldPreferSettledAssistantText(completedOutput, bestSettledAssistantText)) {
          completedOutput = selectPreferredTextSnapshot(completedOutput, bestSettledAssistantText);
        }
      } catch (historyError) {
        const historyErrorDetail = historyError instanceof Error ? historyError.message : String(historyError);
        if (isRecoverableGatewayDisconnectDetail(historyErrorDetail)) {
          this.scheduleGatewayReconnectProbe();
          this.scheduleCompletionProbe(OPENCLAW_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
          return;
        }
        console.warn(`[ActiveRunManager] Failed to read final history for session ${this.request.sessionId}, run ${this.gatewayRunId}:`, historyError);
        shouldRetryForEmptyCompletion = true;
      }

      if (!completedOutput.trim()) {
        shouldRetryForEmptyCompletion = true;
      }

      completedOutput = selectPreferredTextSnapshot(completedOutput, this.finalEventText, {
        allowShorterReplacement: hasFinalEventText(),
      });

      const hasSettledAssistantText = bestSettledAssistantText.trim().length > 0;
      const hasStableVisibleFinalText = probeFinalGeneration > 0
        && probeFinalGeneration === this.finalEventGeneration
        && completedOutput.trim().length > 0
        && this.latestFinalEventAt !== undefined
        && Date.now() >= (this.latestFinalEventAt + OPENCLAW_FINAL_EVENT_SETTLE_GRACE_MS);

      if (
        probeFinalGeneration > 0
        && probeFinalGeneration === this.finalEventGeneration
        && (hasSettledAssistantText || hasStableVisibleFinalText)
      ) {
        this.settledCalibrationGeneration = Math.max(this.settledCalibrationGeneration, probeFinalGeneration);
      }

      const isAwaitingInitialTerminalEvidence = this.finalEventGeneration === 0 && !hasSettledAssistantText;
      const isAwaitingSettledFinalCalibration = this.finalEventGeneration > this.settledCalibrationGeneration;
      const hasRecentHistoryActivity = this.lastObservedHistoryActivityAt !== undefined
        && (Date.now() - this.lastObservedHistoryActivityAt) < OPENCLAW_HISTORY_ACTIVITY_GRACE_MS;

      if (
        (shouldRetryForEmptyCompletion || isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration)
        && hasRecentHistoryActivity
      ) {
        this.scheduleCompletionProbe(OPENCLAW_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if (
        shouldRetryForEmptyCompletion
        && this.firstCompletionWaitResolvedAt !== undefined
        && (Date.now() - this.firstCompletionWaitResolvedAt) < OPENCLAW_EMPTY_COMPLETION_RETRY_WINDOW_MS
      ) {
        this.scheduleCompletionProbe(OPENCLAW_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if (
        (isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration)
        && this.firstCompletionWaitResolvedAt !== undefined
        && (Date.now() - this.firstCompletionWaitResolvedAt) < OPENCLAW_EMPTY_COMPLETION_RETRY_WINDOW_MS
      ) {
        this.scheduleCompletionProbe(OPENCLAW_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if ((isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration) && completedOutput.trim() && !pendingErrorDetail) {
        console.warn(
          `[ActiveRunManager] Finalizing run ${this.gatewayRunId} for session ${this.request.sessionId} using streamed text fallback because terminal assistant evidence never settled.`,
        );
        this.finish({ kind: 'completed', outputText: completedOutput });
        return;
      }

      if (isAwaitingInitialTerminalEvidence) {
        this.failRun(pendingErrorDetail || 'Run completed without a terminal assistant response.');
        return;
      }

      if (isAwaitingSettledFinalCalibration) {
        this.failRun(pendingErrorDetail || 'Run completed but the final assistant response never settled.');
        return;
      }

      if (!completedOutput.trim() && pendingErrorDetail) {
        this.failRun(pendingErrorDetail);
        return;
      }

      this.finish({ kind: 'completed', outputText: completedOutput });
    } catch (error: any) {
      if (!this.isCurrent) return;
      const detail = typeof error?.message === 'string' ? error.message : '';
      if (/timeout/i.test(detail)) {
        this.scheduleCompletionProbe();
        return;
      }
      if (isRecoverableGatewayDisconnectDetail(detail)) {
        this.scheduleGatewayReconnectProbe();
        this.scheduleCompletionProbe(OPENCLAW_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
        return;
      }
      this.failRun(pendingErrorDetail || detail || 'Failed waiting for run completion.');
    } finally {
      this.completionProbeInFlight = false;
      if (this.isCurrent && this.completionProbePending && !this.completionProbeTimer) {
        this.scheduleCompletionProbe(0);
      }
    }
  }

  private failRun(detail: string): void {
    if (!this.isCurrent) return;
    this.abortUnderlyingRunBestEffort(detail);
    this.finish({ kind: 'failed', error: detail });
  }

  private abortUnderlyingRunBestEffort(reason: string): void {
    const client = this.client;
    if (!client || !this.finalSessionKey || !this.gatewayRunId) return;
    const { sessionId } = this.request;
    const runId = this.gatewayRunId;
    const sessionKey = this.finalSessionKey;
    void client.abortChat({ sessionKey, runId, timeoutMs: OPENCLAW_CHAT_ABORT_TIMEOUT_MS }).then((result) => {
      if (!result.aborted) {
        scheduleOpenClawSessionAbortRetry(client, sessionKey, `run ${runId} for session ${sessionId} after ${reason}`);
      }
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[chat] Failed to abort OpenClaw run ${runId} for session ${sessionId} after ${reason}: ${detail}`);
      scheduleOpenClawSessionAbortRetry(client, sessionKey, `run ${runId} for session ${sessionId} after ${reason}`);
    });
  }

  // ------------------------------------------------------------ 中止

  async interrupt(reason: InterruptReason): Promise<{ synced: boolean }> {
    if (this.phase === 'finished') return { synced: true };
    if (this.phase === 'preparing') {
      // 准备段里每个 await 之后都会看 signal；网关若已收下这一轮，由准备段自己去 abort。
      this.finish({ kind: 'aborted', reason, synced: true, phase: 'preparing' });
      return { synced: true };
    }
    const client = this.client!;
    const { sessionId } = this.request;
    let aborted = false;
    try {
      const result = await client.abortChat({
        sessionKey: this.finalSessionKey,
        runId: this.gatewayRunId,
        timeoutMs: OPENCLAW_CHAT_ABORT_TIMEOUT_MS,
      });
      aborted = result.aborted;
      if (!result.aborted) {
        scheduleOpenClawSessionAbortRetry(client, this.finalSessionKey, `active run ${this.gatewayRunId} for session ${sessionId}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[chat] Failed to abort active OpenClaw run ${this.gatewayRunId} for session ${sessionId}: ${detail}`);
      scheduleOpenClawSessionAbortRetry(client, this.finalSessionKey, `active run ${this.gatewayRunId} for session ${sessionId}`);
    }
    this.finish({ kind: 'aborted', reason, synced: aborted, phase: 'running' });
    return { synced: aborted };
  }

  private cleanup(): void {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);
    if (this.completionProbeTimer) clearTimeout(this.completionProbeTimer);
    if (this.gatewayReconnectTimer) clearTimeout(this.gatewayReconnectTimer);
    const client = this.client;
    if (!client) return;
    for (const [event, listener] of this.listeners.splice(0)) client.off(event, listener);
    if (this.sessionEventsSubscribed) {
      this.sessionEventsSubscribed = false;
      void client.unsubscribeSessionEvents().catch((error) => {
        console.warn(`[chat] Failed to unsubscribe session events for session ${this.request.sessionId}:`, error);
      });
    }
  }
}

export function createOpenClawRuntimeAdapter(): AgentRuntimeAdapter<OpenClawChatRunRequest> {
  return {
    id: 'openclaw',
    capabilities: OPENCLAW_CAPABILITIES,
    sourceOfTruth: NATIVE_ONLY_SOURCE_OF_TRUTH,
    start(context): AdapterRunHandle {
      const run = new OpenClawGatewayRun(context);
      void run.start();
      return {
        done: run.done,
        status: () => ({ phase: run.phase, nativeRunId: run.nativeRunId }),
        interrupt: (reason) => run.interrupt(reason),
      };
    },
  };
}
