/**
 * 交接链的持久状态（spec 02 F10）：停止的链、一跳「继续」的尝试、outbox / delivery / inbox 与重启恢复。
 *
 * ## 不变量
 *
 * 1. 每条链同一时刻至多一个活跃尝试（部分唯一索引 `idx_room_handoff_attempts_active`）；
 * 2. 载荷在认领时冻结，入 inbox 时按 SHA-256 摘要复核，目标 Agent 的配置快照必须与冻结时一致；
 * 3. 完成的**唯一证据**是目标侧落库的终态消息 id（inbox.terminal_message_id）；
 * 4. `outcome_unknown` 对自动化是终态（不重试可能已执行过的远程工作），交给人看；
 * 5. 每条链至多一次成功的「继续」（continue_used）。
 *
 * 所有状态迁移都是带条件的 UPDATE，放在 IMMEDIATE 事务里——并发的两个「继续」只有一个能认领成功。
 * 单实例部署：source_instance_id 恒为 `local`（多实例时换成实例 id，表结构不变）。
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';

import { canonicalJson } from '../../core/http';
import type { RoomOriginator } from './room-policy';
import { applyRoomSchema } from './room-schema';

export const HANDOFF_SOURCE_INSTANCE = 'local';
export const HANDOFF_LEASE_MS = 30_000;
export const HANDOFF_MAX_ATTEMPTS = 3;

export type ChainStatus = 'stopped' | 'claimed' | 'resumed' | 'outcome_unknown';
export type ChainStopReason = 'max_depth' | 'continue_failed' | 'outcome_unknown' | '';
export type AttemptStatus = 'claimed' | 'admitted' | 'dispatched' | 'completed' | 'failed' | 'outcome_unknown';
export type InboxStatus = 'admitted' | 'running' | 'completed' | 'failed_manual' | 'cancelled' | 'outcome_unknown';

export type HandoffPayload = {
  groupId: string;
  sourceMessageId: number;
  content: string;
  senderName: string;
  senderMemberId: string | null;
  role: 'assistant';
  createdAt: string;
  /** 续跑消息的深度 = 停下时的深度 − 1：目标的回复回到停下时的深度，正好多给一跳。 */
  mentionDepth: number;
  chainId: string;
  originator: RoomOriginator;
  targetMemberId: string;
  mention: { type: 'agent'; participantId: string; displayName: string };
};

export type ChainRow = {
  chain_id: string;
  group_id: string;
  source_message_id: number;
  current_depth: number;
  max_depth: number;
  unlimited: number;
  target_member_id: string;
  target_snapshot: string;
  originator_json: string;
  status: ChainStatus;
  stop_reason: ChainStopReason;
  continue_used: number;
  attempt_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type AttemptRow = {
  attempt_id: string;
  chain_id: string;
  group_id: string;
  source_instance_id: string;
  target_member_id: string;
  target_snapshot: string;
  payload_digest: string;
  replaces_attempt_id: string | null;
  status: AttemptStatus;
  lease_until: number;
  attempt_count: number;
  last_error: string | null;
};

export type InboxRow = {
  inbox_id: string;
  attempt_id: string;
  group_id: string;
  target_member_id: string;
  payload_digest: string;
  receipt: string;
  status: InboxStatus;
  executor: 'local' | 'remote';
  lease_until: number;
  invocation_started_at: number | null;
  terminal_message_id: number | null;
  last_error: string | null;
};

/** 可继续判据的外部输入（按当前库状态算，不信任链上记的）。 */
export type ActionabilityContext = {
  policy: { enabled: boolean; unlimited: boolean; maxDepth: number } | null;
  sourceMessageExists: boolean;
  /** 目标成员当前的配置快照；成员不在了为 null。 */
  currentTargetSnapshot: string | null;
  /** 链是 continue_failed 时：对应尝试是否真的失败过且带非空错误。 */
  failedAttemptWithError?: boolean;
};

export function payloadDigest(payload: HandoffPayload): string {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** 一条被停下的回复里点了几个目标就记几条链（参考实现只记第一个目标）。 */
export function stoppedChainId(sourceMessageId: number, targetMemberId: string): string {
  return `handoff:${sourceMessageId}:${targetMemberId}`;
}

export function isChainActionable(chain: ChainRow, ctx: ActionabilityContext): boolean {
  if (chain.status !== 'stopped') return false;
  if (chain.continue_used !== 0) return false;
  if (chain.unlimited !== 0) return false;
  if (chain.stop_reason === 'max_depth') {
    // ok
  } else if (chain.stop_reason === 'continue_failed') {
    if (!ctx.failedAttemptWithError || !String(chain.last_error ?? '').trim()) return false;
  } else {
    return false;
  }
  if (!Number.isInteger(chain.current_depth) || !Number.isInteger(chain.max_depth)) return false;
  if (!(chain.current_depth >= chain.max_depth && chain.max_depth >= 1)) return false;
  const policy = ctx.policy;
  if (!policy || !policy.enabled || policy.unlimited || policy.maxDepth !== chain.max_depth) return false;
  if (!ctx.sourceMessageExists) return false;
  if (ctx.currentTargetSnapshot === null || ctx.currentTargetSnapshot !== chain.target_snapshot) return false;
  return true;
}

export type ContinueResult =
  | { status: 'continuing'; attemptId: string; chain: ChainRow }
  | { status: 'replay'; chain: ChainRow }
  | { status: 'alreadyClaimed'; attemptId: string; chain: ChainRow }
  | { status: 'outcomeUnknown'; chain: ChainRow }
  | { status: 'notActionable'; chain: ChainRow | null }
  | { status: 'sourceMissing'; chain: ChainRow };

export function createHandoffStore(conn: Database.Database, now: () => number = Date.now) {
  applyRoomSchema(conn);

  const getChainStmt = conn.prepare('SELECT * FROM room_handoff_chains WHERE chain_id = ?');
  const getAttemptStmt = conn.prepare('SELECT * FROM room_handoff_attempts WHERE attempt_id = ?');
  const getInboxStmt = conn.prepare('SELECT * FROM room_handoff_inbox WHERE source_instance_id = ? AND attempt_id = ?');

  const getChain = (chainId: string) => (getChainStmt.get(chainId) as ChainRow | undefined) ?? null;
  const getAttempt = (attemptId: string) => (getAttemptStmt.get(attemptId) as AttemptRow | undefined) ?? null;
  const getInbox = (attemptId: string) => (getInboxStmt.get(HANDOFF_SOURCE_INSTANCE, attemptId) as InboxRow | undefined) ?? null;

  function touchChain(chainId: string, fields: Partial<Pick<ChainRow, 'status' | 'stop_reason' | 'continue_used' | 'attempt_id' | 'last_error'>>, where = ''): number {
    const sets = Object.keys(fields).map((key) => `${key} = @${key}`);
    return conn.prepare(`UPDATE room_handoff_chains SET ${[...sets, 'updated_at = @updated_at'].join(', ')} WHERE chain_id = @chain_id ${where}`)
      .run({ ...fields, updated_at: now(), chain_id: chainId }).changes;
  }

  /** 记一条停止的链（深度到了上限，回复里点了目标）。已有且仍是「停止 / 未用 / 未认领」时刷新，其余状态不动。 */
  function recordStoppedChain(input: {
    groupId: string;
    sourceMessageId: number;
    currentDepth: number;
    maxDepth: number;
    unlimited: boolean;
    targetMemberId: string;
    targetSnapshot: string;
    originator: RoomOriginator;
  }): ChainRow {
    const chainId = stoppedChainId(input.sourceMessageId, input.targetMemberId);
    const run = conn.transaction(() => {
      const existing = getChain(chainId);
      const t = now();
      if (!existing) {
        conn.prepare(`INSERT INTO room_handoff_chains (chain_id, group_id, source_message_id, current_depth, max_depth, unlimited, target_member_id,
          target_snapshot, originator_json, status, stop_reason, continue_used, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', 'max_depth', 0, ?, ?)`).run(
          chainId, input.groupId, input.sourceMessageId, input.currentDepth, input.maxDepth, input.unlimited ? 1 : 0,
          input.targetMemberId, input.targetSnapshot, JSON.stringify(input.originator), t, t,
        );
      } else if (existing.status === 'stopped' && existing.stop_reason === 'max_depth' && existing.continue_used === 0 && !existing.attempt_id) {
        conn.prepare(`UPDATE room_handoff_chains SET current_depth = ?, max_depth = ?, unlimited = ?, target_member_id = ?, target_snapshot = ?, updated_at = ?
          WHERE chain_id = ?`).run(input.currentDepth, input.maxDepth, input.unlimited ? 1 : 0, input.targetMemberId, input.targetSnapshot, t, chainId);
      }
      return getChain(chainId)!;
    });
    return run.immediate();
  }

  function listChains(groupId: string): ChainRow[] {
    return conn.prepare('SELECT * FROM room_handoff_chains WHERE group_id = ? ORDER BY created_at ASC').all(groupId) as ChainRow[];
  }

  function failedAttemptWithError(chain: ChainRow): boolean {
    if (!chain.attempt_id) return false;
    const attempt = getAttempt(chain.attempt_id);
    return !!attempt && attempt.status === 'failed' && !!String(attempt.last_error ?? '').trim();
  }

  /**
   * 一跳「继续」。`buildPayload` 在事务里调用（读源消息）；返回 null 表示源消息没了。
   */
  function continueChain(chainId: string, ctx: () => ActionabilityContext, buildPayload: (chain: ChainRow) => HandoffPayload | null): ContinueResult {
    const run = conn.transaction((): ContinueResult => {
      const chain = getChain(chainId);
      if (!chain) return { status: 'notActionable', chain: null };
      if (chain.status === 'resumed' && chain.continue_used === 1) return { status: 'replay', chain };
      if (chain.status === 'outcome_unknown') return { status: 'outcomeUnknown', chain };
      if (chain.status === 'claimed' && chain.attempt_id) return { status: 'alreadyClaimed', attemptId: chain.attempt_id, chain };
      const context = { ...ctx(), failedAttemptWithError: failedAttemptWithError(chain) };
      if (!context.sourceMessageExists && chain.status === 'stopped') {
        touchChain(chainId, { stop_reason: 'continue_failed', last_error: 'source message was deleted' });
        return { status: 'sourceMissing', chain: getChain(chainId)! };
      }
      if (!isChainActionable(chain, context)) return { status: 'notActionable', chain };
      const payload = buildPayload(chain);
      if (!payload) {
        touchChain(chainId, { stop_reason: 'continue_failed', last_error: 'source message was deleted' });
        return { status: 'sourceMissing', chain: getChain(chainId)! };
      }
      const attemptId = crypto.randomUUID();
      const claimed = conn.prepare(`UPDATE room_handoff_chains SET status = 'claimed', attempt_id = ?, updated_at = ?
        WHERE chain_id = ? AND status = 'stopped' AND continue_used = 0 AND target_snapshot = ?`)
        .run(attemptId, now(), chainId, chain.target_snapshot).changes === 1;
      if (!claimed) {
        const latest = getChain(chainId)!;
        if (latest.status === 'claimed' && latest.attempt_id) return { status: 'alreadyClaimed', attemptId: latest.attempt_id, chain: latest };
        return { status: 'notActionable', chain: latest };
      }
      const t = now();
      conn.prepare(`INSERT INTO room_handoff_attempts (attempt_id, chain_id, group_id, source_instance_id, target_member_id, target_snapshot,
        payload_digest, replaces_attempt_id, status, lease_until, attempt_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, 0, ?, ?)`).run(
        attemptId, chainId, chain.group_id, HANDOFF_SOURCE_INSTANCE, chain.target_member_id, chain.target_snapshot,
        payloadDigest(payload), chain.stop_reason === 'continue_failed' ? chain.attempt_id : null, t + HANDOFF_LEASE_MS, t, t,
      );
      conn.prepare(`INSERT INTO room_handoff_outbox (attempt_id, group_id, payload_json, status, available_at, lease_until, updated_at)
        VALUES (?, ?, ?, 'pending', ?, 0, ?)`).run(attemptId, chain.group_id, JSON.stringify(payload), t, t);
      return { status: 'continuing', attemptId, chain: getChain(chainId)! };
    });
    return run.immediate();
  }

  /** 调度器取下一条可派发的 outbox（单飞：调用方保证串行）。 */
  function claimNextOutbox(): { attempt: AttemptRow; payload: HandoffPayload } | null {
    const run = conn.transaction(() => {
      const t = now();
      const row = conn.prepare(`SELECT o.attempt_id, o.payload_json FROM room_handoff_outbox o
        JOIN room_handoff_attempts a ON a.attempt_id = o.attempt_id
        WHERE a.status = 'claimed' AND o.available_at <= ?
          AND (o.status = 'pending' OR (o.status = 'dispatching' AND o.lease_until < ?))
        ORDER BY o.available_at ASC LIMIT 1`).get(t, t) as { attempt_id: string; payload_json: string } | undefined;
      if (!row) return null;
      conn.prepare("UPDATE room_handoff_outbox SET status = 'dispatching', lease_until = ?, updated_at = ? WHERE attempt_id = ?").run(t + HANDOFF_LEASE_MS, t, row.attempt_id);
      conn.prepare('UPDATE room_handoff_attempts SET attempt_count = attempt_count + 1, lease_until = ?, updated_at = ? WHERE attempt_id = ?').run(t + HANDOFF_LEASE_MS, t, row.attempt_id);
      return { attempt: getAttempt(row.attempt_id)!, payload: JSON.parse(row.payload_json) as HandoffPayload };
    });
    return run.immediate();
  }

  /**
   * 入 inbox：尝试存在、目标对得上、载荷摘要与冻结时一致、目标配置快照未变。
   * 同一个尝试重复入 → `already`（同一张回执，幂等重放）。
   */
  function admit(input: { attemptId: string; targetMemberId: string; payload: HandoffPayload; currentSnapshot: string | null; executor: 'local' | 'remote' }):
    { status: 'admitted' | 'already'; receipt: string } | { status: 'rejected'; reason: string } {
    const run = conn.transaction(() => {
      const attempt = getAttempt(input.attemptId);
      if (!attempt) return { status: 'rejected' as const, reason: 'attempt not found' };
      if (attempt.target_member_id !== input.targetMemberId) return { status: 'rejected' as const, reason: 'target mismatch' };
      if (payloadDigest(input.payload) !== attempt.payload_digest) return { status: 'rejected' as const, reason: 'payload digest mismatch' };
      if (input.currentSnapshot === null || input.currentSnapshot !== attempt.target_snapshot) return { status: 'rejected' as const, reason: 'target configuration changed' };
      const existing = getInbox(input.attemptId);
      if (existing) return { status: 'already' as const, receipt: existing.receipt };
      const receipt = crypto.randomBytes(24).toString('hex');
      const t = now();
      conn.prepare(`INSERT INTO room_handoff_inbox (inbox_id, source_instance_id, attempt_id, group_id, target_member_id, target_snapshot, payload_digest,
        payload_json, receipt, status, state_version, executor, lease_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', 0, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), HANDOFF_SOURCE_INSTANCE, input.attemptId, attempt.group_id, input.targetMemberId, attempt.target_snapshot,
        attempt.payload_digest, JSON.stringify(input.payload), receipt, input.executor, t + HANDOFF_LEASE_MS, t, t,
      );
      return { status: 'admitted' as const, receipt };
    });
    return run.immediate();
  }

  /** 送达回执：目标队列收下了。重复 → 尝试已派发则 `already`；重启后被重新认领的尝试允许再收一次。 */
  function recordDelivery(attemptId: string, targetMemberId: string): 'accepted' | 'already' | 'rejected' {
    const run = conn.transaction(() => {
      const existing = conn.prepare('SELECT * FROM room_handoff_deliveries WHERE attempt_id = ?').get(attemptId) as { admissions: number } | undefined;
      const t = now();
      if (!existing) {
        conn.prepare("INSERT INTO room_handoff_deliveries (attempt_id, target_member_id, status, admissions, updated_at) VALUES (?, ?, 'accepted', 1, ?)").run(attemptId, targetMemberId, t);
        return 'accepted' as const;
      }
      const attempt = getAttempt(attemptId);
      if (attempt?.status === 'dispatched') return 'already' as const;
      if (attempt?.status === 'claimed' && existing.admissions < 2) {
        conn.prepare("UPDATE room_handoff_deliveries SET admissions = admissions + 1, status = 'accepted', updated_at = ? WHERE attempt_id = ?").run(t, attemptId);
        return 'accepted' as const;
      }
      return 'rejected' as const;
    });
    return run.immediate();
  }

  /** 认领且租约有效 → 已受理；outbox 记 delivered。 */
  function acceptAttempt(attemptId: string): boolean {
    const run = conn.transaction(() => {
      const t = now();
      const ok = conn.prepare("UPDATE room_handoff_attempts SET status = 'dispatched', updated_at = ? WHERE attempt_id = ? AND status = 'claimed' AND lease_until >= ?")
        .run(t, attemptId, t).changes === 1;
      if (ok) conn.prepare("UPDATE room_handoff_outbox SET status = 'delivered', updated_at = ? WHERE attempt_id = ?").run(t, attemptId);
      return ok;
    });
    return run.immediate();
  }

  /** 真正交给 Agent 之前（持久记下「调用已开始」：重启后据此判断本机运行不能盲目重跑）。 */
  function markInvocationStarted(attemptId: string): void {
    const t = now();
    conn.prepare(`UPDATE room_handoff_inbox SET status = 'running', invocation_started_at = COALESCE(invocation_started_at, ?), state_version = state_version + 1,
      lease_until = ?, updated_at = ? WHERE source_instance_id = ? AND attempt_id = ? AND status IN ('admitted', 'running')`)
      .run(t, t + HANDOFF_LEASE_MS, t, HANDOFF_SOURCE_INSTANCE, attemptId);
  }

  /** 目标的回复落库了（带着这个续跑尝试 id）：成功 → completed + 终态消息 id；错误回复 → failed_manual。 */
  function markInboxTerminal(attemptId: string, messageId: number, ok: boolean, error?: string): void {
    conn.prepare(`UPDATE room_handoff_inbox SET status = ?, terminal_message_id = ?, last_error = ?, state_version = state_version + 1, updated_at = ?
      WHERE source_instance_id = ? AND attempt_id = ? AND status IN ('admitted', 'running')`)
      .run(ok ? 'completed' : 'failed_manual', messageId, ok ? null : (error ?? 'agent reply failed'), now(), HANDOFF_SOURCE_INSTANCE, attemptId);
  }

  /** 成功收尾：尝试 / 送达 / outbox 完成，链 resumed 且 continue_used = 1。 */
  function finalizeSuccess(attemptId: string): void {
    const run = conn.transaction(() => {
      const attempt = getAttempt(attemptId);
      if (!attempt) return;
      const t = now();
      conn.prepare("UPDATE room_handoff_attempts SET status = 'completed', updated_at = ? WHERE attempt_id = ?").run(t, attemptId);
      conn.prepare("UPDATE room_handoff_deliveries SET status = 'completed', updated_at = ? WHERE attempt_id = ?").run(t, attemptId);
      conn.prepare("UPDATE room_handoff_outbox SET status = 'completed', updated_at = ? WHERE attempt_id = ?").run(t, attemptId);
      conn.prepare("UPDATE room_handoff_chains SET status = 'resumed', continue_used = 1, stop_reason = '', last_error = NULL, updated_at = ? WHERE chain_id = ? AND attempt_id = ?")
        .run(t, attempt.chain_id, attemptId);
    });
    run.immediate();
  }

  /** 失败收尾：链回到 stopped / continue_failed（continue_used 仍为 0，「继续」重新可用）。 */
  function finalizeFailure(attemptId: string, error: string): void {
    const run = conn.transaction(() => {
      const attempt = getAttempt(attemptId);
      if (!attempt) return;
      const t = now();
      const detail = error.trim() || 'continuation failed';
      conn.prepare("UPDATE room_handoff_attempts SET status = 'failed', last_error = ?, updated_at = ? WHERE attempt_id = ?").run(detail, t, attemptId);
      conn.prepare("UPDATE room_handoff_deliveries SET status = 'failed', updated_at = ? WHERE attempt_id = ?").run(t, attemptId);
      conn.prepare("UPDATE room_handoff_outbox SET status = 'failed', updated_at = ? WHERE attempt_id = ?").run(t, attemptId);
      conn.prepare(`UPDATE room_handoff_inbox SET status = CASE WHEN status IN ('completed', 'failed_manual') THEN status ELSE 'cancelled' END, updated_at = ?
        WHERE source_instance_id = ? AND attempt_id = ?`).run(t, HANDOFF_SOURCE_INSTANCE, attemptId);
      conn.prepare("UPDATE room_handoff_chains SET status = 'stopped', stop_reason = 'continue_failed', last_error = ?, updated_at = ? WHERE chain_id = ? AND attempt_id = ?")
        .run(detail, t, attempt.chain_id, attemptId);
    });
    run.immediate();
  }

  /** 结局未知（远程通道断在没有权威结果时）：inbox / 尝试 / outbox / 送达 / 链一并 outcome_unknown，continue_used = 1。 */
  function finalizeOutcomeUnknown(attemptId: string, error: string): void {
    const run = conn.transaction(() => {
      const attempt = getAttempt(attemptId);
      if (!attempt) return;
      const t = now();
      conn.prepare("UPDATE room_handoff_attempts SET status = 'outcome_unknown', last_error = ?, updated_at = ? WHERE attempt_id = ?").run(error, t, attemptId);
      conn.prepare("UPDATE room_handoff_deliveries SET status = 'outcome_unknown', updated_at = ? WHERE attempt_id = ?").run(t, attemptId);
      conn.prepare("UPDATE room_handoff_outbox SET status = 'outcome_unknown', updated_at = ? WHERE attempt_id = ?").run(t, attemptId);
      conn.prepare("UPDATE room_handoff_inbox SET status = 'outcome_unknown', last_error = ?, updated_at = ? WHERE source_instance_id = ? AND attempt_id = ?")
        .run(error, t, HANDOFF_SOURCE_INSTANCE, attemptId);
      conn.prepare(`UPDATE room_handoff_chains SET status = 'outcome_unknown', stop_reason = 'outcome_unknown', continue_used = 1, last_error = ?, updated_at = ?
        WHERE chain_id = ? AND attempt_id = ?`).run(error, t, attempt.chain_id, attemptId);
    });
    run.immediate();
  }

  /** 暂缓（目标不在线）：不消耗尝试次数。 */
  function defer(attemptId: string, delayMs: number): void {
    const t = now();
    conn.prepare("UPDATE room_handoff_outbox SET status = 'pending', available_at = ?, lease_until = 0, updated_at = ? WHERE attempt_id = ?").run(t + delayMs, t, attemptId);
    conn.prepare('UPDATE room_handoff_attempts SET attempt_count = MAX(0, attempt_count - 1), lease_until = ?, updated_at = ? WHERE attempt_id = ?')
      .run(t + delayMs + HANDOFF_LEASE_MS, t, attemptId);
  }

  /** 退避重排；超过次数按失败收尾。返回是否已按失败收尾。 */
  function requeue(attemptId: string, error: string, backoffMs = 1000): boolean {
    const attempt = getAttempt(attemptId);
    if (!attempt) return true;
    if (attempt.attempt_count >= HANDOFF_MAX_ATTEMPTS) {
      finalizeFailure(attemptId, error);
      return true;
    }
    const t = now();
    conn.prepare("UPDATE room_handoff_outbox SET status = 'pending', available_at = ?, lease_until = 0, updated_at = ? WHERE attempt_id = ?").run(t + backoffMs, t, attemptId);
    conn.prepare('UPDATE room_handoff_attempts SET last_error = ?, lease_until = ?, updated_at = ? WHERE attempt_id = ?').run(error, t + backoffMs + HANDOFF_LEASE_MS, t, attemptId);
    return false;
  }

  /**
   * 重启恢复（按顺序）：
   * 1. inbox 已 completed → 尝试 / 送达 / outbox 完成、链 resumed；
   * 2. 远程执行、已开始调用的 running → outcome_unknown；
   * 3. 本机执行、已开始调用的 running → failed_manual，并把失败传回链（stopped / continue_failed）；
   * 4. 未开始调用、租约过期的 running → 退回 admitted；
   * 5. admitted 且未开始调用 → 尝试重新认领（新租约）、outbox pending；
   * 6. dispatching / dispatched 且 inbox 没有终态 → 重新认领、outbox pending；
   * 7. 仍是 claimed、租约已过期的尝试 → failed，链 stopped / continue_failed「重启时租约已过期」。
   */
  function recoverOnBoot(): { completed: number; unknown: number; failed: number; reclaimed: number } {
    const stats = { completed: 0, unknown: 0, failed: 0, reclaimed: 0 };
    const t = now();
    const inbox = conn.prepare('SELECT * FROM room_handoff_inbox').all() as InboxRow[];
    for (const row of inbox.filter((item) => item.status === 'completed')) {
      const attempt = getAttempt(row.attempt_id);
      if (attempt && attempt.status !== 'completed') { finalizeSuccess(row.attempt_id); stats.completed += 1; }
    }
    for (const row of inbox.filter((item) => item.status === 'running' && item.invocation_started_at !== null)) {
      if (row.executor === 'remote') {
        finalizeOutcomeUnknown(row.attempt_id, 'remote run was in flight when the host restarted');
        stats.unknown += 1;
      } else {
        conn.prepare("UPDATE room_handoff_inbox SET status = 'failed_manual', last_error = ?, updated_at = ? WHERE inbox_id = ?").run('interrupted by restart', t, row.inbox_id);
        finalizeFailure(row.attempt_id, 'interrupted by restart');
        stats.failed += 1;
      }
    }
    conn.prepare("UPDATE room_handoff_inbox SET status = 'admitted', updated_at = ? WHERE status = 'running' AND invocation_started_at IS NULL AND lease_until < ?").run(t, t);
    const reclaim = (attemptId: string) => {
      conn.prepare("UPDATE room_handoff_attempts SET status = 'claimed', lease_until = ?, updated_at = ? WHERE attempt_id = ?").run(t + HANDOFF_LEASE_MS, t, attemptId);
      conn.prepare("UPDATE room_handoff_outbox SET status = 'pending', available_at = ?, lease_until = 0, updated_at = ? WHERE attempt_id = ?").run(t, t, attemptId);
      stats.reclaimed += 1;
    };
    for (const row of conn.prepare("SELECT * FROM room_handoff_inbox WHERE status = 'admitted' AND invocation_started_at IS NULL").all() as InboxRow[]) {
      const attempt = getAttempt(row.attempt_id);
      if (attempt && !['completed', 'failed', 'outcome_unknown'].includes(attempt.status)) reclaim(row.attempt_id);
    }
    const outboxOpen = conn.prepare("SELECT o.attempt_id FROM room_handoff_outbox o JOIN room_handoff_attempts a ON a.attempt_id = o.attempt_id WHERE a.status = 'dispatched' OR o.status = 'dispatching'").all() as Array<{ attempt_id: string }>;
    for (const row of outboxOpen) {
      const box = getInbox(row.attempt_id);
      if (box && ['completed', 'failed_manual', 'outcome_unknown', 'cancelled'].includes(box.status)) continue;
      const attempt = getAttempt(row.attempt_id);
      if (attempt && !['completed', 'failed', 'outcome_unknown'].includes(attempt.status)) reclaim(row.attempt_id);
    }
    const expired = conn.prepare("SELECT attempt_id FROM room_handoff_attempts WHERE status = 'claimed' AND lease_until < ?").all(t) as Array<{ attempt_id: string }>;
    for (const row of expired) {
      finalizeFailure(row.attempt_id, 'lease expired during restart');
      stats.failed += 1;
    }
    return stats;
  }

  function deleteForGroup(groupId: string): void {
    const attempts = (conn.prepare('SELECT attempt_id FROM room_handoff_attempts WHERE group_id = ?').all(groupId) as Array<{ attempt_id: string }>).map((row) => row.attempt_id);
    const run = conn.transaction(() => {
      for (const attemptId of attempts) conn.prepare('DELETE FROM room_handoff_deliveries WHERE attempt_id = ?').run(attemptId);
      conn.prepare('DELETE FROM room_handoff_inbox WHERE group_id = ?').run(groupId);
      conn.prepare('DELETE FROM room_handoff_outbox WHERE group_id = ?').run(groupId);
      conn.prepare('DELETE FROM room_handoff_attempts WHERE group_id = ?').run(groupId);
      conn.prepare('DELETE FROM room_handoff_chains WHERE group_id = ?').run(groupId);
    });
    run.immediate();
  }

  return {
    getChain, getAttempt, getInbox, listChains, failedAttemptWithError, recordStoppedChain, continueChain, claimNextOutbox, admit,
    recordDelivery, acceptAttempt, markInvocationStarted, markInboxTerminal, finalizeSuccess, finalizeFailure, finalizeOutcomeUnknown,
    defer, requeue, recoverOnBoot, deleteForGroup, touchChain,
  };
}

export type HandoffStore = ReturnType<typeof createHandoffStore>;
