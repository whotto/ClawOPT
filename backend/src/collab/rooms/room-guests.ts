/**
 * 邀请码访客（spec 02 F9 访客页；plan §5 P3 task 10）。
 *
 * - 管理员 / 房间归属人签发邀请码（16 位、32 字符表），轮换或吊销时 `invite_generation` +1，旧码的访客令牌随之全部失效。
 * - 访客凭邀请码 + 名字 + 头像加入，拿到一枚 **访客令牌**（32 字节随机，只存 SHA-256；只返回一次，前端存 localStorage）。
 * - 访客令牌只在「这个群 + 签发时的邀请代」里有效；吊销单个访客、轮换 / 吊销邀请码、删群都让它失效。
 * - 访客能：看消息、发消息（@ Agent；叫起判定按签发邀请码的人的授权——委托）、上传附件、配对自己的远程 Agent、答复自己 Agent 的审批。
 * - 访客不能：管理房间、审批别人的 Agent、澄清、@all、继续交接链、看工作区。
 * - 名字不能与群里的 Agent 同名（防冒名 @），不能与另一个在册访客同名；加入有房间级速率与人数上限。
 */
import crypto from 'crypto';

import type Database from 'better-sqlite3';

import type { RoomActor, RoomPolicy, RoomPolicyStore } from './room-policy';

export const GUEST_TOKEN_HEADER = 'x-clawopt-guest-token';
export const GUEST_NAME_MAX = 40;
export const GUEST_AVATAR_MAX = 16;
export const GUESTS_PER_ROOM_LIMIT = 50;
export const GUEST_JOINS_PER_MINUTE = 20;

export class GuestError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

type GuestRow = {
  id: string;
  group_id: string;
  name: string;
  avatar: string | null;
  token_hash: string;
  invite_generation: number;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
};

export type RoomGuestView = { id: string; name: string; avatar: string | null; createdAt: number; lastSeenAt: number };

export type AuthenticatedGuest = { guest: RoomGuestView; policy: RoomPolicy; actor: Extract<RoomActor, { kind: 'guest' }> };

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

function normalizeName(value: unknown): string {
  // 去掉控制字符与 @（名字里带 @ 会与 @ 协议混淆）；折叠空白。
  const text = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f@]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!text || [...text].length > GUEST_NAME_MAX) throw new GuestError(400, 'share.nameInvalid');
  return text;
}

function normalizeAvatar(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f<>"'`]/g, '').trim() : '';
  if (!text || [...text].length > GUEST_AVATAR_MAX) throw new GuestError(400, 'share.avatarInvalid');
  return text;
}

const view = (row: GuestRow): RoomGuestView => ({ id: row.id, name: row.name, avatar: row.avatar, createdAt: row.created_at, lastSeenAt: row.last_seen_at });

export function createRoomGuests(deps: {
  conn: Database.Database;
  policies: Pick<RoomPolicyStore, 'get' | 'findByInviteCode'>;
  /** 群里 Agent 的显示名（防冒名）。 */
  agentNames: (groupId: string) => string[];
  now?: () => number;
}) {
  const { conn, policies } = deps;
  const now = deps.now ?? Date.now;

  function requireInvite(code: string): RoomPolicy {
    const policy = policies.findByInviteCode(code);
    if (!policy || !policy.inviteCode) throw new GuestError(404, 'share.inviteNotFound');
    return policy;
  }

  function activeRows(groupId: string, generation: number): GuestRow[] {
    return conn.prepare('SELECT * FROM room_guests WHERE group_id = ? AND invite_generation = ? AND revoked_at IS NULL ORDER BY created_at').all(groupId, generation) as GuestRow[];
  }

  function join(code: string, input: { name: unknown; avatar?: unknown }): { guest: RoomGuestView; token: string; groupId: string } {
    const policy = requireInvite(code);
    const name = normalizeName(input.name);
    const avatar = normalizeAvatar(input.avatar);
    const lower = name.toLocaleLowerCase();
    if (deps.agentNames(policy.groupId).some((agent) => agent.trim().toLocaleLowerCase() === lower)) throw new GuestError(409, 'share.nameConflict');
    return conn.transaction(() => {
      const active = activeRows(policy.groupId, policy.inviteGeneration);
      if (active.some((row) => row.name.toLocaleLowerCase() === lower)) throw new GuestError(409, 'share.nameConflict');
      if (active.length >= GUESTS_PER_ROOM_LIMIT) throw new GuestError(429, 'share.roomFull');
      const recent = (conn.prepare('SELECT COUNT(*) AS n FROM room_guests WHERE group_id = ? AND created_at > ?').get(policy.groupId, now() - 60_000) as { n: number }).n;
      if (recent >= GUEST_JOINS_PER_MINUTE) throw new GuestError(429, 'share.joinRateLimited');
      const token = crypto.randomBytes(32).toString('base64url');
      const row: GuestRow = {
        id: `guest_${crypto.randomUUID()}`, group_id: policy.groupId, name, avatar, token_hash: hashToken(token),
        invite_generation: policy.inviteGeneration, created_at: now(), last_seen_at: now(), revoked_at: null,
      };
      conn.prepare(`INSERT INTO room_guests (id, group_id, name, avatar, token_hash, invite_generation, created_at, last_seen_at, revoked_at)
        VALUES (@id, @group_id, @name, @avatar, @token_hash, @invite_generation, @created_at, @last_seen_at, @revoked_at)`).run(row);
      return { guest: view(row), token, groupId: policy.groupId };
    }).immediate();
  }

  /**
   * 认访客：邀请码仍有效 + 令牌哈希命中 + 同一个群 + 同一个邀请代 + 没被吊销。
   * 任一不符都按「不存在」处理（401），不区分原因，免得给探测者信号。
   */
  function authenticate(code: string, token: string): AuthenticatedGuest {
    const policy = policies.findByInviteCode(code);
    if (!policy || !policy.inviteCode || typeof token !== 'string' || token.length < 20 || token.length > 200) throw new GuestError(401, 'share.guestUnauthorized');
    const row = conn.prepare('SELECT * FROM room_guests WHERE token_hash = ?').get(hashToken(token)) as GuestRow | undefined;
    if (!row || row.group_id !== policy.groupId || row.invite_generation !== policy.inviteGeneration || row.revoked_at !== null) {
      throw new GuestError(401, 'share.guestUnauthorized');
    }
    if (now() - row.last_seen_at > 60_000) conn.prepare('UPDATE room_guests SET last_seen_at = ? WHERE id = ?').run(now(), row.id);
    return { guest: view(row), policy, actor: { kind: 'guest', guestId: row.id, name: row.name, groupId: row.group_id } };
  }

  function list(groupId: string): RoomGuestView[] {
    const policy = policies.get(groupId);
    if (!policy) return [];
    return activeRows(groupId, policy.inviteGeneration).map(view);
  }

  function get(guestId: string): GuestRow | null {
    return (conn.prepare('SELECT * FROM room_guests WHERE id = ?').get(guestId) as GuestRow | undefined) ?? null;
  }

  function revoke(groupId: string, guestId: string): boolean {
    return conn.prepare('UPDATE room_guests SET revoked_at = ? WHERE id = ? AND group_id = ? AND revoked_at IS NULL').run(now(), guestId, groupId).changes > 0;
  }

  function deleteForGroup(groupId: string): void {
    conn.prepare('DELETE FROM room_guests WHERE group_id = ?').run(groupId);
  }

  return { join, authenticate, list, get, revoke, deleteForGroup, requireInvite };
}

export type RoomGuests = ReturnType<typeof createRoomGuests>;
