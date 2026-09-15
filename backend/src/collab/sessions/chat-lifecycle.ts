import type { ChatRow, DB } from '../../core/db';
import {
  type GatewayConnections,
  buildOpenClawChatSessionKey,
  extractLatestAssistantOutcomeRecord,
} from '../../openclaw';
import type { RunCoordinator } from '../../runtime';
import { canonicalizeAssistantWorkspaceArtifacts } from '../../workspace';
import {
  CHAT_HISTORY_COMPLETION_PROBE_LIMIT,
  CHAT_REGENERATE_LOOKBACK_LIMIT,
} from './chat-constants';
import { createStructuredChatError } from './chat-messages';
import type { ChatRuns } from './chat-run-managers';
import { rewriteOpenClawMediaPaths } from './process-text';
import type { SessionManager } from './session-manager';
import type { SessionRuntime } from './session-runtime';

export type ChatLifecycleDeps = {
  db: DB;
  sessionManager: SessionManager;
  chatRuns: ChatRuns;
  runCoordinator: RunCoordinator;
  sessionRuntime: SessionRuntime;
  gatewayConnections: GatewayConnections;
};

export function createChatLifecycle(ctx: ChatLifecycleDeps) {
  const { db, sessionManager } = ctx;
  const { localChatOperationManager } = ctx.chatRuns;
  const { runCoordinator } = ctx;
  const { bumpSessionInterruptionEpoch, getSessionWorkspacePath } = ctx.sessionRuntime;
  const { disconnectConnection, getConnection } = ctx.gatewayConnections;

  // Force overlapping requests for the same session onto a fresh interruption epoch so
  // stale pending work or an older run cannot keep mutating state after a newer send begins.
  // 网关运行（含准备阶段）在协调器里：中止它并等它收尾——准备阶段的占位行由投影器删掉，
  // 运行中的以当前文本推终帧。本地操作（直连模型、生图）仍按原来的方式打断。
  async function interruptSessionStreamingStateForNewRun(sessionId: string): Promise<number> {
    const nextEpoch = bumpSessionInterruptionEpoch(sessionId);
    const hadCoordinatorRun = runCoordinator.isBusy(sessionId);
    const localOperation = localChatOperationManager.get(sessionId);

    if (hadCoordinatorRun) {
      try {
        await runCoordinator.abort(sessionId, 'replaced');
      } catch (error) {
        console.warn(`[chat] Failed to abort previous run for session ${sessionId}:`, error);
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

    if (hadCoordinatorRun || localOperation) {
      disconnectConnection(sessionId);
    }

    return nextEpoch;
  }

  async function reconcileInactiveChatLatestMessage(sessionId: string): Promise<void> {
    if (runCoordinator.isBusy(sessionId) || localChatOperationManager.get(sessionId)) {
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
      const finalSessionKey = buildOpenClawChatSessionKey(sessionId, agentId);
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
