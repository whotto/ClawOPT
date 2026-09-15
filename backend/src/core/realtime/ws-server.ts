/**
 * 实时通道：一条鉴权的 WebSocket（路径 `/ws`），按主题订阅实时中枢的事件。
 *
 * ## 协议（JSON 文本帧）
 *
 * 服务端 → 客户端
 * - `{ type: 'hello', connectionId, heartbeatMs }`：连上即发；
 * - `{ type: 'event', id, topic, event, payload, runId?, runMarker?, at }`：中枢里的一个事件；
 * - `{ type: 'subscribed', topic, requestId?, snapshot? }` / `{ type: 'unsubscribed', topic, requestId? }`；
 * - `{ type: 'result', requestId, ... }`：客户端请求的结果；
 * - `{ type: 'error', code, requestId?, topic? }`：code 为 `realtime.*` 错误码。
 *
 * 客户端 → 服务端
 * - `{ type: 'subscribe', topic, resume?, requestId? }`：`resume` 为真时回带快照（活跃运行、重放缓冲、队列、待决交互）；
 * - `{ type: 'unsubscribe', topic, requestId? }`；
 * - `{ type: 'interaction.respond', sessionKey, id, choice?, text?, requestId? }`：答复审批 / 澄清；
 * - `{ type: 'ping', requestId? }` → `{ type: 'pong', requestId? }`。
 *
 * ## 规则
 *
 * - **鉴权与 HTTP 同一套**：升级请求用同一个 httpOnly 会话 cookie（或 CLI 头），不接受查询串令牌；
 *   失败直接回 HTTP 401、不升级。连接期间每次心跳复查一次——口令改了、令牌吊销了，连接就断（4401）。
 * - **按主题授权**：订阅前逐个主题判一次（会话 / 群 / Agent 必须存在），不是连上就能听全站。
 * - **每个事件带 id 与 topic**。
 * - **先发给主题，主题没人订阅而发起连接仍在时直发发起者**：补上「提交运行」与「订阅生效」之间的竞态。
 * - **心跳**：服务端定时 ping，上一轮没回 pong 的连接直接断。
 * - **背压**：发送缓冲超过上限的慢消费者直接断（4008），不让一个卡住的浏览器把服务端内存拖垮；
 *   断开后客户端重连并带 resume 重新订阅，靠快照补齐。
 */
import { randomUUID } from 'crypto';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { isRealtimeTopic, type RealtimeEvent, type RealtimeHub } from './realtime-hub';

export const REALTIME_WS_PATH = '/ws';
export const REALTIME_CLOSE_UNAUTHORIZED = 4401;
export const REALTIME_CLOSE_SLOW_CONSUMER = 4008;
export const REALTIME_CLOSE_SHUTDOWN = 1001;
export const DEFAULT_HEARTBEAT_MS = 25_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/** 单个客户端帧上限：客户端只发订阅与答复，大帧只可能是滥用。 */
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
export const MAX_TOPICS_PER_CONNECTION = 200;

export type RealtimeServerOptions = {
  hub: RealtimeHub;
  /** 升级请求是否已登录（登录关闭时恒为 true）。 */
  authenticate: (req: IncomingMessage) => boolean;
  /** 升级请求的 Host 是否被允许（与 HTTP 的 allowedHosts 同一判据）。 */
  isHostAllowed: (req: IncomingMessage) => boolean;
  authorizeTopic: (topic: string) => boolean;
  /** `resume: true` 时回给订阅者的快照。 */
  snapshotTopic: (topic: string) => unknown;
  respondInteraction: (sessionKey: string, id: string, response: { choice?: string; text?: string }) => unknown;
  heartbeatMs?: number;
  maxBufferedBytes?: number;
  log?: (message: string) => void;
};

type Connection = {
  id: string;
  socket: WebSocket;
  req: IncomingMessage;
  topics: Set<string>;
  alive: boolean;
};

type ClientMessage = {
  type?: unknown;
  topic?: unknown;
  resume?: unknown;
  requestId?: unknown;
  sessionKey?: unknown;
  id?: unknown;
  choice?: unknown;
  text?: unknown;
};

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

export function attachRealtimeWebSocketServer(server: Server, options: RealtimeServerOptions) {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const log = options.log ?? ((message) => console.warn(message));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  const connections = new Map<string, Connection>();
  const byTopic = new Map<string, Set<Connection>>();

  const send = (connection: Connection, message: unknown): boolean => {
    if (connection.socket.readyState !== connection.socket.OPEN) return false;
    if (connection.socket.bufferedAmount > maxBufferedBytes) {
      // 慢消费者：它的缓冲已经堆到上限，再塞只会拖垮服务端。断开，让它重连后按快照补齐。
      connection.socket.close(REALTIME_CLOSE_SLOW_CONSUMER, 'slow consumer');
      return false;
    }
    connection.socket.send(JSON.stringify(message));
    return true;
  };

  const eventMessage = (event: RealtimeEvent) => ({
    type: 'event',
    id: event.id,
    topic: event.topic,
    event: event.type,
    payload: event.payload,
    runId: event.runId,
    runMarker: event.runMarker,
    at: event.at,
  });

  const unlisten = options.hub.listen('realtime:ws', (event) => {
    const subscribers = byTopic.get(event.topic);
    if (subscribers && subscribers.size > 0) {
      for (const connection of subscribers) send(connection, eventMessage(event));
      return;
    }
    // 主题没人订阅、但发起这次运行的连接还在：直发给它。只对会话 / 房间主题兜底——
    // `agent:<id>` 是附带的活动主题，发起者没订阅就是不想要，兜底会把它硬塞过去。
    if (event.origin && !event.topic.startsWith('agent:')) {
      const origin = connections.get(event.origin);
      if (origin && options.authorizeTopic(event.topic)) send(origin, eventMessage(event));
    }
  });

  const unsubscribe = (connection: Connection, topic: string) => {
    connection.topics.delete(topic);
    const set = byTopic.get(topic);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) byTopic.delete(topic);
  };

  const drop = (connection: Connection) => {
    for (const topic of [...connection.topics]) unsubscribe(connection, topic);
    connections.delete(connection.id);
  };

  const handleMessage = (connection: Connection, raw: string) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      send(connection, { type: 'error', code: 'realtime.invalidMessage' });
      return;
    }
    const requestId = typeof message.requestId === 'string' || typeof message.requestId === 'number' ? message.requestId : undefined;
    switch (message.type) {
      case 'ping':
        send(connection, { type: 'pong', requestId });
        return;
      case 'subscribe': {
        const topic = message.topic;
        if (!isRealtimeTopic(topic)) {
          send(connection, { type: 'error', code: 'realtime.invalidTopic', requestId });
          return;
        }
        if (!connection.topics.has(topic) && connection.topics.size >= MAX_TOPICS_PER_CONNECTION) {
          send(connection, { type: 'error', code: 'realtime.tooManyTopics', topic, requestId });
          return;
        }
        let allowed = false;
        try {
          allowed = options.authorizeTopic(topic);
        } catch (error) {
          log(`[Realtime] authorizeTopic failed for ${topic}: ${(error as Error)?.name}`);
        }
        if (!allowed) {
          send(connection, { type: 'error', code: 'realtime.topicForbidden', topic, requestId });
          return;
        }
        connection.topics.add(topic);
        const set = byTopic.get(topic) ?? new Set<Connection>();
        set.add(connection);
        byTopic.set(topic, set);
        // 订阅与快照在同一个同步段里完成：快照之后的事件一定会被这个连接收到，不会漏也不会先后颠倒。
        send(connection, {
          type: 'subscribed',
          topic,
          requestId,
          lastEventId: options.hub.lastEventId(),
          snapshot: message.resume === true ? options.snapshotTopic(topic) : undefined,
        });
        return;
      }
      case 'unsubscribe': {
        if (typeof message.topic === 'string') unsubscribe(connection, message.topic);
        send(connection, { type: 'unsubscribed', topic: message.topic, requestId });
        return;
      }
      case 'interaction.respond': {
        if (typeof message.sessionKey !== 'string' || typeof message.id !== 'string') {
          send(connection, { type: 'error', code: 'realtime.invalidMessage', requestId });
          return;
        }
        const result = options.respondInteraction(message.sessionKey, message.id, {
          choice: typeof message.choice === 'string' ? message.choice : undefined,
          text: typeof message.text === 'string' ? message.text : undefined,
        });
        send(connection, { type: 'result', requestId, result });
        return;
      }
      default:
        send(connection, { type: 'error', code: 'realtime.unknownMessage', requestId });
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== REALTIME_WS_PATH) return;
    if (!options.isHostAllowed(req)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (!options.authenticate(req)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection: Connection = { id: randomUUID(), socket: ws, req, topics: new Set(), alive: true };
      connections.set(connection.id, connection);
      ws.on('pong', () => { connection.alive = true; });
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          send(connection, { type: 'error', code: 'realtime.invalidMessage' });
          return;
        }
        handleMessage(connection, data.toString());
      });
      ws.on('close', () => drop(connection));
      ws.on('error', () => drop(connection));
      send(connection, { type: 'hello', connectionId: connection.id, heartbeatMs });
    });
  };
  server.on('upgrade', onUpgrade);

  const heartbeat = setInterval(() => {
    for (const connection of [...connections.values()]) {
      if (!connection.alive) {
        connection.socket.terminate();
        drop(connection);
        continue;
      }
      // 连接期间复查登录：令牌被吊销或口令改了，连接跟着失效。
      if (!options.authenticate(connection.req)) {
        connection.socket.close(REALTIME_CLOSE_UNAUTHORIZED, 'unauthorized');
        drop(connection);
        continue;
      }
      connection.alive = false;
      try {
        connection.socket.ping();
      } catch {
        drop(connection);
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    connectionCount: () => connections.size,
    subscriberCount: (topic: string) => byTopic.get(topic)?.size ?? 0,
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      unlisten();
      server.off('upgrade', onUpgrade);
      for (const connection of connections.values()) {
        try { connection.socket.close(REALTIME_CLOSE_SHUTDOWN, 'server shutdown'); } catch {}
      }
      connections.clear();
      byTopic.clear();
      wss.close(() => resolve());
    }),
  };
}

export type RealtimeWebSocketServer = ReturnType<typeof attachRealtimeWebSocketServer>;
