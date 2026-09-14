import type { DB } from '../../core/db';
import type { StructuredMessageParams } from '../../core/http';
import { rewriteOpenClawMediaPaths } from '../sessions';
import { getStructuredGroupMessage } from './group-chat-engine';
import { getGroupWorkspacePath } from './group-workspace';

export function withStructuredGroupMessage<T extends {
  content?: string | null;
  process_content?: string | null;
  process_streaming?: boolean | null;
  messageCode?: string;
  messageParams?: StructuredMessageParams | null;
  rawDetail?: string | null;
  sender_id?: string | null;
  sender_name?: string | null;
}>(
  message: T,
  options?: { groupId?: string | null }
): T & {
  messageCode?: string;
  messageParams?: StructuredMessageParams;
  rawDetail?: string | null;
  sender_id?: string | null;
  sender_name?: string | null;
  process_content?: string | null;
  process_streaming?: boolean | null;
} {
  const content = typeof message.content === 'string'
    ? rewriteOpenClawMediaPaths(message.content, options?.groupId ? getGroupWorkspacePath(options.groupId) : undefined)
    : message.content;
  const processContent = typeof message.process_content === 'string'
    ? rewriteOpenClawMediaPaths(message.process_content, options?.groupId ? getGroupWorkspacePath(options.groupId) : undefined)
    : message.process_content;
  const structured = getStructuredGroupMessage(content);
  return {
    ...message,
    content,
    process_content: processContent,
    messageCode: message.messageCode ?? structured.messageCode,
    messageParams: message.messageParams ?? structured.messageParams,
    rawDetail: message.rawDetail ?? structured.rawDetail,
    sender_id: structured.forceSystemMessage ? 'system' : (message.sender_id ?? null),
    sender_name: structured.forceSystemMessage ? '系统' : (message.sender_name ?? null),
  };
}

export type RoomMessagesDeps = {
  db: DB;
};

export function createRoomMessages(ctx: RoomMessagesDeps) {
  const { db } = ctx;

  function resolveGroupMemberDisplayName(member: { agent_id: string; display_name: string }): string {
    const linkedSession = db.getSessionByAgentId(member.agent_id) || db.getSession(member.agent_id);
    const latestName = linkedSession?.name?.trim();
    return latestName || member.display_name;
  }

  function withResolvedGroupMemberDisplayName<T extends { agent_id: string; display_name: string }>(member: T): T {
    const latestName = resolveGroupMemberDisplayName(member);
    return latestName === member.display_name ? member : { ...member, display_name: latestName };
  }

  function repairLegacyGroupMessageRoots() {
    for (const group of db.getGroupChats()) {
      const rootIds = db.getGroupRootMessageIds(group.id);
      if (rootIds.length <= 1) continue;

      for (const rootId of rootIds.slice(1)) {
        const previousMessageId = db.getLatestGroupMessageId(group.id, rootId);
        if (!previousMessageId) continue;

        db.updateGroupMessageParent(rootId, previousMessageId);
        console.log(`[Startup] Repaired extra group root ${group.id}:${rootId} -> parent ${previousMessageId}`);
      }
    }
  }

  return {
    withResolvedGroupMemberDisplayName,
    repairLegacyGroupMessageRoots,
  };
}
export type RoomMessages = ReturnType<typeof createRoomMessages>;
