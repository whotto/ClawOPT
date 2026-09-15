/**
 * 终端的 WebSocket 通道（`/ws/terminal`）。
 *
 * ## 鉴权（三道，顺序固定）
 *
 * 1. 升级请求：Host 白名单 → URL 里不许带 `ticket` / `token` 查询参数（400）→ 登录身份（与 HTTP 同一套 cookie 解析，401）
 *    → 必须是 super_admin（403）；
 * 2. 连上以后 **5 秒内第一条消息必须是** `{ type: 'auth', ticket }`：票据经 `POST /api/terminal/tickets` 签发，一次性、30 秒过期、
 *    绑定签发的用户；不是 auth、票据不对、超时一律 4401 断开；
 * 3. 每次心跳重新解析登录身份：会话被吊销、用户被停用或降级，连接断开（4401）——会话本身保留，按空闲超时回收。
 *
 * ## 协议（JSON 文本帧）
 *
 * 客户端 → 服务端：`auth{ticket}`、`create{requestId, shellId, cols, rows, cwd?}`、`attach{requestId, sessionId, sinceOffset?}`、
 * `input{sessionId, data}`、`resize{sessionId, cols, rows}`、`detach{sessionId}`、`close{requestId?, sessionId}`、`ping`。
 * 服务端 → 客户端：`ready{sessions, shells}`、`created{requestId, session}`、
 * `attached{requestId, session, start, end, truncated, data}`（重放缓冲，之后才是实时输出）、
 * `output{sessionId, end, data}`（`end` 是字节偏移，客户端下次接回带上它就只补差额）、`exit{sessionId, exitCode, signal}`、
 * `closed{requestId, sessionId}`、`error{requestId?, sessionId?, code}`、`pong`。
 *
 * 连接断开只脱离会话，不杀 shell；慢消费者（发送缓冲超过上限）按 4008 断开，客户端重连后按偏移补齐。
 */
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { TerminalError, type TerminalIdentity, type TerminalService } from './terminal-service';

export const TERMINAL_WS_PATH = '/ws/terminal';
export const TERMINAL_AUTH_TIMEOUT_MS = 5000;
export const TERMINAL_CLOSE_UNAUTHORIZED = 4401;
export const TERMINAL_CLOSE_SLOW_CONSUMER = 4008;
const MAX_CLIENT_MESSAGE_BYTES = 256 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;

export type TerminalWsOptions<TIdentity extends TerminalIdentity> = {
  terminal: TerminalService;
  authenticate: (req: IncomingMessage) => TIdentity | null;
  isHostAllowed: (req: IncomingMessage) => boolean;
  authTimeoutMs?: number;
  heartbeatMs?: number;
  log?: (message: string) => void;
};

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

/** URL 里出现凭据形状的查询参数：不管值对不对都拒绝——它已经进了访问日志。 */
export function urlCarriesCredential(url: string | undefined): boolean {
  const query = (url ?? '').split('?')[1];
  if (!query) return false;
  const params = new URLSearchParams(query);
  return ['ticket', 'token', 'auth', 'access_token'].some((name) => params.has(name));
}

export function attachTerminalWebSocketServer<TIdentity extends TerminalIdentity>(server: Server, options: TerminalWsOptions<TIdentity>) {
  const { terminal } = options;
  const log = options.log ?? ((message: string) => console.warn(message));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  const connections = new Set<{ socket: WebSocket; req: IncomingMessage; identity: TIdentity; authed: boolean; alive: boolean; detachAll: () => void }>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== TERMINAL_WS_PATH) return;
    if (!options.isHostAllowed(req)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (urlCarriesCredential(req.url)) {
      terminal.recordReject(null, 'credential in URL');
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const identity = options.authenticate(req);
    if (identity === null) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (identity.role !== 'super_admin') {
      terminal.recordReject(identity, 'role is not super_admin');
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req, identity));
  };

  function handleConnection(ws: WebSocket, req: IncomingMessage, initialIdentity: TIdentity) {
    const detachers = new Map<string, () => void>();
    const connection = {
      socket: ws,
      req,
      identity: initialIdentity,
      authed: false,
      alive: true,
      detachAll: () => {
        for (const detach of detachers.values()) detach();
        detachers.clear();
      },
    };
    connections.add(connection);

    const send = (message: unknown) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(TERMINAL_CLOSE_SLOW_CONSUMER, 'slow consumer');
        return;
      }
      ws.send(JSON.stringify(message));
    };

    const authTimer = setTimeout(() => {
      if (!connection.authed) {
        terminal.recordReject(connection.identity, 'auth timeout');
        ws.close(TERMINAL_CLOSE_UNAUTHORIZED, 'auth timeout');
      }
    }, options.authTimeoutMs ?? TERMINAL_AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    const drop = () => {
      clearTimeout(authTimer);
      connection.detachAll();
      connections.delete(connection);
    };
    ws.on('close', drop);
    ws.on('error', drop);
    ws.on('pong', () => { connection.alive = true; });

    const attachSession = (requestId: unknown, sessionId: unknown, sinceOffset: unknown) => {
      if (typeof sessionId !== 'string') throw new TerminalError('terminal.sessionNotFound', 404);
      detachers.get(sessionId)?.();
      const attached = terminal.attach(connection.identity, sessionId, sinceOffset, {
        onOutput: (data, end) => send({ type: 'output', sessionId, end, data }),
        onExit: (exitCode, signal) => send({ type: 'exit', sessionId, exitCode, signal }),
      });
      detachers.set(sessionId, attached.detach);
      send({ type: 'attached', requestId, session: attached.session, start: attached.replay.start, end: attached.replay.end, truncated: attached.replay.truncated, data: attached.replay.data });
      if (attached.session.exited) send({ type: 'exit', sessionId, exitCode: attached.session.exitCode, signal: null });
    };

    ws.on('message', (raw, isBinary) => {
      let message: Record<string, unknown>;
      try {
        if (isBinary) throw new Error('binary');
        message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object') throw new Error('shape');
      } catch {
        if (!connection.authed) {
          ws.close(TERMINAL_CLOSE_UNAUTHORIZED, 'auth required');
          return;
        }
        send({ type: 'error', code: 'terminal.invalidMessage' });
        return;
      }
      const requestId = typeof message.requestId === 'string' || typeof message.requestId === 'number' ? message.requestId : undefined;

      if (!connection.authed) {
        if (message.type !== 'auth' || !terminal.consumeTicket(connection.identity, message.ticket)) {
          if (message.type !== 'auth') terminal.recordReject(connection.identity, 'first message was not auth');
          send({ type: 'error', code: 'terminal.ticketInvalid' });
          ws.close(TERMINAL_CLOSE_UNAUTHORIZED, 'invalid ticket');
          return;
        }
        connection.authed = true;
        clearTimeout(authTimer);
        send({ type: 'ready', sessions: terminal.listSessions(connection.identity), shells: terminal.shells() });
        return;
      }

      const sessionId = message.sessionId;
      const run = async () => {
        switch (message.type) {
          case 'ping':
            send({ type: 'pong', requestId });
            return;
          case 'create': {
            const session = await terminal.createSession(connection.identity, { shellId: message.shellId, cols: message.cols, rows: message.rows, cwd: message.cwd });
            send({ type: 'created', requestId, session });
            attachSession(undefined, session.id, 0);
            return;
          }
          case 'attach':
            attachSession(requestId, sessionId, message.sinceOffset);
            return;
          case 'input':
            terminal.input(connection.identity, sessionId, message.data);
            return;
          case 'resize':
            terminal.resize(connection.identity, sessionId, message.cols, message.rows);
            return;
          case 'detach':
            if (typeof sessionId === 'string') {
              detachers.get(sessionId)?.();
              detachers.delete(sessionId);
            }
            return;
          case 'close':
            if (typeof sessionId === 'string') {
              detachers.get(sessionId)?.();
              detachers.delete(sessionId);
            }
            terminal.close(connection.identity, sessionId);
            send({ type: 'closed', requestId, sessionId });
            return;
          default:
            send({ type: 'error', requestId, code: 'terminal.unknownMessage' });
        }
      };
      run().catch((error) => {
        const code = error instanceof TerminalError ? error.code : 'terminal.internalError';
        if (!(error instanceof TerminalError)) log(`[Terminal] message failed: ${(error as Error)?.name ?? 'Error'}`);
        send({ type: 'error', requestId, sessionId: typeof sessionId === 'string' ? sessionId : undefined, code });
      });
    });
  }

  server.on('upgrade', onUpgrade);

  const heartbeat = setInterval(() => {
    for (const connection of [...connections]) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      let identity: TIdentity | null = null;
      try {
        identity = options.authenticate(connection.req);
      } catch {
        identity = null;
      }
      if (!identity || identity.role !== 'super_admin' || identity.userId !== connection.identity.userId) {
        connection.socket.close(TERMINAL_CLOSE_UNAUTHORIZED, 'unauthorized');
        continue;
      }
      connection.identity = identity;
      connection.alive = false;
      try { connection.socket.ping(); } catch { /* 下一轮 terminate */ }
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    connectionCount: () => connections.size,
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const connection of connections) {
        connection.detachAll();
        try { connection.socket.close(1001, 'server shutdown'); } catch {}
      }
      connections.clear();
      wss.close(() => resolve());
    }),
  };
}
