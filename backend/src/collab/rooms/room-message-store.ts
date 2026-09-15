/**
 * 群消息的 P3 元数据（发送人身份、结构化 @、服务端签发的深度 / 链、发起人、续跑尝试、消息种类、附件）。
 *
 * 核心库的 `saveGroupMessage` 只写老列；元数据在同一个同步调用栈里紧接着写（Node 单线程下与插入之间没有别的写入者）。
 * 读历史时按页里的 id 一次性取回再并进行里（`attachMeta`），不改核心库的查询。
 */
import type Database from 'better-sqlite3';

import { deserializeStructuredMentions, serializeStructuredMentions, type StructuredMention } from './mentions';
import { parseOriginator, serializeOriginator, type RoomOriginator } from './room-policy';
import { applyRoomSchema } from './room-schema';

export type MessageKind = '' | 'workspace_diff' | 'attachment' | 'delegation_result' | 'handoff_notice';

export type RoomMessageMeta = {
  id: number;
  groupId: string;
  senderUserId: number | null;
  senderGuestId: string | null;
  senderMemberId: string | null;
  structuredMentions: StructuredMention[] | undefined;
  mentionDepth: number;
  handoffChainId: string | null;
  originator: RoomOriginator;
  continuationAttemptId: string | null;
  messageKind: MessageKind;
  attachments: RoomMessageAttachment[];
};

export type RoomMessageAttachment = { id: string; name: string; mediaType: string; size: number; url: string; kind: 'image' | 'file' };

type MetaRow = {
  id: number;
  group_id: string;
  sender_user_id: number | null;
  sender_guest_id: string | null;
  sender_member_id: string | null;
  structured_mentions: string | null;
  mention_depth: number;
  handoff_chain_id: string | null;
  originator_json: string | null;
  continuation_attempt_id: string | null;
  message_kind: string;
  attachments_json: string | null;
};

export type ContextMessageRow = {
  id: number;
  parent_id: number | null;
  sender_type: 'user' | 'agent';
  sender_id: string | null;
  sender_name: string | null;
  content: string;
  process_content: string | null;
  message_kind: string;
  created_at: string;
};

function parseAttachments(value: string | null): RoomMessageAttachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string') : [];
  } catch {
    return [];
  }
}

export function createRoomMessageStore(conn: Database.Database) {
  applyRoomSchema(conn);

  const updateMeta = conn.prepare(`UPDATE group_messages SET sender_user_id = @senderUserId, sender_guest_id = @senderGuestId,
    sender_member_id = @senderMemberId, structured_mentions = @structuredMentions, mention_depth = @mentionDepth,
    handoff_chain_id = @handoffChainId, originator_json = @originator, continuation_attempt_id = @continuationAttemptId,
    message_kind = @messageKind, attachments_json = @attachments WHERE id = @id`);

  function toMeta(row: MetaRow): RoomMessageMeta {
    return {
      id: row.id,
      groupId: row.group_id,
      senderUserId: row.sender_user_id ?? null,
      senderGuestId: row.sender_guest_id ?? null,
      senderMemberId: row.sender_member_id ?? null,
      structuredMentions: deserializeStructuredMentions(row.structured_mentions),
      mentionDepth: row.mention_depth ?? 0,
      handoffChainId: row.handoff_chain_id ?? null,
      originator: parseOriginator(row.originator_json),
      continuationAttemptId: row.continuation_attempt_id ?? null,
      messageKind: (row.message_kind || '') as MessageKind,
      attachments: parseAttachments(row.attachments_json),
    };
  }

  function writeMeta(id: number, meta: Partial<Omit<RoomMessageMeta, 'id' | 'groupId'>>): void {
    updateMeta.run({
      id,
      senderUserId: meta.senderUserId ?? null,
      senderGuestId: meta.senderGuestId ?? null,
      senderMemberId: meta.senderMemberId ?? null,
      structuredMentions: serializeStructuredMentions(meta.structuredMentions),
      mentionDepth: Math.max(0, Math.floor(meta.mentionDepth ?? 0)),
      handoffChainId: meta.handoffChainId ?? null,
      originator: meta.originator ? serializeOriginator(meta.originator) : null,
      continuationAttemptId: meta.continuationAttemptId ?? null,
      messageKind: meta.messageKind ?? '',
      attachments: meta.attachments && meta.attachments.length > 0 ? JSON.stringify(meta.attachments) : null,
    });
  }

  function getMeta(id: number): RoomMessageMeta | null {
    const row = conn.prepare(`SELECT id, group_id, sender_user_id, sender_guest_id, sender_member_id, structured_mentions, mention_depth,
      handoff_chain_id, originator_json, continuation_attempt_id, message_kind, attachments_json FROM group_messages WHERE id = ?`).get(id) as MetaRow | undefined;
    return row ? toMeta(row) : null;
  }

  function getMetaForIds(ids: number[]): Map<number, RoomMessageMeta> {
    const out = new Map<number, RoomMessageMeta>();
    const unique = [...new Set(ids.filter((id) => Number.isInteger(id)))];
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      const rows = conn.prepare(`SELECT id, group_id, sender_user_id, sender_guest_id, sender_member_id, structured_mentions, mention_depth,
        handoff_chain_id, originator_json, continuation_attempt_id, message_kind, attachments_json FROM group_messages
        WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as MetaRow[];
      for (const row of rows) out.set(row.id, toMeta(row));
    }
    return out;
  }

  /**
   * 删掉**一条**消息（撤回用）：它的子消息改挂到它的父消息上，不连带删后代。
   * 核心库的 `deleteGroupMessage` 按子树删——撤回一条排队中的消息不能顺手删掉之后别人发的消息。
   */
  function deleteSingle(groupId: string, id: number): { deleted: boolean; parentId: number | null } {
    const row = conn.prepare('SELECT parent_id FROM group_messages WHERE id = ? AND group_id = ?').get(id, groupId) as { parent_id: number | null } | undefined;
    if (!row) return { deleted: false, parentId: null };
    conn.prepare('UPDATE group_messages SET parent_id = ? WHERE parent_id = ? AND group_id = ?').run(row.parent_id ?? null, id, groupId);
    conn.prepare('DELETE FROM group_messages WHERE id = ? AND group_id = ?').run(id, groupId);
    return { deleted: true, parentId: row.parent_id ?? null };
  }

  /**
   * 进上下文的消息：严格早于 `beforeId`、严格晚于 `afterId`（摘要锚点），最近 `limit` 条，按 id 升序。
   * 工作区 diff 行不进上下文。
   */
  function listContextMessages(groupId: string, options: { beforeId?: number | null; afterId?: number | null; limit: number }): ContextMessageRow[] {
    const rows = conn.prepare(`SELECT id, parent_id, sender_type, sender_id, sender_name, content, process_content, message_kind,
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at FROM group_messages
      WHERE group_id = ? AND (? IS NULL OR id < ?) AND (? IS NULL OR id > ?) AND message_kind != 'workspace_diff'
      ORDER BY id DESC LIMIT ?`).all(
      groupId, options.beforeId ?? null, options.beforeId ?? null, options.afterId ?? null, options.afterId ?? null, options.limit,
    ) as ContextMessageRow[];
    return rows.reverse();
  }

  function latestMessageId(groupId: string): number | null {
    const row = conn.prepare('SELECT MAX(id) AS id FROM group_messages WHERE group_id = ?').get(groupId) as { id: number | null };
    return row?.id ?? null;
  }

  function messageExists(groupId: string, id: number): boolean {
    return !!conn.prepare('SELECT 1 FROM group_messages WHERE id = ? AND group_id = ?').get(id, groupId);
  }

  /** 最近出现过的人类发送者（名册里的「成员」）。 */
  function recentHumanSenders(groupId: string, limit = 500): Array<{ name: string; userId: number | null; guestId: string | null }> {
    const rows = conn.prepare(`SELECT sender_name, sender_user_id, sender_guest_id FROM (
      SELECT sender_name, sender_user_id, sender_guest_id, id FROM group_messages WHERE group_id = ? AND sender_type = 'user' ORDER BY id DESC LIMIT ?
    ) GROUP BY sender_name, sender_user_id, sender_guest_id ORDER BY MAX(id) DESC`).all(groupId, limit) as Array<{ sender_name: string | null; sender_user_id: number | null; sender_guest_id: string | null }>;
    return rows.map((row) => ({ name: row.sender_name || '', userId: row.sender_user_id ?? null, guestId: row.sender_guest_id ?? null })).filter((row) => row.name);
  }

  return { writeMeta, getMeta, getMetaForIds, deleteSingle, listContextMessages, latestMessageId, messageExists, recentHumanSenders };
}

export type RoomMessageStore = ReturnType<typeof createRoomMessageStore>;
