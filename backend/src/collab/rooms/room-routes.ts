import type express from 'express';

import { getRequestIdentity, type ResourceAccess, sendResourceForbidden } from '../../core/auth';
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
  type RouteApp,
} from '../../core/http';
import { sanitizeMemberExternalConfig, type RunCoordinator, type RuntimePlatform } from '../../runtime';
import type { UploadService } from '../../workspace';
import {
  buildHistoryPageResponse,
  buildHistorySearchResponse,
  getHistoryPageQueryParams,
} from '../sessions';
import { roomTopic } from './external-member-run';
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
};

export function registerRoomRoutes(app: RouteApp, ctx: RoomRoutesDeps): void {
  const { db } = ctx;
  const { groupChatEngine, groupSSEClients, publishRoomFrame } = ctx.rooms;
  const { withResolvedGroupMemberDisplayName } = ctx.roomMessages;
  const { broadcastGroupReconciliationActions, reconcileInactiveGroupLatestMessage } = ctx.roomReconciliation;
  const { cleanupGroupRuntimeAgent } = ctx.roomRuntime;
  const { clearStoredFilesBySessionKey } = ctx.uploads;

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
  /**
   * 发消息的人能直接叫起的 Agent（admin 全部；member 只有授权给自己的）。
   * 只管用户发起的第一跳：@、没 @ 时的默认回复对象、编辑后重跑、重新生成某个 Agent 的回复；
   * Agent 回复里的 @ 转交按既有链深规则继续，不再按发起人过滤（AGENTS.md「群聊叫起」）。
   */
  const wakePredicateFor = (req: express.Request) => {
    const identity = getRequestIdentity(req);
    return (agentId: string) => ctx.access.canAccessAgent(identity, agentId);
  };
  const guardMemberAgents: express.RequestHandler = (req, res, next) => {
    const members = Array.isArray(req.body?.members) ? req.body.members : [];
    const identity = getRequestIdentity(req);
    if (members.every((member: any) => ctx.access.canAccessAgent(identity, String(member?.agentId ?? '')))) return next();
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

      groupChatEngine.markGroupReset(req.params.id);
      await ctx.runCoordinator.abortTopic(roomTopic(req.params.id), 'user_stop');
      try {
        await groupChatEngine.abortGroupRun(req.params.id);
      } catch {}
      groupChatEngine.forceResetGroupState(req.params.id);
      clearStoredFilesBySessionKey(req.params.id);
      const configCleanupFailed = cleanupGroupRuntimeAgent(req.params.id, { removeConfig: true });
      deleteGroupWorkspace(req.params.id);
      db.deleteGroupChat(req.params.id);
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

  // --- Group Messages ---
  app.get('/api/groups/:id/messages', guardRoom, async (req, res) => {
    try {
      await reconcileInactiveGroupLatestMessage(req.params.id);
      const { beforeId, limit } = getHistoryPageQueryParams(req.query as Record<string, unknown>);
      const result = db.getGroupMessagesPage(req.params.id, { beforeId, limit });
      res.json(buildHistoryPageResponse(
        result.rows.map((row) => withStructuredGroupMessage(row, { groupId: req.params.id })),
        result.pageInfo,
      ));
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

  app.post('/api/groups/:id/messages', guardRoom, async (req, res) => {
    try {
      const { content, parentId: rawParentId } = req.body;
      if (!content?.trim()) return res.status(400).json({ success: false, error: 'content is required' });

      const group = db.getGroupChat(req.params.id);
      if (!group) {
        return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
      }

      // 新消息用 isGroupBlockingNewMessage（**不含成员锁**）。用 isGroupProcessing
      // 会把 per-member 锁在这一层整个抵消掉——一个外部成员跑 10 分钟，整个群 409。
      if (groupChatEngine.isGroupBlockingNewMessage(req.params.id)) {
        return res.status(409).json({
          // 把「已经跑了多久」一并回去：用户看到「上一轮已经跑了 3 分钟」
          // 和看到一个裸 409，能做的判断完全不同。
          ...buildStructuredApiError(GROUP_RUN_IN_PROGRESS_ERROR_CODE, null, {
            minutes: groupChatEngine.groupLockAgeMinutes(req.params.id) ?? 0,
          }),
          runState: groupChatEngine.getGroupRunState(req.params.id),
        });
      }

      const parsedParentId = (
        typeof rawParentId === 'number' && Number.isFinite(rawParentId) && rawParentId > 0
          ? Math.floor(rawParentId)
          : typeof rawParentId === 'string' && rawParentId.trim()
            ? Number.parseInt(rawParentId, 10)
            : undefined
      );
      const parentId = Number.isFinite(parsedParentId as number) && (parsedParentId as number) > 0
        ? Number(parsedParentId)
        : undefined;

      // 被挡下的 @ 照样作为正文落库，只是不叫起；回一条结构化提示让界面说清楚为什么没人回。
      const canWake = wakePredicateFor(req);
      const blocked = groupChatEngine.blockedMentions(req.params.id, content, canWake);
      const agentNames = blocked.map((member) => member.display_name);

      // Respond immediately, processing happens async
      res.json({
        success: true,
        ...(agentNames.length > 0
          ? { notice: { messageCode: GROUP_MENTION_NOT_PERMITTED_MESSAGE_CODE, messageParams: { agents: agentNames.join(', ') }, agentNames } }
          : {}),
      });

      // Process message in background
      groupChatEngine.sendUserMessage(req.params.id, content, parentId, canWake).catch((err: any) => {
        console.error('[GroupChat] Error processing message:', err);
      });
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

      groupChatEngine.markGroupReset(req.params.id);
      // 外部成员的运行在协调器里：一并中止（子进程整组收掉）。此前停止按钮停不住外部 Agent，
      // 它会一直跑到自己结束、占着成员锁。
      const externalAborts = await ctx.runCoordinator.abortTopic(roomTopic(req.params.id), 'user_stop');
      const result = await groupChatEngine.abortGroupRun(req.params.id).catch((error) => {
        console.warn(`[GroupStop] Failed to abort active run for group ${req.params.id}:`, error);
        return { aborted: false };
      });
      groupChatEngine.forceResetGroupState(req.params.id);
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

      const shouldRerun = existingMessage.sender_type === 'user';
      if (shouldRerun && groupChatEngine.isGroupProcessing(req.params.id)) {
        return res.status(409).json({
          // 把「已经跑了多久」一并回去：用户看到「上一轮已经跑了 3 分钟」
          // 和看到一个裸 409，能做的判断完全不同。
          ...buildStructuredApiError(GROUP_RUN_IN_PROGRESS_ERROR_CODE, null, {
            minutes: groupChatEngine.groupLockAgeMinutes(req.params.id) ?? 0,
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

      res.json({ success: true, rerunStarted: shouldRerun, deletedIds });

      if (updatedMessage) {
        publishRoomFrame(req.params.id, { type: 'edit', ...withStructuredGroupMessage(updatedMessage, { groupId: req.params.id }) });
      }
      if (deletedIds.length > 0) {
        publishRoomFrame(req.params.id, { type: 'delete', deletedIds, fallbackParentId: messageId });
      }

      if (shouldRerun) {
        void groupChatEngine.rerunUserMessage(req.params.id, messageId, wakePredicateFor(req)).catch((err: any) => {
          console.error('[GroupChat] Error rerunning edited user message:', err);
        });
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

  app.post('/api/groups/:id/messages/regenerate', guardRoom, async (req, res) => {
    try {
      const { msgId } = req.body; // The message we want to regenerate
      if (!msgId) return res.status(400).json({ success: false, error: 'msgId required' });
      
      const targetMsg = db.getGroupMessageById(Number(msgId), req.params.id) as any;
      
      if (!targetMsg || targetMsg.sender_type !== 'agent' || !targetMsg.sender_id) {
         return res.status(400).json({ success: false, error: 'Cannot regenerate this message' });
      }
      // 重新生成 = 叫起写这条回复的 Agent：发起人叫不起就 403，且不删原回复。
      if (!groupChatEngine.canWakeMemberRef(req.params.id, targetMsg.sender_id, wakePredicateFor(req))) {
        return sendResourceForbidden(res);
      }

      // 与发消息走同一把群锁。原先这里不查锁：正在流式输出的那条被点「重新生成」，
      // 旧 run 继续往已删除的消息 id 写 delta，前端据此复活一条幽灵消息，
      // 同一群会话上两个 run 并行，/stop 只能停后起的那个。
      if (groupChatEngine.isGroupProcessing(req.params.id)) {
        return res.status(409).json({
          ...buildStructuredApiError(GROUP_RUN_IN_PROGRESS_ERROR_CODE, null, {
            minutes: groupChatEngine.groupLockAgeMinutes(req.params.id) ?? 0,
          }),
          runState: groupChatEngine.getGroupRunState(req.params.id),
        });
      }

      // In linear group history, regenerate reuses the parent trigger message.
      let promptContext = "继续";
      let validParentId = targetMsg.parent_id || null;
      if (validParentId) {
         const triggerMsg = db.getGroupMessageById(validParentId) as any;
         if (triggerMsg) {
           promptContext = triggerMsg.content;
         } else {
           validParentId = null; // SAFEGUARD: Prevent FOREIGN KEY constraint fail if parent is orphaned
         }
      }

      db.deleteGroupMessage(Number(msgId));
      publishRoomFrame(req.params.id, { type: 'delete', id: Number(msgId), parent_id: validParentId });

      res.json({ success: true });

      // Inform engine to resend request as a sibling response
      const groupName = db.getGroupChat(req.params.id)?.name || '团队';
      // Emulate a new trigger directly targeting that agent without advancing depth too quickly, using promptContext
      (groupChatEngine as any).sendToAgent(req.params.id, groupName, targetMsg.sender_id, promptContext, targetMsg.sender_name || 'Agent', 0, validParentId || undefined).catch((err: any) => {
        console.error('[GroupChat] Error regenerating message:', err);
      });

    } catch (err: any) {
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
