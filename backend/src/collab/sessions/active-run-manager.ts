import express from 'express';

import type { ConfigManager } from '../../core/config';
import { DB } from '../../core/db';
import { normalizeCliText } from '../../core/util';
import { OpenClawClient } from '../../openclaw';
import { canonicalizeAssistantWorkspaceArtifacts } from '../../workspace';
import {
  appendToolProgressLine,
  formatToolResultProgress,
  formatToolStartProgress,
  type GroupToolProgressState,
  normalizeGroupToolProgressLocale,
  normalizeToolArgsRecord,
} from '../rooms';
import {
  CHAT_EMPTY_COMPLETION_RETRY_WINDOW_MS,
  CHAT_FINAL_EVENT_SETTLE_GRACE_MS,
  CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS,
  CHAT_GATEWAY_RECONNECT_PROBE_RETRY_DELAY_MS,
  CHAT_HISTORY_ACTIVITY_GRACE_MS,
  CHAT_HISTORY_COMPLETION_PROBE_LIMIT,
  CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS,
  CHAT_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS,
  CHAT_ORPHAN_ABORT_TIMEOUT_MS,
  CHAT_STREAM_COMPLETION_PROBE_DELAY_MS,
  CHAT_STREAM_COMPLETION_WAIT_TIMEOUT_MS,
} from './chat-constants';
import {
  type ChatHistorySnapshot,
  extractSettledAssistantOutcome,
  getHistoryTailActivity,
  shouldPreferSettledAssistantText,
} from './chat-history-reconciliation';
import { scheduleOpenClawSessionAbortRetry } from './chat-lifecycle';
import { createStructuredChatError } from './chat-messages';
import {
  type ActiveRun,
  isRecoverableGatewayDisconnectDetail,
  isStreamingClientOpen,
  LocalChatOperationManager,
  PendingChatPreparationManager,
  resolveChatFinalTextSnapshot,
} from './chat-run-managers';
import {
  combineChatProcessContent,
  rewriteOpenClawMediaPaths,
  splitChatProcessOutput,
} from './process-text';
import { selectPreferredTextSnapshot } from './text-snapshot-protection';

export class ActiveRunManager {
  private runs = new Map<string, ActiveRun>();
  private db: DB;
  private configManager: ConfigManager;
  private connections: Map<string, OpenClawClient>;

  constructor(db: DB, configManager: ConfigManager, connections: Map<string, OpenClawClient>) {
    this.db = db;
    this.configManager = configManager;
    this.connections = connections;
  }

  getRun(sessionId: string): ActiveRun | undefined {
    return this.runs.get(sessionId);
  }

  private writeRunEvent(run: ActiveRun, payload: Record<string, unknown>, options?: { end?: boolean }) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    run.clients = run.clients.filter((res) => {
      if (!isStreamingClientOpen(res)) {
        return false;
      }

      try {
        res.write(frame);
        if (options?.end) {
          res.end();
          return false;
        }
        return isStreamingClientOpen(res);
      } catch {
        return false;
      }
    });
  }

  private writeSingleRunEvent(res: express.Response, payload: Record<string, unknown>, options?: { end?: boolean }): boolean {
    if (!isStreamingClientOpen(res)) return false;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (options?.end) {
        res.end();
        return false;
      }
      return isStreamingClientOpen(res);
    } catch {
      return false;
    }
  }

  private persistVisibleSnapshot(run: ActiveRun, visible: { text: string; process_content: string; process_streaming: boolean }) {
    this.db.updateMessage(
      run.messageId,
      visible.text,
      run.modelUsed,
      visible.process_content,
      visible.process_streaming,
    );
  }

  private scheduleGatewayReconnectProbe(run: ActiveRun, delay = CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS) {
    if (!this.isCurrentRun(run) || !run.clientRef) return;
    run.gatewayDisconnectedAt = run.gatewayDisconnectedAt ?? Date.now();
    if (run.gatewayReconnectTimer) {
      clearTimeout(run.gatewayReconnectTimer);
    }
    run.gatewayReconnectTimer = setTimeout(() => {
      run.gatewayReconnectTimer = undefined;
      if (!this.isCurrentRun(run) || run.gatewayReconnectInFlight || !run.clientRef) {
        return;
      }

      run.gatewayReconnectInFlight = true;
      void run.clientRef.connect()
        .then(async () => {
          if (!this.isCurrentRun(run) || !run.clientRef) return;
          this.connections.set(run.sessionId, run.clientRef);
          run.gatewayDisconnectedAt = undefined;
          if (isRecoverableGatewayDisconnectDetail(run.pendingErrorDetail)) {
            run.pendingErrorDetail = undefined;
          }
          if (run.sessionEventsSubscribed) {
            try {
              await run.clientRef.subscribeSessionEvents();
            } catch (error) {
              console.warn(`[chat] Failed to resubscribe session events after gateway reconnect for session ${run.sessionId}:`, error);
            }
          }
          this.scheduleCompletionProbe(run, 0);
        })
        .catch((error) => {
          if (!this.isCurrentRun(run)) return;
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[chat] Waiting for gateway reconnect for session ${run.sessionId}, run ${run.runId}: ${detail}`);
          this.scheduleGatewayReconnectProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_RETRY_DELAY_MS);
        })
        .finally(() => {
          run.gatewayReconnectInFlight = false;
        });
    }, delay);
    run.gatewayReconnectTimer.unref?.();
  }

  private isCurrentRun(run: ActiveRun | undefined): run is ActiveRun {
    if (!run) return false;
    const current = this.runs.get(run.sessionId);
    return !!current && current.runId === run.runId && current.messageId === run.messageId;
  }

  async abortRun(sessionId: string): Promise<{ aborted: boolean }> {
    const run = this.runs.get(sessionId);
    if (!run || !run.clientRef) {
      return { aborted: false };
    }

    const clientRef = run.clientRef;
    let aborted = false;
    try {
      const result = await clientRef.abortChat({
        sessionKey: run.finalSessionKey,
        runId: run.runId,
        timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
      });
      aborted = result.aborted;
      if (!result.aborted) {
        scheduleOpenClawSessionAbortRetry(
          clientRef,
          run.finalSessionKey,
          `active run ${run.runId} for session ${sessionId}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[chat] Failed to abort active OpenClaw run ${run.runId} for session ${sessionId}: ${detail}`);
      scheduleOpenClawSessionAbortRetry(
        clientRef,
        run.finalSessionKey,
        `active run ${run.runId} for session ${sessionId}`,
      );
    }

    const canonicalText = canonicalizeAssistantWorkspaceArtifacts(run.text || '', {
      workspacePath: run.workspacePath,
      startedAtMs: run.startedAt,
    });
    const rewritten = rewriteOpenClawMediaPaths(canonicalText, run.workspacePath);
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(run.processContent || '', run.workspacePath);
    this.db.updateMessage(run.messageId, rewritten, run.modelUsed, rewrittenProcessContent, false);

    this.writeRunEvent(run, {
      type: 'final',
      text: rewritten,
      process_content: rewrittenProcessContent,
      process_streaming: false,
    }, { end: true });

    this.cleanupRun(run);
    return { aborted };
  }

  private applyRawTextSnapshot(
    run: ActiveRun,
    candidateText?: string | null,
    options?: { allowShorterReplacement?: boolean },
  ) {
    const nextRawText = selectPreferredTextSnapshot(run.rawText, candidateText, options);
    const rawChanged = nextRawText !== run.rawText;
    if (rawChanged) {
      run.rawText = nextRawText;
    }

    const splitOutput = splitChatProcessOutput(run.rawText, run.processStartTag, run.processEndTag);
    run.text = splitOutput.finalContent;
    run.modelProcessContent = splitOutput.processContent;
    run.modelProcessStreaming = splitOutput.processStreaming;
    run.processContent = combineChatProcessContent(run.toolProcessContent, run.modelProcessContent);
    run.processStreaming = run.modelProcessStreaming || run.activeToolCallIds.size > 0;
    return rawChanged;
  }

  private buildVisibleChatPatch(run: ActiveRun, content: string, processContent = run.processContent, processStreaming = run.processStreaming) {
    const rewritten = rewriteOpenClawMediaPaths(content, run.workspacePath);
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(processContent, run.workspacePath);
    return {
      text: rewritten,
      process_content: rewrittenProcessContent,
      process_streaming: processStreaming,
    };
  }

  private emitVisibleDelta(run: ActiveRun, options?: { force?: boolean }) {
    const visible = this.buildVisibleChatPatch(run, run.text);
    const didVisibleChange = visible.text !== run.visibleFinalText
      || visible.process_content !== run.visibleProcessContent
      || visible.process_streaming !== run.visibleProcessStreaming;

    if (!options?.force && !didVisibleChange) {
      return;
    }

    run.visibleFinalText = visible.text;
    run.visibleProcessContent = visible.process_content;
    run.visibleProcessStreaming = visible.process_streaming;
    this.persistVisibleSnapshot(run, visible);
    this.writeRunEvent(run, { type: 'delta', ...visible });
  }

  private emitVisibleFinal(run: ActiveRun, finalText: string, options?: { end?: boolean; allowShorterReplacement?: boolean }) {
    this.applyRawTextSnapshot(run, finalText, {
      allowShorterReplacement: options?.allowShorterReplacement,
    });
    const canonicalText = options?.end
      ? canonicalizeAssistantWorkspaceArtifacts(run.text, {
          workspacePath: run.workspacePath,
          startedAtMs: run.startedAt,
        })
      : run.text;
    const visible = this.buildVisibleChatPatch(run, canonicalText, run.processContent, options?.end ? false : run.processStreaming);
    const nextVisibleFinalText = selectPreferredTextSnapshot(run.visibleFinalText, visible.text, {
      allowShorterReplacement: options?.allowShorterReplacement,
    });
    const nextVisibleProcessContent = selectPreferredTextSnapshot(run.visibleProcessContent, visible.process_content);
    if (!nextVisibleFinalText.trim() && !nextVisibleProcessContent.trim()) {
      if (options?.end) {
        this.persistVisibleSnapshot(run, {
          text: nextVisibleFinalText,
          process_content: nextVisibleProcessContent,
          process_streaming: false,
        });
        this.writeRunEvent(run, {
          type: 'final',
          text: nextVisibleFinalText,
          process_content: nextVisibleProcessContent,
          process_streaming: false,
        }, { end: true });
      }
      return '';
    }

    const shouldSendFinalEvent = !!options?.end
      || run.visibleFinalText !== nextVisibleFinalText
      || run.visibleProcessContent !== nextVisibleProcessContent
      || run.visibleProcessStreaming !== visible.process_streaming;
    if (shouldSendFinalEvent) {
      run.visibleFinalText = nextVisibleFinalText;
      run.visibleProcessContent = nextVisibleProcessContent;
      run.visibleProcessStreaming = visible.process_streaming;
      const eventPayload = {
        type: 'final',
        text: nextVisibleFinalText,
        process_content: nextVisibleProcessContent,
        process_streaming: visible.process_streaming,
      };
      this.persistVisibleSnapshot(run, eventPayload);
      this.writeRunEvent(run, eventPayload, { end: options?.end });
      return nextVisibleFinalText;
    }

    if (options?.end) {
      this.persistVisibleSnapshot(run, {
        text: nextVisibleFinalText,
        process_content: nextVisibleProcessContent,
        process_streaming: false,
      });
      this.writeRunEvent(run, {
        type: 'final',
        text: nextVisibleFinalText,
        process_content: nextVisibleProcessContent,
        process_streaming: false,
      }, { end: true });
    }

    return nextVisibleFinalText;
  }

  startRun(
    sessionId: string,
    runId: string,
    agentId: string,
    agentName: string,
    modelUsed: string,
    messageId: number,
    workspacePath: string,
    clientRef: OpenClawClient,
    finalSessionKey: string,
    historySnapshot: ChatHistorySnapshot,
    processStartTag?: string,
    processEndTag?: string,
    sessionEventsSubscribed = false
  ): ActiveRun {
    const run: ActiveRun = {
      sessionId,
      runId,
      agentId,
      agentName,
      modelUsed,
      messageId,
      startedAt: Date.now(),
      workspacePath,
      finalSessionKey,
      processStartTag,
      processEndTag,
      historySnapshot,
      rawText: '',
      text: '',
      modelProcessContent: '',
      modelProcessStreaming: false,
      toolProcessContent: '',
      processContent: '',
      processStreaming: !!(processStartTag && processEndTag),
      clients: [],
      completionProbePending: false,
      firstCompletionWaitResolvedAt: undefined,
      finalEventGeneration: 0,
      settledCalibrationGeneration: 0,
      latestFinalEventAt: undefined,
      lastObservedHistoryLength: historySnapshot.length,
      lastObservedHistorySignature: historySnapshot.latestSignature,
      lastObservedHistoryActivityAt: undefined,
      pendingErrorDetail: undefined,
      toolProgressLines: [],
      activeToolCallIds: new Set<string>(),
      toolProgressById: new Map<string, GroupToolProgressState>(),
      sessionEventsSubscribed,
      clientRef
    };
    this.runs.set(sessionId, run);
    this.resetIdleTimeout(run);

    const onDelta = (data: { sessionKey: string; runId: string; text: string }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        this.resetIdleTimeout(run);
        const didTextChange = this.applyRawTextSnapshot(run, data.text);
        if (!didTextChange) {
          return;
        }
        this.emitVisibleDelta(run);
      }
    };

    const onFinal = (data: { sessionKey: string; runId: string; text: string; message: any }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        const finalEventObservedAt = Date.now();
        const terminalFinalText = resolveChatFinalTextSnapshot(data.text, data.message);
        if (terminalFinalText) {
          run.finalEventText = selectPreferredTextSnapshot(run.finalEventText, terminalFinalText, {
            allowShorterReplacement: true,
          });
          this.applyRawTextSnapshot(run, terminalFinalText, {
            allowShorterReplacement: true,
          });
          run.latestFinalEventAt = finalEventObservedAt;
          run.finalEventGeneration += 1;
          this.emitVisibleFinal(run, run.finalEventText || run.rawText, {
            allowShorterReplacement: true,
          });
        } else if (data.text) {
          this.applyRawTextSnapshot(run, data.text);
          this.emitVisibleDelta(run);
        }
        this.resetIdleTimeout(run);
        this.scheduleCompletionProbe(run, 0);
      }
    };

    const onAborted = (data: { sessionKey: string; runId: string; text: string }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        if (data.text) {
          this.applyRawTextSnapshot(run, data.text);
          this.emitVisibleDelta(run);
        }
        this.scheduleCompletionProbe(run, 0);
      }
    };

    const onError = (data: { sessionKey: string; runId: string; error: string }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        const detail = normalizeCliText(data.error) || 'Unknown stream error';
        this.resetIdleTimeout(run);
        if (isRecoverableGatewayDisconnectDetail(detail)) {
          this.scheduleGatewayReconnectProbe(run);
          this.scheduleCompletionProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
          return;
        }
        run.pendingErrorDetail = detail;
        this.scheduleCompletionProbe(run, 0);
      }
    };

    const onSessionTool = (payload: {
      sessionKey?: string;
      parentSessionKey?: string;
      runId?: string;
      data?: any;
    }) => {
      const isRelevant = payload.runId === run.runId
        || this.matchesRunEvent(run, payload.sessionKey || '', payload.runId)
        || payload.parentSessionKey === run.finalSessionKey;
      if (!isRelevant) {
        return;
      }

      const eventData = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? payload.data as Record<string, unknown>
        : {};
      const toolName = typeof eventData.name === 'string' && eventData.name.trim()
        ? eventData.name.trim()
        : 'tool';
      const toolCallId = typeof eventData.toolCallId === 'string' && eventData.toolCallId.trim()
        ? eventData.toolCallId.trim()
        : `${payload.runId || run.runId}:${toolName}`;
      const phase = typeof eventData.phase === 'string' ? eventData.phase.trim() : '';
      const existingState = run.toolProgressById.get(toolCallId);
      const nextArgs = normalizeToolArgsRecord(eventData.args) ?? existingState?.args;
      const nextState: GroupToolProgressState = existingState ?? {
        toolName,
        args: nextArgs,
      };
      nextState.toolName = toolName;
      nextState.args = nextArgs;

      const progressLocale = normalizeGroupToolProgressLocale(this.configManager.getConfig().language);
      if (phase === 'start') {
        run.activeToolCallIds.add(toolCallId);
        appendToolProgressLine(run.toolProgressLines, formatToolStartProgress(progressLocale, toolName, nextArgs));
      } else if (phase === 'update') {
        run.activeToolCallIds.add(toolCallId);
      } else if (phase === 'result') {
        run.activeToolCallIds.delete(toolCallId);
        appendToolProgressLine(run.toolProgressLines, formatToolResultProgress(
          progressLocale,
          toolName,
          nextArgs,
          eventData.isError === true,
        ));
      } else {
        return;
      }

      run.toolProcessContent = run.toolProgressLines.join('\n');
      if (phase === 'result') {
        run.toolProgressById.delete(toolCallId);
      } else {
        run.toolProgressById.set(toolCallId, nextState);
      }
      this.applyRawTextSnapshot(run);
      this.emitVisibleDelta(run, { force: true });
      this.resetIdleTimeout(run);
    };

    const onDisconnect = () => {
      this.scheduleGatewayReconnectProbe(run);
      this.scheduleCompletionProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
    };

    clientRef.on('chat.delta', onDelta);
    clientRef.on('chat.final', onFinal);
    clientRef.on('chat.aborted', onAborted);
    clientRef.on('chat.error', onError);
    clientRef.on('session.tool', onSessionTool);
    clientRef.on('disconnected', onDisconnect);

    // Attach listeners to run for easy cleanup
    (run as any)._onDelta = onDelta;
    (run as any)._onFinal = onFinal;
    (run as any)._onAborted = onAborted;
    (run as any)._onError = onError;
    (run as any)._onSessionTool = onSessionTool;
    (run as any)._onDisconnect = onDisconnect;

    this.scheduleCompletionProbe(run);

    return run;
  }

  attachClient(sessionId: string, res: express.Response, options?: { announceAttach?: boolean }) {
    if (!isStreamingClientOpen(res)) {
      return false;
    }

    const run = this.runs.get(sessionId);
    if (run) {
      run.clients.push(res);
      if (options?.announceAttach) {
        this.writeSingleRunEvent(res, {
          type: 'attached',
          messageId: run.messageId,
          agentId: run.agentId,
          agentName: run.agentName,
          modelUsed: run.modelUsed,
        });
      }
      if (run.visibleFinalText || run.visibleProcessContent) {
        this.writeSingleRunEvent(res, {
          type: 'final',
          text: run.visibleFinalText || '',
          process_content: run.visibleProcessContent || '',
          process_streaming: !!run.visibleProcessStreaming,
        });
      } else if (run.text || run.processContent || run.processStreaming) {
        const visible = this.buildVisibleChatPatch(run, run.text);
        this.writeSingleRunEvent(res, { type: 'delta', ...visible });
      }
      res.on('close', () => {
        run.clients = run.clients.filter(c => c !== res);
      });
      return true;
    }
    return false;
  }

  private resetIdleTimeout(run: ActiveRun) {
    if (run.idleTimeout) clearTimeout(run.idleTimeout);
    run.idleTimeout = setTimeout(() => {
      if (!this.isCurrentRun(run)) {
        this.cleanupRun(run);
        return;
      }
      const errorMsg = run.rawText ? 'Response interrupted (idle timeout).' : 'Response timed out (no connection).';
      const finalText = run.rawText || errorMsg;
      this.applyRawTextSnapshot(run, finalText);
      const canonicalText = canonicalizeAssistantWorkspaceArtifacts(run.text, {
        workspacePath: run.workspacePath,
        startedAtMs: run.startedAt,
      });
      const rewritten = rewriteOpenClawMediaPaths(canonicalText, run.workspacePath);
      const rewrittenProcessContent = rewriteOpenClawMediaPaths(run.processContent, run.workspacePath);
      
      this.db.updateMessage(run.messageId, rewritten, run.modelUsed, rewrittenProcessContent, false);
      this.emitVisibleFinal(run, finalText, { end: true });
      this.abortUnderlyingRunBestEffort(run, 'idle timeout');
      this.cleanupRun(run);
    }, 600000); // 10 minutes
  }

  private matchesRunEvent(run: ActiveRun, sessionKey: string, runId?: string | null) {
    if (runId && runId !== run.runId) {
      return false;
    }
    return sessionKey === run.finalSessionKey
      || sessionKey === run.sessionId
      || sessionKey.endsWith(`:${run.sessionId}`)
      || sessionKey.includes(`:chat:${run.sessionId}`);
  }

  private hasAnyRunEvidence(run: ActiveRun) {
    return !!(
      run.rawText.trim()
      || run.finalEventText?.trim()
      || run.processContent.trim()
      || run.pendingErrorDetail?.trim()
      || run.lastObservedHistoryActivityAt !== undefined
    );
  }

  private scheduleCompletionProbe(run: ActiveRun, delay = CHAT_STREAM_COMPLETION_PROBE_DELAY_MS) {
    if (!this.isCurrentRun(run)) return;
    run.completionProbePending = true;
    if (run.completionProbeTimer) {
      clearTimeout(run.completionProbeTimer);
    }
    run.completionProbeTimer = setTimeout(() => {
      run.completionProbeTimer = undefined;
      if (run.completionProbeInFlight) {
        return;
      }
      run.completionProbePending = false;
      void this.probeCompletion(run);
    }, delay);
  }

  private async probeCompletion(run: ActiveRun) {
    if (!this.isCurrentRun(run) || run.completionProbeInFlight || !run.clientRef) {
      return;
    }

    run.completionProbeInFlight = true;
    const probeFinalGeneration = run.finalEventGeneration;
    const pendingErrorDetail = normalizeCliText(run.pendingErrorDetail) || '';

    try {
      await run.clientRef.waitForRun(run.runId, CHAT_STREAM_COMPLETION_WAIT_TIMEOUT_MS);
      if (run.firstCompletionWaitResolvedAt === undefined) {
        run.firstCompletionWaitResolvedAt = Date.now();
      }
      if (!this.isCurrentRun(run)) return;

      const hasFinalEventText = () => !!run.finalEventText?.trim();
      let completedOutput = selectPreferredTextSnapshot(run.rawText, run.finalEventText, {
        allowShorterReplacement: hasFinalEventText(),
      });
      let settledErrorDetail = '';
      let shouldRetryForEmptyCompletion = false;
      let sawSettledAssistantText = false;
      let bestSettledAssistantText = '';
      const visibleFinalGraceDeadline = probeFinalGeneration > 0
        && completedOutput.trim()
        && run.latestFinalEventAt !== undefined
        ? run.latestFinalEventAt + CHAT_FINAL_EVENT_SETTLE_GRACE_MS
        : null;
      try {
        const historyProbeStartedAt = Date.now();
        while ((Date.now() - historyProbeStartedAt) < CHAT_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS) {
          const history = await run.clientRef.getChatHistory(run.finalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
          const historyTailActivity = getHistoryTailActivity(history, run.historySnapshot);
          if (
            historyTailActivity.hasChanges
            && (
              historyTailActivity.length !== run.lastObservedHistoryLength
              || historyTailActivity.latestSignature !== run.lastObservedHistorySignature
            )
          ) {
            run.lastObservedHistoryLength = historyTailActivity.length;
            run.lastObservedHistorySignature = historyTailActivity.latestSignature;
            run.lastObservedHistoryActivityAt = Date.now();
            this.resetIdleTimeout(run);
          }
          const settledAssistantOutcome = extractSettledAssistantOutcome(history, run.historySnapshot);
          if (settledAssistantOutcome.kind === 'error') {
            settledErrorDetail = settledAssistantOutcome.error;
            break;
          }
          if (settledAssistantOutcome.kind === 'text') {
            sawSettledAssistantText = true;
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
            await new Promise((resolve) => setTimeout(resolve, Math.min(CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS, remainingVisibleFinalGraceMs)));
            continue;
          }

          await new Promise((resolve) => setTimeout(resolve, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS));
        }

        if (settledErrorDetail) {
          this.failRun(run, settledErrorDetail);
          return;
        }

        if (shouldPreferSettledAssistantText(completedOutput, bestSettledAssistantText)) {
          completedOutput = selectPreferredTextSnapshot(completedOutput, bestSettledAssistantText);
      }
    } catch (historyError) {
        const historyErrorDetail = historyError instanceof Error ? historyError.message : String(historyError);
        if (isRecoverableGatewayDisconnectDetail(historyErrorDetail)) {
          this.scheduleGatewayReconnectProbe(run);
          this.scheduleCompletionProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
          return;
        }
        console.warn(`[ActiveRunManager] Failed to read final history for session ${run.sessionId}, run ${run.runId}:`, historyError);
        shouldRetryForEmptyCompletion = true;
      }

      if (!completedOutput.trim()) {
        shouldRetryForEmptyCompletion = true;
      }

      completedOutput = selectPreferredTextSnapshot(completedOutput, run.finalEventText, {
        allowShorterReplacement: hasFinalEventText(),
      });

      const hasSettledAssistantText = bestSettledAssistantText.trim().length > 0;
      const hasStableVisibleFinalText = probeFinalGeneration > 0
        && probeFinalGeneration === run.finalEventGeneration
        && completedOutput.trim().length > 0
        && run.latestFinalEventAt !== undefined
        && Date.now() >= (run.latestFinalEventAt + CHAT_FINAL_EVENT_SETTLE_GRACE_MS);

      if (
        probeFinalGeneration > 0
        && probeFinalGeneration === run.finalEventGeneration
        && (hasSettledAssistantText || hasStableVisibleFinalText)
      ) {
        run.settledCalibrationGeneration = Math.max(run.settledCalibrationGeneration, probeFinalGeneration);
      }

      const isAwaitingInitialTerminalEvidence = run.finalEventGeneration === 0 && !hasSettledAssistantText;
      const isAwaitingSettledFinalCalibration = run.finalEventGeneration > run.settledCalibrationGeneration;
      const hasRecentHistoryActivity = run.lastObservedHistoryActivityAt !== undefined
        && (Date.now() - run.lastObservedHistoryActivityAt) < CHAT_HISTORY_ACTIVITY_GRACE_MS;

      if (
        (shouldRetryForEmptyCompletion || isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration)
        && hasRecentHistoryActivity
      ) {
        this.scheduleCompletionProbe(run, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if (
        shouldRetryForEmptyCompletion
        && run.firstCompletionWaitResolvedAt !== undefined
        && (Date.now() - run.firstCompletionWaitResolvedAt) < CHAT_EMPTY_COMPLETION_RETRY_WINDOW_MS
      ) {
        this.scheduleCompletionProbe(run, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if (
        (isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration)
        && run.firstCompletionWaitResolvedAt !== undefined
        && (Date.now() - run.firstCompletionWaitResolvedAt) < CHAT_EMPTY_COMPLETION_RETRY_WINDOW_MS
      ) {
        this.scheduleCompletionProbe(run, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if ((isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration) && completedOutput.trim() && !pendingErrorDetail) {
        console.warn(
          `[ActiveRunManager] Finalizing run ${run.runId} for session ${run.sessionId} using streamed text fallback because terminal assistant evidence never settled.`,
        );
        this.finalizeRun(run, completedOutput);
        return;
      }

      if (isAwaitingInitialTerminalEvidence) {
        this.failRun(run, pendingErrorDetail || 'Run completed without a terminal assistant response.');
        return;
      }

      if (isAwaitingSettledFinalCalibration) {
        this.failRun(run, pendingErrorDetail || 'Run completed but the final assistant response never settled.');
        return;
      }

      if (!completedOutput.trim() && pendingErrorDetail) {
        this.failRun(run, pendingErrorDetail);
        return;
      }

      this.finalizeRun(run, completedOutput);
    } catch (error: any) {
      if (!this.isCurrentRun(run)) return;
      const detail = typeof error?.message === 'string' ? error.message : '';
      if (/timeout/i.test(detail)) {
        this.scheduleCompletionProbe(run);
        return;
      }
      if (isRecoverableGatewayDisconnectDetail(detail)) {
        this.scheduleGatewayReconnectProbe(run);
        this.scheduleCompletionProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
        return;
      }
      this.failRun(run, pendingErrorDetail || detail || 'Failed waiting for run completion.');
    } finally {
      run.completionProbeInFlight = false;
      if (this.isCurrentRun(run) && run.completionProbePending && !run.completionProbeTimer) {
        this.scheduleCompletionProbe(run, 0);
      }
    }
  }

  private finalizeRun(run: ActiveRun, finalText: string) {
    if (!this.isCurrentRun(run)) return;

    const hasFinalEventText = !!run.finalEventText?.trim();
    let protectedRawText = selectPreferredTextSnapshot(run.rawText, finalText);
    protectedRawText = selectPreferredTextSnapshot(protectedRawText, run.finalEventText, {
      allowShorterReplacement: hasFinalEventText,
    });
    this.applyRawTextSnapshot(run, protectedRawText, {
      allowShorterReplacement: hasFinalEventText,
    });
    run.processStreaming = false;

    const canonicalText = canonicalizeAssistantWorkspaceArtifacts(run.text, {
      workspacePath: run.workspacePath,
      startedAtMs: run.startedAt,
    });
    const rewritten = rewriteOpenClawMediaPaths(canonicalText, run.workspacePath);
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(run.processContent, run.workspacePath);
    if (!rewritten.trim()) {
      const canonicalFallbackText = canonicalizeAssistantWorkspaceArtifacts(run.modelProcessContent, {
        workspacePath: run.workspacePath,
        startedAtMs: run.startedAt,
      });
      const rewrittenFallbackText = rewriteOpenClawMediaPaths(canonicalFallbackText, run.workspacePath);
      if (rewrittenFallbackText.trim()) {
        run.text = canonicalFallbackText;
        run.modelProcessContent = '';
        run.processContent = combineChatProcessContent(run.toolProcessContent, run.modelProcessContent);
        run.processStreaming = false;
        const rewrittenFallbackProcessContent = rewriteOpenClawMediaPaths(run.processContent, run.workspacePath);

        this.db.updateMessage(run.messageId, rewrittenFallbackText, run.modelUsed, rewrittenFallbackProcessContent, false);
        run.visibleFinalText = rewrittenFallbackText;
        run.visibleProcessContent = rewrittenFallbackProcessContent;
        run.visibleProcessStreaming = false;
        this.writeRunEvent(run, {
          type: 'final',
          text: rewrittenFallbackText,
          process_content: rewrittenFallbackProcessContent,
          process_streaming: false,
        }, { end: true });
        this.cleanupRun(run);
        return;
      }
      this.failRun(run, 'No text output returned from the run.');
      return;
    }

    this.db.updateMessage(run.messageId, rewritten, run.modelUsed, rewrittenProcessContent, false);
    this.emitVisibleFinal(run, protectedRawText, {
      end: true,
      allowShorterReplacement: hasFinalEventText,
    });
    this.cleanupRun(run);
  }

  private failRun(run: ActiveRun, detail: string, options?: {
    messageCode?: string;
  }) {
    if (!this.isCurrentRun(run)) return;

    const structuredError = createStructuredChatError(detail, options?.messageCode);

    run.processStreaming = false;
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(run.processContent, run.workspacePath);
    this.db.updateMessage(run.messageId, structuredError.content, run.modelUsed, rewrittenProcessContent, false);
    this.db.updateMessageEnvelope(run.messageId, structuredError.role, structuredError.agent_id, structuredError.agent_name);

    this.writeRunEvent(run, {
      type: 'error',
      text: structuredError.content,
      process_content: rewrittenProcessContent,
      process_streaming: false,
      messageCode: structuredError.messageCode,
      messageParams: structuredError.messageParams,
      rawDetail: structuredError.rawDetail,
      role: structuredError.role,
    }, { end: true });
    this.abortUnderlyingRunBestEffort(run, detail);
    this.cleanupRun(run);
  }

  private abortUnderlyingRunBestEffort(run: ActiveRun, reason: string) {
    if (!run.clientRef || !run.finalSessionKey || !run.runId) {
      return;
    }

    const clientRef = run.clientRef;
    void clientRef.abortChat({
      sessionKey: run.finalSessionKey,
      runId: run.runId,
      timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
    }).then((result) => {
      if (!result.aborted) {
        scheduleOpenClawSessionAbortRetry(
          clientRef,
          run.finalSessionKey,
          `run ${run.runId} for session ${run.sessionId} after ${reason}`,
        );
      }
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[chat] Failed to abort OpenClaw run ${run.runId} for session ${run.sessionId} after ${reason}: ${detail}`,
      );
      scheduleOpenClawSessionAbortRetry(
        clientRef,
        run.finalSessionKey,
        `run ${run.runId} for session ${run.sessionId} after ${reason}`,
      );
    });
  }

  private cleanupRun(run: ActiveRun) {
    if (run.cleanedUp) {
      if (this.isCurrentRun(run)) {
        this.runs.delete(run.sessionId);
      }
      return;
    }

    run.cleanedUp = true;
    if (run.idleTimeout) clearTimeout(run.idleTimeout);
    if (run.completionProbeTimer) clearTimeout(run.completionProbeTimer);
    if (run.gatewayReconnectTimer) clearTimeout(run.gatewayReconnectTimer);
    if (run.clientRef) {
      if ((run as any)._onDelta) run.clientRef.off('chat.delta', (run as any)._onDelta);
      if ((run as any)._onFinal) run.clientRef.off('chat.final', (run as any)._onFinal);
      if ((run as any)._onAborted) run.clientRef.off('chat.aborted', (run as any)._onAborted);
      if ((run as any)._onError) run.clientRef.off('chat.error', (run as any)._onError);
      if ((run as any)._onSessionTool) run.clientRef.off('session.tool', (run as any)._onSessionTool);
      if ((run as any)._onDisconnect) run.clientRef.off('disconnected', (run as any)._onDisconnect);
      if (run.sessionEventsSubscribed) {
        run.sessionEventsSubscribed = false;
        void run.clientRef.unsubscribeSessionEvents().catch((error) => {
          console.warn(`[chat] Failed to unsubscribe session events for session ${run.sessionId}:`, error);
        });
      }
    }
    if (this.isCurrentRun(run)) {
      this.runs.delete(run.sessionId);
    }
  }
}

export type ChatRunsDeps = {
  configManager: ConfigManager;
  connections: Map<string, OpenClawClient>;
  db: DB;
};

export function createChatRuns(ctx: ChatRunsDeps) {
  const { configManager, connections, db } = ctx;

  const activeRunManager = new ActiveRunManager(db, configManager, connections);
  const pendingChatPreparationManager = new PendingChatPreparationManager();
  const localChatOperationManager = new LocalChatOperationManager();

  return {
    activeRunManager,
    pendingChatPreparationManager,
    localChatOperationManager,
  };
}
export type ChatRuns = ReturnType<typeof createChatRuns>;
