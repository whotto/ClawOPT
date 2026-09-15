/**
 * 群协作编排器：人类消息与 Agent 回复进来之后「谁接、按什么顺序、能不能继续转交」全在这里（spec 02 §3.1 / §3.2）。
 *
 * ## 信任边界
 *
 * - 深度 / 链 / 续跑尝试 id **只由服务端签发**：Agent 回复的深度 = 触发它的那条消息的深度 + 1，写在回复行上；
 *   Agent（含远程 Agent）上报的任何深度字段一律不读。
 * - 发起人（originator）沿链传播：人类消息记发起人，Agent 回复继承触发消息的发起人；**每一跳**叫起前按发起人的授权判
 *   （修掉 v1.9「member 借授权 Agent 的回复间接叫起未授权 Agent」的已知风险）。
 * - 本机 Agent 的回复由服务端按正文构造结构化 @（与正文恰好一致）；远程 Agent 发来的消息走 `resolveMentions` 的严格校验。
 *
 * ## 执行
 *
 * 每个目标一项进 `RoomExecutionQueue`（每 (群, 成员) 一个 FIFO worker）；人类消息另建 `room_queue` 持久化行（可见位置 + 撤回）。
 * 一跳执行完只返回结果，转交路由在 `routeReply` 里统一做——不再在执行里递归。
 */
import type { RequestIdentity } from '../../core/auth';
import type { DB, GroupMemberRow } from '../../core/db';
import type { HandoffPayload, HandoffStore } from './handoff-store';
import {
  deriveAgentMentions,
  findTextMentions,
  MentionValidationError,
  parseStructuredMentionsInput,
  resolveMentions,
  stripMentionsForRecipient,
  type MentionParticipant,
  type StructuredMention,
} from './mentions';
import type { RoomAccess } from './room-access';
import { isRelayMember } from './room-access';
import type { RoomMessageStore } from './room-message-store';
import {
  handoffAllows,
  originatorDisplayName,
  originatorFromActor,
  type RoomActor,
  type RoomOriginator,
  type RoomPolicy,
  type RoomPolicyStore,
} from './room-policy';
import type { RoomPromptTrigger } from './room-prompt';
import {
  QUEUE_CLEARED_ERROR,
  QUEUE_MEMBER_INTERRUPTED_ERROR,
  QUEUE_MEMBER_REMOVED_ERROR,
  RoomExecutionQueue,
  type QueueRequester,
  type QueueWorkItem,
  type RoomQueueStore,
} from './room-queue';

export const DELEGATE_LINE = /^[ \t]*\/delegate[ \t]+(@\S[^\n]*)$/gim;
export const MAX_DELEGATIONS_PER_REPLY = 4;

export type TurnKind = 'human' | 'handoff' | 'continuation' | 'delegation_task' | 'delegation_result' | 'regenerate' | 'rerun';

export type TurnPayload = {
  kind: TurnKind;
  triggerKind: RoomPromptTrigger['kind'];
  triggerMessageId: number;
  /** 交给接收方的正文（原文；构建 prompt 时再去掉接收方自己的 @）。 */
  triggerText: string;
  triggerSenderName: string;
  /** 触发消息的深度（服务端签发）。回复深度 = depth + 1。 */
  depth: number;
  chainId: string;
  originator: RoomOriginator;
  continuationAttemptId?: string;
  delegationId?: string;
};

export type MemberTurnResult = {
  status: 'completed' | 'failed' | 'aborted' | 'busy' | 'reset';
  messageId: number | null;
  text: string;
  error?: string;
  errorCode?: string;
};

export type ExecuteTurnInput = {
  groupId: string;
  member: GroupMemberRow;
  payload: TurnPayload;
  policy: RoomPolicy;
  /** 回复行刚落库（占位）时同步调用：写元数据（深度、链、发起人、续跑尝试）。 */
  onReplyCreated: (messageId: number) => void;
};

/** 执行一跳的端口（引擎实现；用例替身）。 */
export interface MemberTurnExecutor {
  executeTurn(input: ExecuteTurnInput): Promise<MemberTurnResult>;
}

export type RoomSummaryPort = {
  /** 调用 Agent 之前：够节奏时先跑一批摘要（配置缺失或失败都不挡调用）。 */
  beforeInvocation(groupId: string, triggerMessageId: number): Promise<void>;
  /** 一条非路由的消息落库之后：检查节奏。 */
  afterMessage(groupId: string, messageId: number): void;
  invalidate(groupId: string): void;
};

export type RoomOrchestratorDeps = {
  db: Pick<DB, 'getGroupChat' | 'saveGroupMessage' | 'getGroupMessageById' | 'getRecentGroupMessages' | 'getLatestGroupMessageId' | 'deleteGroupMessageDescendants'>;
  members: (groupId: string) => GroupMemberRow[];
  policies: RoomPolicyStore;
  access: RoomAccess;
  messages: RoomMessageStore;
  queueStore: RoomQueueStore;
  handoffs: HandoffStore;
  executor: MemberTurnExecutor;
  summary: RoomSummaryPort;
  /** 远程 Agent 在不在线（本机 Agent 恒在线）。 */
  isMemberOnline: (member: GroupMemberRow) => boolean;
  /** 人类消息落库后发 legacy `message` 帧。 */
  emitMessage: (payload: Record<string, unknown>) => void;
  publish: (groupId: string, frame: { type: string; data: unknown }) => void;
  /** 附件重绑（消息里引用的上传必须属于这个群）；不合法抛 `RoomRequestError`。 */
  rebindAttachments?: (groupId: string, content: string, actor: RoomActor) => string;
  /** 异步委派落库（room-delegation.ts）。 */
  createDelegation?: (input: { groupId: string; sourceMessageId: number; from: GroupMemberRow; to: GroupMemberRow; task: string; originator: RoomOriginator; depth: number; chainId: string }) => void;
  onDelegationTaskFinished?: (delegationId: string, result: MemberTurnResult) => void;
  onContinuationFinished?: (attemptId: string, result: MemberTurnResult) => void;
  log?: (message: string) => void;
};

export class RoomRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string, readonly params?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'RoomRequestError';
  }
}

export type IngestHumanInput = {
  groupId: string;
  actor: RoomActor;
  identity: RequestIdentity | null;
  content: string;
  mentions?: unknown;
  queueCapability?: string | null;
};

export type IngestResult = {
  messageId: number;
  queued: Array<{ memberId: string; rowId: string | null }>;
  blocked: GroupMemberRow[];
  offline: GroupMemberRow[];
};

/** 成员的参与者形状（参与者 id = 群成员行 id）。 */
export function memberParticipant(member: GroupMemberRow): MentionParticipant {
  return { participantId: member.id, displayName: member.display_name, kind: 'agent' };
}

/** 交接快照：目标成员「当前配置」的指纹（名字、运行时、配置、角色）。改了配置的成员不能被继续交接。 */
export function memberSnapshot(member: GroupMemberRow): string {
  return JSON.stringify({
    id: member.id,
    agentId: member.agent_id,
    name: member.display_name,
    runtime: member.runtime ?? 'openclaw',
    config: member.external_config ?? null,
    role: member.role_description ?? '',
  });
}

/** 回复里的 `/delegate @名字 任务` 行。 */
export function parseDelegations(text: string, agents: readonly MentionParticipant[], senderParticipantId: string): Array<{ participant: MentionParticipant; task: string }> {
  const out: Array<{ participant: MentionParticipant; task: string }> = [];
  for (const match of text.matchAll(DELEGATE_LINE)) {
    const body = match[1];
    const hit = findTextMentions(body, agents.map((agent) => agent.displayName)).find((item) => item.start === 0);
    if (!hit) continue;
    const participant = agents.find((agent) => agent.displayName.toLowerCase() === hit.name.toLowerCase());
    if (!participant || participant.participantId === senderParticipantId) continue;
    const task = body.slice(hit.end).trim();
    if (!task) continue;
    out.push({ participant, task });
    if (out.length >= MAX_DELEGATIONS_PER_REPLY) break;
  }
  return out;
}

/** 去掉委派行（它们不参与 @ 转交路由）。 */
export function stripDelegationLines(text: string): string {
  return text.replace(DELEGATE_LINE, '');
}

export function createRoomOrchestrator(deps: RoomOrchestratorDeps) {
  const log = deps.log ?? ((message: string) => console.warn(message));

  const queue = new RoomExecutionQueue<TurnPayload>((item) => runItem(item), log);

  function requirePolicy(groupId: string): RoomPolicy {
    const policy = deps.policies.get(groupId);
    if (!policy) throw new RoomRequestError(404, 'groups.notFound');
    return policy;
  }

  function agentMembers(groupId: string): GroupMemberRow[] {
    return deps.members(groupId);
  }

  function publishQueue(groupId: string): void {
    deps.publish(groupId, { type: 'queue', data: { items: deps.queueStore.snapshot(groupId), busyMembers: queue.busyMembers(groupId) } });
  }

  function publishHandoffs(groupId: string): void {
    deps.publish(groupId, { type: 'handoff', data: { changed: true } });
  }

  function requesterOf(actor: RoomActor): QueueRequester {
    return actor.kind === 'user' ? { kind: 'user', userId: actor.userId } : { kind: 'guest', guestId: actor.guestId };
  }

  /** 没有 @ 时的默认回复对象（旧协议保留）：上一个发言的 Agent（发起人叫得起时），否则第一个叫得起的成员。 */
  function legacyDefaultTarget(groupId: string, members: GroupMemberRow[], originator: RoomOriginator): GroupMemberRow[] {
    const recent = deps.db.getRecentGroupMessages(groupId, 5);
    const lastAgent = [...recent].reverse().find((message) => message.sender_type === 'agent' && message.sender_id && message.sender_id !== 'system');
    if (lastAgent) {
      const meta = typeof lastAgent.id === 'number' ? deps.messages.getMeta(lastAgent.id) : null;
      const byMeta = meta?.senderMemberId ? members.find((member) => member.id === meta.senderMemberId) : undefined;
      const bySender = members.find((member) => member.agent_id === lastAgent.sender_id || `ext:${member.runtime}:${member.agent_id}` === lastAgent.sender_id);
      const candidate = byMeta ?? bySender;
      if (candidate && deps.isMemberOnline(candidate) && deps.access.originatorCanWake(originator, candidate)) return [candidate];
    }
    const first = members.find((member) => deps.isMemberOnline(member) && deps.access.originatorCanWake(originator, member));
    return first ? [first] : [];
  }

  /**
   * 人类发消息：校验结构化 @ → @all 权限 → 附件重绑 → 落库 → 目标（在线 + 发起人授权）→ 入队。
   * 被挡下的 @（发起人叫不起）照样作为正文落库，结果里带回去由路由层回提示。
   */
  function ingestHumanMessage(input: IngestHumanInput): IngestResult {
    const group = deps.db.getGroupChat(input.groupId);
    if (!group) throw new RoomRequestError(404, 'groups.notFound');
    const policy = requirePolicy(input.groupId);
    const members = agentMembers(input.groupId);
    const participants = members.map(memberParticipant);

    let structured: StructuredMention[] | undefined;
    let validated;
    try {
      structured = parseStructuredMentionsInput(input.mentions);
      validated = resolveMentions(input.content, structured, participants, { kind: 'human' });
    } catch (error) {
      if (error instanceof MentionValidationError) throw new RoomRequestError(400, error.code, error.message);
      throw error;
    }
    if (validated.all && !deps.access.canMentionAll(input.actor, input.groupId, input.identity)) {
      throw new RoomRequestError(403, 'groups.allMentionForbidden');
    }

    const content = deps.rebindAttachments ? deps.rebindAttachments(input.groupId, input.content, input.actor) : input.content;
    const originator = originatorFromActor(input.actor, policy);
    const senderName = input.actor.kind === 'guest' ? input.actor.name : (input.actor.username || '用户');
    const parentId = deps.db.getLatestGroupMessageId(input.groupId);
    const createdAt = new Date().toISOString();
    const messageId = deps.db.saveGroupMessage({ group_id: input.groupId, parent_id: parentId, sender_type: 'user', sender_name: senderName, content, created_at: createdAt });
    deps.messages.writeMeta(messageId, {
      senderUserId: input.actor.kind === 'user' ? input.actor.userId : null,
      senderGuestId: input.actor.kind === 'guest' ? input.actor.guestId : null,
      structuredMentions: structured,
      mentionDepth: 0,
      handoffChainId: String(messageId),
      originator,
    });
    deps.emitMessage({
      groupId: input.groupId, id: messageId, parent_id: parentId, sender_type: 'user', sender_name: senderName, content, created_at: createdAt,
      sender_user_id: input.actor.kind === 'user' ? input.actor.userId : null,
      sender_guest_id: input.actor.kind === 'guest' ? input.actor.guestId : null,
      structured_mentions: structured ?? null,
    });

    const isReset = content.trim() === '/new';
    let candidates: GroupMemberRow[];
    let triggerKind: RoomPromptTrigger['kind'];
    if (isReset) {
      candidates = members;
      triggerKind = 'all';
    } else if (validated.all) {
      candidates = members;
      triggerKind = 'all';
    } else if (structured !== undefined || validated.targets.length > 0) {
      candidates = validated.targets.map((target) => members.find((member) => member.id === target.participantId)).filter((member): member is GroupMemberRow => !!member);
      triggerKind = 'mention';
    } else {
      candidates = legacyDefaultTarget(input.groupId, members, originator);
      triggerKind = 'legacy';
    }

    const offline = candidates.filter((member) => !deps.isMemberOnline(member));
    const online = candidates.filter((member) => deps.isMemberOnline(member));
    const blocked = online.filter((member) => !deps.access.originatorCanWake(originator, member));
    const targets = online.filter((member) => deps.access.originatorCanWake(originator, member));

    const queued: IngestResult['queued'] = [];
    if (targets.length > 0) {
      const rows = deps.queueStore.enqueueRows({
        groupId: input.groupId,
        messageId,
        targets: targets.map((member) => ({ memberId: member.id, name: member.display_name })),
        requester: requesterOf(input.actor),
        capability: input.queueCapability ?? null,
        text: content,
      });
      for (const member of targets) {
        const rowId = rows.get(member.id) ?? null;
        queued.push({ memberId: member.id, rowId });
        void queue.enqueue({
          groupId: input.groupId,
          memberId: member.id,
          rowId,
          payload: { kind: 'human', triggerKind, triggerMessageId: messageId, triggerText: content, triggerSenderName: senderName, depth: 0, chainId: String(messageId), originator },
        });
      }
      publishQueue(input.groupId);
    } else {
      deps.summary.afterMessage(input.groupId, messageId);
    }
    return { messageId, queued, blocked, offline };
  }

  async function runItem(item: QueueWorkItem<TurnPayload>): Promise<void> {
    const { groupId, memberId, rowId, payload } = item;
    const member = agentMembers(groupId).find((row) => row.id === memberId);
    const finishRow = (status: 'completed' | 'failed' | 'cancelled', error?: string | null) => {
      if (rowId) deps.queueStore.markFinished(rowId, status, error);
    };
    const policy = deps.policies.get(groupId);
    if (!member || !policy) {
      finishRow('failed', QUEUE_MEMBER_REMOVED_ERROR);
      if (payload.continuationAttemptId) deps.onContinuationFinished?.(payload.continuationAttemptId, { status: 'failed', messageId: null, text: '', error: 'target Agent is not connected' });
      if (payload.kind === 'delegation_task' && payload.delegationId) deps.onDelegationTaskFinished?.(payload.delegationId, { status: 'failed', messageId: null, text: '', error: 'target Agent was removed' });
      publishQueue(groupId);
      return;
    }
    // 授权可能在排队期间被收回：开跑前按发起人再判一次。
    if (!deps.access.originatorCanWake(payload.originator, member)) {
      finishRow('failed', 'groups.mentionNotPermitted');
      if (payload.continuationAttemptId) deps.onContinuationFinished?.(payload.continuationAttemptId, { status: 'failed', messageId: null, text: '', error: 'originator is no longer authorized for the target Agent' });
      publishQueue(groupId);
      return;
    }

    try {
      await deps.summary.beforeInvocation(groupId, payload.triggerMessageId);
    } catch (error) {
      log(`[RoomOrchestrator] summary preparation failed for ${groupId}: ${(error as Error)?.message}`);
    }

    if (rowId && !deps.queueStore.markRunning(rowId)) {
      // 已被撤回或作废。
      publishQueue(groupId);
      return;
    }
    publishQueue(groupId);

    const replyDepth = payload.depth + 1;
    let replyId: number | null = null;
    // 续跑：真正交给 Agent 之前持久记下「调用已开始」（重启恢复据此判断能不能重跑）。
    if (payload.continuationAttemptId) deps.handoffs.markInvocationStarted(payload.continuationAttemptId);
    const result = await deps.executor.executeTurn({
      groupId,
      member,
      payload,
      policy,
      onReplyCreated: (messageId) => {
        replyId = messageId;
        deps.messages.writeMeta(messageId, {
          senderMemberId: member.id,
          mentionDepth: replyDepth,
          handoffChainId: payload.chainId,
          originator: payload.originator,
          continuationAttemptId: payload.continuationAttemptId ?? null,
          structuredMentions: undefined,
        });
      },
    }).catch((error): MemberTurnResult => ({ status: 'failed', messageId: replyId, text: '', error: (error as Error)?.message || String(error) }));

    finishRow(result.status === 'completed' ? 'completed' : 'failed', result.status === 'completed' ? null : (result.errorCode ?? result.error ?? result.status));
    publishQueue(groupId);

    if (payload.continuationAttemptId) deps.onContinuationFinished?.(payload.continuationAttemptId, result);
    if (payload.kind === 'delegation_task' && payload.delegationId) deps.onDelegationTaskFinished?.(payload.delegationId, result);

    if (result.status === 'completed' && result.messageId !== null && result.text.trim()) {
      routeReply(groupId, member, result.messageId, result.text, payload);
    } else if (result.messageId !== null) {
      deps.summary.afterMessage(groupId, result.messageId);
    }
  }

  /**
   * Agent 回复之后的转交：结构化 @（服务端按正文构造）→ 委派行 → 每个目标按「在线、发起人授权、深度策略」决定入队 / 记停止链 / 回提示。
   * 深度到了上限：**每个**被点到的目标各记一条停止链（参考实现只记第一个目标，这里修掉）。
   */
  function routeReply(groupId: string, sender: GroupMemberRow, replyId: number, text: string, trigger: TurnPayload): void {
    const policy = deps.policies.get(groupId);
    if (!policy) return;
    const members = agentMembers(groupId);
    const participants = members.map(memberParticipant);
    const routingText = stripDelegationLines(text);
    const structured = deriveAgentMentions(routingText, participants, sender.id);
    const existing = deps.messages.getMeta(replyId);
    deps.messages.writeMeta(replyId, {
      senderMemberId: sender.id,
      mentionDepth: existing?.mentionDepth ?? trigger.depth + 1,
      handoffChainId: existing?.handoffChainId ?? trigger.chainId,
      originator: existing?.originator ?? trigger.originator,
      continuationAttemptId: existing?.continuationAttemptId ?? null,
      structuredMentions: structured,
      messageKind: existing?.messageKind ?? '',
      attachments: existing?.attachments ?? [],
    });
    deps.publish(groupId, { type: 'message_meta', data: { id: replyId, structured_mentions: structured, mention_depth: trigger.depth + 1 } });

    const replyDepth = trigger.depth + 1;
    const notices: Array<{ messageCode: string; messageParams: Record<string, string | number> }> = [];
    let routed = false;

    if (policy.handoff.enabled && handoffAllows(policy.handoff, replyDepth)) {
      for (const delegation of parseDelegations(text, participants, sender.id)) {
        const target = members.find((member) => member.id === delegation.participant.participantId);
        if (!target) continue;
        if (!deps.access.originatorCanWake(trigger.originator, target)) {
          notices.push({ messageCode: 'groups.handoffNotPermitted', messageParams: { agentName: target.display_name } });
          continue;
        }
        deps.createDelegation?.({ groupId, sourceMessageId: replyId, from: sender, to: target, task: delegation.task, originator: trigger.originator, depth: replyDepth, chainId: trigger.chainId });
        routed = true;
      }
    }

    for (const mention of structured) {
      if (mention.type !== 'agent') continue;
      const target = members.find((member) => member.id === mention.participantId);
      if (!target) continue;
      if (!policy.handoff.enabled) {
        notices.push({ messageCode: 'group.chainForwardingDisabled', messageParams: { agentName: target.display_name } });
        continue;
      }
      if (!deps.isMemberOnline(target)) {
        notices.push({ messageCode: 'groups.agentOffline', messageParams: { agentName: target.display_name } });
        continue;
      }
      if (!deps.access.originatorCanWake(trigger.originator, target)) {
        notices.push({ messageCode: 'groups.handoffNotPermitted', messageParams: { agentName: target.display_name } });
        continue;
      }
      if (handoffAllows(policy.handoff, replyDepth)) {
        routed = true;
        void queue.enqueue({
          groupId,
          memberId: target.id,
          rowId: null,
          payload: {
            kind: 'handoff', triggerKind: 'handoff', triggerMessageId: replyId, triggerText: routingText, triggerSenderName: sender.display_name,
            depth: replyDepth, chainId: trigger.chainId, originator: trigger.originator,
          },
        });
      } else {
        deps.handoffs.recordStoppedChain({
          groupId,
          sourceMessageId: replyId,
          currentDepth: replyDepth,
          maxDepth: policy.handoff.maxDepth,
          unlimited: policy.handoff.unlimited,
          targetMemberId: target.id,
          targetSnapshot: memberSnapshot(target),
          originator: trigger.originator,
        });
        publishHandoffs(groupId);
      }
    }
    if (routed) publishQueue(groupId);
    for (const notice of notices) deps.publish(groupId, { type: 'notice', data: { messageId: replyId, ...notice } });
    if (!routed) deps.summary.afterMessage(groupId, replyId);
  }

  /** 交接续跑：调度器认领 outbox 后调用。返回入队后的完成 promise（结果经 onContinuationFinished 回调给调度器）。 */
  function enqueueContinuation(payload: HandoffPayload, attemptId: string): { status: 'queued' | 'notConnected'; done?: Promise<boolean> } {
    const member = agentMembers(payload.groupId).find((row) => row.id === payload.targetMemberId);
    if (!member || !deps.isMemberOnline(member)) return { status: 'notConnected' };
    const done = queue.enqueue({
      groupId: payload.groupId,
      memberId: member.id,
      rowId: null,
      payload: {
        kind: 'continuation', triggerKind: 'continuation', triggerMessageId: payload.sourceMessageId, triggerText: payload.content,
        triggerSenderName: payload.senderName, depth: payload.mentionDepth, chainId: payload.chainId, originator: payload.originator,
        continuationAttemptId: attemptId,
      },
    });
    publishQueue(payload.groupId);
    return { status: 'queued', done };
  }

  /** 异步委派：任务交给目标（delegation_task），结果回到发起委派的 Agent（delegation_result）。 */
  function enqueueDelegationTurn(input: { groupId: string; memberId: string; kind: 'delegation_task' | 'delegation_result'; triggerMessageId: number; text: string; senderName: string; depth: number; chainId: string; originator: RoomOriginator; delegationId: string }): Promise<boolean> | null {
    const member = agentMembers(input.groupId).find((row) => row.id === input.memberId);
    if (!member || !deps.isMemberOnline(member)) return null;
    const done = queue.enqueue({
      groupId: input.groupId,
      memberId: member.id,
      rowId: null,
      payload: {
        kind: input.kind, triggerKind: input.kind, triggerMessageId: input.triggerMessageId, triggerText: input.text, triggerSenderName: input.senderName,
        depth: input.depth, chainId: input.chainId, originator: input.originator, delegationId: input.delegationId,
      },
    });
    publishQueue(input.groupId);
    return done;
  }

  /** 重新生成某条 Agent 回复：按触发消息重跑那个 Agent，发起人 = 点重新生成的人。 */
  function regenerate(input: { groupId: string; member: GroupMemberRow; triggerMessageId: number | null; triggerText: string; triggerSenderName: string; actor: RoomActor }): void {
    const policy = requirePolicy(input.groupId);
    const meta = input.triggerMessageId ? deps.messages.getMeta(input.triggerMessageId) : null;
    void queue.enqueue({
      groupId: input.groupId,
      memberId: input.member.id,
      rowId: null,
      payload: {
        kind: 'regenerate', triggerKind: 'mention', triggerMessageId: input.triggerMessageId ?? 0, triggerText: input.triggerText,
        triggerSenderName: input.triggerSenderName, depth: meta?.mentionDepth ?? 0,
        chainId: meta?.handoffChainId ?? String(input.triggerMessageId ?? ''), originator: originatorFromActor(input.actor, policy),
      },
    });
    publishQueue(input.groupId);
  }

  /**
   * 编辑自己的消息后重跑：编辑过的正文按文本重新解析目标（原来的结构化 @ 对不上改过的正文，清掉），发起人 = 编辑的人。
   * 这条消息旧的排队行（completed / failed）占着 (消息, 目标) 唯一键：先删掉再建，否则 CAS queued→running 永远失败。
   */
  function rerunHumanMessage(input: { groupId: string; messageId: number; actor: RoomActor; identity: RequestIdentity | null; queueCapability?: string | null }): IngestResult {
    const message = deps.db.getGroupMessageById(input.messageId, input.groupId);
    if (!message || message.sender_type !== 'user') throw new RoomRequestError(400, 'groups.rerunInvalid');
    const policy = requirePolicy(input.groupId);
    const members = agentMembers(input.groupId);
    const meta = deps.messages.getMeta(input.messageId);
    const originator = originatorFromActor(input.actor, policy);
    const validated = resolveMentions(message.content, undefined, members.map(memberParticipant), { kind: 'human' });
    if (validated.all && !deps.access.canMentionAll(input.actor, input.groupId, input.identity)) throw new RoomRequestError(403, 'groups.allMentionForbidden');
    deps.messages.writeMeta(input.messageId, {
      senderUserId: meta?.senderUserId ?? (input.actor.kind === 'user' ? input.actor.userId : null),
      senderGuestId: meta?.senderGuestId ?? (input.actor.kind === 'guest' ? input.actor.guestId : null),
      structuredMentions: undefined,
      mentionDepth: 0,
      handoffChainId: String(input.messageId),
      originator,
      attachments: meta?.attachments ?? [],
    });
    const isReset = message.content.trim() === '/new';
    const candidates = validated.all || isReset
      ? members
      : validated.targets.length > 0
        ? validated.targets.map((target) => members.find((member) => member.id === target.participantId)).filter((member): member is GroupMemberRow => !!member)
        : legacyDefaultTarget(input.groupId, members, originator);
    const online = candidates.filter((member) => deps.isMemberOnline(member));
    const blocked = online.filter((member) => !deps.access.originatorCanWake(originator, member));
    const targets = online.filter((member) => deps.access.originatorCanWake(originator, member));
    deps.queueStore.deleteRowsForMessage(input.messageId);
    const rows = targets.length > 0 ? deps.queueStore.enqueueRows({
      groupId: input.groupId, messageId: input.messageId, targets: targets.map((member) => ({ memberId: member.id, name: member.display_name })),
      requester: requesterOf(input.actor), capability: input.queueCapability ?? null, text: message.content,
    }) : new Map<string, string>();
    const queued: IngestResult['queued'] = [];
    const triggerKind: RoomPromptTrigger['kind'] = validated.all || isReset ? 'all' : validated.targets.length > 0 ? 'mention' : 'legacy';
    for (const member of targets) {
      const rowId = rows.get(member.id) ?? null;
      queued.push({ memberId: member.id, rowId });
      void queue.enqueue({
        groupId: input.groupId, memberId: member.id, rowId,
        payload: { kind: 'rerun', triggerKind, triggerMessageId: input.messageId, triggerText: message.content, triggerSenderName: message.sender_name || '用户', depth: 0, chainId: String(input.messageId), originator },
      });
    }
    publishQueue(input.groupId);
    return { messageId: input.messageId, queued, blocked, offline: candidates.filter((member) => !deps.isMemberOnline(member)) };
  }

  /**
   * 撤回排队中的消息。成功后：内存队列里对应的项摘掉、摘要失效、广播撤回 + 队列快照。
   */
  function retract(input: { groupId: string; messageId: number; actor: RoomActor; capability?: string | null }): { status: 'retracted'; parentId: number | null } {
    const outcome = deps.queueStore.retract({
      groupId: input.groupId,
      messageId: input.messageId,
      requester: requesterOf(input.actor),
      capability: input.capability ?? null,
      isHumanMessageOfRequester: (messageId) => {
        const message = deps.db.getGroupMessageById(messageId, input.groupId);
        if (!message || message.sender_type !== 'user') return false;
        const meta = deps.messages.getMeta(messageId);
        if (!meta) return false;
        return input.actor.kind === 'user'
          ? meta.senderGuestId === null && meta.senderUserId === input.actor.userId
          : meta.senderGuestId === input.actor.guestId;
      },
      deleteMessage: (messageId) => deps.messages.deleteSingle(input.groupId, messageId),
      invalidateSummary: () => {
        deps.policies.bumpSummaryGeneration(input.groupId);
        deps.summary.invalidate(input.groupId);
      },
    });
    if (!outcome.ok) {
      if (outcome.reason === 'notCancellable') throw new RoomRequestError(409, 'groups.queueNotCancellable', undefined, { statuses: outcome.statuses ?? [] });
      if (outcome.reason === 'notFound') throw new RoomRequestError(404, 'groups.queueItemNotFound');
      throw new RoomRequestError(403, 'groups.queueRetractForbidden');
    }
    for (const rowId of outcome.rowIds) queue.removeRow(rowId);
    deps.publish(input.groupId, { type: 'message_retracted', data: { messageId: input.messageId, parentId: outcome.parentId } });
    deps.publish(input.groupId, { type: 'summary', data: { invalidated: true } });
    publishQueue(input.groupId);
    return { status: 'retracted', parentId: outcome.parentId };
  }

  /** 中断一个成员：丢掉它排队中的项（行记失败），正在跑的由调用方经协调器中止。 */
  function dropMember(groupId: string, memberId: string, reason: 'interrupted' | 'removed'): void {
    const error = reason === 'removed' ? QUEUE_MEMBER_REMOVED_ERROR : QUEUE_MEMBER_INTERRUPTED_ERROR;
    for (const item of queue.drop(groupId, memberId)) {
      if (item.payload.continuationAttemptId) deps.onContinuationFinished?.(item.payload.continuationAttemptId, { status: 'aborted', messageId: null, text: '', error });
    }
    deps.queueStore.failOpenRows({ groupId, memberId }, error);
    publishQueue(groupId);
  }

  /** 房间级清空 / 删除 / 停止：暂停排空、丢掉全部排队项、行作废。 */
  function dropRoom(groupId: string): void {
    queue.pause(groupId);
    for (const item of queue.drop(groupId)) {
      if (item.payload.continuationAttemptId) deps.onContinuationFinished?.(item.payload.continuationAttemptId, { status: 'aborted', messageId: null, text: '', error: QUEUE_CLEARED_ERROR });
    }
    deps.queueStore.failOpenRows({ groupId }, QUEUE_CLEARED_ERROR);
    publishQueue(groupId);
  }

  function resumeRoom(groupId: string): void {
    queue.resume(groupId);
  }

  function snapshot(groupId: string) {
    return { items: deps.queueStore.snapshot(groupId), busyMembers: queue.busyMembers(groupId) };
  }

  return {
    ingestHumanMessage,
    routeReply,
    enqueueContinuation,
    enqueueDelegationTurn,
    regenerate,
    rerunHumanMessage,
    retract,
    dropMember,
    dropRoom,
    resumeRoom,
    snapshot,
    publishQueue,
    busyMembers: (groupId: string) => queue.busyMembers(groupId),
    pendingCount: (groupId: string, memberId: string) => queue.pendingCount(groupId, memberId),
    stripMentionsForRecipient,
    originatorDisplayName,
  };
}

export type RoomOrchestrator = ReturnType<typeof createRoomOrchestrator>;

export function isRelayOnlineMember(member: GroupMemberRow, online: (connectorId: string) => boolean): boolean {
  if (!isRelayMember(member)) return true;
  const connectorId = (member as GroupMemberRow & { connector_id?: string | null }).connector_id;
  return !!connectorId && online(connectorId);
}
