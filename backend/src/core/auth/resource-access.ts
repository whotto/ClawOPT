/**
 * 数据面资源的访问判定：会话、群、Agent 活动、协调器会话键。
 *
 * P5a 的授权模型是「用户 ↔ Agent」：admin 及以上看全部；member 只看被授权的 Agent。
 * 会话与群本身不带归属，它们的可见性**从 Agent 推出来**：
 *
 * | 资源 | member 可见的条件 |
 * |---|---|
 * | 单聊会话 | 会话的 Agent 在授权里 |
 * | 群 | 群里至少一个成员的 Agent 在授权里 |
 * | 协调器会话键 `room:<群>:member:<成员>` | 同群 |
 * | 其他协调器会话（工作流节点等） | `run_sessions.agent_id` 在授权里 |
 * | 工作流（状态流、待审批） | 工作流里**每个**节点的 Agent 都在授权里（外部运行时节点对 member 一律不可见） |
 *
 * HTTP 路由（列表过滤、按 id 取、流、停止）与 `/ws` 主题授权都经这一处——两条通道的判据不许分家。
 * 资源不存在时一律返回 false：「不存在」与「无权看」对 member 不可区分，不泄露存在性。
 */
import type express from 'express';

import { buildStructuredApiError } from '../http';
import { AUTH_AGENT_FORBIDDEN_ERROR_CODE, type RequestIdentity } from './auth-middleware';
import { roleAtLeast } from './user-store';

/** 数据面资源不在授权里：与 `requireAgentAccess` 同一个错误码，前端同一句文案。 */
export function sendResourceForbidden(res: express.Response): void {
  res.status(403).json(buildStructuredApiError(AUTH_AGENT_FORBIDDEN_ERROR_CODE, 'This resource belongs to an agent that is not assigned to you.'));
}

export interface ResourceLookup {
  /** 单聊会话的 Agent；会话不存在返回 null。 */
  chatSessionAgentId(sessionId: string): string | null;
  /** 群里所有成员的 Agent id；群不存在返回 null。 */
  roomAgentIds(groupId: string): string[] | null;
  /** 协调器通用会话行（run_sessions）的 Agent；没有行返回 null。 */
  runSessionAgentId(sessionKey: string): string | null;
}

export type ResourceAccessDeps = {
  canAccessAgent: (identity: RequestIdentity, agentId: string) => boolean;
  lookup: ResourceLookup;
};

const ROOM_SESSION_KEY = /^room:(.+):member:[^:]+$/;

export function createResourceAccess({ canAccessAgent, lookup }: ResourceAccessDeps) {
  const isAdmin = (identity: RequestIdentity) => roleAtLeast(identity.role, 'admin');

  function canAccessRoom(identity: RequestIdentity, groupId: string): boolean {
    const agentIds = lookup.roomAgentIds(groupId);
    if (agentIds === null) return false;
    if (isAdmin(identity)) return true;
    return agentIds.some((agentId) => canAccessAgent(identity, agentId));
  }

  function canAccessChatSession(identity: RequestIdentity, sessionId: string): boolean {
    const agentId = lookup.chatSessionAgentId(sessionId);
    if (agentId === null) return false;
    return canAccessAgent(identity, agentId);
  }

  /** 协调器会话键（`session:<key>` 主题、交互答复用）：单聊会话、群外部成员、其他表面（工作流节点）。 */
  function canAccessRunSession(identity: RequestIdentity, sessionKey: string): boolean {
    const roomMatch = ROOM_SESSION_KEY.exec(sessionKey);
    if (roomMatch) return canAccessRoom(identity, roomMatch[1]);
    if (lookup.chatSessionAgentId(sessionKey) !== null) return canAccessChatSession(identity, sessionKey);
    const agentId = lookup.runSessionAgentId(sessionKey);
    if (agentId === null) return false;
    return canAccessAgent(identity, agentId);
  }

  /**
   * 改群的结构（改成员 / 重置 / 删除）：看得见这个群，且群里**每个** Agent 都在授权里——
   * 不能因为群里有自己的一个 Agent，就删掉别人的 Agent 也在里面的群。
   */
  function canManageRoom(identity: RequestIdentity, groupId: string): boolean {
    if (!canAccessRoom(identity, groupId)) return false;
    if (isAdmin(identity)) return true;
    return (lookup.roomAgentIds(groupId) ?? []).every((agentId) => canAccessAgent(identity, agentId));
  }

  /** `agentIds` 为 null 表示工作流不存在。 */
  function canAccessWorkflow(identity: RequestIdentity, agentIds: string[] | null): boolean {
    if (agentIds === null) return false;
    if (isAdmin(identity)) return true;
    return agentIds.every((agentId) => canAccessAgent(identity, agentId));
  }

  return {
    isAdmin,
    canAccessWorkflow,
    canAccessAgent,
    canAccessRoom,
    canManageRoom,
    canAccessChatSession,
    canAccessRunSession,
  };
}

export type ResourceAccess = ReturnType<typeof createResourceAccess>;
