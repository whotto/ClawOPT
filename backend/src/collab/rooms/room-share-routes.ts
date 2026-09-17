/**
 * 访客页的公开接口（`/share/rooms/:code`，plan §5 P3 task 10）。
 *
 * 全部登记在 `AUTH_PUBLIC_PATHS`，安全在处理器里：
 * - 除 `GET /api/share/rooms/:code`（房间名 + 名册，邀请码有效才回）与 `POST …/join` 外，每个接口都要访客令牌头
 *   `x-clawopt-guest-token`（只存 SHA-256；邀请码、群、邀请代、未吊销四项都对上才认，任一不符一律 401）；
 * - 访客只有「看 / 发 / 撤回自己排队中的消息 / 上传附件 / 读本群登记过的附件 / 答复自己 Agent 的审批」；
 *   管理、澄清、@all、继续交接链、工作区都不开放（工作区 diff 从消息与事件流里剥掉）；
 * - 访客发起的链按签发邀请码的人的授权判（room-policy.ts `originatorFromActor`）；
 * - 发消息按访客限速（每分钟 20 条），加入按房间限速（room-guests.ts）。
 */
import type express from 'express';
import { raw as expressRaw } from 'express';

import type { DB } from '../../core/db';
import { buildStructuredApiError, GROUP_MENTION_NOT_PERMITTED_MESSAGE_CODE, type RouteApp } from '../../core/http';
import type { RealtimeHub } from '../../core/realtime';
import { parseRealtimeTopic } from '../../core/realtime';
import { buildHistoryPageResponse, getHistoryPageQueryParams } from '../sessions';
import { AttachmentError, ATTACHMENT_CHUNK_BYTES } from './room-attachments';
import type { RoomCollab } from './room-collab';
import type { RoomEngine } from './room-engine';
import { ROOM_FRAME_EVENT } from './room-frames';
import { type AuthenticatedGuest, GUEST_TOKEN_HEADER, GuestError } from './room-guests';
import { RoomRequestError } from './room-orchestrator';
import { decorateRoomMessageRows } from './room-routes';

const SHARE_SSE_KEEPALIVE_MS = 15_000;
const GUEST_MESSAGES_PER_MINUTE = 20;
const rawChunkParser = expressRaw({ type: 'application/octet-stream', limit: ATTACHMENT_CHUNK_BYTES + 1024 });

/** 访客事件流不转发的帧：工作区 diff（管理员的地盘）、配对与访客名册变动（只给管理员界面刷新用）。 */
const GUEST_HIDDEN_FRAMES = new Set(['workspace_diff', 'pairing']);

export type RoomShareRoutesDeps = {
  db: Pick<DB, 'getGroupChat' | 'getGroupMessagesPage'>;
  rooms: Pick<RoomEngine, 'groupChatEngine'>;
  realtime: Pick<RealtimeHub, 'listen'>;
  roomCollab: RoomCollab;
};

export function guestTokenOf(req: express.Request): string {
  return String(req.headers[GUEST_TOKEN_HEADER] ?? '');
}

export function sendShareError(res: express.Response, error: unknown): void {
  if (error instanceof GuestError || error instanceof RoomRequestError || error instanceof AttachmentError) {
    res.status(error.status).json(buildStructuredApiError(error.code, error.message));
    return;
  }
  res.status(500).json({ success: false, error: (error as Error)?.message });
}

/** 访客看得到的帧：剥掉工作区 diff 字段。 */
export function guestVisibleFrame(frame: unknown): Record<string, unknown> | null {
  if (!frame || typeof frame !== 'object') return null;
  const record = frame as Record<string, unknown>;
  if (typeof record.type === 'string' && GUEST_HIDDEN_FRAMES.has(record.type)) return null;
  if ('workspace_changes' in record) {
    const { workspace_changes: _hidden, ...rest } = record;
    return rest;
  }
  return record;
}

export function registerRoomShareRoutes(app: RouteApp, ctx: RoomShareRoutesDeps): void {
  const guestClients = new Map<string, Set<{ res: express.Response; code: string; token: string }>>();
  let stopListening: (() => void) | null = null;
  const messageRate = new Map<string, number[]>();

  /** 事件流监听在第一个访客连上时才挂（路由登记期不调用上下文里的函数）。 */
  const ensureListener = () => {
    if (stopListening) return;
    stopListening = ctx.realtime.listen('sse:room-guests', (event) => {
      if (event.type !== ROOM_FRAME_EVENT) return;
      const parsed = parseRealtimeTopic(event.topic);
      if (!parsed || parsed.kind !== 'room') return;
      const clients = guestClients.get(parsed.id);
      if (!clients || clients.size === 0) return;
      const visible = guestVisibleFrame(event.payload);
      if (!visible) return;
      const data = JSON.stringify(visible);
      for (const client of clients) {
        try { client.res.write(`data: ${data}\n\n`); } catch {}
      }
    });
  };

  const collab = () => ctx.roomCollab;

  /** 访客闸门：邀请码 + 令牌。认过的访客挂在 res.locals 上。 */
  const guardGuest: express.RequestHandler = (req, res, next) => {
    try {
      res.locals.guest = collab().guests.authenticate(String(req.params.code ?? ''), guestTokenOf(req));
      next();
    } catch (error) {
      sendShareError(res, error);
    }
  };
  const guestOf = (res: express.Response) => res.locals.guest as AuthenticatedGuest;

  const roomInfo = (groupId: string) => {
    const group = ctx.db.getGroupChat(groupId);
    const policy = collab().policies.get(groupId);
    return {
      id: groupId,
      name: group?.name ?? groupId,
      agents: collab().members(groupId).map((member) => ({
        id: member.id,
        name: member.display_name || member.agent_id,
        description: member.role_description ?? '',
        online: collab().isMemberOnline(member),
      })),
      guests: collab().guests.list(groupId).map((guest) => ({ id: guest.id, name: guest.name, avatar: guest.avatar })),
      allowGuestAgents: policy?.allowGuestAgents ?? false,
      maxGuestAgentsPerMember: policy?.maxGuestAgentsPerMember ?? 0,
    };
  };

  // 房间概况：邀请码有效才回（不要令牌——加入之前要看到房间名）。
  app.get('/api/share/rooms/:code', (req, res) => {
    try {
      const policy = collab().guests.requireInvite(String(req.params.code));
      res.json({ success: true, room: roomInfo(policy.groupId) });
    } catch (error) {
      sendShareError(res, error);
    }
  });

  app.post('/api/share/rooms/:code/join', (req, res) => {
    try {
      const joined = collab().guests.join(String(req.params.code), { name: req.body?.name, avatar: req.body?.avatar });
      collab().publish(joined.groupId, { type: 'room_updated', data: { guestsChanged: true } });
      res.json({ success: true, guest: joined.guest, guestToken: joined.token, room: roomInfo(joined.groupId) });
    } catch (error) {
      sendShareError(res, error);
    }
  });

  app.get('/api/share/rooms/:code/me', guardGuest, (_req, res) => {
    const { guest, policy } = guestOf(res);
    res.json({ success: true, guest, room: roomInfo(policy.groupId) });
  });

  app.get('/api/share/rooms/:code/messages', guardGuest, (req, res) => {
    try {
      const { policy } = guestOf(res);
      const { beforeId, limit } = getHistoryPageQueryParams(req.query as Record<string, unknown>);
      const page = ctx.db.getGroupMessagesPage(policy.groupId, { beforeId, limit });
      res.json(buildHistoryPageResponse(decorateRoomMessageRows(collab(), policy.groupId, page.rows, { workspace: false }), page.pageInfo));
    } catch (error) {
      sendShareError(res, error);
    }
  });

  app.post('/api/share/rooms/:code/messages', guardGuest, (req, res) => {
    try {
      const { policy, actor } = guestOf(res);
      const content = req.body?.content;
      if (typeof content !== 'string' || !content.trim()) return res.status(400).json(buildStructuredApiError('share.contentRequired'));
      const now = Date.now();
      const recent = (messageRate.get(actor.guestId) ?? []).filter((at) => now - at < 60_000);
      if (recent.length >= GUEST_MESSAGES_PER_MINUTE) return res.status(429).json(buildStructuredApiError('share.messageRateLimited'));
      recent.push(now);
      messageRate.set(actor.guestId, recent);
      const result = collab().orchestrator.ingestHumanMessage({
        groupId: policy.groupId,
        actor,
        identity: null,
        content,
        mentions: req.body?.mentions,
        queueCapability: typeof req.body?.queueCapability === 'string' ? req.body.queueCapability : null,
      });
      const blocked = result.blocked.map((member) => member.display_name);
      const offline = result.offline.map((member) => member.display_name);
      res.json({
        success: true,
        messageId: result.messageId,
        queued: result.queued,
        ...(blocked.length > 0
          ? { notice: { messageCode: GROUP_MENTION_NOT_PERMITTED_MESSAGE_CODE, messageParams: { agents: blocked.join(', ') }, agentNames: blocked } }
          : offline.length > 0
            ? { notice: { messageCode: 'groups.agentOffline', messageParams: { agentName: offline.join(', ') }, agentNames: offline } }
            : {}),
      });
    } catch (error) {
      sendShareError(res, error);
    }
  });

  app.post('/api/share/rooms/:code/messages/:msgId/retract', guardGuest, (req, res) => {
    try {
      const { policy, actor } = guestOf(res);
      const result = collab().orchestrator.retract({
        groupId: policy.groupId,
        messageId: Number(req.params.msgId),
        actor,
        capability: typeof req.body?.queueCapability === 'string' ? req.body.queueCapability : null,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      sendShareError(res, error);
    }
  });

  app.get('/api/share/rooms/:code/queue', guardGuest, (_req, res) => {
    res.json({ success: true, ...collab().orchestrator.snapshot(guestOf(res).policy.groupId) });
  });

  app.get('/api/share/rooms/:code/events', guardGuest, (req, res) => {
    const { policy } = guestOf(res);
    const code = String(req.params.code);
    const token = guestTokenOf(req);
    ensureListener();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'run_state', data: ctx.rooms.groupChatEngine.getGroupRunState(policy.groupId) })}\n\n`);
    const client = { res, code, token };
    if (!guestClients.has(policy.groupId)) guestClients.set(policy.groupId, new Set());
    guestClients.get(policy.groupId)!.add(client);
    const detach = () => {
      clearInterval(keepalive);
      guestClients.get(policy.groupId)?.delete(client);
      if (guestClients.get(policy.groupId)?.size === 0) guestClients.delete(policy.groupId);
    };
    // 保活时顺便复核令牌：访客被吊销、邀请码被轮换后，事件流在一个保活周期内断开。
    const keepalive = setInterval(() => {
      try {
        collab().guests.authenticate(code, token);
        res.write(': keepalive\n\n');
      } catch {
        detach();
        res.end();
      }
    }, SHARE_SSE_KEEPALIVE_MS);
    req.on('close', detach);
  });

  app.get('/api/share/rooms/:code/interactions', guardGuest, (_req, res) => {
    const { policy, actor } = guestOf(res);
    res.json({ success: true, interactions: collab().interactions.list(policy.groupId, actor, null) });
  });

  app.post('/api/share/rooms/:code/interactions/:interactionId/respond', guardGuest, (req, res) => {
    const { policy, actor } = guestOf(res);
    const result = collab().interactions.respond(policy.groupId, String(req.params.interactionId), actor, null, {
      choice: typeof req.body?.choice === 'string' ? req.body.choice : undefined,
      text: typeof req.body?.text === 'string' ? req.body.text : undefined,
    });
    if (result.status === 'forbidden') return res.status(403).json(buildStructuredApiError('auth.forbidden'));
    if (result.status === 'notActive') return res.status(409).json(buildStructuredApiError('runApprovals.notActive'));
    res.json({ success: true, resolved: true, stale: result.status === 'stale' });
  });

  app.post('/api/share/rooms/:code/uploads', guardGuest, (req, res) => {
    try {
      const { policy, actor } = guestOf(res);
      res.json({ success: true, ...collab().attachments.openUpload(policy.groupId, actor, { name: req.body?.name, size: req.body?.size, mediaType: req.body?.mediaType }) });
    } catch (error) {
      sendShareError(res, error);
    }
  });

  app.get('/api/share/rooms/:code/uploads/:uploadId', guardGuest, (req, res) => {
    try {
      const { policy, actor } = guestOf(res);
      res.json({ success: true, ...collab().attachments.status(policy.groupId, String(req.params.uploadId), actor) });
    } catch (error) {
      sendShareError(res, error);
    }
  });

  app.put('/api/share/rooms/:code/uploads/:uploadId', guardGuest, rawChunkParser, (req, res) => {
    try {
      const { policy, actor } = guestOf(res);
      const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json({ success: true, ...collab().attachments.appendChunk(policy.groupId, String(req.params.uploadId), actor, Number(req.query.offset), chunk) });
    } catch (error) {
      sendShareError(res, error);
    }
  });

  app.post('/api/share/rooms/:code/uploads/:uploadId/complete', guardGuest, (req, res) => {
    try {
      const { policy, actor } = guestOf(res);
      res.json({ success: true, attachment: collab().attachments.complete(policy.groupId, String(req.params.uploadId), actor, req.body?.sha256) });
    } catch (error) {
      sendShareError(res, error);
    }
  });

  /** 读附件：只认本群登记过的存储名；一律按下载返回（不内联渲染 HTML / SVG），nosniff。 */
  app.get('/api/share/rooms/:code/files/:storedName', guardGuest, (req, res) => {
    const { policy } = guestOf(res);
    const file = collab().attachments.resolveStored(policy.groupId, String(req.params.storedName));
    if (!file) return res.status(404).json(buildStructuredApiError('share.fileNotFound'));
    const inlineImage = /^image\/(png|jpeg|gif|webp)$/.test(file.mediaType);
    res.setHeader('Content-Type', inlineImage ? file.mediaType : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', `${inlineImage ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.sendFile(file.absolutePath, { dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) res.status(404).json(buildStructuredApiError('share.fileNotFound'));
    });
  });
}
