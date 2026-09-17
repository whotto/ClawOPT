import type express from 'express';
import { raw as expressRaw } from 'express';

import { AttachmentError, ATTACHMENT_CHUNK_BYTES } from './room-attachments';

import { getRequestIdentity, groupMemberAccessAgentId, type ResourceAccess, sendResourceForbidden } from '../../core/auth';
import type { DB } from '../../core/db';
import {
  AGENT_CONFIG_READ_FAILED_ERROR_CODE,
  buildStructuredApiError,
  GROUP_ID_ALREADY_EXISTS_ERROR_CODE,
  GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE,
  GROUP_ID_INVALID_ERROR_CODE,
  GROUP_ID_REQUIRED_ERROR_CODE,
  GROUP_MENTION_NOT_PERMITTED_MESSAGE_CODE,
  GROUP_NOT_FOUND_ERROR_CODE,
  GROUP_RUN_IN_PROGRESS_ERROR_CODE,
  isStructuredRequestError,
  type RouteApp,
} from '../../core/http';
import { sanitizeMemberExternalConfig, type RunCoordinator, type RuntimePlatform } from '../../runtime';
import type { UploadService } from '../../workspace';
import {
  buildHistoryPageResponse,
  buildHistorySearchResponse,
  getHistoryPageQueryParams,
} from '../sessions';
import { externalMemberSessionKey, roomTopic } from './external-member-run';
import type { RoomCollab } from './room-collab';
import { RoomRequestError } from './room-orchestrator';
import { originatorFromActor } from './room-policy';
import { SummaryConflictError } from './room-summary';
import { WorkspaceFiles, WorkspacePathError } from './room-workspace';
import { assertServablePath, servedPathOwner } from '../../core/files';
import {
  deleteGroupWorkspace,
  ensureGroupWorkspace,
  resetGroupWorkspace,
  validateGroupId,
} from './group-workspace';
import type { RoomEngine } from './room-engine';
import { type RoomMessages, withStructuredGroupMessage } from './room-messages';
import type { RoomReconciliation } from './room-reconciliation';
import { createNextGroupRuntimeSessionEpoch, type RoomRuntime } from './room-runtime';

const GROUP_SSE_KEEPALIVE_MS = 15000;
/** 分块上传的请求体：原始字节，上限比一个分块略大（多出来的由服务层判 400）。 */
const rawChunkParser = expressRaw({ type: 'application/octet-stream', limit: ATTACHMENT_CHUNK_BYTES + 1024 });

export type RoomRoutesDeps = {
  db: DB;
  runCoordinator: RunCoordinator;
  runtimePlatform: Pick<RuntimePlatform, 'releaseOwner'>;
  rooms: RoomEngine;
  roomMessages: RoomMessages;
  roomReconciliation: RoomReconciliation;
  roomRuntime: RoomRuntime;
  uploads: UploadService;
  access: ResourceAccess;
  roomCollab: RoomCollab;
};

/** 历史页的行：并上 P3 元数据（发送人、结构化 @、深度、附件）与挂在回复上的工作区 diff（`workspace: false` 时不带，访客页用）。 */
export function decorateRoomMessageRows(collab: Pick<RoomCollab, 'messages' | 'workspaceChanges'>, groupId: string, rows: any[], options: { workspace?: boolean } = {}) {
  const ids = rows.map((row) => Number(row.id)).filter(Number.isFinite);
  const metas = collab.messages.getMetaForIds(ids);
  const changes = options.workspace === false ? new Map() : collab.workspaceChanges.forMessages(groupId, ids);
  return rows.map((row) => {
    const meta = metas.get(Number(row.id));
    const base = withStructuredGroupMessage(row, { groupId });
    return {
      ...base,
      sender_user_id: meta?.senderUserId ?? null,
      sender_guest_id: meta?.senderGuestId ?? null,
      sender_member_id: meta?.senderMemberId ?? null,
      structured_mentions: meta?.structuredMentions ?? null,
      mention_depth: meta?.mentionDepth ?? 0,
      message_kind: meta?.messageKind ?? '',
      attachments: meta?.attachments ?? [],
      workspace_changes: changes.get(Number(row.id)) ?? [],
    };
  });
}

export function registerRoomRoutes(app: RouteApp, ctx: RoomRoutesDeps): void {
  const { db } = ctx;
  const { groupChatEngine, groupSSEClients, publishRoomFrame } = ctx.rooms;
  const { withResolvedGroupMemberDisplayName } = ctx.roomMessages;
  const { broadcastGroupReconciliationActions, reconcileInactiveGroupLatestMessage } = ctx.roomReconciliation;
  const { cleanupGroupRuntimeAgent } = ctx.roomRuntime;
  const { clearStoredFilesBySessionKey } = ctx.uploads;
  const collab = ctx.roomCollab;

  /**
   * 群的数据面授权（P5a 用户 ↔ Agent）：
   * - 看、发消息、停、改 / 删 / 重新生成消息、事件流：群里至少一个 Agent 在授权里（admin 全部）；
   * - 改群结构（改成员 / 重置 / 删群）：群里每个 Agent 都在授权里；
   * - 建群、给群加成员：引用到的每个 Agent 都在授权里。
   * 中间件在请求到来时才读 `access`（路由登记期不调用上下文里的函数）。
   */
  const guardRoom: express.RequestHandler = (req, res, next) => (
    ctx.access.canAccessRoom(getRequestIdentity(req), String(req.params.id ?? '')) ? next() : sendResourceForbidden(res)
  );
  const guardManageRoom: express.RequestHandler = (req, res, next) => (
    ctx.access.canManageRoom(getRequestIdentity(req), String(req.params.id ?? '')) ? next() : sendResourceForbidden(res)
  );
  const guardMemberAgents: express.RequestHandler = (req, res, next) => {
    const members = Array.isArray(req.body?.members) ? req.body.members : [];
    const identity = getRequestIdentity(req);
    if (members.every((member: any) => ctx.access.canAccessAgent(identity, groupMemberAccessAgentId({ agentId: String(member?.agentId ?? ''), runtime: typeof member?.runtime === 'string' ? member.runtime : null })))) return next();
    return sendResourceForbidden(res);
  };

  // --- Group Chat CRUD ---
  app.get('/api/groups', (req, res) => {
    try {
      const identity = getRequestIdentity(req);
      const groups = db.getGroupChats().filter((group) => ctx.access.canAccessRoom(identity, group.id));
      // Attach members to each group
      const result = groups.map(g => ({
        ...g,
        members: db.getGroupMembers(g.id).map(withResolvedGroupMemberDisplayName),
      }));
      res.json({ success: true, groups: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/groups', guardMemberAgents, (req, res) => {
    let persistedGroupId: string | null = null;
    try {
      const { id: rawId, name, description, system_prompt, process_start_tag, process_end_tag, max_chain_depth, members } = req.body;
      if (!name) return res.status(400).json({ success: false, error: 'name is required' });

      const validation = validateGroupId(rawId);
      if (validation.issue === 'required') {
        return res.status(400).json(buildStructuredApiError(GROUP_ID_REQUIRED_ERROR_CODE));
      }
      if (validation.issue === 'whitespace') {
        return res.status(400).json(buildStructuredApiError(GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE));
      }
      if (validation.issue) {
        return res.status(400).json(buildStructuredApiError(GROUP_ID_INVALID_ERROR_CODE, null, {
          groupId: validation.normalizedId || String(rawId || ''),
        }));
      }

      const id = validation.normalizedId;
      if (db.getGroupChat(id)) {
        return res.status(400).json(buildStructuredApiError(GROUP_ID_ALREADY_EXISTS_ERROR_CODE, null, { groupId: id }));
      }

      const now = new Date().toISOString();
      const allGroups = db.getGroupChats();
      const maxPosition = allGroups.length > 0 ? Math.max(...allGroups.map((group) => group.position || 0)) : -1;
      db.saveGroupChat({
        id,
        name,
        description: description || '',
        system_prompt: system_prompt || '',
        process_start_tag: process_start_tag || '',
        process_end_tag: process_end_tag || '',
        max_chain_depth: max_chain_depth !== undefined ? max_chain_depth : 6,
        runtime_session_epoch: createNextGroupRuntimeSessionEpoch(),
        position: maxPosition + 1,
        created_at: now,
        updated_at: now,
      });
      persistedGroupId = id;
      // 房间归属人 = 建群的人（登录关闭时的隐式主人不记 id：归属人判定对隐式身份恒为真）。
      collab.policies.setOwner(id, getRequestIdentity(req).userId);

      // Save members
      if (Array.isArray(members)) {
        members.forEach((m: any, idx: number) => {
          db.saveGroupMember({
            id: `gm_${id}_${m.agentId}`,
            group_id: id,
            agent_id: m.agentId,
            display_name: m.displayName || m.agentId,
            role_description: m.roleDescription || '',
            position: idx,
            // P2：新建时也收运行时与外部配置（此前只有编辑能设，新建一个带远程成员的群要保存两次）。
            runtime: typeof m.runtime === 'string' && m.runtime ? m.runtime : null,
            external_config: sanitizeMemberExternalConfig(m.externalConfig),
          });
        });
      }

      ensureGroupWorkspace(id);
      res.json({ success: true, id });
    } catch (err: any) {
      if (/UNIQUE constraint failed: group_chats\.id|PRIMARY KEY/i.test(String(err?.message || ''))) {
        return res.status(400).json(buildStructuredApiError(GROUP_ID_ALREADY_EXISTS_ERROR_CODE, null, {
          groupId: typeof req.body?.id === 'string' ? req.body.id.trim() : '',
        }));
      }
      if (persistedGroupId) {
        try {
          db.deleteGroupChat(persistedGroupId);
          deleteGroupWorkspace(persistedGroupId);
        } catch {}
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/groups/:id', guardManageRoom, guardMemberAgents, (req, res) => {
    try {
      const existing = db.getGroupChat(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Group not found' });

      const { name, description, system_prompt, process_start_tag, process_end_tag, max_chain_depth, members } = req.body;
      db.saveGroupChat({
        ...existing,
        name: name ?? existing.name,
        description: description ?? existing.description,
        system_prompt: system_prompt ?? existing.system_prompt,
        process_start_tag: process_start_tag ?? existing.process_start_tag,
        process_end_tag: process_end_tag ?? existing.process_end_tag,
        max_chain_depth: max_chain_depth ?? existing.max_chain_depth ?? 6,
        runtime_session_epoch: existing.runtime_session_epoch ?? 0,
        position: existing.position ?? 0,
        updated_at: new Date().toISOString(),
      });

      // Replace members if provided
      if (Array.isArray(members)) {
        // 增量 upsert，不是「删光重插」——后者会连同该群的外部会话一起删掉，
        // 并让成员的 runtime 落回默认值。详见 db.replaceGroupMembers 的注释。
        //
        // runtime / externalConfig 从这里进来，补上此前「有配置、无界面入口」
        // 的缺口（AGENTS.md:75）。
        const membersBefore = db.getGroupMembers(req.params.id);
        db.replaceGroupMembers(req.params.id, members.map((m: any) => ({
          agentId: m.agentId,
          displayName: m.displayName,
          roleDescription: m.roleDescription,
          runtime: m.runtime ?? null,
          externalConfig: sanitizeMemberExternalConfig(m.externalConfig),
        })));
        // P2：被移出群的成员，它的运行时目录一起回收；换了运行时的成员，旧运行时下的目录回收（新运行时的留着）。
        const membersAfter = new Map(db.getGroupMembers(req.params.id).map((member) => [member.id, member]));
        for (const before of membersBefore) {
          const after = membersAfter.get(before.id);
          if (!after) {
            ctx.runtimePlatform.releaseOwner({ kind: 'room-member', groupId: req.params.id, memberId: before.id });
          } else if ((after.runtime ?? null) !== (before.runtime ?? null)) {
            ctx.runtimePlatform.releaseOwner({ kind: 'room-member', groupId: req.params.id, memberId: before.id }, after.runtime ? { exceptRuntime: after.runtime } : {});
          }
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/groups/reorder', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ success: false, error: 'Invalid ids format' });
    }
    const identity = getRequestIdentity(req);
    if (!ids.every((id: unknown) => ctx.access.canAccessRoom(identity, String(id)))) return sendResourceForbidden(res);

    try {
      db.updateGroupChatPositions(ids.map((id: string, index: number) => ({ id, position: index })));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/groups/:id', guardManageRoom, async (req, res) => {
    try {
      const group = db.getGroupChat(req.params.id);
      if (!group) {
        return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
      }

      // 隔离先于中断：先丢排队项并推进房间代数，再停运行——中断返回之后迟到的写入也写不进来。
      collab.orchestrator.dropRoom(req.params.id);
      groupChatEngine.markGroupReset(req.params.id);
      await ctx.runCoordinator.abortTopic(roomTopic(req.params.id), 'user_stop');
      try {
        await groupChatEngine.abortGroupRun(req.params.id);
      } catch {}
      groupChatEngine.forceResetGroupState(req.params.id);
      clearStoredFilesBySessionKey(req.params.id);
      const configCleanupFailed = cleanupGroupRuntimeAgent(req.params.id, { removeConfig: true });
      deleteGroupWorkspace(req.params.id);
      collab.clearRoomState(req.params.id);
      collab.guests.deleteForGroup(req.params.id);
      db.deleteGroupChat(req.params.id);
      collab.forgetRoom(req.params.id);
      // P2：群里所有外部成员的运行时目录一起回收。
      ctx.runtimePlatform.releaseOwner({ kind: 'room-member', groupId: req.params.id });
      // 群、工作区、库行都删干净了；只有 openclaw.json 的清理没跑完（配置读不动）。
      // 措辞是「没跑完」而不是「还留着」——配置读不动时我们并不知道里面有没有那个条目。
      res.json(configCleanupFailed.length > 0
        ? { success: true, configCleanupFailed, warningCode: AGENT_CONFIG_READ_FAILED_ERROR_CODE }
        : { success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Reset group back to its initialized runtime state while keeping the team entity and members.
  app.post('/api/groups/:id/reset', guardManageRoom, async (req, res) => {
    try {
      const group = db.getGroupChat(req.params.id);
      if (!group) {
        return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
      }

      // 隔离先于中断：先丢排队项并推进房间代数，再停运行——中断返回之后迟到的写入也写不进来。
      collab.orchestrator.dropRoom(req.params.id);
      groupChatEngine.markGroupReset(req.params.id);
      await ctx.runCoordinator.abortTopic(roomTopic(req.params.id), 'user_stop');
      try {
        await groupChatEngine.abortGroupRun(req.params.id);
      } catch {}
      groupChatEngine.forceResetGroupState(req.params.id);

      // Restore the team runtime baseline while keeping the team definition.
      db.saveGroupChat({
        ...group,
        runtime_session_epoch: createNextGroupRuntimeSessionEpoch(group.runtime_session_epoch),
        updated_at: new Date().toISOString(),
      });
      db.deleteGroupMessagesByGroup(req.params.id);
      // 清空上下文：队列、交接链、工作区 diff、摘要一并清掉；会话种子轮换、外部成员的续话句柄作废（旧上下文不再续）。
      collab.clearRoomState(req.params.id);
      for (const member of db.getGroupMembers(req.params.id)) db.clearExternalSession(req.params.id, member.id);
      collab.orchestrator.resumeRoom(req.params.id);
      clearStoredFilesBySessionKey(req.params.id);
      const configCleanupFailed = cleanupGroupRuntimeAgent(req.params.id, { removeConfig: true });
      resetGroupWorkspace(req.params.id);

      res.json(configCleanupFailed.length > 0
        ? { success: true, configCleanupFailed, warningCode: AGENT_CONFIG_READ_FAILED_ERROR_CODE }
        : { success: true });
    } catch (err: any) {
      console.error('Failed to reset group:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** 历史页：并上 P3 元数据（发送人、结构化 @、深度、附件）与挂在回复上的工作区 diff。 */
  const decorateRows = (groupId: string, rows: any[]) => decorateRoomMessageRows(collab, groupId, rows);

  const sendRoomError = (res: express.Response, error: unknown): boolean => {
    if (error instanceof RoomRequestError) {
      res.status(error.status).json(buildStructuredApiError(error.code, error.message, error.params as any));
      return true;
    }
    if (error instanceof AttachmentError) {
      res.status(error.status).json(buildStructuredApiError(error.code, error.message));
      return true;
    }
    return false;
  };

  // --- Group Messages ---
  app.get('/api/groups/:id/messages', guardRoom, async (req, res) => {
    try {
      await reconcileInactiveGroupLatestMessage(req.params.id);
      const { beforeId, limit } = getHistoryPageQueryParams(req.query as Record<string, unknown>);
      const result = db.getGroupMessagesPage(req.params.id, { beforeId, limit });
      res.json(buildHistoryPageResponse(decorateRows(req.params.id, result.rows), result.pageInfo));
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/groups/:id/active-run', guardRoom, async (req, res) => {
    try {
      const group = db.getGroupChat(req.params.id);
      if (!group) {
        return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
      }

      const runState = groupChatEngine.getGroupRunState(req.params.id);
      const activeMessage = groupChatEngine.getGroupActiveRunMessage(req.params.id);
      if (!runState.active) {
        const actions = await reconcileInactiveGroupLatestMessage(req.params.id);
        if (actions.length > 0) {
          broadcastGroupReconciliationActions(req.params.id, actions);
        }

        const latestMessage = db.getRecentGroupMessages(req.params.id, 1)[0];
        return res.json({
          success: true,
          active: false,
          runState,
          message: latestMessage ? withStructuredGroupMessage(latestMessage, { groupId: req.params.id }) : null,
        });
      }

      res.json({
        success: true,
        active: true,
        runState,
        message: activeMessage ? withStructuredGroupMessage(activeMessage, { groupId: req.params.id }) : null,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/groups/:id/messages/search', guardRoom, (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      res.json(buildHistorySearchResponse(db.searchGroupMessages(req.params.id, query)));
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * 发消息：结构化 @ 校验（三态）、@all 只给 admin 与房间归属人、按发起人授权决定叫起谁、每 Agent 排队。
   * 永远受理（不再因为「群里有人在跑」回 409）；被挡下的 @ 照样落库，回结构化提示。
   */
  app.post('/api/groups/:id/messages', guardRoom, async (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ success: false, error: 'content is required' });
      const identity = getRequestIdentity(req);
      const result = collab.orchestrator.ingestHumanMessage({
        groupId: req.params.id,
        actor: collab.roomAccess.actorFromIdentity(identity),
        identity,
        content,
        mentions: req.body?.mentions,
        queueCapability: typeof req.body?.queueCapability === 'string' ? req.body.queueCapability : null,
      });
      const agentNames = result.blocked.map((member) => member.display_name);
      const offlineNames = result.offline.map((member) => member.display_name);
      res.json({
        success: true,
        messageId: result.messageId,
        queued: result.queued,
        ...(agentNames.length > 0
          ? { notice: { messageCode: GROUP_MENTION_NOT_PERMITTED_MESSAGE_CODE, messageParams: { agents: agentNames.join(', ') }, agentNames } }
          : offlineNames.length > 0
            ? { notice: { messageCode: 'groups.agentOffline', messageParams: { agentName: offlineNames.join(', ') }, agentNames: offlineNames } }
            : {}),
      });
    } catch (err: any) {
      if (sendRoomError(res, err)) return;
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** 执行队列快照（界面可见位置）。 */
  app.get('/api/groups/:id/queue', guardRoom, (req, res) => {
    res.json({ success: true, ...collab.orchestrator.snapshot(req.params.id) });
  });

  /** 撤回排队中的消息：发送人本人，且这条消息的所有目标都还在排队。 */
  app.post('/api/groups/:id/messages/:msgId/retract', guardRoom, (req, res) => {
    try {
      const identity = getRequestIdentity(req);
      const result = collab.orchestrator.retract({
        groupId: req.params.id,
        messageId: Number(req.params.msgId),
        actor: collab.roomAccess.actorFromIdentity(identity),
        capability: typeof req.body?.queueCapability === 'string' ? req.body.queueCapability : null,
      });
      res.json({ success: true, ...result });
    } catch (err: any) {
      if (sendRoomError(res, err)) return;
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** 交接链（停止卡片）。 */
  app.get('/api/groups/:id/handoffs', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    res.json({ success: true, chains: collab.dispatcher.list(req.params.id), canManage: collab.roomAccess.isManager(identity, req.params.id) });
  });

  /** 一跳「继续」：管理员；目标必须对发起人与点按钮的人都叫得起。 */
  app.post('/api/groups/:id/handoffs/:chainId/continue', guardRoom, (req, res) => {
    try {
      const identity = getRequestIdentity(req);
      if (!collab.roomAccess.isManager(identity, req.params.id)) return sendResourceForbidden(res);
      const result = collab.dispatcher.continueChain(req.params.id, req.params.chainId, identity);
      res.status(result.status === 'replay' ? 200 : 202).json({ success: true, ...result });
    } catch (err: any) {
      if (sendRoomError(res, err)) return;
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** 房间协作策略（交接、摘要、超时、访客 / 远程 Agent）。读：看得见群；改：管理员。 */
  app.get('/api/groups/:id/policy', guardRoom, (req, res) => {
    const policy = collab.policies.get(req.params.id);
    if (!policy) return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    const identity = getRequestIdentity(req);
    const canManage = collab.roomAccess.isManager(identity, req.params.id);
    const { inviteCode, inviteCreatedBy, sessionSeed, ...rest } = policy;
    res.json({
      success: true,
      policy: { ...rest, inviteCode: canManage ? inviteCode : null },
      canManage,
      canMentionAll: collab.roomAccess.canMentionAll(collab.roomAccess.actorFromIdentity(identity), req.params.id, identity),
      isOwner: collab.roomAccess.isOwner(identity, req.params.id),
    });
  });

  app.put('/api/groups/:id/policy', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    if (!collab.roomAccess.isManager(identity, req.params.id)) return sendResourceForbidden(res);
    const body = req.body ?? {};
    const pick = <T,>(key: string, check: (value: unknown) => boolean): T | undefined => (check(body[key]) ? body[key] as T : undefined);
    const isBool = (value: unknown) => typeof value === 'boolean';
    const isNum = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
    const policy = collab.policies.update(req.params.id, {
      handoffEnabled: pick('handoffEnabled', isBool),
      handoffUnlimited: pick('handoffUnlimited', isBool),
      handoffMaxDepth: pick('handoffMaxDepth', isNum),
      summaryModel: pick('summaryModel', (value) => typeof value === 'string'),
      summaryEveryTurns: pick('summaryEveryTurns', isNum),
      runIdleTimeoutSec: pick('runIdleTimeoutSec', isNum),
      runTotalBudgetSec: pick('runTotalBudgetSec', isNum),
      allowGuestAgents: pick('allowGuestAgents', isBool),
      maxGuestAgentsPerMember: pick('maxGuestAgentsPerMember', isNum),
      allowRemoteWorkspace: pick('allowRemoteWorkspace', isBool),
    });
    if (!policy) return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    collab.publish(req.params.id, { type: 'room_updated', data: { policyChanged: true } });
    const { sessionSeed, ...rest } = policy;
    res.json({ success: true, policy: rest });
  });

  /**
   * 邀请码（访客页 `/share/rooms/:code`）：管理员签发 / 轮换 / 吊销，列出与吊销访客。
   * 轮换与吊销都让邀请代 +1——旧码下所有访客令牌立即失效。访客发起的链按签发人的授权判（委托），所以签发人记在策略上。
   */
  app.post('/api/groups/:id/invite', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    if (!collab.roomAccess.isManager(identity, req.params.id)) return sendResourceForbidden(res);
    if (!collab.policies.get(req.params.id)) return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    collab.retireGuests(req.params.id);
    const code = collab.policies.rotateInviteCode(req.params.id, identity.implicit ? null : identity.userId);
    collab.publish(req.params.id, { type: 'room_updated', data: { inviteChanged: true } });
    res.json({ success: true, inviteCode: code, path: `/share/rooms/${code}` });
  });

  app.delete('/api/groups/:id/invite', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    if (!collab.roomAccess.isManager(identity, req.params.id)) return sendResourceForbidden(res);
    collab.retireGuests(req.params.id);
    collab.policies.revokeInviteCode(req.params.id);
    collab.publish(req.params.id, { type: 'room_updated', data: { inviteChanged: true } });
    res.json({ success: true });
  });

  app.get('/api/groups/:id/guests', guardRoom, (req, res) => {
    res.json({ success: true, guests: collab.guests.list(req.params.id) });
  });

  app.delete('/api/groups/:id/guests/:guestId', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    if (!collab.roomAccess.isManager(identity, req.params.id)) return sendResourceForbidden(res);
    if (!collab.revokeGuest(req.params.id, req.params.guestId)) return res.status(404).json(buildStructuredApiError('share.guestNotFound'));
    res.json({ success: true });
  });

  /**
   * 群共享工作区的文件浏览 / 编辑（管理员）。路径一律相对工作区根：不收绝对路径与 `..`、realpath 必须仍在根里、敏感名字拒绝；
   * 写入与删除按 SHA-256 乐观并发（409 `workspace.conflict`）。下载走可服务路径闸门 + 文件归属授权（与 /api/files/download 同一套）。
   */
  const workspaceFiles = new Map<string, WorkspaceFiles>();
  const filesFor = (groupId: string) => {
    let files = workspaceFiles.get(groupId);
    if (!files) {
      files = new WorkspaceFiles(() => ensureGroupWorkspace(groupId).workspacePath);
      workspaceFiles.set(groupId, files);
    }
    return files;
  };
  const guardWorkspace: express.RequestHandler = (req, res, next) => (
    collab.roomAccess.isManager(getRequestIdentity(req), String(req.params.id ?? '')) ? next() : sendResourceForbidden(res)
  );
  const sendWorkspaceError = (res: express.Response, error: unknown) => {
    if (error instanceof WorkspacePathError) return res.status(error.status).json(buildStructuredApiError(error.code, error.message));
    return res.status(500).json({ success: false, error: (error as Error)?.message });
  };

  app.get('/api/groups/:id/workspace/list', guardRoom, guardWorkspace, (req, res) => {
    try {
      res.json({ success: true, ...filesFor(req.params.id).list(typeof req.query.path === 'string' ? req.query.path : '') });
    } catch (error) {
      sendWorkspaceError(res, error);
    }
  });

  app.get('/api/groups/:id/workspace/file', guardRoom, guardWorkspace, (req, res) => {
    try {
      res.json({ success: true, file: filesFor(req.params.id).readText(String(req.query.path ?? '')) });
    } catch (error) {
      sendWorkspaceError(res, error);
    }
  });

  app.put('/api/groups/:id/workspace/file', guardRoom, guardWorkspace, async (req, res) => {
    try {
      if (typeof req.body?.content !== 'string') return res.status(400).json(buildStructuredApiError('workspace.invalidContent'));
      const expected = typeof req.body?.expectedSha256 === 'string' ? req.body.expectedSha256 : null;
      const written = await filesFor(req.params.id).write(String(req.body?.path ?? ''), Buffer.from(req.body.content, 'utf8'), expected);
      res.json({ success: true, file: written });
    } catch (error) {
      sendWorkspaceError(res, error);
    }
  });

  app.post('/api/groups/:id/workspace/mkdir', guardRoom, guardWorkspace, async (req, res) => {
    try {
      res.json({ success: true, ...(await filesFor(req.params.id).mkdir(String(req.body?.path ?? ''))) });
    } catch (error) {
      sendWorkspaceError(res, error);
    }
  });

  app.post('/api/groups/:id/workspace/rename', guardRoom, guardWorkspace, async (req, res) => {
    try {
      res.json({ success: true, ...(await filesFor(req.params.id).rename(String(req.body?.from ?? ''), String(req.body?.to ?? ''))) });
    } catch (error) {
      sendWorkspaceError(res, error);
    }
  });

  app.post('/api/groups/:id/workspace/delete', guardRoom, guardWorkspace, async (req, res) => {
    try {
      const expected = typeof req.body?.expectedSha256 === 'string' ? req.body.expectedSha256 : null;
      res.json({ success: true, ...(await filesFor(req.params.id).remove(String(req.body?.path ?? ''), expected)) });
    } catch (error) {
      sendWorkspaceError(res, error);
    }
  });

  app.get('/api/groups/:id/workspace/download', guardRoom, guardWorkspace, (req, res) => {
    try {
      const { abs } = filesFor(req.params.id).statFile(String(req.query.path ?? ''));
      const realPath = assertServablePath(abs);
      if (!ctx.access.canAccessServedFile(getRequestIdentity(req), servedPathOwner(realPath))) return sendResourceForbidden(res);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.download(realPath);
    } catch (error) {
      if (isStructuredRequestError(error)) return res.status(error.status).json(error.payload);
      sendWorkspaceError(res, error);
    }
  });

  /**
   * 附件的可续传分块上传（看得见群即可上传；单文件 20 MB、每群 500 MB、每群每分钟 30 次、分块 256 KB）。
   * 会话绑定发起人；分块按 offset 顺序追加，断线后 GET 状态从已收处续传。
   */
  const sendAttachmentError = (res: express.Response, error: unknown) => {
    if (error instanceof AttachmentError) return res.status(error.status).json(buildStructuredApiError(error.code, error.message));
    return res.status(500).json({ success: false, error: (error as Error)?.message });
  };
  const actorOf = (req: express.Request) => collab.roomAccess.actorFromIdentity(getRequestIdentity(req));

  app.post('/api/groups/:id/attachments/uploads', guardRoom, (req, res) => {
    try {
      res.json({ success: true, ...collab.attachments.openUpload(req.params.id, actorOf(req), { name: req.body?.name, size: req.body?.size, mediaType: req.body?.mediaType }) });
    } catch (error) {
      sendAttachmentError(res, error);
    }
  });

  app.get('/api/groups/:id/attachments/uploads/:uploadId', guardRoom, (req, res) => {
    try {
      res.json({ success: true, ...collab.attachments.status(req.params.id, req.params.uploadId, actorOf(req)) });
    } catch (error) {
      sendAttachmentError(res, error);
    }
  });

  app.put('/api/groups/:id/attachments/uploads/:uploadId', guardRoom, rawChunkParser, (req, res) => {
    try {
      const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json({ success: true, ...collab.attachments.appendChunk(req.params.id, req.params.uploadId, actorOf(req), Number(req.query.offset), chunk) });
    } catch (error) {
      sendAttachmentError(res, error);
    }
  });

  app.post('/api/groups/:id/attachments/uploads/:uploadId/complete', guardRoom, (req, res) => {
    try {
      res.json({ success: true, attachment: collab.attachments.complete(req.params.id, req.params.uploadId, actorOf(req), req.body?.sha256) });
    } catch (error) {
      sendAttachmentError(res, error);
    }
  });

  app.delete('/api/groups/:id/attachments/uploads/:uploadId', guardRoom, (req, res) => {
    try {
      collab.attachments.abort(req.params.id, req.params.uploadId, actorOf(req));
      res.json({ success: true });
    } catch (error) {
      sendAttachmentError(res, error);
    }
  });

  /** 待决的审批与澄清：审批只列 Agent 主人能处理的，澄清只列给管理员（重连后据此恢复卡片，倒计时按剩余时间）。 */
  app.get('/api/groups/:id/interactions', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    res.json({ success: true, interactions: collab.interactions.list(req.params.id, collab.roomAccess.actorFromIdentity(identity), identity) });
  });

  app.post('/api/groups/:id/interactions/:interactionId/respond', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    const result = collab.interactions.respond(req.params.id, req.params.interactionId, collab.roomAccess.actorFromIdentity(identity), identity, {
      choice: typeof req.body?.choice === 'string' ? req.body.choice : undefined,
      text: typeof req.body?.text === 'string' ? req.body.text : undefined,
    });
    if (result.status === 'forbidden') return sendResourceForbidden(res);
    if (result.status === 'notActive') return res.status(409).json(buildStructuredApiError('runApprovals.notActive'));
    res.json({ success: true, resolved: true, stale: result.status === 'stale' });
  });

  /** 滚动摘要：状态 + 锚点消息预览。看得见群即可读。 */
  app.get('/api/groups/:id/summary', guardRoom, (req, res) => {
    const state = collab.summary.state(req.params.id);
    if (!state) return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    const anchor = state.throughMessageId ? db.getGroupMessageById(state.throughMessageId, req.params.id) : null;
    res.json({
      success: true,
      state,
      anchor: anchor ? { id: anchor.id, created_at: anchor.created_at, sender_name: anchor.sender_name, sender_type: anchor.sender_type, content: String(anchor.content ?? '').slice(0, 500) } : null,
      canManage: collab.roomAccess.isManager(getRequestIdentity(req), req.params.id),
    });
  });

  /** 手工编辑摘要（管理员，按版本号 CAS）。 */
  app.put('/api/groups/:id/summary', guardRoom, (req, res) => {
    if (!collab.roomAccess.isManager(getRequestIdentity(req), req.params.id)) return sendResourceForbidden(res);
    const text = typeof req.body?.summary === 'string' ? req.body.summary : null;
    const version = typeof req.body?.version === 'number' ? req.body.version : null;
    if (text === null || version === null) return res.status(400).json(buildStructuredApiError('groups.summaryInvalid'));
    try {
      res.json({ success: true, state: collab.summary.edit(req.params.id, text, version) });
    } catch (error) {
      if (error instanceof SummaryConflictError) {
        return res.status(error.code === 'groups.summaryTooLong' ? 413 : 409).json({ ...buildStructuredApiError(error.code), state: collab.summary.state(req.params.id) });
      }
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  /** 立即摘要一次（管理员；不看节奏）。 */
  app.post('/api/groups/:id/summary/run', guardRoom, (req, res) => {
    if (!collab.roomAccess.isManager(getRequestIdentity(req), req.params.id)) return sendResourceForbidden(res);
    const state = collab.summary.state(req.params.id);
    if (!state) return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    if (!state.configured) return res.status(409).json(buildStructuredApiError('groups.summaryNotConfigured'));
    void collab.summary.schedule(req.params.id, { force: true });
    res.status(202).json({ success: true });
  });

  /** 中断单个成员：管理员，或远程 Agent 的主人。丢掉它排队中的项、推进它的中断版本、停掉正在跑的那一轮。 */
  app.post('/api/groups/:id/members/:memberId/interrupt', guardRoom, async (req, res) => {
    try {
      const identity = getRequestIdentity(req);
      const member = collab.members(req.params.id).find((row) => row.id === req.params.memberId);
      if (!member) return res.status(404).json(buildStructuredApiError('groups.memberNotFound'));
      const actor = collab.roomAccess.actorFromIdentity(identity);
      const allowed = collab.roomAccess.isManager(identity, req.params.id)
        || ((member as any).owner_kind === 'user' && collab.roomAccess.isAgentOwner(actor, identity, req.params.id, member));
      if (!allowed) return sendResourceForbidden(res);
      collab.orchestrator.dropMember(req.params.id, member.id, 'interrupted');
      groupChatEngine.markMemberInterrupted(req.params.id, member.id);
      const external = await ctx.runCoordinator.abort(externalMemberSessionKey(req.params.id, member.id), 'user_stop');
      const gateway = await groupChatEngine.abortGatewayMember(req.params.id, member.agent_id).catch(() => false);
      res.json({ success: true, aborted: external.aborted || gateway });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/groups/:id/stop', guardRoom, async (req, res) => {
    try {
      const group = db.getGroupChat(req.params.id);
      if (!group) {
        return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
      }

      // 停止整个房间：暂停排空并丢掉排队项 → 推进房间代数（迟到的写入被拒）→ 中止外部与网关运行。
      collab.orchestrator.dropRoom(req.params.id);
      groupChatEngine.markGroupReset(req.params.id);
      // 外部成员的运行在协调器里：一并中止（子进程整组收掉）。此前停止按钮停不住外部 Agent，
      // 它会一直跑到自己结束、占着成员锁。
      const externalAborts = await ctx.runCoordinator.abortTopic(roomTopic(req.params.id), 'user_stop');
      const result = await groupChatEngine.abortGroupRun(req.params.id).catch((error) => {
        console.warn(`[GroupStop] Failed to abort active run for group ${req.params.id}:`, error);
        return { aborted: false };
      });
      groupChatEngine.forceResetGroupState(req.params.id);
      collab.orchestrator.resumeRoom(req.params.id);
      const cleanedMessageIds: number[] = [];

      const recentMessages = db.getRecentGroupMessages(req.params.id, 20);
      const staleMessages = recentMessages.filter((message) => (
        message.sender_type === 'agent'
        && typeof message.content === 'string'
        && message.content.trim() === ''
      ));

      for (const staleMessage of staleMessages) {
        if (typeof staleMessage.id !== 'number') continue;
        db.deleteGroupMessage(staleMessage.id);
        cleanedMessageIds.push(staleMessage.id);
        publishRoomFrame(req.params.id, { type: 'delete', id: staleMessage.id, parent_id: staleMessage.parent_id ?? null });
      }

      res.json({ success: true, aborted: result.aborted || externalAborts.some((item) => item.aborted), cleanedMessageIds });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/groups/:id/messages/:msgId', guardRoom, (req, res) => {
    try {
      const { content } = req.body;
      const messageId = Number(req.params.msgId);
      const group = db.getGroupChat(req.params.id);
      if (!group) {
        return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
      }
      if (!content?.trim()) {
        return res.status(400).json({ success: false, error: 'content is required' });
      }

      const existingMessage = db.getGroupMessageById(messageId, req.params.id);
      if (!existingMessage) {
        return res.status(404).json({ success: false, error: 'Message not found' });
      }

      // 编辑后重跑会删掉这条之后的消息：群里还有人在跑或在排队时不行（它们正往那些消息里写）。
      const shouldRerun = existingMessage.sender_type === 'user';
      if (shouldRerun && (groupChatEngine.isGroupProcessing(req.params.id) || collab.orchestrator.busyMembers(req.params.id).length > 0)) {
        return res.status(409).json({
          ...buildStructuredApiError(GROUP_RUN_IN_PROGRESS_ERROR_CODE, null, {
            minutes: groupChatEngine.longestMemberRunMinutes(req.params.id) ?? 0,
          }),
          runState: groupChatEngine.getGroupRunState(req.params.id),
        });
      }

      db.updateGroupMessage(
        messageId,
        content,
        existingMessage.model_used,
        existingMessage.mentions ?? null,
        existingMessage.process_content ?? null,
      );

      const updatedMessage = db.getGroupMessageById(messageId, req.params.id);
      const deletedRows = shouldRerun
        ? db.deleteGroupMessageDescendants(messageId) as Array<{ id: number; parent_id: number | null }>
        : [];
      const deletedIds = deletedRows.map((row) => row.id);

      let rerun: ReturnType<typeof collab.orchestrator.rerunHumanMessage> | null = null;
      if (shouldRerun) {
        const identity = getRequestIdentity(req);
        try {
          rerun = collab.orchestrator.rerunHumanMessage({ groupId: req.params.id, messageId, actor: collab.roomAccess.actorFromIdentity(identity), identity });
        } catch (error) {
          if (!sendRoomError(res, error)) throw error;
          return;
        }
      }
      const blockedNames = rerun?.blocked.map((member) => member.display_name) ?? [];
      res.json({
        success: true,
        rerunStarted: shouldRerun,
        deletedIds,
        ...(blockedNames.length > 0 ? { notice: { messageCode: GROUP_MENTION_NOT_PERMITTED_MESSAGE_CODE, messageParams: { agents: blockedNames.join(', ') }, agentNames: blockedNames } } : {}),
      });

      if (updatedMessage) {
        publishRoomFrame(req.params.id, { type: 'edit', ...decorateRows(req.params.id, [updatedMessage])[0] });
      }
      if (deletedIds.length > 0) {
        publishRoomFrame(req.params.id, { type: 'delete', deletedIds, fallbackParentId: messageId });
      }
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/groups/:id/messages/:msgId', guardRoom, (req, res) => {
    try {
      // 消息必须属于路径里的这个群：授权判的是群，不按群收窄就能借自己看得见的群删别的群的消息。
      if (!db.getGroupMessageById(Number(req.params.msgId), req.params.id)) {
        return res.status(404).json({ success: false, error: 'Message not found' });
      }
      const deletedRows = db.deleteGroupMessage(Number(req.params.msgId)) as Array<{ id: number; parent_id: number | null }>;
      if (!deletedRows.length) {
        return res.status(404).json({ success: false, error: 'Message not found' });
      }

      const deletedIds = deletedRows.map((row) => row.id);
      const fallbackParentId = deletedRows[0]?.parent_id ?? null;
      res.json({ success: true, deletedIds, fallbackParentId });

      // Broadcast delete event
      publishRoomFrame(req.params.id, { type: 'delete', deletedIds, fallbackParentId });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * 重新生成某条 Agent 回复 = 按它的触发消息重跑那个 Agent（发起人 = 点重新生成的人，第一跳授权照判）。
   * 那个 Agent 正在跑或排队时 409：旧运行还在往这条消息里写。
   */
  app.post('/api/groups/:id/messages/regenerate', guardRoom, async (req, res) => {
    try {
      const { msgId } = req.body;
      if (!msgId) return res.status(400).json({ success: false, error: 'msgId required' });

      const targetMsg = db.getGroupMessageById(Number(msgId), req.params.id) as any;
      if (!targetMsg || targetMsg.sender_type !== 'agent' || !targetMsg.sender_id) {
        return res.status(400).json({ success: false, error: 'Cannot regenerate this message' });
      }
      const members = collab.members(req.params.id);
      const meta = collab.messages.getMeta(Number(msgId));
      const member = (meta?.senderMemberId ? members.find((row) => row.id === meta.senderMemberId) : undefined)
        ?? groupChatEngine.resolveMemberByAgentRef(members, targetMsg.sender_id);
      if (!member) return res.status(400).json({ success: false, error: 'Cannot regenerate this message' });
      const identity = getRequestIdentity(req);
      const actor = collab.roomAccess.actorFromIdentity(identity);
      // 重新生成 = 叫起写这条回复的 Agent：发起人叫不起就 403，且不删原回复。
      if (!collab.roomAccess.originatorCanWake(originatorFromActor(actor, collab.policies.get(req.params.id)), member)) {
        return sendResourceForbidden(res);
      }
      if (groupChatEngine.isMemberBusy(req.params.id, member.agent_id) || collab.orchestrator.pendingCount(req.params.id, member.id) > 0) {
        return res.status(409).json({
          ...buildStructuredApiError(GROUP_RUN_IN_PROGRESS_ERROR_CODE, null, { minutes: groupChatEngine.longestMemberRunMinutes(req.params.id) ?? 0 }),
          runState: groupChatEngine.getGroupRunState(req.params.id),
        });
      }

      // 线性历史里，重新生成复用它的父消息作为触发。
      let triggerText = '继续';
      let triggerSenderName = '用户';
      let validParentId: number | null = targetMsg.parent_id || null;
      if (validParentId) {
        const triggerMsg = db.getGroupMessageById(validParentId) as any;
        if (triggerMsg) {
          triggerText = triggerMsg.content;
          triggerSenderName = triggerMsg.sender_name || triggerSenderName;
        } else {
          validParentId = null;
        }
      }

      db.deleteGroupMessage(Number(msgId));
      publishRoomFrame(req.params.id, { type: 'delete', id: Number(msgId), parent_id: validParentId });
      res.json({ success: true });

      collab.orchestrator.regenerate({ groupId: req.params.id, member, triggerMessageId: validParentId, triggerText, triggerSenderName, actor });
    } catch (err: any) {
      if (sendRoomError(res, err)) return;
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // SSE endpoint for real-time updates
  app.get('/api/groups/:id/events', guardRoom, async (req, res) => {
    const groupId = req.params.id;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write('retry: 1000\n\n');
    // Send initial ping
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'run_state', data: groupChatEngine.getGroupRunState(groupId) })}\n\n`);

    const keepaliveTimer = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {}
    }, GROUP_SSE_KEEPALIVE_MS);

    if (!groupSSEClients.has(groupId)) {
      groupSSEClients.set(groupId, new Set());
    }
    groupSSEClients.get(groupId)!.add(res);

    try {
      const actions = await reconcileInactiveGroupLatestMessage(groupId);
      broadcastGroupReconciliationActions(groupId, actions);
    } catch (error) {
      console.warn(`[GroupEvents] Failed to reconcile group ${groupId} on SSE connect:`, error);
    }

    req.on('close', () => {
      clearInterval(keepaliveTimer);
      groupSSEClients.get(groupId)?.delete(res);
      if (groupSSEClients.get(groupId)?.size === 0) {
        groupSSEClients.delete(groupId);
      }
    });
  });
}
