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
 * | 工作流（列表、读、运行 / 停止 / 重跑、审批、状态流、待审批） | 工作流里**每个**节点的 Agent 都在授权里（外部运行时节点对 member 一律不可见） |
 * | 按路径出的文件（下载、预览、HTML 预览、`/uploads`、`/openclaw`） | 先过可服务路径闸门；再按归属：Agent 工作区看 Agent、群工作区看群、上传目录看 `files` 表登记的会话 / 群；无主文件只给 admin |
 * | 上传 | 目标会话 / 群看得见；不带上下文（落到默认工作区）只给 admin |
 * | 看板任务（列表、详情、评论、完成 / 阻塞、派活） | 任务的负责 Agent 在授权里（没有负责人、外部运行时负责人对 member 不可见） |
 *
 * 自动化里「建 / 改 / 删」工作流、定时、钩子、Webhook 端点与看板管理不按资源判，是管理员闸门（`requireAdminAuth`）。
 * 外部运行时（协调器 Agent id 以 `ext:` 开头）不属于任何 member 的授权——即便有人把这样的 id 写进了授权清单。
 *
 * HTTP 路由（列表过滤、按 id 取、流、停止）与 `/ws` 主题授权都经这一处——两条通道的判据不许分家。
 * 资源不存在时一律返回 false：「不存在」与「无权看」对 member 不可区分，不泄露存在性。
 */
import type express from 'express';

import type { ServedPathOwner } from '../files';
import { buildStructuredApiError, StructuredRequestError } from '../http';
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
  /** 上传目录里的文件在 `files` 表登记的会话键（单聊会话 id 或群 id）；没登记返回 null。 */
  uploadSessionKey(storedName: string): string | null;
}

/** 与 `sendResourceForbidden` 同一个错误码，给抛错风格的处理器用。 */
export function resourceForbiddenError(): StructuredRequestError {
  return new StructuredRequestError(403, AUTH_AGENT_FORBIDDEN_ERROR_CODE, 'This resource belongs to an agent that is not assigned to you.');
}

export type ResourceAccessDeps = {
  canAccessAgent: (identity: RequestIdentity, agentId: string) => boolean;
  lookup: ResourceLookup;
};

const ROOM_SESSION_KEY = /^room:(.+):member:[^:]+$/;
/** 协调器给外部运行时起的 Agent id 前缀（`ext:<运行时>:<表面>`）。 */
const EXTERNAL_AGENT_ID_PREFIX = 'ext:';

/** member 在看板里能做的任务动作；其余（移动、解除阻塞、收回、归档）是管理员的。 */
export const MEMBER_KANBAN_ACTIONS: ReadonlySet<string> = new Set(['complete', 'block', 'dispatch']);

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

  /** 自动化引用的 Agent（工作流节点、看板负责人）：外部运行时只有 admin 能用。 */
  function canUseAutomationAgent(identity: RequestIdentity, agentId: string): boolean {
    if (isAdmin(identity)) return true;
    if (agentId.startsWith(EXTERNAL_AGENT_ID_PREFIX)) return false;
    return canAccessAgent(identity, agentId);
  }

  /** `agentIds` 为 null 表示工作流不存在。 */
  function canAccessWorkflow(identity: RequestIdentity, agentIds: string[] | null): boolean {
    if (agentIds === null) return false;
    if (isAdmin(identity)) return true;
    return agentIds.every((agentId) => canUseAutomationAgent(identity, agentId));
  }

  /**
   * 看板任务：`assignee` 为任务的负责人（null = 没有负责人）。
   * OpenClaw 负责人按 Agent id 判；外部运行时负责人换成 `ext:` id，member 一律不可见。
   */
  function canAccessKanbanTask(identity: RequestIdentity, assignee: { kind: string; id: string } | null): boolean {
    if (isAdmin(identity)) return true;
    if (!assignee) return false;
    const agentId = assignee.kind === 'openclaw' ? assignee.id : `${EXTERNAL_AGENT_ID_PREFIX}${assignee.id}`;
    return canUseAutomationAgent(identity, agentId);
  }

  /** 会话键可能是单聊会话 id，也可能是群 id（上传记录与 `files` 表共用这一列）。 */
  function canAccessSessionOrRoom(identity: RequestIdentity, key: string): boolean {
    if (lookup.chatSessionAgentId(key) !== null) return canAccessChatSession(identity, key);
    if (lookup.roomAgentIds(key) !== null) return canAccessRoom(identity, key);
    return isAdmin(identity);
  }

  /** 已过可服务路径闸门的文件（`owner` 由 `servedPathOwner(realPath)` 给出）。 */
  function canAccessServedFile(identity: RequestIdentity, owner: ServedPathOwner): boolean {
    if (isAdmin(identity)) return true;
    switch (owner.kind) {
      case 'agent': return canAccessAgent(identity, owner.agentId);
      case 'group': return canAccessRoom(identity, owner.groupId);
      case 'upload': {
        const key = lookup.uploadSessionKey(owner.storedName);
        return key ? canAccessSessionOrRoom(identity, key) : false;
      }
      default: return false;
    }
  }

  /** 上传目标：单聊会话或群必须看得见；没有上下文（空会话键，查不到会话）只给 admin。 */
  function canUploadTo(identity: RequestIdentity, target: { contextType: 'session' | 'group'; sessionKey: string }): boolean {
    if (isAdmin(identity)) return true;
    return target.contextType === 'group' ? canAccessRoom(identity, target.sessionKey) : canAccessChatSession(identity, target.sessionKey);
  }

  return {
    isAdmin,
    canAccessServedFile,
    canAccessSessionOrRoom,
    canUploadTo,
    canAccessWorkflow,
    canAccessKanbanTask,
    canUseAutomationAgent,
    canAccessAgent,
    canAccessRoom,
    canManageRoom,
    canAccessChatSession,
    canAccessRunSession,
  };
}

export type ResourceAccess = ReturnType<typeof createResourceAccess>;
