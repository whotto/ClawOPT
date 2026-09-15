import type { AgentSettings } from '../../control';
import type { DB } from '../../core/db';
import type { StructuredMessageParams } from '../../core/http';
import type { GatewayConnections } from '../../openclaw';
import {
  CHAT_HISTORY_COMPLETION_PROBE_LIMIT,
  DEFAULT_PROCESS_END_TAG,
  DEFAULT_PROCESS_START_TAG,
  extractLatestAssistantOutcomeRecord,
  hasUnclosedProcessBlock,
  selectPreferredTextSnapshot,
  shouldPreferSettledAssistantText,
  stripProcessBlocks,
} from '../sessions';
import { createAgentResponseFailedMessage, getStructuredGroupMessage } from './group-chat-engine';
import { getGroupRuntimeSessionKey } from './group-workspace';
import type { RoomEngine } from './room-engine';
import { withStructuredGroupMessage } from './room-messages';
import { getGroupRuntimeContext, type RoomRuntime } from './room-runtime';

type GroupReconciliationAction =
  | { type: 'delete'; id: number; parent_id: number | null }
  | {
      type: 'edit';
      data: {
        groupId: string;
        id: number;
        parent_id: number | null;
        sender_type: 'agent';
        sender_id: string;
        sender_name: string;
        content: string;
        model_used?: string;
        messageCode?: string;
        messageParams?: StructuredMessageParams;
        rawDetail?: string;
        created_at: string;
      };
    };
const GROUP_RECONCILIATION_RETRY_COOLDOWN_MS = 8000;

function getGroupReconciliationFingerprint(
  latestMessageId: number,
  currentContent: string,
  sourceAgentId: string,
  staleMessageIds: number[],
  isFailureRecovery: boolean,
): string {
  const normalized = currentContent.trim();
  const head = normalized.slice(0, 120);
  const tail = normalized.length > 120 ? normalized.slice(-120) : normalized;
  const staleIdsKey = staleMessageIds.length > 0 ? staleMessageIds.join(',') : '-';
  return [
    latestMessageId,
    sourceAgentId || '-',
    isFailureRecovery ? 'failure' : 'history',
    normalized.length,
    staleIdsKey,
    head,
    tail,
  ].join('|');
}

function isLikelyStaleInactiveGroupMessage(content: string, pairs: Array<{ startTag: string; endTag: string }>): boolean {
  const normalized = content.trim();
  if (!normalized) return true;
  if (hasUnclosedProcessBlock(normalized, pairs)) return true;

  const containsProcessBlock = pairs.some((pair) => normalized.includes(pair.startTag));
  if (!containsProcessBlock) return false;

  return stripProcessBlocks(normalized, pairs).length === 0;
}

export type RoomReconciliationDeps = {
  db: DB;
  rooms: RoomEngine;
  roomRuntime: RoomRuntime;
  agentSettings: AgentSettings;
  gatewayConnections: GatewayConnections;
};

export function createRoomReconciliation(ctx: RoomReconciliationDeps) {
  const { db } = ctx;
  const { groupChatEngine, publishRoomFrame } = ctx.rooms;
  const { prepareGroupRuntimeAgent } = ctx.roomRuntime;
  const { readAgentModelForDisplay } = ctx.agentSettings;
  const { getConnection } = ctx.gatewayConnections;

  const groupReconciliationInFlight = new Map<string, Promise<GroupReconciliationAction[]>>();
  const groupReconciliationCooldown = new Map<string, { fingerprint: string; attemptedAt: number }>();

  function shouldSkipGroupReconciliation(groupId: string, fingerprint: string): boolean {
    const cached = groupReconciliationCooldown.get(groupId);
    if (!cached) return false;
    if (cached.fingerprint !== fingerprint) return false;
    return (Date.now() - cached.attemptedAt) < GROUP_RECONCILIATION_RETRY_COOLDOWN_MS;
  }

  function rememberGroupReconciliationAttempt(groupId: string, fingerprint: string): void {
    groupReconciliationCooldown.set(groupId, {
      fingerprint,
      attemptedAt: Date.now(),
    });
  }

  async function readGroupRuntimeHistoryForReconciliation(groupId: string, sourceAgentId: string): Promise<{
    runtimeContext: {
      runtimeAgentId: string;
      workspacePath: string;
      uploadsPath: string;
      outputPath: string;
    };
    history: any[];
  }> {
    const runtimeContext = getGroupRuntimeContext(groupId, sourceAgentId);
    const group = db.getGroupChat(groupId);
    const finalSessionKey = `agent:${runtimeContext.runtimeAgentId}:chat:${getGroupRuntimeSessionKey(groupId, group?.runtime_session_epoch)}`;

    try {
      const client = await getConnection(runtimeContext.runtimeAgentId);
      const history = await client.getChatHistory(finalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
      return { runtimeContext, history };
    } catch (error) {
      const preparedRuntimeContext = await prepareGroupRuntimeAgent(groupId, sourceAgentId);
      const preparedGroup = db.getGroupChat(groupId);
      const preparedFinalSessionKey = `agent:${preparedRuntimeContext.runtimeAgentId}:chat:${getGroupRuntimeSessionKey(groupId, preparedGroup?.runtime_session_epoch)}`;
      const client = await getConnection(preparedRuntimeContext.runtimeAgentId);
      const history = await client.getChatHistory(preparedFinalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
      return { runtimeContext: preparedRuntimeContext, history };
    }
  }

  function getGroupProcessTagPairs(groupId: string, agentId?: string): Array<{ startTag: string; endTag: string }> {
    const pairs: Array<{ startTag: string; endTag: string }> = [];
    const appendPair = (startTag?: string | null, endTag?: string | null) => {
      const normalizedStart = typeof startTag === 'string' ? startTag.trim() : '';
      const normalizedEnd = typeof endTag === 'string' ? endTag.trim() : '';
      if (!normalizedStart || !normalizedEnd) return;
      if (pairs.some((pair) => pair.startTag === normalizedStart && pair.endTag === normalizedEnd)) return;
      pairs.push({ startTag: normalizedStart, endTag: normalizedEnd });
    };

    const group = db.getGroupChat(groupId);
    appendPair(group?.process_start_tag, group?.process_end_tag);

    if (agentId) {
      const session = db.getSessionByAgentId(agentId) || db.getSession(agentId);
      appendPair(session?.process_start_tag, session?.process_end_tag);
    }

    appendPair(DEFAULT_PROCESS_START_TAG, DEFAULT_PROCESS_END_TAG);
    return pairs;
  }

  async function reconcileInactiveGroupLatestMessage(groupId: string): Promise<GroupReconciliationAction[]> {
    const runState = groupChatEngine.getGroupRunState(groupId);
    if (runState.active) {
      return [];
    }

    const recentMessages = db.getRecentGroupMessages(groupId, 100);
    const actions: GroupReconciliationAction[] = [];
    const staleMessageIds = recentMessages
      .filter((message) => (
        message.sender_type === 'agent'
        && typeof message.content === 'string'
        && message.content.trim() === ''
        && typeof message.id === 'number'
      ))
      .map((message) => message.id as number);

    for (const messageId of staleMessageIds) {
      const staleMessage = recentMessages.find((message) => message.id === messageId);
      db.deleteGroupMessage(messageId);
      actions.push({
        type: 'delete',
        id: messageId,
        parent_id: typeof staleMessage?.parent_id === 'number' ? staleMessage.parent_id : null,
      });
    }

    const latestAgentLikeMessage = [...recentMessages].reverse().find((message) => (
      message.sender_type === 'agent'
      && typeof message.id === 'number'
    ));

    if (!latestAgentLikeMessage?.id) {
      return actions;
    }
    const latestAgentLikeMessageId = latestAgentLikeMessage.id;

    const latestNonSystemAgentMessage = [...recentMessages].reverse().find((message) => (
      message.sender_type === 'agent'
      && typeof message.id === 'number'
      && !!message.sender_id
      && message.sender_id !== 'system'
    ));
    const currentContent = typeof latestAgentLikeMessage.content === 'string' ? latestAgentLikeMessage.content : '';
    const currentStructured = getStructuredGroupMessage(currentContent);
    const isLatestSystemFailureMessage = latestAgentLikeMessage.sender_id === 'system'
      && currentStructured.messageCode === 'group.agentResponseFailed';
    const sourceAgentName = typeof currentStructured.messageParams?.agentName === 'string'
      ? currentStructured.messageParams.agentName.trim()
      : '';
    const groupMembers = db.getGroupMembers(groupId);
    const matchedMember = sourceAgentName
      ? groupMembers.find((member) => {
        const session = db.getSessionByAgentId(member.agent_id) || db.getSession(member.agent_id);
        const latestDisplayName = session?.name?.trim();
        return member.display_name === sourceAgentName || latestDisplayName === sourceAgentName;
      })
      : undefined;
    const sourceAgentId = latestAgentLikeMessage.sender_id && latestAgentLikeMessage.sender_id !== 'system'
      ? latestAgentLikeMessage.sender_id
      : (matchedMember?.agent_id || latestNonSystemAgentMessage?.sender_id || '');

    if (!sourceAgentId) {
      return actions;
    }

    const sourceAgentDisplayName = latestAgentLikeMessage.sender_id && latestAgentLikeMessage.sender_id !== 'system'
      ? (latestAgentLikeMessage.sender_name || sourceAgentId)
      : (matchedMember?.display_name || sourceAgentName || latestNonSystemAgentMessage?.sender_name || sourceAgentId);
    const processTagPairs = getGroupProcessTagPairs(groupId, sourceAgentId);
    const currentMessageLooksStale = isLikelyStaleInactiveGroupMessage(currentContent, processTagPairs);
    const shouldAttemptHistoryReconciliation = actions.length > 0 || currentMessageLooksStale;
    const shouldAttemptFailureRecovery = isLatestSystemFailureMessage;

    if (!shouldAttemptHistoryReconciliation && !shouldAttemptFailureRecovery) {
      return actions;
    }

    const reconciliationFingerprint = getGroupReconciliationFingerprint(
      latestAgentLikeMessageId,
      currentContent,
      sourceAgentId,
      staleMessageIds,
      shouldAttemptFailureRecovery,
    );
    if (shouldSkipGroupReconciliation(groupId, reconciliationFingerprint)) {
      return actions;
    }

    const inFlightKey = `${groupId}:${reconciliationFingerprint}`;
    const existingInFlight = groupReconciliationInFlight.get(inFlightKey);
    if (existingInFlight) {
      const sharedActions = await existingInFlight;
      return actions.concat(sharedActions);
    }

    const reconciliationPromise = (async (): Promise<GroupReconciliationAction[]> => {
      const reconciliationActions: GroupReconciliationAction[] = [];
      try {
        const { history } = await readGroupRuntimeHistoryForReconciliation(groupId, sourceAgentId);
        const latestOutcomeRecord = extractLatestAssistantOutcomeRecord(history);
        const latestOutcome = latestOutcomeRecord.kind === 'text'
          ? { kind: 'text' as const, text: latestOutcomeRecord.text }
          : latestOutcomeRecord.kind === 'error'
            ? { kind: 'error' as const, error: latestOutcomeRecord.error }
            : { kind: 'none' as const };
        const latestMessageCreatedAtMs = Date.parse(latestAgentLikeMessage.created_at || '');
        const historyIsNewerThanCurrentMessage = latestOutcomeRecord.timestampMs !== null
          && Number.isFinite(latestMessageCreatedAtMs)
          && latestOutcomeRecord.timestampMs > latestMessageCreatedAtMs;

        if (latestOutcome.kind === 'none') {
          return reconciliationActions;
        }

        if (latestOutcome.kind === 'error') {
          const { content, messageCode, messageParams, rawDetail } = createAgentResponseFailedMessage(
            sourceAgentDisplayName,
            latestOutcome.error,
          );

          if (
            latestAgentLikeMessage.content.trim() !== content.trim()
            || latestAgentLikeMessage.sender_id !== 'system'
            || latestAgentLikeMessage.sender_name !== '系统'
          ) {
            const modelUsed = latestAgentLikeMessage.model_used || readAgentModelForDisplay(sourceAgentId);
            db.updateGroupMessage(latestAgentLikeMessageId, content, modelUsed, null);
            db.updateGroupMessageSender(latestAgentLikeMessageId, 'system', '系统');
            reconciliationActions.push({
              type: 'edit',
              data: {
                groupId,
                id: latestAgentLikeMessageId,
                parent_id: typeof latestAgentLikeMessage.parent_id === 'number' ? latestAgentLikeMessage.parent_id : null,
                sender_type: 'agent',
                sender_id: 'system',
                sender_name: '系统',
                content,
                model_used: modelUsed,
                messageCode,
                messageParams,
                rawDetail,
                created_at: latestAgentLikeMessage.created_at || new Date().toISOString(),
              },
            });
          }

          return reconciliationActions;
        }

        const allowShorterHistoryReplacement = isLatestSystemFailureMessage && historyIsNewerThanCurrentMessage;
        const preferredLatestText = selectPreferredTextSnapshot(currentContent, latestOutcome.text, {
          allowShorterReplacement: allowShorterHistoryReplacement,
        });
        const shouldReplaceWithHistoryText = preferredLatestText === latestOutcome.text && (
          shouldPreferSettledAssistantText(currentContent, latestOutcome.text)
          || (
            currentMessageLooksStale
            && latestOutcome.text.trim() !== currentContent.trim()
          )
          || allowShorterHistoryReplacement
        );

        if (shouldReplaceWithHistoryText) {
          const modelUsed = latestAgentLikeMessage.model_used || readAgentModelForDisplay(sourceAgentId);
          db.updateGroupMessage(latestAgentLikeMessageId, preferredLatestText, modelUsed, latestAgentLikeMessage.mentions || null);
          db.updateGroupMessageSender(latestAgentLikeMessageId, sourceAgentId, sourceAgentDisplayName);
          reconciliationActions.push({
            type: 'edit',
            data: {
              groupId,
              id: latestAgentLikeMessageId,
              parent_id: typeof latestAgentLikeMessage.parent_id === 'number' ? latestAgentLikeMessage.parent_id : null,
              sender_type: 'agent',
              sender_id: sourceAgentId,
              sender_name: sourceAgentDisplayName,
              content: preferredLatestText,
              model_used: modelUsed,
              created_at: latestAgentLikeMessage.created_at || new Date().toISOString(),
            },
          });
        }
      } catch (error) {
        console.warn(`[GroupReconcile] Failed to reconcile latest inactive message for group ${groupId}:`, error);
      } finally {
        rememberGroupReconciliationAttempt(groupId, reconciliationFingerprint);
        groupReconciliationInFlight.delete(inFlightKey);
      }

      return reconciliationActions;
    })();

    groupReconciliationInFlight.set(inFlightKey, reconciliationPromise);
    const reconciliationActions = await reconciliationPromise;
    return actions.concat(reconciliationActions);
  }

  function broadcastGroupReconciliationActions(groupId: string, actions: GroupReconciliationAction[]) {
    for (const action of actions) {
      publishRoomFrame(groupId, action.type === 'delete'
        ? { type: 'delete', id: action.id, parent_id: action.parent_id }
        : { type: 'edit', ...withStructuredGroupMessage(action.data, { groupId }) });
    }
  }

  return {
    reconcileInactiveGroupLatestMessage,
    broadcastGroupReconciliationActions,
  };
}
export type RoomReconciliation = ReturnType<typeof createRoomReconciliation>;
