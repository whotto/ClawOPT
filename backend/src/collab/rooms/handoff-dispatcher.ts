/**
 * 交接续跑的调度器与「继续」入口（spec 02 F10 的 Dispatcher 段）。
 *
 * - `continueChain`：管理员点「继续」。判据按**当前**库状态在事务里重算（策略、源消息、目标配置快照），
 *   另外按发起人与点「继续」的人**两个**身份都判一次能不能叫起目标。
 * - 调度：每秒一次、单飞。认领 outbox → 入 inbox（摘要 / 快照复核）→ 送达回执 → 受理 → 交给目标成员的执行队列。
 *   **不在调度里等运行结束**（运行可能要十分钟），结果经 `onTurnFinished` 回来收尾：
 *   成功（有终态消息）→ resumed；错误回复 → 链回到 stopped / continue_failed（可再点继续）；
 *   远程通道断在没有权威结果时（`relay.outcomeUnknown`）→ outcome_unknown，不再自动重试。
 * - 目标不在线：暂缓 5 秒，不消耗尝试次数；其余入队失败按 1 秒退避重排，超过 3 次按失败收尾。
 */
import type { RequestIdentity } from '../../core/auth';
import type { DB, GroupMemberRow } from '../../core/db';
import { isChainActionable, type ChainRow, type HandoffPayload, type HandoffStore } from './handoff-store';
import type { RoomAccess } from './room-access';
import { isRelayMember } from './room-access';
import type { RoomMessageStore } from './room-message-store';
import { memberSnapshot, RoomRequestError, type MemberTurnResult, type RoomOrchestrator } from './room-orchestrator';
import { originatorFromActor, parseOriginator, type RoomPolicyStore } from './room-policy';

export const HANDOFF_TICK_MS = 1000;
export const HANDOFF_OFFLINE_DEFER_MS = 5000;
export const RELAY_OUTCOME_UNKNOWN_CODE = 'relay.outcomeUnknown';

export type HandoffChainView = {
  chainId: string;
  sourceMessageId: number;
  currentDepth: number;
  maxDepth: number;
  targetMemberId: string;
  targetName: string;
  status: ChainRow['status'];
  stopReason: ChainRow['stop_reason'];
  continueUsed: boolean;
  actionable: boolean;
  lastError: string | null;
  attemptId: string | null;
};

export type HandoffDispatcherDeps = {
  db: Pick<DB, 'getGroupMessageById'>;
  members: (groupId: string) => GroupMemberRow[];
  policies: RoomPolicyStore;
  access: RoomAccess;
  messages: RoomMessageStore;
  store: HandoffStore;
  orchestrator: () => RoomOrchestrator;
  isMemberOnline: (member: GroupMemberRow) => boolean;
  publish: (groupId: string, frame: { type: string; data: unknown }) => void;
  log?: (message: string) => void;
};

export function createHandoffDispatcher(deps: HandoffDispatcherDeps) {
  const log = deps.log ?? ((message: string) => console.warn(message));
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  function contextFor(chain: ChainRow) {
    const policy = deps.policies.get(chain.group_id);
    const target = deps.members(chain.group_id).find((member) => member.id === chain.target_member_id) ?? null;
    return {
      policy: policy?.handoff ?? null,
      sourceMessageExists: deps.messages.messageExists(chain.group_id, chain.source_message_id),
      currentTargetSnapshot: target ? memberSnapshot(target) : null,
    };
  }

  function view(chain: ChainRow): HandoffChainView {
    const target = deps.members(chain.group_id).find((member) => member.id === chain.target_member_id);
    return {
      chainId: chain.chain_id,
      sourceMessageId: chain.source_message_id,
      currentDepth: chain.current_depth,
      maxDepth: chain.max_depth,
      targetMemberId: chain.target_member_id,
      targetName: target?.display_name ?? chain.target_member_id,
      status: chain.status,
      stopReason: chain.stop_reason,
      continueUsed: chain.continue_used === 1,
      actionable: isChainActionable(chain, { ...contextFor(chain), failedAttemptWithError: deps.store.failedAttemptWithError(chain) }),
      lastError: chain.last_error,
      attemptId: chain.attempt_id,
    };
  }

  function list(groupId: string): HandoffChainView[] {
    return deps.store.listChains(groupId).map(view);
  }

  /** 管理员点「继续」。`identity` 是点按钮的人；目标必须同时对发起人与点按钮的人都叫得起。 */
  function continueChain(groupId: string, chainId: string, identity: RequestIdentity): { status: 'continuing' | 'replay' | 'alreadyClaimed'; attemptId?: string; chain: HandoffChainView } {
    const chain = deps.store.getChain(chainId);
    if (!chain || chain.group_id !== groupId) throw new RoomRequestError(404, 'groups.handoffNotFound');
    const target = deps.members(groupId).find((member) => member.id === chain.target_member_id);
    const originator = parseOriginator(chain.originator_json);
    if (target) {
      const continuer = originatorFromActor(deps.access.actorFromIdentity(identity), deps.policies.get(groupId));
      if (!deps.access.originatorCanWake(originator, target) || !deps.access.originatorCanWake(continuer, target)) {
        throw new RoomRequestError(403, 'groups.handoffNotPermitted', undefined, { agentName: target.display_name });
      }
    }
    const result = deps.store.continueChain(chainId, () => contextFor(chain), (current) => {
      const message = deps.db.getGroupMessageById(current.source_message_id, groupId);
      const meta = deps.messages.getMeta(current.source_message_id);
      const targetMember = deps.members(groupId).find((member) => member.id === current.target_member_id);
      if (!message || !targetMember) return null;
      const payload: HandoffPayload = {
        groupId,
        sourceMessageId: current.source_message_id,
        content: message.content,
        senderName: message.sender_name || '',
        senderMemberId: meta?.senderMemberId ?? null,
        role: 'assistant',
        createdAt: message.created_at || '',
        mentionDepth: current.current_depth - 1,
        chainId: meta?.handoffChainId ?? String(current.source_message_id),
        originator: parseOriginator(current.originator_json),
        targetMemberId: targetMember.id,
        mention: { type: 'agent', participantId: targetMember.id, displayName: targetMember.display_name },
      };
      return payload;
    });
    switch (result.status) {
      case 'continuing':
        deps.publish(groupId, { type: 'handoff', data: { changed: true } });
        return { status: 'continuing', attemptId: result.attemptId, chain: view(result.chain) };
      case 'replay':
        return { status: 'replay', chain: view(result.chain) };
      case 'alreadyClaimed':
        return { status: 'alreadyClaimed', attemptId: result.attemptId, chain: view(result.chain) };
      case 'outcomeUnknown':
        throw new RoomRequestError(409, 'groups.handoffOutcomeUnknown');
      case 'sourceMissing':
        deps.publish(groupId, { type: 'handoff', data: { changed: true } });
        throw new RoomRequestError(409, 'groups.handoffSourceMissing');
      default:
        throw new RoomRequestError(409, 'groups.handoffNotActionable');
    }
  }

  /** 一次调度。返回是否派出了一条（用例逐步驱动）。 */
  function tick(): boolean {
    const claimed = deps.store.claimNextOutbox();
    if (!claimed) return false;
    const { attempt, payload } = claimed;
    const target = deps.members(attempt.group_id).find((member) => member.id === attempt.target_member_id) ?? null;
    const orchestrator = deps.orchestrator();
    const admission = deps.store.admit({
      attemptId: attempt.attempt_id,
      targetMemberId: attempt.target_member_id,
      payload,
      currentSnapshot: target ? memberSnapshot(target) : null,
      executor: target && isRelayMember(target) ? 'remote' : 'local',
    });
    if (admission.status === 'rejected') {
      deps.store.finalizeFailure(attempt.attempt_id, `admission rejected: ${admission.reason}`);
      deps.publish(attempt.group_id, { type: 'handoff', data: { changed: true } });
      return true;
    }
    if (!target || !deps.isMemberOnline(target)) {
      deps.store.defer(attempt.attempt_id, HANDOFF_OFFLINE_DEFER_MS);
      return true;
    }
    const delivery = deps.store.recordDelivery(attempt.attempt_id, attempt.target_member_id);
    if (delivery === 'already') return true;
    if (delivery === 'rejected') {
      deps.store.requeue(attempt.attempt_id, 'delivery receipt rejected');
      return true;
    }
    if (!deps.store.acceptAttempt(attempt.attempt_id)) {
      deps.store.requeue(attempt.attempt_id, 'attempt lease expired before acceptance');
      return true;
    }
    const queued = orchestrator.enqueueContinuation(payload, attempt.attempt_id);
    if (queued.status === 'notConnected') {
      // 受理与入队之间目标掉线（极窄窗口）：按失败收尾，链回到可继续。
      deps.store.finalizeFailure(attempt.attempt_id, 'target Agent is not connected');
    }
    deps.publish(attempt.group_id, { type: 'handoff', data: { changed: true } });
    return true;
  }

  /** 续跑的那一跳结束（编排器回调）。 */
  function onTurnFinished(attemptId: string, result: MemberTurnResult): void {
    const attempt = deps.store.getAttempt(attemptId);
    if (!attempt) return;
    try {
      if (result.errorCode === RELAY_OUTCOME_UNKNOWN_CODE) {
        deps.store.finalizeOutcomeUnknown(attemptId, result.error || 'remote outcome unknown');
      } else if (result.status === 'completed' && result.messageId !== null) {
        deps.store.markInboxTerminal(attemptId, result.messageId, true);
        deps.store.finalizeSuccess(attemptId);
      } else if (result.messageId !== null) {
        deps.store.markInboxTerminal(attemptId, result.messageId, false, result.error);
        deps.store.finalizeFailure(attemptId, result.error || result.status);
      } else {
        const inbox = deps.store.getInbox(attemptId);
        if (inbox?.status === 'completed') deps.store.finalizeSuccess(attemptId);
        else deps.store.finalizeFailure(attemptId, result.error || 'completed without a durable Agent message');
      }
    } catch (error) {
      log(`[Handoff] finalize failed for ${attemptId}: ${(error as Error)?.message}`);
    }
    deps.publish(attempt.group_id, { type: 'handoff', data: { changed: true } });
  }

  function start(): void {
    try {
      const stats = deps.store.recoverOnBoot();
      if (stats.completed + stats.unknown + stats.failed + stats.reclaimed > 0) {
        log(`[Handoff] recovered after restart: completed=${stats.completed} unknown=${stats.unknown} failed=${stats.failed} reclaimed=${stats.reclaimed}`);
      }
    } catch (error) {
      log(`[Handoff] restart recovery failed: ${(error as Error)?.message}`);
    }
    if (timer) return;
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      try {
        // 每次最多派 10 条，剩下的下一秒再派（不让一次积压把事件循环占住）。
        for (let i = 0; i < 10 && tick(); i += 1) { /* 继续 */ }
      } catch (error) {
        log(`[Handoff] dispatch tick failed: ${(error as Error)?.message}`);
      } finally {
        ticking = false;
      }
    }, HANDOFF_TICK_MS);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { list, continueChain, tick, onTurnFinished, start, stop };
}

export type HandoffDispatcher = ReturnType<typeof createHandoffDispatcher>;
