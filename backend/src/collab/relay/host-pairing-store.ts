/**
 * host 侧的配对请求与 connector（spec 02 F19 的配对生命周期）。
 *
 * 配对请求：`draft → pending → approved → connecting → consumed`，或 `rejected | expired | failed`。
 * 请求 10 分钟有效；批准后票据 2 分钟有效、一次性（approved → connecting 的原子认领）；审计行 7 天后清掉。
 *
 * 两把秘密分开用：**请求密钥**只用于 target 的 submit / status / failure；**配对票据**只用于 WebSocket 首次接入。
 * 两者、以及 connector 的长期凭据，库里都只存 SHA-256，比较常数时间。
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';

import { applyRoomSchema } from '../rooms';
import { parseDescriptor, RelayProtocolError, type RelayDescriptor } from './protocol';

export const PAIRING_REQUEST_TTL_MS = 10 * 60_000;
export const PAIRING_TICKET_TTL_MS = 2 * 60_000;
export const PAIRING_AUDIT_RETENTION_MS = 7 * 24 * 3600_000;
export const PAIRING_RECENT_LIMIT = 5;

export type PairingStatus = 'draft' | 'pending' | 'approved' | 'connecting' | 'consumed' | 'rejected' | 'expired' | 'failed';

export type PairingRequester = { kind: 'user'; userId: number | null; name: string } | { kind: 'guest'; guestId: string; name: string };

export type PairingRow = {
  request_id: string;
  group_id: string;
  requester_kind: 'user' | 'guest';
  requester_user_id: number | null;
  requester_guest_id: string | null;
  requester_name: string;
  secret_hash: string;
  ticket_hash: string;
  status: PairingStatus;
  descriptor_json: string | null;
  target_origin: string | null;
  member_id: string | null;
  connector_id: string | null;
  failure_reason: string | null;
  decided_by: number | null;
  created_at: number;
  expires_at: number;
  ticket_expires_at: number | null;
  host_base_url: string;
};

export type ConnectorRow = {
  id: string;
  group_id: string;
  member_id: string;
  credential_hash: string;
  owner_kind: 'user' | 'guest';
  owner_user_id: number | null;
  owner_guest_id: string | null;
  target_origin: string;
  descriptor_json: string;
  status: 'active' | 'revoked';
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  revoke_reason: string | null;
  host_base_url: string;
};

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashEquals(hash: string, value: string): boolean {
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(sha256Hex(value), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const secret = () => crypto.randomBytes(32).toString('base64url');

export function createHostPairingStore(conn: Database.Database, now: () => number = Date.now) {
  applyRoomSchema(conn);

  const get = (requestId: string) => (conn.prepare('SELECT * FROM room_relay_pairings WHERE request_id = ?').get(requestId) as PairingRow | undefined) ?? null;

  function expireStale(): void {
    const t = now();
    conn.prepare("UPDATE room_relay_pairings SET status = 'expired', updated_at = ? WHERE status IN ('draft', 'pending') AND expires_at < ?").run(t, t);
    conn.prepare("UPDATE room_relay_pairings SET status = 'expired', updated_at = ? WHERE status = 'approved' AND ticket_expires_at < ?").run(t, t);
    conn.prepare("DELETE FROM room_relay_pairings WHERE status IN ('consumed', 'rejected', 'expired', 'failed') AND updated_at < ?").run(t - PAIRING_AUDIT_RETENTION_MS);
  }

  function requesterWhere(requester: PairingRequester): { sql: string; params: unknown[] } {
    return requester.kind === 'user'
      ? { sql: "requester_kind = 'user' AND requester_user_id IS ?", params: [requester.userId] }
      : { sql: "requester_kind = 'guest' AND requester_guest_id = ?", params: [requester.guestId] };
  }

  /** 这个人在这个群里已经接进来的远程 Agent 数（有效 connector）+ 还在路上的请求数。 */
  function activeCount(groupId: string, requester: PairingRequester): number {
    const ownerSql = requester.kind === 'user' ? "owner_kind = 'user' AND owner_user_id IS ?" : "owner_kind = 'guest' AND owner_guest_id = ?";
    const owner = requester.kind === 'user' ? requester.userId : requester.guestId;
    const connectors = (conn.prepare(`SELECT COUNT(*) AS n FROM room_relay_connectors WHERE group_id = ? AND status = 'active' AND ${ownerSql}`).get(groupId, owner) as { n: number }).n;
    const where = requesterWhere(requester);
    const inFlight = (conn.prepare(`SELECT COUNT(*) AS n FROM room_relay_pairings WHERE group_id = ? AND status IN ('pending', 'approved', 'connecting') AND ${where.sql}`).get(groupId, ...where.params) as { n: number }).n;
    return connectors + inFlight;
  }

  function createRequest(input: { groupId: string; requester: PairingRequester; maxAgents: number; hostBaseUrl: string }): { requestId: string; secret: string; ticket: string; expiresAt: number } {
    expireStale();
    if (activeCount(input.groupId, input.requester) >= input.maxAgents) throw new RelayProtocolError('relay.guestAgentLimit');
    const where = requesterWhere(input.requester);
    const recent = (conn.prepare(`SELECT COUNT(*) AS n FROM room_relay_pairings WHERE group_id = ? AND created_at > ? AND ${where.sql}`).get(input.groupId, now() - PAIRING_REQUEST_TTL_MS, ...where.params) as { n: number }).n;
    if (recent >= PAIRING_RECENT_LIMIT) throw new RelayProtocolError('relay.pairingRateLimited');
    const requestId = crypto.randomUUID();
    const requestSecret = secret();
    const ticket = secret();
    const t = now();
    conn.prepare(`INSERT INTO room_relay_pairings (request_id, group_id, requester_kind, requester_user_id, requester_guest_id, requester_name, secret_hash, ticket_hash,
      status, created_at, expires_at, updated_at, host_base_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`).run(
      requestId, input.groupId, input.requester.kind, input.requester.kind === 'user' ? input.requester.userId : null,
      input.requester.kind === 'guest' ? input.requester.guestId : null, input.requester.name.slice(0, 120),
      sha256Hex(requestSecret), sha256Hex(ticket), t, t + PAIRING_REQUEST_TTL_MS, t, input.hostBaseUrl,
    );
    return { requestId, secret: requestSecret, ticket, expiresAt: t + PAIRING_REQUEST_TTL_MS };
  }

  function requireBySecret(requestId: string, requestSecret: string): PairingRow {
    expireStale();
    const row = get(requestId);
    if (!row || !requestSecret || !hashEquals(row.secret_hash, requestSecret)) throw new RelayProtocolError('relay.pairingNotFound');
    return row;
  }

  function submit(requestId: string, requestSecret: string, input: { targetOrigin: unknown; descriptor: unknown }, nameTaken: (groupId: string, name: string) => boolean): PairingRow {
    const row = requireBySecret(requestId, requestSecret);
    if (row.status !== 'draft') throw new RelayProtocolError('relay.pairingState', row.status);
    const descriptor = parseDescriptor(input.descriptor);
    const origin = typeof input.targetOrigin === 'string' ? input.targetOrigin.trim().slice(0, 500) : '';
    if (!/^https?:\/\/[^\s/]+$/.test(origin)) throw new RelayProtocolError('relay.originInvalid');
    if (nameTaken(row.group_id, descriptor.name)) throw new RelayProtocolError('relay.nameConflict');
    conn.prepare("UPDATE room_relay_pairings SET status = 'pending', descriptor_json = ?, target_origin = ?, updated_at = ? WHERE request_id = ? AND status = 'draft'")
      .run(JSON.stringify(descriptor), origin, now(), requestId);
    return get(requestId)!;
  }

  function status(requestId: string, requestSecret: string) {
    const row = requireBySecret(requestId, requestSecret);
    return { status: row.status, reason: row.failure_reason, ticketExpiresAt: row.ticket_expires_at, roomId: row.group_id };
  }

  function fail(requestId: string, requestSecret: string, reason: string): void {
    requireBySecret(requestId, requestSecret);
    conn.prepare("UPDATE room_relay_pairings SET status = 'failed', failure_reason = ?, updated_at = ? WHERE request_id = ? AND status IN ('draft', 'pending', 'approved', 'connecting')")
      .run(reason.replace(/[\r\n]+/g, ' ').slice(0, 240), now(), requestId);
  }

  function decide(groupId: string, requestId: string, approve: boolean, decidedBy: number | null, nameTaken: (groupId: string, name: string) => boolean): PairingRow {
    expireStale();
    const row = get(requestId);
    if (!row || row.group_id !== groupId) throw new RelayProtocolError('relay.pairingNotFound');
    if (row.status !== 'pending') throw new RelayProtocolError('relay.pairingState', row.status);
    if (approve) {
      const descriptor = parseDescriptor(JSON.parse(row.descriptor_json ?? 'null'));
      if (nameTaken(groupId, descriptor.name)) throw new RelayProtocolError('relay.nameConflict');
      const t = now();
      conn.prepare("UPDATE room_relay_pairings SET status = 'approved', decided_by = ?, ticket_expires_at = ?, updated_at = ? WHERE request_id = ? AND status = 'pending'")
        .run(decidedBy, t + PAIRING_TICKET_TTL_MS, t, requestId);
    } else {
      conn.prepare("UPDATE room_relay_pairings SET status = 'rejected', decided_by = ?, updated_at = ? WHERE request_id = ? AND status = 'pending'").run(decidedBy, now(), requestId);
    }
    return get(requestId)!;
  }

  /** WebSocket 首次接入：票据对、未过期、来源一致 → approved → connecting（原子，一次性）。 */
  function claimTicket(requestId: string, ticket: string, origin: string): PairingRow {
    expireStale();
    const row = get(requestId);
    if (!row || !ticket || !hashEquals(row.ticket_hash, ticket) || row.status !== 'approved' || row.target_origin !== origin) {
      throw new RelayProtocolError('relay.pairingTicketInvalid');
    }
    const claimed = conn.prepare("UPDATE room_relay_pairings SET status = 'connecting', updated_at = ? WHERE request_id = ? AND status = 'approved' AND ticket_expires_at >= ?")
      .run(now(), requestId, now()).changes === 1;
    if (!claimed) throw new RelayProtocolError('relay.pairingTicketInvalid');
    return get(requestId)!;
  }

  function releaseTicket(requestId: string, reason: string): void {
    conn.prepare("UPDATE room_relay_pairings SET status = 'failed', failure_reason = ?, updated_at = ? WHERE request_id = ? AND status = 'connecting'").run(reason.slice(0, 240), now(), requestId);
  }

  function completePairing(requestId: string, memberId: string, connectorId: string): void {
    conn.prepare("UPDATE room_relay_pairings SET status = 'consumed', member_id = ?, connector_id = ?, updated_at = ? WHERE request_id = ? AND status = 'connecting'").run(memberId, connectorId, now(), requestId);
  }

  function listPending(groupId: string) {
    expireStale();
    return (conn.prepare("SELECT * FROM room_relay_pairings WHERE group_id = ? AND status IN ('draft', 'pending', 'approved', 'connecting') ORDER BY created_at ASC").all(groupId) as PairingRow[]).map((row) => ({
      requestId: row.request_id,
      status: row.status,
      requesterKind: row.requester_kind,
      requesterName: row.requester_name,
      requesterUserId: row.requester_user_id,
      requesterGuestId: row.requester_guest_id,
      targetOrigin: row.target_origin,
      descriptor: row.descriptor_json ? JSON.parse(row.descriptor_json) as RelayDescriptor : null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  function createConnector(input: { groupId: string; memberId: string; owner: PairingRequester; targetOrigin: string; descriptor: RelayDescriptor; hostBaseUrl: string }): { id: string; credential: string } {
    const id = crypto.randomUUID();
    const credential = secret();
    conn.prepare(`INSERT INTO room_relay_connectors (id, group_id, member_id, credential_hash, owner_kind, owner_user_id, owner_guest_id, target_origin, descriptor_json, status, created_at, host_base_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
      id, input.groupId, input.memberId, sha256Hex(credential), input.owner.kind, input.owner.kind === 'user' ? input.owner.userId : null,
      input.owner.kind === 'guest' ? input.owner.guestId : null, input.targetOrigin, JSON.stringify(input.descriptor), now(), input.hostBaseUrl,
    );
    return { id, credential };
  }

  const getConnector = (id: string) => (conn.prepare('SELECT * FROM room_relay_connectors WHERE id = ?').get(id) as ConnectorRow | undefined) ?? null;

  /** 重连：凭据哈希常数时间比较、来源一致、未吊销。 */
  function verifyConnector(id: string, credential: string, origin: string): ConnectorRow {
    const row = getConnector(id);
    if (!row || !credential || !hashEquals(row.credential_hash, credential)) throw new RelayProtocolError('relay.credentialInvalid');
    if (row.status !== 'active') throw new RelayProtocolError('relay.credentialInvalid', 'connector revoked');
    if (row.target_origin !== origin) throw new RelayProtocolError('relay.credentialInvalid', 'origin mismatch');
    return row;
  }

  function markSeen(id: string): void {
    conn.prepare('UPDATE room_relay_connectors SET last_seen_at = ? WHERE id = ?').run(now(), id);
  }

  function revokeConnector(id: string, reason: string): ConnectorRow | null {
    conn.prepare("UPDATE room_relay_connectors SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE id = ? AND status = 'active'").run(now(), reason.slice(0, 200), id);
    return getConnector(id);
  }

  function listConnectors(groupId: string): ConnectorRow[] {
    return conn.prepare('SELECT * FROM room_relay_connectors WHERE group_id = ? ORDER BY created_at ASC').all(groupId) as ConnectorRow[];
  }

  function deleteForGroup(groupId: string): void {
    conn.prepare('DELETE FROM room_relay_pairings WHERE group_id = ?').run(groupId);
    conn.prepare("UPDATE room_relay_connectors SET status = 'revoked', revoked_at = ?, revoke_reason = 'room deleted' WHERE group_id = ? AND status = 'active'").run(now(), groupId);
  }

  return {
    get, createRequest, submit, status, fail, decide, claimTicket, releaseTicket, completePairing, listPending, createConnector,
    getConnector, verifyConnector, markSeen, revokeConnector, listConnectors, deleteForGroup, activeCount,
  };
}

export type HostPairingStore = ReturnType<typeof createHostPairingStore>;
