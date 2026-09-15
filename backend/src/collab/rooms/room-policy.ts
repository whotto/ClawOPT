/**
 * 房间策略与身份：P3 新增的房间列（归属人、交接、摘要、超时、访客 / 远程 Agent、邀请码）的读写，
 * 以及「谁是管理员 / 归属人 / 能不能 @all / 这个 Agent 的主人是谁」的判定。
 *
 * 判定只在这里写一次：HTTP 路由、编排器、审批路由、访客页、relay 配对都从这里取。
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';

import { applyRoomSchema } from './room-schema';

export const HANDOFF_DEFAULT_MAX_DEPTH = 4;
export const HANDOFF_MAX_DEPTH_LIMIT = 100;
export const SUMMARY_EVERY_TURNS_DEFAULT = 20;
export const RUN_IDLE_TIMEOUT_DEFAULT_SEC = 600;
export const RUN_TOTAL_BUDGET_DEFAULT_SEC = 3600;

export type HandoffPolicy = {
  enabled: boolean;
  unlimited: boolean;
  /** 1–100；`unlimited` 时仍保留数值（界面切回有限时恢复）。 */
  maxDepth: number;
};

export type RoomPolicy = {
  groupId: string;
  ownerUserId: number | null;
  handoff: HandoffPolicy;
  summaryModel: string;
  summaryEveryTurns: number;
  summaryGeneration: number;
  sessionSeed: string;
  runIdleTimeoutSec: number;
  runTotalBudgetSec: number;
  allowGuestAgents: boolean;
  maxGuestAgentsPerMember: number;
  allowRemoteWorkspace: boolean;
  inviteCode: string | null;
  inviteCreatedBy: number | null;
  inviteGeneration: number;
};

export type RoomPolicyPatch = Partial<{
  handoffEnabled: boolean;
  handoffUnlimited: boolean;
  handoffMaxDepth: number;
  summaryModel: string;
  summaryEveryTurns: number;
  runIdleTimeoutSec: number;
  runTotalBudgetSec: number;
  allowGuestAgents: boolean;
  maxGuestAgentsPerMember: number;
  allowRemoteWorkspace: boolean;
}>;

/** 发起人（沿交接链传播；每一跳叫起前按它判授权）。 */
export type RoomOriginator =
  | { kind: 'user'; userId: number | null; username: string | null; implicit: boolean }
  | { kind: 'guest'; guestId: string; name: string; delegatedUserId: number | null; delegatedImplicit: boolean }
  | { kind: 'system' };

/** 房间里的一个人类操作者（HTTP 登录用户或邀请码访客）。 */
export type RoomActor =
  | { kind: 'user'; userId: number | null; username: string | null; role: 'super_admin' | 'admin' | 'member'; implicit: boolean }
  | { kind: 'guest'; guestId: string; name: string; groupId: string };

type PolicyRow = {
  id: string;
  owner_user_id: number | null;
  max_chain_depth: number | null;
  handoff_enabled: number;
  handoff_unlimited: number;
  summary_model: string;
  summary_every_turns: number;
  summary_generation: number;
  session_seed: string;
  run_idle_timeout_sec: number;
  run_total_budget_sec: number;
  allow_guest_agents: number;
  max_guest_agents_per_member: number;
  allow_remote_workspace: number;
  invite_code: string | null;
  invite_created_by: number | null;
  invite_generation: number;
};

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 16 位邀请码：32 个字符的字母表（去掉 0/O/1/I），每位 5 bit，取自随机字节，均匀无偏。 */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateInviteCode(random: (size: number) => Buffer = crypto.randomBytes): string {
  const bytes = random(10); // 80 bit = 16 × 5
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 16) {
      out += INVITE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function isInviteCodeShape(value: unknown): value is string {
  return typeof value === 'string' && /^[A-HJ-NP-Z2-9]{16}$/.test(value);
}

export function createRoomPolicyStore(conn: Database.Database) {
  applyRoomSchema(conn);

  const selectRow = conn.prepare(`SELECT id, owner_user_id, max_chain_depth, handoff_enabled, handoff_unlimited, summary_model,
    summary_every_turns, summary_generation, session_seed, run_idle_timeout_sec, run_total_budget_sec, allow_guest_agents,
    max_guest_agents_per_member, allow_remote_workspace, invite_code, invite_created_by, invite_generation
    FROM group_chats WHERE id = ?`);

  function toPolicy(row: PolicyRow): RoomPolicy {
    return {
      groupId: row.id,
      ownerUserId: row.owner_user_id ?? null,
      handoff: {
        enabled: row.handoff_enabled !== 0,
        unlimited: row.handoff_unlimited !== 0,
        maxDepth: clampInt(row.max_chain_depth, 1, HANDOFF_MAX_DEPTH_LIMIT, HANDOFF_DEFAULT_MAX_DEPTH),
      },
      summaryModel: row.summary_model ?? '',
      summaryEveryTurns: clampInt(row.summary_every_turns, 1, 1000, SUMMARY_EVERY_TURNS_DEFAULT),
      summaryGeneration: row.summary_generation ?? 0,
      sessionSeed: row.session_seed ?? '',
      runIdleTimeoutSec: clampInt(row.run_idle_timeout_sec, 30, 24 * 3600, RUN_IDLE_TIMEOUT_DEFAULT_SEC),
      runTotalBudgetSec: clampInt(row.run_total_budget_sec, 60, 7 * 24 * 3600, RUN_TOTAL_BUDGET_DEFAULT_SEC),
      allowGuestAgents: row.allow_guest_agents !== 0,
      maxGuestAgentsPerMember: clampInt(row.max_guest_agents_per_member, 1, 5, 1),
      allowRemoteWorkspace: row.allow_guest_agents !== 0 && row.allow_remote_workspace !== 0,
      inviteCode: row.invite_code ?? null,
      inviteCreatedBy: row.invite_created_by ?? null,
      inviteGeneration: row.invite_generation ?? 0,
    };
  }

  function get(groupId: string): RoomPolicy | null {
    const row = selectRow.get(groupId) as PolicyRow | undefined;
    return row ? toPolicy(row) : null;
  }

  /**
   * 改策略。交接策略改动会让已有的停止卡片不可继续（可继续判据按当前策略重算）；
   * 摘要配置与交接策略的改动都推进 `summary_generation`（正在跑的摘要按 generation 隔离，提交会被拒）。
   */
  function update(groupId: string, patch: RoomPolicyPatch): RoomPolicy | null {
    const current = get(groupId);
    if (!current) return null;
    const next = {
      handoff_enabled: patch.handoffEnabled ?? current.handoff.enabled,
      handoff_unlimited: patch.handoffUnlimited ?? current.handoff.unlimited,
      max_chain_depth: patch.handoffMaxDepth === undefined ? current.handoff.maxDepth : clampInt(patch.handoffMaxDepth, 1, HANDOFF_MAX_DEPTH_LIMIT, current.handoff.maxDepth),
      summary_model: patch.summaryModel === undefined ? current.summaryModel : String(patch.summaryModel).trim().slice(0, 500),
      summary_every_turns: patch.summaryEveryTurns === undefined ? current.summaryEveryTurns : clampInt(patch.summaryEveryTurns, 1, 1000, current.summaryEveryTurns),
      run_idle_timeout_sec: patch.runIdleTimeoutSec === undefined ? current.runIdleTimeoutSec : clampInt(patch.runIdleTimeoutSec, 30, 24 * 3600, current.runIdleTimeoutSec),
      run_total_budget_sec: patch.runTotalBudgetSec === undefined ? current.runTotalBudgetSec : clampInt(patch.runTotalBudgetSec, 60, 7 * 24 * 3600, current.runTotalBudgetSec),
      allow_guest_agents: patch.allowGuestAgents ?? current.allowGuestAgents,
      max_guest_agents_per_member: patch.maxGuestAgentsPerMember === undefined ? current.maxGuestAgentsPerMember : clampInt(patch.maxGuestAgentsPerMember, 1, 5, current.maxGuestAgentsPerMember),
      allow_remote_workspace: patch.allowRemoteWorkspace ?? current.allowRemoteWorkspace,
    };
    const bumpGeneration = next.handoff_enabled !== current.handoff.enabled
      || next.handoff_unlimited !== current.handoff.unlimited
      || next.max_chain_depth !== current.handoff.maxDepth
      || next.summary_model !== current.summaryModel
      || next.summary_every_turns !== current.summaryEveryTurns;
    conn.prepare(`UPDATE group_chats SET handoff_enabled = ?, handoff_unlimited = ?, max_chain_depth = ?, summary_model = ?,
      summary_every_turns = ?, run_idle_timeout_sec = ?, run_total_budget_sec = ?, allow_guest_agents = ?,
      max_guest_agents_per_member = ?, allow_remote_workspace = ?, summary_generation = summary_generation + ?, updated_at = ?
      WHERE id = ?`).run(
      next.handoff_enabled ? 1 : 0, next.handoff_unlimited ? 1 : 0, next.max_chain_depth, next.summary_model,
      next.summary_every_turns, next.run_idle_timeout_sec, next.run_total_budget_sec, next.allow_guest_agents ? 1 : 0,
      next.max_guest_agents_per_member, next.allow_remote_workspace ? 1 : 0, bumpGeneration ? 1 : 0, new Date().toISOString(), groupId,
    );
    return get(groupId);
  }

  function setOwner(groupId: string, userId: number | null): void {
    conn.prepare('UPDATE group_chats SET owner_user_id = ? WHERE id = ?').run(userId, groupId);
  }

  function bumpSummaryGeneration(groupId: string): number {
    conn.prepare('UPDATE group_chats SET summary_generation = summary_generation + 1 WHERE id = ?').run(groupId);
    return get(groupId)?.summaryGeneration ?? 0;
  }

  /** 轮换会话种子（清空 / 换工作区）：确定性的会话键随之改变，旧运行被隔离。 */
  function rotateSessionSeed(groupId: string): string {
    const seed = crypto.randomBytes(12).toString('hex');
    conn.prepare('UPDATE group_chats SET session_seed = ? WHERE id = ?').run(seed, groupId);
    return seed;
  }

  function rotateInviteCode(groupId: string, createdBy: number | null): string {
    for (let i = 0; i < 5; i += 1) {
      const code = generateInviteCode();
      try {
        conn.prepare('UPDATE group_chats SET invite_code = ?, invite_created_by = ?, invite_generation = invite_generation + 1 WHERE id = ?').run(code, createdBy, groupId);
        return code;
      } catch (error) {
        if (!/UNIQUE/i.test(String((error as Error)?.message))) throw error;
      }
    }
    throw new Error('could not allocate a unique invite code');
  }

  function revokeInviteCode(groupId: string): void {
    conn.prepare('UPDATE group_chats SET invite_code = NULL, invite_generation = invite_generation + 1 WHERE id = ?').run(groupId);
  }

  function findByInviteCode(code: string): RoomPolicy | null {
    if (!isInviteCodeShape(code)) return null;
    const row = conn.prepare('SELECT id FROM group_chats WHERE invite_code = ?').get(code) as { id: string } | undefined;
    return row ? get(row.id) : null;
  }

  return { get, update, setOwner, bumpSummaryGeneration, rotateSessionSeed, rotateInviteCode, revokeInviteCode, findByInviteCode };
}

export type RoomPolicyStore = ReturnType<typeof createRoomPolicyStore>;

/** 交接允许不允许到这个深度（服务端签发的深度）。 */
export function handoffAllows(policy: HandoffPolicy, depth: number): boolean {
  if (!policy.enabled) return false;
  if (policy.unlimited) return true;
  return depth < policy.maxDepth;
}

/** 界面建议值：max(4, 在线 Agent 数 + 1)。 */
export function recommendedHandoffDepth(activeAgentCount: number): number {
  return Math.min(HANDOFF_MAX_DEPTH_LIMIT, Math.max(HANDOFF_DEFAULT_MAX_DEPTH, activeAgentCount + 1));
}

export function serializeOriginator(originator: RoomOriginator): string {
  return JSON.stringify(originator);
}

export function parseOriginator(value: string | null | undefined): RoomOriginator {
  if (!value) return { kind: 'system' };
  try {
    const parsed = JSON.parse(value) as RoomOriginator;
    if (parsed?.kind === 'user') {
      return { kind: 'user', userId: typeof parsed.userId === 'number' ? parsed.userId : null, username: typeof parsed.username === 'string' ? parsed.username : null, implicit: parsed.implicit === true };
    }
    if (parsed?.kind === 'guest' && typeof parsed.guestId === 'string') {
      return {
        kind: 'guest', guestId: parsed.guestId, name: String(parsed.name ?? ''),
        delegatedUserId: typeof parsed.delegatedUserId === 'number' ? parsed.delegatedUserId : null,
        delegatedImplicit: parsed.delegatedImplicit === true,
      };
    }
  } catch {
    // 坏 JSON 按系统处理：系统发起人不叫起任何人（见 originatorCanWake）。
  }
  return { kind: 'system' };
}

export function originatorFromActor(actor: RoomActor, policy: RoomPolicy | null): RoomOriginator {
  if (actor.kind === 'user') return { kind: 'user', userId: actor.userId, username: actor.username, implicit: actor.implicit };
  const delegatedUserId = policy?.inviteCreatedBy ?? null;
  return { kind: 'guest', guestId: actor.guestId, name: actor.name, delegatedUserId, delegatedImplicit: delegatedUserId === null };
}

export function originatorDisplayName(originator: RoomOriginator): string {
  if (originator.kind === 'user') return originator.username ?? '';
  if (originator.kind === 'guest') return originator.name;
  return '';
}

/** 发起人的稳定 id（非主人安全提示里「请求人」一栏）。 */
export function originatorId(originator: RoomOriginator): string {
  if (originator.kind === 'user') return originator.userId === null ? 'owner' : `user:${originator.userId}`;
  if (originator.kind === 'guest') return `guest:${originator.guestId}`;
  return 'system';
}
