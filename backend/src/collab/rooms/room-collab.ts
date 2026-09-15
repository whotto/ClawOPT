/**
 * 群协作（P3）的组装：存储、判定、编排器、交接调度、摘要、执行钩子（prompt v2、工作区检查点、远程工作区令牌）。
 *
 * bootstrap 在群聊引擎与数据面授权都建好之后调用一次；路由与 `/ws` 只经这里拿到协作服务。
 */
import type { RequestIdentity, ResourceAccess } from '../../core/auth';
import type { DB, GroupMemberRow } from '../../core/db';
import { createHandoffDispatcher } from './handoff-dispatcher';
import { createHandoffStore } from './handoff-store';
import { getStructuredGroupMessage, type RoomRunScope, type RoomTurnHooks } from './group-chat-engine';
import { stripMentionsForRecipient } from './mentions';
import { createRoomAccess, isRelayMember, type RoomAccess } from './room-access';
import { buildPromptInput } from './room-context';
import { buildCollabFrame, type RoomCollabFrameType } from './room-frames';
import type { RoomEngine } from './room-engine';
import { createRoomMessageStore } from './room-message-store';
import { createRoomOrchestrator, isRelayOnlineMember, type ExecuteTurnInput, type RoomSummaryPort } from './room-orchestrator';
import { createRoomPolicyStore, handoffAllows, originatorDisplayName, originatorId, type RoomPolicy } from './room-policy';
import { buildRoomPrompt, type RoomPromptInput } from './room-prompt';
import { createRoomQueueStore } from './room-queue';
import { createWorkspaceChangeStore, diffWorkspaceSnapshots, takeWorkspaceSnapshot } from './room-workspace';

export type RoomCollabDeps = {
  db: DB;
  rooms: RoomEngine;
  access: ResourceAccess;
  identityForUser: (userId: number) => RequestIdentity | null;
  loginEnabled: () => boolean;
  log?: (message: string) => void;
};

/** 远程工作区令牌与 relay 在线状态的端口（collab/relay 在组装时接上；没有 relay 时远程成员一律离线）。 */
export type RoomRelayPort = {
  isConnectorOnline(connectorId: string): boolean;
  issueWorkspaceGrant(input: { groupId: string; member: GroupMemberRow; policy: RoomPolicy; workspacePath: string }): { baseUrl: string; token: string; revoke(): Promise<void> } | null;
};

/** 摘要状态的端口（room-summary.ts 实现；缺省没有摘要）。 */
export type RoomSummaryState = { text: string; throughMessageId: number | null } | null;

export function handoffModeFor(policy: RoomPolicy, replyDepth: number): RoomPromptInput['handoff'] {
  if (!policy.handoff.enabled) return { mode: 'disabled', remainingHops: 0 };
  if (handoffAllows(policy.handoff, replyDepth)) {
    return { mode: 'available', remainingHops: policy.handoff.unlimited ? 'unlimited' : Math.max(0, policy.handoff.maxDepth - replyDepth) };
  }
  return { mode: 'exhausted', remainingHops: 0 };
}

export function createRoomCollab(deps: RoomCollabDeps) {
  const conn = deps.db.connection();
  const log = deps.log ?? ((message: string) => console.warn(message));
  const engine = deps.rooms.groupChatEngine;
  const policies = createRoomPolicyStore(conn);
  const messages = createRoomMessageStore(conn);
  const queueStore = createRoomQueueStore(conn);
  const handoffs = createHandoffStore(conn);
  const workspaceChanges = createWorkspaceChangeStore(conn);
  const roomAccess: RoomAccess = createRoomAccess({
    access: deps.access,
    identityForUser: deps.identityForUser,
    loginEnabled: deps.loginEnabled,
    policies,
  });

  let relay: RoomRelayPort | null = null;
  let summaryPort: RoomSummaryPort = { beforeInvocation: async () => {}, afterMessage: () => {}, invalidate: () => {} };
  let summaryState: (groupId: string) => RoomSummaryState = () => null;

  const members = (groupId: string): GroupMemberRow[] => engine.resolveMembers(deps.db.getGroupMembers(groupId));
  const isMemberOnline = (member: GroupMemberRow) => isRelayOnlineMember(member, (connectorId) => relay?.isConnectorOnline(connectorId) ?? false);

  function publish(groupId: string, frame: { type: string; data: unknown }): void {
    deps.rooms.publishRoomFrame(groupId, buildCollabFrame(frame.type as RoomCollabFrameType, frame.data));
  }

  const summaryProxy: RoomSummaryPort = {
    beforeInvocation: (groupId, messageId) => summaryPort.beforeInvocation(groupId, messageId),
    afterMessage: (groupId, messageId) => summaryPort.afterMessage(groupId, messageId),
    invalidate: (groupId) => summaryPort.invalidate(groupId),
  };

  const dispatcherRef: { current: ReturnType<typeof createHandoffDispatcher> | null } = { current: null };

  const orchestrator = createRoomOrchestrator({
    db: deps.db,
    members,
    policies,
    access: roomAccess,
    messages,
    queueStore,
    handoffs,
    executor: engine,
    summary: summaryProxy,
    isMemberOnline,
    emitMessage: (payload) => engine.emit('message', payload),
    publish,
    onContinuationFinished: (attemptId, result) => dispatcherRef.current?.onTurnFinished(attemptId, result),
    log,
  });

  const dispatcher = createHandoffDispatcher({
    db: deps.db,
    members,
    policies,
    access: roomAccess,
    messages,
    store: handoffs,
    orchestrator: () => orchestrator,
    isMemberOnline,
    publish,
    log,
  });
  dispatcherRef.current = dispatcher;

  function buildPrompt(input: ExecuteTurnInput, env: Parameters<RoomTurnHooks['buildPrompt']>[1], scope: RoomRunScope): string {
    const { groupId, member, payload, policy } = input;
    const group = deps.db.getGroupChat(groupId);
    const roster = members(groupId);
    const summary = summaryState(groupId);
    const replyDepth = payload.depth + 1;
    const ownerOk = roomAccess.originatorIsAgentOwner(payload.originator, groupId, member);
    const rows = messages.listContextMessages(groupId, {
      beforeId: payload.triggerMessageId > 0 ? payload.triggerMessageId : null,
      afterId: summary?.throughMessageId ?? null,
      limit: 500,
    });
    const promptInput = buildPromptInput({
      groupName: group?.name ?? groupId,
      groupSystemPrompt: group?.system_prompt || group?.description || '',
      member: { name: member.display_name, roleDescription: member.role_description ?? '' },
      roster: {
        humans: messages.recentHumanSenders(groupId).slice(0, 20).map((human) => ({ name: human.name, description: '' })),
        agents: roster.filter((row) => row.id !== member.id && isMemberOnline(row)).map((row) => ({ name: row.display_name, description: row.role_description ?? '' })),
      },
      process: env.processTags,
      hostTakeoverPrompt: env.hostTakeoverPrompt,
      workspace: env.workspace,
      handoff: handoffModeFor(policy, replyDepth),
      delegationEnabled: true,
      security: ownerOk ? null : {
        requesterName: originatorDisplayName(payload.originator),
        requesterId: originatorId(payload.originator),
        ownerId: roomAccess.ownerLabel(groupId, member),
        workspace: env.workspace?.root ?? '',
      },
      remoteWorkspaceApi: scope.remoteWorkspaceApi,
      summary: summary?.text ?? null,
      rows,
      trigger: { kind: payload.triggerKind, senderName: payload.triggerSenderName, text: stripMentionsForRecipient(env.triggerText, member.display_name) },
      isStructuredNotice: (content) => !!getStructuredGroupMessage(content).messageCode,
      rewriteContent: env.rewriteContent,
    });
    return buildRoomPrompt(promptInput);
  }

  async function beginRun(input: ExecuteTurnInput, workspacePath: string | null): Promise<RoomRunScope> {
    const { groupId, member, policy } = input;
    const before = workspacePath ? takeWorkspaceSnapshot(workspacePath) : null;
    const grant = isRelayMember(member) && policy.allowRemoteWorkspace && workspacePath && relay
      ? relay.issueWorkspaceGrant({ groupId, member, policy, workspacePath })
      : null;
    let finished = false;
    return {
      remoteWorkspaceApi: grant ? { baseUrl: grant.baseUrl, token: grant.token } : null,
      runtimeConfig: grant ? { relayWorkspaceGrant: { baseUrl: grant.baseUrl, token: grant.token } } : {},
      async finish(result) {
        if (finished) return;
        finished = true;
        // 先吊销令牌并等进行中的写入排空，再算 diff。
        if (grant) await grant.revoke();
        if (!before || !workspacePath) return;
        const status = result.status === 'completed' ? 'completed' : result.status === 'aborted' || result.status === 'reset' ? 'aborted' : 'failed';
        const change = diffWorkspaceSnapshots(before, takeWorkspaceSnapshot(workspacePath), status);
        if (change.filesChanged === 0) return;
        const stored = workspaceChanges.save({ groupId, memberId: member.id, runMarker: result.runMarker ?? '', parentMessageId: result.messageId, change });
        publish(groupId, { type: 'workspace_diff', data: stored });
      },
    };
  }

  engine.useRoomTurnHooks({ buildPrompt, beginRun });

  return {
    policies,
    messages,
    queueStore,
    handoffs,
    workspaceChanges,
    roomAccess,
    orchestrator,
    dispatcher,
    members,
    isMemberOnline,
    publish,
    useRelay(port: RoomRelayPort) { relay = port; },
    useSummary(port: RoomSummaryPort, state: (groupId: string) => RoomSummaryState) { summaryPort = port; summaryState = state; },
    /** 清空 / 删除房间时：协作表里这个群的状态一并清掉，摘要失效，会话种子轮换。 */
    clearRoomState(groupId: string) {
      queueStore.deleteForGroup(groupId);
      handoffs.deleteForGroup(groupId);
      workspaceChanges.deleteForGroup(groupId);
      conn.prepare('DELETE FROM room_summaries WHERE group_id = ?').run(groupId);
      policies.bumpSummaryGeneration(groupId);
      policies.rotateSessionSeed(groupId);
      summaryPort.invalidate(groupId);
      publish(groupId, { type: 'room_updated', data: { cleared: true } });
    },
    forgetRoom(groupId: string) {
      orchestrator.resumeRoom(groupId);
      engine.fence.forget(groupId);
    },
    start() {
      const failed = queueStore.recoverOnBoot();
      if (failed > 0) log(`[Rooms] ${failed} queued item(s) marked failed after restart`);
      dispatcher.start();
    },
    stop() { dispatcher.stop(); },
  };
}

export type RoomCollab = ReturnType<typeof createRoomCollab>;
