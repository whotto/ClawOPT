/**
 * 单聊运行控制（P1b）：状态快照、服务端队列（取消 / 立即插入）、会话实时通道。
 *
 * - `GET /api/chat/:sessionId/state`：刷新、切标签、断线重连时一次拿全——活跃运行（含它的消息 id 与开始时间，
 *   后加入的标签页据此显示真实已耗时）、队列、插入状态、待答审批（剩余时间服务端重算）、最新计划与用量、
 *   以及实时中枢的事件游标（客户端据此丢掉比快照旧的事件）。
 * - `DELETE /api/chat/:sessionId/queue/:queueId`、`POST …/insert`：取消排队项、「立即插入」（状态机在协调器）。
 * - `GET /api/chat/:sessionId/events`：SSE 模式下的会话实时通道（WebSocket 模式订阅 `session:<id>` 主题拿同一串事件）。
 *   **只转控制事件**（运行开始 / 排队 / 终态 / 插入 / 用户消息回声 / 用量 / 计划 / 审批 / 会话命令 / 工作区 diff），
 *   不转正文帧——正文走发起那一轮的 POST 流或接回流，一条会话在浏览器里只占这一条长连接。
 *
 * 全部挂 `chatSessionParamGuard`：看不见的会话 403，与发送 / 停止同一个判据。
 */
import type express from 'express';

import { getRequestIdentity, type ResourceAccess } from '../../core/auth';
import type { DB } from '../../core/db';
import type { RouteApp } from '../../core/http';
import type { RealtimeEvent, RealtimeHub } from '../../core/realtime';
import type { RunCoordinator } from '../../runtime';
import { buildStructuredChatHttpError } from './chat-messages';
import { chatSessionTopic, openSseResponse, writeSseFrame } from './chat-stream';
import { CHAT_USER_MESSAGE_EVENT } from './chat-turn-rows';

export type ChatRunControlDeps = {
  db: Pick<DB, 'getSession'>;
  realtime: RealtimeHub;
  runCoordinator: Pick<RunCoordinator, 'snapshot' | 'cancelQueued' | 'insertNow' | 'pendingApprovals'>;
  access: ResourceAccess;
  guardParamSession: express.RequestHandler;
  heartbeatMs?: number;
};

/** 会话实时通道转发的事件类型（正文帧不在里面）。 */
export const CHAT_LIVE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.started',
  'run.queued',
  'run.completed',
  'run.failed',
  'run.aborted',
  'abort.started',
  'abort.timeout',
  'queue.insertion.updated',
  CHAT_USER_MESSAGE_EVENT,
  'usage.updated',
  'plan.updated',
  'session.command',
  'workspace.diff.completed',
  'approval.requested',
  'approval.resolved',
  'clarify.requested',
  'clarify.resolved',
]);

function latestOfType(replay: RealtimeEvent[], type: string): unknown {
  for (let index = replay.length - 1; index >= 0; index -= 1) {
    if (replay[index].type === type) return replay[index].payload;
  }
  return null;
}

export function buildChatRunState(deps: Pick<ChatRunControlDeps, 'realtime' | 'runCoordinator' | 'access'>, sessionId: string, identity: ReturnType<typeof getRequestIdentity>) {
  const snapshot = deps.runCoordinator.snapshot(sessionId);
  const run = snapshot.activeRun;
  return {
    success: true as const,
    sessionId,
    cursor: deps.realtime.lastEventId(),
    activeRun: run
      ? {
        runId: run.runId,
        runMarker: run.runMarker,
        runtime: run.runtime,
        phase: run.phase,
        aborting: run.aborting,
        startedAt: run.startedAt,
        messageId: typeof run.meta.messageId === 'number' ? run.meta.messageId : null,
        userMessageId: typeof run.meta.userMessageId === 'number' ? run.meta.userMessageId : null,
        kind: typeof run.meta.kind === 'string' ? run.meta.kind : null,
      }
      : null,
    queue: snapshot.queue,
    insertion: snapshot.insertion,
    pendingApprovals: deps.runCoordinator.pendingApprovals()
      .filter((item) => item.sessionKey === sessionId && deps.access.canAccessRunSession(identity, item.sessionKey)),
    plan: latestOfType(snapshot.replay, 'plan.updated'),
    usage: latestOfType(snapshot.replay, 'usage.updated'),
  };
}

export function registerChatRunControlRoutes(app: RouteApp, deps: ChatRunControlDeps): void {
  const heartbeatMs = deps.heartbeatMs ?? 25_000;

  app.get('/api/chat/:sessionId/state', deps.guardParamSession, (req, res) => {
    res.json(buildChatRunState(deps, req.params.sessionId, getRequestIdentity(req)));
  });

  app.delete('/api/chat/:sessionId/queue/:queueId', deps.guardParamSession, (req, res) => {
    const cancelled = deps.runCoordinator.cancelQueued(req.params.sessionId, req.params.queueId);
    if (!cancelled) {
      res.status(404).json(buildStructuredChatHttpError('Queued message not found.', 'chat.queueItemNotFound'));
      return;
    }
    res.json({ success: true });
  });

  app.post('/api/chat/:sessionId/queue/:queueId/insert', deps.guardParamSession, async (req, res) => {
    try {
      const result = await deps.runCoordinator.insertNow(req.params.sessionId, req.params.queueId);
      if (result.status === 'not_found') {
        res.status(404).json(buildStructuredChatHttpError('Queued message not found.', 'chat.queueItemNotFound'));
        return;
      }
      if (result.status === 'already_pending') {
        res.status(409).json({ ...buildStructuredChatHttpError('Another message is already being inserted.', 'chat.queueInsertionPending'), insertion: result.insertion });
        return;
      }
      res.json({ success: true, status: result.status, generation: result.generation });
    } catch (error: any) {
      res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to insert queued message.'));
    }
  });

  app.get('/api/chat/:sessionId/events', deps.guardParamSession, (req, res) => {
    const { sessionId } = req.params;
    const topic = chatSessionTopic(sessionId);
    openSseResponse(res);
    let closed = false;
    const listenerName = `sse:chat-live:${sessionId}:${Math.random().toString(36).slice(2)}`;
    writeSseFrame(res, { type: 'state', state: buildChatRunState(deps, sessionId, getRequestIdentity(req)) });
    const unlisten = deps.realtime.listen(listenerName, (event) => {
      if (closed || event.topic !== topic || !CHAT_LIVE_EVENT_TYPES.has(event.type)) return;
      if (!writeSseFrame(res, { type: 'event', id: event.id, event: event.type, payload: event.payload, runId: event.runId ?? null, runMarker: event.runMarker ?? null, at: event.at })) close();
    });
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(': ping\n\n');
      } catch {
        close();
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unlisten();
      try { res.end(); } catch {}
    }
    req.on('close', close);
    res.on('close', close);
  });
}
