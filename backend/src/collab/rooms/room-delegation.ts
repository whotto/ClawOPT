/**
 * 群级异步委派（spec 01 §2.28 / spec 06 §2.7 的「后台子任务结果回原会话」，在群里的对应物）。
 *
 * ## 为什么在群这一层做
 *
 * 当前七个编码类运行时与远程 OpenClaw 都没有声明 `backgroundDelegation`（没有一个适配器把「比本轮活得更久的后台子任务」
 * 暴露成规范事件），所以不在协调器里接运行时原生的子任务。这里用群里已有的交接机制实现同一个语义：
 *
 * 1. Agent A 在回复里单独写一行 `/delegate @B 任务`（prompt v2 规则【异步委派】）；本机 Agent 与远程 Agent 都能触发，
 *    与运行时无关——**任何能按 prompt 输出这一行的成员都能触发**；
 * 2. 委派落库（queued），调度器认领后把任务作为 B 的一跳交给 B 的执行队列（B 的回复不需要 @ A）；
 * 3. B 那一跳结束，结果（或失败说明）作为 A 的**自主后续一跳**交还给 A（路由说明：用结果继续原任务、不要只回「收到」、不要再委派同一件事）。
 *
 * ## 认领 / 确认 / 释放
 *
 * 两个投递点（交给 B、交还给 A）都用同一套：认领（claim_id + 60 秒租约）→ 目标在线且入队成功 → 确认（推进状态）；
 * 目标不在线或入队失败 → 释放（清认领，下一轮再试）。重启时过期的认领一律释放；交给 B 之后、B 还没结束就重启的，
 * 按失败交还给 A（不重跑可能已经执行过一半的工作）。发起人授权、服务端深度照旧沿链传播。
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';

import type { GroupMemberRow } from '../../core/db';
import type { MemberTurnResult, RoomOrchestrator } from './room-orchestrator';
import { parseOriginator, type RoomOriginator } from './room-policy';
import { applyRoomSchema } from './room-schema';

export const DELEGATION_LEASE_MS = 60_000;
export const DELEGATION_TICK_MS = 1000;

export type DelegationStatus = 'queued' | 'dispatching' | 'running' | 'result_pending' | 'result_delivering' | 'completed' | 'failed';

type Row = {
  id: string;
  group_id: string;
  source_message_id: number;
  from_member_id: string;
  to_member_id: string;
  task: string;
  originator_json: string;
  depth: number;
  chain_id: string;
  status: DelegationStatus;
  result_message_id: number | null;
  result_ok: number | null;
  claim_id: string | null;
  claim_until: number;
  attempts: number;
  last_error: string | null;
};

export type RoomDelegationDeps = {
  conn: Database.Database;
  members: (groupId: string) => GroupMemberRow[];
  orchestrator: () => RoomOrchestrator;
  resultText: (messageId: number | null) => string;
  publish: (groupId: string, frame: { type: string; data: unknown }) => void;
  now?: () => number;
  log?: (message: string) => void;
};

export function createRoomDelegation(deps: RoomDelegationDeps) {
  const { conn } = deps;
  applyRoomSchema(conn);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(message));
  let timer: ReturnType<typeof setInterval> | null = null;

  const get = (id: string) => (conn.prepare('SELECT * FROM room_delegations WHERE id = ?').get(id) as Row | undefined) ?? null;

  function create(input: { groupId: string; sourceMessageId: number; from: GroupMemberRow; to: GroupMemberRow; task: string; originator: RoomOriginator; depth: number; chainId: string }): string {
    const id = crypto.randomUUID();
    const t = now();
    conn.prepare(`INSERT INTO room_delegations (id, group_id, source_message_id, from_member_id, to_member_id, task, originator_json, depth, chain_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(id, input.groupId, input.sourceMessageId, input.from.id, input.to.id, input.task.slice(0, 20_000), JSON.stringify(input.originator), input.depth, input.chainId, t, t);
    deps.publish(input.groupId, { type: 'handoff', data: { delegation: id } });
    return id;
  }

  /** 认领一行（从 `from` 状态），成功返回认领 id。 */
  function claim(id: string, from: DelegationStatus, to: DelegationStatus): string | null {
    const claimId = crypto.randomBytes(8).toString('hex');
    const t = now();
    const ok = conn.prepare(`UPDATE room_delegations SET status = ?, claim_id = ?, claim_until = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = ? AND (claim_id IS NULL OR claim_until < ?)`).run(to, claimId, t + DELEGATION_LEASE_MS, t, id, from, t).changes === 1;
    return ok ? claimId : null;
  }

  function ack(id: string, claimId: string, next: DelegationStatus): boolean {
    return conn.prepare('UPDATE room_delegations SET status = ?, claim_id = NULL, claim_until = 0, updated_at = ? WHERE id = ? AND claim_id = ?').run(next, now(), id, claimId).changes === 1;
  }

  function release(id: string, claimId: string, back: DelegationStatus, error: string): void {
    conn.prepare('UPDATE room_delegations SET status = ?, claim_id = NULL, claim_until = 0, last_error = ?, updated_at = ? WHERE id = ? AND claim_id = ?').run(back, error, now(), id, claimId);
  }

  function member(groupId: string, memberId: string) {
    return deps.members(groupId).find((row) => row.id === memberId) ?? null;
  }

  function dispatchTask(row: Row): void {
    const claimId = claim(row.id, 'queued', 'dispatching');
    if (!claimId) return;
    const to = member(row.group_id, row.to_member_id);
    const from = member(row.group_id, row.from_member_id);
    if (!to || !from) {
      ack(row.id, claimId, 'failed');
      return;
    }
    const queued = deps.orchestrator().enqueueDelegationTurn({
      groupId: row.group_id, memberId: to.id, kind: 'delegation_task', triggerMessageId: row.source_message_id,
      text: row.task, senderName: from.display_name, depth: row.depth, chainId: row.chain_id, originator: parseOriginator(row.originator_json), delegationId: row.id,
    });
    if (!queued) {
      release(row.id, claimId, 'queued', 'target Agent is not connected');
      return;
    }
    ack(row.id, claimId, 'running');
  }

  function deliverResult(row: Row): void {
    const claimId = claim(row.id, 'result_pending', 'result_delivering');
    if (!claimId) return;
    const from = member(row.group_id, row.from_member_id);
    const to = member(row.group_id, row.to_member_id);
    if (!from) {
      ack(row.id, claimId, 'failed');
      return;
    }
    const text = row.result_ok === 1
      ? deps.resultText(row.result_message_id)
      : `（${to?.display_name ?? row.to_member_id} 没有完成这项后台任务：${row.last_error ?? 'unknown'}）\n原任务：${row.task}`;
    const queued = deps.orchestrator().enqueueDelegationTurn({
      groupId: row.group_id, memberId: from.id, kind: 'delegation_result', triggerMessageId: row.result_message_id ?? row.source_message_id,
      text, senderName: to?.display_name ?? '', depth: row.depth, chainId: row.chain_id, originator: parseOriginator(row.originator_json), delegationId: row.id,
    });
    if (!queued) {
      release(row.id, claimId, 'result_pending', 'delegating Agent is not connected');
      return;
    }
    ack(row.id, claimId, 'completed');
    deps.publish(row.group_id, { type: 'handoff', data: { delegation: row.id } });
  }

  /** 委派给 B 的那一跳结束（编排器回调）。交还给 A 的那一跳结束时什么都不做（它已经 completed）。 */
  function onTaskFinished(delegationId: string, result: MemberTurnResult): void {
    const row = get(delegationId);
    if (!row || row.status !== 'running') return;
    conn.prepare("UPDATE room_delegations SET status = 'result_pending', result_message_id = ?, result_ok = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(result.messageId, result.status === 'completed' ? 1 : 0, result.status === 'completed' ? null : (result.error ?? result.status), now(), delegationId);
    deliverResult(get(delegationId)!);
  }

  function tick(): number {
    const rows = conn.prepare("SELECT * FROM room_delegations WHERE status IN ('queued', 'result_pending') AND (claim_id IS NULL OR claim_until < ?) ORDER BY created_at ASC LIMIT 20").all(now()) as Row[];
    for (const row of rows) {
      try {
        if (row.status === 'queued') dispatchTask(row);
        else deliverResult(row);
      } catch (error) {
        log(`[RoomDelegation] ${row.id} failed: ${(error as Error)?.message}`);
      }
    }
    return rows.length;
  }

  /** 重启恢复：认领过期的释放回去；交给 B 之后没结束的按失败交还给 A。 */
  function recoverOnBoot(): void {
    const t = now();
    conn.prepare("UPDATE room_delegations SET status = 'queued', claim_id = NULL, claim_until = 0 WHERE status = 'dispatching'").run();
    conn.prepare("UPDATE room_delegations SET status = 'result_pending', claim_id = NULL, claim_until = 0 WHERE status = 'result_delivering'").run();
    conn.prepare("UPDATE room_delegations SET status = 'result_pending', result_ok = 0, last_error = 'interrupted by restart', updated_at = ? WHERE status = 'running'").run(t);
  }

  function list(groupId: string) {
    return (conn.prepare('SELECT * FROM room_delegations WHERE group_id = ? ORDER BY created_at DESC LIMIT 50').all(groupId) as Row[]).map((row) => ({
      id: row.id, sourceMessageId: row.source_message_id, fromMemberId: row.from_member_id, toMemberId: row.to_member_id, task: row.task,
      status: row.status, resultMessageId: row.result_message_id, lastError: row.last_error,
    }));
  }

  function deleteForGroup(groupId: string): void {
    conn.prepare('DELETE FROM room_delegations WHERE group_id = ?').run(groupId);
  }

  return {
    create, tick, onTaskFinished, recoverOnBoot, list, deleteForGroup, get,
    start() {
      recoverOnBoot();
      if (timer) return;
      timer = setInterval(() => tick(), DELEGATION_TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type RoomDelegation = ReturnType<typeof createRoomDelegation>;
