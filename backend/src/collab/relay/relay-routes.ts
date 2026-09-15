/**
 * relay 的 HTTP 接口。
 *
 * host 侧（群所在的实例）：
 * - `POST /api/groups/:id/relay/pairings`：看得见群的人发起配对请求（房间要开「允许远程 Agent」；每人数量上限）→ 配对码（只返回一次）；
 * - `GET /api/groups/:id/relay/pairings`：管理员看全部待处理请求，其他人只看自己发起的；
 * - `POST /api/groups/:id/relay/pairings/:requestId/decision`：**房间归属人**批准 / 拒绝；
 * - `GET /api/groups/:id/relay/connectors`、`DELETE …/:connectorId`：管理员，或配对它的那个人吊销；
 * - 公开（`AUTH_PUBLIC_PATHS`，安全在处理器里）：`POST /api/relay/v1/pairings/:requestId/submit`、`GET …/status`、`POST …/failure`
 *   （请求密钥头 `x-clawopt-relay-secret`，SHA-256 常数时间比较）；远程工作区 `POST /api/room-relay/workspace/actions`、
 *   `GET|PUT /api/room-relay/workspace/file`（每跳令牌 Bearer）。
 *
 * target 侧（把本机 Agent 接出去的实例，管理员）：`GET|POST /api/relay/links`、`DELETE /api/relay/links/:id`、`POST /api/relay/links/:id/reconnect`。
 */
import type express from 'express';
import { raw as expressRaw } from 'express';

import { getRequestIdentity, type ResourceAccess, sendResourceForbidden } from '../../core/auth';
import type { DB } from '../../core/db';
import { buildStructuredApiError, type RouteApp } from '../../core/http';
import { WorkspacePathError, type RoomCollab } from '../rooms';
import type { HostPairingStore, PairingRequester } from './host-pairing-store';
import { encodePairingCode, RELAY_HEADERS, RelayProtocolError } from './protocol';
import type { RelayHost } from './relay-host';
import { RelayTargetError, type RelayTarget } from './relay-target';

const WORKSPACE_BINARY_LIMIT = 20 * 1024 * 1024;
const binaryBody = expressRaw({ type: () => true, limit: WORKSPACE_BINARY_LIMIT + 1 });

export type RelayRoutesDeps = {
  db: Pick<DB, 'getGroupChat'>;
  access: ResourceAccess;
  roomCollab: RoomCollab;
  relay: { host: RelayHost; pairings: HostPairingStore; target: RelayTarget };
  auth: { requireAdminAuth: express.RequestHandler };
};

/** 请求方看到的本实例根地址（配对码里给 target 用，远程工作区令牌接口也按它拼）。 */
export function requestOrigin(req: express.Request): string {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : req.protocol;
  return `${proto}://${req.get('host')}`;
}

function sendRelayError(res: express.Response, error: unknown): void {
  if (error instanceof RelayProtocolError) {
    const status = ['relay.pairingNotFound'].includes(error.code) ? 404 : ['relay.guestAgentLimit', 'relay.pairingRateLimited'].includes(error.code) ? 429 : error.code === 'relay.descriptorInvalid' || error.code === 'relay.originInvalid' ? 400 : 409;
    res.status(status).json(buildStructuredApiError(error.code, error.message));
    return;
  }
  if (error instanceof RelayTargetError) {
    res.status(error.status).json(buildStructuredApiError(error.code, error.message));
    return;
  }
  if (error instanceof WorkspacePathError) {
    res.status(error.status).json(buildStructuredApiError(error.code, error.message));
    return;
  }
  res.status(500).json({ success: false, error: (error as Error)?.message });
}

export function registerRelayRoutes(app: RouteApp, ctx: RelayRoutesDeps): void {
  const guardRoom: express.RequestHandler = (req, res, next) => (
    ctx.access.canAccessRoom(getRequestIdentity(req), String(req.params.id ?? '')) ? next() : sendResourceForbidden(res)
  );
  const secretOf = (req: express.Request) => String(req.headers[RELAY_HEADERS.secret] ?? '');

  // ---------------------------------------------------------------- host：配对（登录用户）

  app.post('/api/groups/:id/relay/pairings', guardRoom, (req, res) => {
    try {
      const collab = ctx.roomCollab;
      const policy = collab.policies.get(req.params.id);
      if (!policy) return res.status(404).json(buildStructuredApiError('groups.notFound'));
      if (!policy.allowGuestAgents) return res.status(403).json(buildStructuredApiError('relay.guestAgentsDisabled'));
      const identity = getRequestIdentity(req);
      const requester: PairingRequester = { kind: 'user', userId: identity.userId, name: identity.username ?? '' };
      const hostUrl = requestOrigin(req);
      const created = ctx.relay.pairings.createRequest({ groupId: req.params.id, requester, maxAgents: policy.maxGuestAgentsPerMember, hostBaseUrl: hostUrl });
      const roomName = ctx.db.getGroupChat(req.params.id)?.name ?? req.params.id;
      res.json({
        success: true,
        requestId: created.requestId,
        expiresAt: created.expiresAt,
        pairingCode: encodePairingCode({ hostUrl, requestId: created.requestId, secret: created.secret, ticket: created.ticket, roomName }),
      });
    } catch (error) {
      sendRelayError(res, error);
    }
  });

  app.get('/api/groups/:id/relay/pairings', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    const all = ctx.relay.pairings.listPending(req.params.id);
    const manager = ctx.roomCollab.roomAccess.isManager(identity, req.params.id);
    res.json({
      success: true,
      canDecide: ctx.roomCollab.roomAccess.isOwner(identity, req.params.id),
      pairings: manager ? all : all.filter((item) => item.requesterKind === 'user' && item.requesterUserId === identity.userId),
    });
  });

  app.post('/api/groups/:id/relay/pairings/:requestId/decision', guardRoom, (req, res) => {
    try {
      const identity = getRequestIdentity(req);
      if (!ctx.roomCollab.roomAccess.isOwner(identity, req.params.id)) return sendResourceForbidden(res);
      const row = ctx.relay.pairings.decide(req.params.id, req.params.requestId, req.body?.approve === true, identity.userId, ctx.relay.host.nameTaken);
      ctx.roomCollab.publish(req.params.id, { type: 'pairing', data: { changed: true } });
      res.json({ success: true, status: row.status });
    } catch (error) {
      sendRelayError(res, error);
    }
  });

  app.get('/api/groups/:id/relay/connectors', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    const manager = ctx.roomCollab.roomAccess.isManager(identity, req.params.id);
    const rows = ctx.relay.pairings.listConnectors(req.params.id)
      .filter((row) => manager || (row.owner_kind === 'user' && row.owner_user_id === identity.userId))
      .map((row) => ({
        id: row.id, memberId: row.member_id, status: row.status, ownerKind: row.owner_kind, ownerUserId: row.owner_user_id,
        targetOrigin: row.target_origin, descriptor: JSON.parse(row.descriptor_json), online: ctx.relay.host.isConnectorOnline(row.id),
        createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at,
      }));
    res.json({ success: true, connectors: rows });
  });

  app.delete('/api/groups/:id/relay/connectors/:connectorId', guardRoom, (req, res) => {
    const identity = getRequestIdentity(req);
    const connector = ctx.relay.pairings.getConnector(req.params.connectorId);
    if (!connector || connector.group_id !== req.params.id) return res.status(404).json(buildStructuredApiError('relay.connectorNotFound'));
    const owner = connector.owner_kind === 'user' && connector.owner_user_id === identity.userId;
    if (!owner && !ctx.roomCollab.roomAccess.isManager(identity, req.params.id)) return sendResourceForbidden(res);
    ctx.relay.host.revokeConnector(connector.id, 'revoked by room');
    ctx.roomCollab.orchestrator.dropMember(req.params.id, connector.member_id, 'removed');
    res.json({ success: true });
  });

  // ---------------------------------------------------------------- host：target 回调（公开，请求密钥）

  app.post('/api/relay/v1/pairings/:requestId/submit', (req, res) => {
    try {
      const row = ctx.relay.pairings.submit(req.params.requestId, secretOf(req), { targetOrigin: req.body?.targetOrigin, descriptor: req.body?.descriptor }, ctx.relay.host.nameTaken);
      ctx.roomCollab.publish(row.group_id, { type: 'pairing', data: { changed: true } });
      res.json({ success: true, status: row.status });
    } catch (error) {
      sendRelayError(res, error);
    }
  });

  app.get('/api/relay/v1/pairings/:requestId/status', (req, res) => {
    try {
      const status = ctx.relay.pairings.status(req.params.requestId, secretOf(req));
      res.json({ success: true, status: status.status, reason: status.reason, ticketExpiresAt: status.ticketExpiresAt });
    } catch (error) {
      sendRelayError(res, error);
    }
  });

  app.post('/api/relay/v1/pairings/:requestId/failure', (req, res) => {
    try {
      ctx.relay.pairings.fail(req.params.requestId, secretOf(req), typeof req.body?.reason === 'string' ? req.body.reason : 'target failure');
      res.json({ success: true });
    } catch (error) {
      sendRelayError(res, error);
    }
  });

  // ---------------------------------------------------------------- host：远程工作区（公开，每跳令牌）

  const requireGrant = (req: express.Request, res: express.Response) => {
    const grant = ctx.relay.host.authorizeGrant(req.headers.authorization);
    if (!grant) {
      res.status(401).json(buildStructuredApiError('relay.workspaceTokenInvalid'));
      return null;
    }
    return grant;
  };

  app.post('/api/room-relay/workspace/actions', async (req, res) => {
    const grant = requireGrant(req, res);
    if (!grant) return;
    try {
      const action = String(req.body?.action ?? '');
      const target = String(req.body?.path ?? '');
      switch (action) {
        case 'list':
          return res.json({ success: true, ...grant.files.list(target) });
        case 'read':
          return res.json({ success: true, ...grant.files.readText(target) });
        case 'write': {
          if (typeof req.body?.content !== 'string') return res.status(400).json(buildStructuredApiError('workspace.invalidContent'));
          const written = await grant.files.write(target, Buffer.from(req.body.content, 'utf8'), typeof req.body?.expectedSha256 === 'string' ? req.body.expectedSha256 : null);
          return res.json({ success: true, ...written });
        }
        case 'mkdir':
          return res.json({ success: true, ...(await grant.files.mkdir(target)) });
        case 'delete':
          return res.json({ success: true, ...(await grant.files.remove(target, typeof req.body?.expectedSha256 === 'string' ? req.body.expectedSha256 : null)) });
        default:
          return res.status(400).json(buildStructuredApiError('workspace.unknownAction'));
      }
    } catch (error) {
      sendRelayError(res, error);
    }
  });

  app.get('/api/room-relay/workspace/file', (req, res) => {
    const grant = requireGrant(req, res);
    if (!grant) return;
    try {
      const file = grant.files.readBinary(String(req.query.path ?? ''), WORKSPACE_BINARY_LIMIT);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-SHA256', file.sha256);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(file.buffer);
    } catch (error) {
      sendRelayError(res, error);
    }
  });

  app.put('/api/room-relay/workspace/file', binaryBody, async (req, res) => {
    const grant = requireGrant(req, res);
    if (!grant) return;
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length > WORKSPACE_BINARY_LIMIT) return res.status(413).json(buildStructuredApiError('workspace.tooLarge'));
      const expected = typeof req.headers['x-expected-sha256'] === 'string' ? req.headers['x-expected-sha256'] : null;
      const written = await grant.files.write(String(req.query.path ?? ''), body, expected, WORKSPACE_BINARY_LIMIT);
      const { abs } = grant.files.statFile(written.path);
      // 上传的二进制自动以这个 Agent 的名义发一条附件消息（受群附件配额约束；配额满了文件照样写进工作区，只是不发附件）。
      let attachmentPublished = true;
      try {
        ctx.relay.host.publishUpload(grant, written.path, abs);
      } catch {
        attachmentPublished = false;
      }
      res.json({ success: true, ...written, attachmentPublished });
    } catch (error) {
      sendRelayError(res, error);
    }
  });

  // ---------------------------------------------------------------- target：本机链接（管理员）

  app.get('/api/relay/links', ctx.auth.requireAdminAuth, (_req, res) => {
    res.json({ success: true, links: ctx.relay.target.list() });
  });

  app.post('/api/relay/links', ctx.auth.requireAdminAuth, async (req, res) => {
    try {
      const link = await ctx.relay.target.createLink({
        pairingCode: req.body?.pairingCode,
        runtime: req.body?.runtime,
        name: req.body?.name,
        description: req.body?.description,
        mode: req.body?.mode,
        model: req.body?.model,
        trustedLan: req.body?.trustedLan === true,
        allowWorkspaceTools: req.body?.allowWorkspaceTools !== false,
        targetOrigin: requestOrigin(req),
      });
      res.json({ success: true, link });
    } catch (error) {
      sendRelayError(res, error);
    }
  });

  app.delete('/api/relay/links/:linkId', ctx.auth.requireAdminAuth, async (req, res) => {
    const removed = await ctx.relay.target.deleteLink(req.params.linkId);
    if (!removed) return res.status(404).json(buildStructuredApiError('relay.linkNotFound'));
    res.json({ success: true });
  });

  app.post('/api/relay/links/:linkId/reconnect', ctx.auth.requireAdminAuth, (req, res) => {
    if (!ctx.relay.target.reconnect(req.params.linkId)) return res.status(409).json(buildStructuredApiError('relay.linkNotReconnectable'));
    res.json({ success: true });
  });
}
