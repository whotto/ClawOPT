/**
 * MCP 路径的记忆宿主上下文：由**宿主**（这里）按令牌推出来，不收模型给的作用域、来历与证据。
 *
 * - 单聊：读写 profile + `clawopt.single-chat:<会话>` + session，缺省写 profile，策略 automatic；
 * - 群聊：读写 profile + `clawopt.group-chat:<群>` + session，**缺省写群 context**（群里的事不进 Agent 的全局记忆）；
 * - 工作流 / 看板：读写 profile + `clawopt.workflow:<工作流>` + session，策略 explicit-only（无人值守的运行没有人说「记住」）；
 * - 证据：ClawOPT 自己落库的**真人消息**（单聊 role=user；群聊 sender_type=user），不是发给 Agent 的提示（带路由信封、注入摘要）。
 *   签发时捕获一次 id（令牌行里），调用时再从库里刷新，二者取并集。
 */
import type { MemoryEvidenceMessage, MemoryHostContext, MemoryScopeRef } from '../memory';
import type { McpDbPort } from './operations';
import type { McpSurface, McpTokenRecord } from './token-store';

export const MEMORY_EVIDENCE_LIMIT = 5;

/** 这次运行的会话里最近的真人消息（最多 5 条）。 */
export function captureEvidence(db: McpDbPort, input: { sessionKey: string; surface: McpSurface; roomId: string | null; pinnedIds?: readonly string[] }): MemoryEvidenceMessage[] {
  const pinned = new Set(input.pinnedIds ?? []);
  const pick = (all: MemoryEvidenceMessage[]) => {
    const latest = new Set(all.slice(-MEMORY_EVIDENCE_LIMIT).map((message) => message.id));
    return all.filter((message) => latest.has(message.id) || pinned.has(message.id));
  };
  try {
    if (input.surface === 'group-chat' && input.roomId) {
      return pick(db.getRecentGroupMessages(input.roomId, 40)
        .filter((row) => row.sender_type === 'user' && typeof row.id === 'number')
        .map((row) => ({ id: `group:${row.id}`, role: 'user' as const, content: row.content, createdAt: row.created_at })));
    }
    if (input.surface === 'single-chat') {
      return pick(db.getMessagesPage(input.sessionKey, { limit: 40 }).rows
        .filter((row) => row.role === 'user' && typeof row.id === 'number')
        .map((row) => ({ id: `chat:${row.id}`, role: 'user' as const, content: row.content, createdAt: row.created_at })));
    }
  } catch {
    // 证据取不到：当作没有证据（明确意图的写入会被闸门拒掉），不当作放行。
  }
  return [];
}

export function buildMemoryHostContext(record: McpTokenRecord, profileId: string, db: McpDbPort): MemoryHostContext {
  const profile: MemoryScopeRef = { type: 'profile', id: profileId };
  const session: MemoryScopeRef = { type: 'session', id: record.sessionKey };
  let context: MemoryScopeRef;
  let namespace: string;
  let contextId: string;
  if (record.surface === 'group-chat' && record.scope.roomId) {
    namespace = 'group-chat';
    contextId = record.scope.roomId;
    context = { type: 'context', namespace: 'clawopt.group-chat', id: record.scope.roomId };
  } else if ((record.surface === 'workflow' || record.surface === 'kanban') && record.scope.workflowIds[0]) {
    namespace = record.surface;
    contextId = record.scope.workflowIds[0];
    context = { type: 'context', namespace: 'clawopt.workflow', id: record.scope.workflowIds[0] };
  } else {
    namespace = record.surface === 'single-chat' ? 'single-chat' : record.surface;
    contextId = record.sessionKey;
    context = { type: 'context', namespace: 'clawopt.single-chat', id: record.sessionKey };
  }
  // 签发时捕获的 id（令牌行里钉住）仍在最近窗口里就留着；运行中新到的真人消息补上。
  const evidence = captureEvidence(db, { sessionKey: record.sessionKey, surface: record.surface, roomId: record.scope.roomId, pinnedIds: record.evidenceIds });
  const unattended = record.surface === 'workflow' || record.surface === 'kanban' || record.surface === 'other';
  return {
    profileId,
    origin: { host: 'clawopt', namespace, contextId },
    recallScopes: [profile, context, session],
    writeScopes: [profile, context, session],
    defaultWriteScope: record.surface === 'group-chat' && record.scope.roomId ? context : profile,
    evidence,
    policy: unattended ? 'explicit-only' : 'automatic',
    actor: `agent:${record.agentId}`,
  };
}
