import type { ChatRow, DB } from '../../core/db';
import { type GatewayConnections, OpenClawClient } from '../../openclaw';
import { canonicalizeAssistantWorkspaceArtifacts } from '../../workspace';
import type { ChatRuns } from './active-run-manager';
import {
  CHAT_ABORT_RETRY_DELAYS_MS,
  CHAT_HISTORY_COMPLETION_PROBE_LIMIT,
  CHAT_ORPHAN_ABORT_TIMEOUT_MS,
  CHAT_REGENERATE_LOOKBACK_LIMIT,
} from './chat-constants';
import { extractLatestAssistantOutcomeRecord } from './chat-history-reconciliation';
import { createStructuredChatError } from './chat-messages';
import { rewriteOpenClawMediaPaths } from './process-text';
import type { SessionManager } from './session-manager';
import type { SessionRuntime } from './session-runtime';

export function scheduleOpenClawSessionAbortRetry(
  client: OpenClawClient,
  sessionKey: string,
  context: string,
  attempt = 0,
) {
  if (attempt >= CHAT_ABORT_RETRY_DELAYS_MS.length) {
    console.warn(`[chat] Exhausted OpenClaw abort retries for ${context} (${sessionKey}).`);
    return;
  }

  const delay = CHAT_ABORT_RETRY_DELAYS_MS[attempt];
  const timer = setTimeout(() => {
    void client.abortChat({
      sessionKey,
      timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
    }).then((result) => {
      if (result.aborted) {
        return;
      }
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context, attempt + 1);
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[chat] OpenClaw abort retry ${attempt + 1} failed for ${context} (${sessionKey}): ${detail}`);
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context, attempt + 1);
    });
  }, delay);
  timer.unref?.();
}

export async function abortOpenClawSessionRuns(
  client: OpenClawClient,
  sessionKey: string,
  context: string,
  options?: { retryOnMiss?: boolean },
): Promise<{ aborted: boolean; runIds: string[] }> {
  try {
    const result = await client.abortChat({
      sessionKey,
      timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
    });
    const runIds = Array.isArray(result.runIds) ? result.runIds : [];
    if (!result.aborted && options?.retryOnMiss) {
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context);
    }
    return {
      aborted: result.aborted,
      runIds,
    };
  } catch (error) {
    console.warn(`[chat] Failed to abort orphan OpenClaw runs for ${context} (${sessionKey}):`, error);
    if (options?.retryOnMiss) {
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context);
    }
    return {
      aborted: false,
      runIds: [],
    };
  }
}

export type ChatLifecycleDeps = {
  db: DB;
  sessionManager: SessionManager;
  chatRuns: ChatRuns;
  sessionRuntime: SessionRuntime;
  gatewayConnections: GatewayConnections;
};

export function createChatLifecycle(ctx: ChatLifecycleDeps) {
  const { db, sessionManager } = ctx;
  const { activeRunManager, localChatOperationManager, pendingChatPreparationManager } = ctx.chatRuns;
  const { bumpSessionInterruptionEpoch, getSessionInterruptionEpoch, getSessionWorkspacePath } = ctx.sessionRuntime;
  const { disconnectConnection, getConnection } = ctx.gatewayConnections;

  // Force overlapping requests for the same session onto a fresh interruption epoch so
  // stale pending work or an older run cannot keep mutating state after a newer send begins.
  async function interruptSessionStreamingStateForNewRun(sessionId: string): Promise<number> {
    const interruptedEpoch = getSessionInterruptionEpoch(sessionId);
    const nextEpoch = bumpSessionInterruptionEpoch(sessionId);
    const pendingPreparation = pendingChatPreparationManager.get(sessionId, interruptedEpoch);
    const activeRun = activeRunManager.getRun(sessionId);
    const localOperation = localChatOperationManager.get(sessionId);

    if (pendingPreparation) {
      pendingChatPreparationManager.cancel(sessionId, interruptedEpoch);
      try {
        db.deleteMessage(pendingPreparation.messageId);
      } catch (error) {
        console.warn(
          `[chat] Failed to delete interrupted pending assistant message ${pendingPreparation.messageId} for session ${sessionId}:`,
          error,
        );
      }
    }

    if (activeRun) {
      try {
        await activeRunManager.abortRun(sessionId);
      } catch (error) {
        console.warn(`[chat] Failed to abort previous run ${activeRun.runId} for session ${sessionId}:`, error);
      }
    }

    if (localOperation) {
      localChatOperationManager.abort(sessionId);
      try {
        db.deleteMessage(localOperation.messageId);
      } catch (error) {
        console.warn(
          `[chat] Failed to delete interrupted local assistant message ${localOperation.messageId} for session ${sessionId}:`,
          error,
        );
      }
    }

    if (pendingPreparation || activeRun || localOperation) {
      disconnectConnection(sessionId);
    }

    return nextEpoch;
  }

  async function reconcileInactiveChatLatestMessage(sessionId: string): Promise<void> {
    if (
      activeRunManager.getRun(sessionId)
      || pendingChatPreparationManager.get(sessionId)
      || localChatOperationManager.get(sessionId)
    ) {
      return;
    }

    const recentMessages = db.getMessages(sessionId, 100);
    if (recentMessages.length === 0) {
      return;
    }

    const latestAssistantLikeMessage = [...recentMessages].reverse().find((message) => (
      (message.role === 'assistant' || message.role === 'system')
      && typeof message.id === 'number'
    ));

    const latestAssistantLikeMessageId = typeof latestAssistantLikeMessage?.id === 'number'
      ? latestAssistantLikeMessage.id
      : null;

    if (!latestAssistantLikeMessageId || !latestAssistantLikeMessage) {
      return;
    }

    const latestStoredMessage = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1] : null;
    if (!latestStoredMessage || latestStoredMessage.id !== latestAssistantLikeMessageId) {
      return;
    }

    const currentContent = typeof latestAssistantLikeMessage.content === 'string'
      ? latestAssistantLikeMessage.content
      : '';
    const currentProcessContent = typeof latestAssistantLikeMessage.process_content === 'string'
      ? latestAssistantLikeMessage.process_content
      : '';
    if (currentContent.trim()) {
      if (latestAssistantLikeMessage.process_streaming) {
        db.updateMessage(
          latestAssistantLikeMessageId,
          currentContent,
          latestAssistantLikeMessage.model_used || undefined,
          currentProcessContent,
          false,
        );
      }
      return;
    }

    const sessionInfo = sessionManager.getSession(sessionId);
    const agentId = latestAssistantLikeMessage.agent_id && latestAssistantLikeMessage.agent_id !== 'system'
      ? latestAssistantLikeMessage.agent_id
      : (sessionInfo?.agentId || 'main');

    if (!agentId) {
      db.deleteMessage(latestAssistantLikeMessageId);
      return;
    }

    try {
      const client = await getConnection(sessionId);
      const finalSessionKey = sessionId.startsWith('agent:')
        ? sessionId
        : `agent:${agentId}:chat:${sessionId}`;
      const history = await client.getChatHistory(finalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
      const latestOutcomeRecord = extractLatestAssistantOutcomeRecord(history);
      const latestMessageCreatedAtMs = Date.parse(latestAssistantLikeMessage.created_at || '');
      const historyIsNewerThanCurrentMessage = latestOutcomeRecord.timestampMs !== null
        && Number.isFinite(latestMessageCreatedAtMs)
        && latestOutcomeRecord.timestampMs > latestMessageCreatedAtMs;

      if (historyIsNewerThanCurrentMessage && latestOutcomeRecord.kind === 'text') {
        const workspacePath = getSessionWorkspacePath(sessionId);
        const startedAtMs = Number.isFinite(latestMessageCreatedAtMs) ? latestMessageCreatedAtMs : Date.now();
        const canonicalText = canonicalizeAssistantWorkspaceArtifacts(latestOutcomeRecord.text, {
          workspacePath,
          startedAtMs,
        });
        const rewritten = rewriteOpenClawMediaPaths(canonicalText, workspacePath);
        if (rewritten.trim()) {
          db.updateMessage(latestAssistantLikeMessageId, rewritten, latestAssistantLikeMessage.model_used || undefined, '', false);
          db.updateMessageEnvelope(
            latestAssistantLikeMessageId,
            'assistant',
            latestAssistantLikeMessage.agent_id && latestAssistantLikeMessage.agent_id !== 'system'
              ? latestAssistantLikeMessage.agent_id
              : agentId,
            latestAssistantLikeMessage.agent_name && latestAssistantLikeMessage.agent_id !== 'system'
              ? latestAssistantLikeMessage.agent_name
              : (sessionInfo?.name || agentId),
          );
          return;
        }
      }

      if (historyIsNewerThanCurrentMessage && latestOutcomeRecord.kind === 'error') {
        const structuredError = createStructuredChatError(latestOutcomeRecord.error);
        db.updateMessage(latestAssistantLikeMessageId, structuredError.content, latestAssistantLikeMessage.model_used || undefined, currentProcessContent, false);
        db.updateMessageEnvelope(
          latestAssistantLikeMessageId,
          structuredError.role,
          structuredError.agent_id,
          structuredError.agent_name,
        );
        return;
      }
    } catch (error) {
      console.warn(`[chat] Failed to reconcile inactive latest message for session ${sessionId}:`, error);
    }

    if (currentProcessContent.trim()) {
      db.updateMessage(
        latestAssistantLikeMessageId,
        currentContent,
        latestAssistantLikeMessage.model_used || undefined,
        currentProcessContent,
        false,
      );
      return;
    }

    db.deleteMessage(latestAssistantLikeMessageId);
  }

  function getLatestChatRegenerateTarget(sessionId: string): {
    latestUserMessage: ChatRow | null;
    latestReplyMessage: ChatRow | null;
  } {
    const recentHistory = db.getMessages(sessionId, CHAT_REGENERATE_LOOKBACK_LIMIT);
    const latestUserMessage = [...recentHistory].reverse().find((message) => message.role === 'user') ?? null;
    const latestUserId = typeof latestUserMessage?.id === 'number' ? latestUserMessage.id : null;
    if (!latestUserMessage || latestUserId === null) {
      return {
        latestUserMessage: null,
        latestReplyMessage: null,
      };
    }

    const latestReplyMessage = [...recentHistory].reverse().find((message) => (
      (message.role === 'assistant' || message.role === 'system')
      && typeof message.id === 'number'
      && message.id > latestUserId
      && Number(message.parent_id) === latestUserId
    )) ?? null;

    return {
      latestUserMessage,
      latestReplyMessage,
    };
  }

  return {
    interruptSessionStreamingStateForNewRun,
    reconcileInactiveChatLatestMessage,
    getLatestChatRegenerateTarget,
  };
}
export type ChatLifecycle = ReturnType<typeof createChatLifecycle>;
