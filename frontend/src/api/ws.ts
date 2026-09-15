// 实时通道客户端（后端 `/ws`，协议见 backend/src/core/realtime/ws-server.ts）。
//
// 三件不做就会出错、而且不报错的事：
// 1. **重连带抖动退避**（1s → 30s）：服务重启时所有标签页同一秒一起重连，会把刚起来的后端再打趴一次；
// 2. **重连后重新订阅并带 resume**：断线期间错过的状态靠服务端快照补齐，不靠「希望没错过什么」；
// 3. **旧 socket 的回调一律丢弃**：替换掉的连接晚到的消息（尤其是登录态变了之后）不能落进新状态。
//
// 鉴权走同源 httpOnly cookie，URL 里不带令牌。

export type RealtimeEventMessage = {
  type: 'event';
  id: number;
  topic: string;
  event: string;
  payload: any;
  runId?: string;
  runMarker?: string;
  at: number;
};

export type TopicListener = {
  onEvent: (event: RealtimeEventMessage) => void;
  /** 每次（重新）订阅成功时带回服务端快照。首次订阅也会调用。 */
  onSnapshot?: (snapshot: any, info: { resubscribe: boolean }) => void;
};

export type RealtimeSubscription = {
  /** 这一次订阅被服务端确认（或拒绝）。 */
  ready: Promise<{ ok: boolean; snapshot?: any; code?: string }>;
  unsubscribe: () => void;
};

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: { data: any }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: any) => void) | null;
}

export type RealtimeClientOptions = {
  url: () => string;
  createSocket?: (url: string) => WebSocketLike;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
const OPEN = 1;

/** 第 attempt 次重连的等待：上限 min(30s, 1s·2^attempt)，在 [上限/2, 上限] 里取随机值。 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

type TopicState = {
  listeners: Set<TopicListener>;
  subscribedOn: WebSocketLike | null;
  pendingReady: Array<(result: { ok: boolean; snapshot?: any; code?: string }) => void>;
};

export class RealtimeClient {
  private socket: WebSocketLike | null = null;
  private connectionId: string | null = null;
  private readyWaiters: Array<(connectionId: string) => void> = [];
  private readonly topics = new Map<string, TopicState>();
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private closedByUser = false;
  private requestSeq = 0;
  private hadConnection = false;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: RealtimeClientOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** 连上（必要时发起连接）并拿到服务端分配的连接 id。 */
  ready(): Promise<string> {
    this.closedByUser = false;
    if (this.connectionId && this.socket?.readyState === OPEN) return Promise.resolve(this.connectionId);
    const waiter = new Promise<string>((resolve) => this.readyWaiters.push(resolve));
    if (!this.socket && !this.reconnectTimer) this.open();
    return waiter;
  }

  subscribe(topic: string, listener: TopicListener): RealtimeSubscription {
    this.closedByUser = false;
    let state = this.topics.get(topic);
    if (!state) {
      state = { listeners: new Set(), subscribedOn: null, pendingReady: [] };
      this.topics.set(topic, state);
    }
    state.listeners.add(listener);
    const topicState = state;
    const ready = new Promise<{ ok: boolean; snapshot?: any; code?: string }>((resolve) => topicState.pendingReady.push(resolve));
    if (this.socket?.readyState === OPEN && this.connectionId) {
      this.sendSubscribe(topic, this.socket, false);
    } else if (!this.socket && !this.reconnectTimer) {
      this.open();
    }
    return {
      ready,
      unsubscribe: () => {
        const current = this.topics.get(topic);
        if (!current) return;
        current.listeners.delete(listener);
        if (current.listeners.size > 0) return;
        this.topics.delete(topic);
        if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify({ type: 'unsubscribe', topic }));
      },
    };
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.connectionId = null;
    socket?.close(1000, 'client closed');
  }

  private open(): void {
    const socket = this.createSocket(this.options.url());
    this.socket = socket;
    this.connectionId = null;
    // 所有回调先判「我还是不是当前连接」：被替换掉的连接晚到的消息直接丢。
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.handleMessage(socket, message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connectionId = null;
      for (const state of this.topics.values()) state.subscribedOn = null;
      if (this.closedByUser) return;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // 错误之后必然还有 close，重连在那里排。
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = reconnectDelayMs(this.attempt, this.random);
    this.attempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.open();
    }, delay);
  }

  private sendSubscribe(topic: string, socket: WebSocketLike, resubscribe: boolean): void {
    const state = this.topics.get(topic);
    if (!state) return;
    state.subscribedOn = socket;
    const requestId = `sub-${++this.requestSeq}`;
    this.pendingSubscribes.set(requestId, { topic, socket, resubscribe });
    socket.send(JSON.stringify({ type: 'subscribe', topic, resume: true, requestId }));
  }

  private readonly pendingSubscribes = new Map<string, { topic: string; socket: WebSocketLike; resubscribe: boolean }>();

  private handleMessage(socket: WebSocketLike, message: any): void {
    switch (message?.type) {
      case 'hello': {
        const resubscribe = this.hadConnection;
        this.hadConnection = true;
        this.connectionId = String(message.connectionId);
        this.attempt = 0;
        for (const resolve of this.readyWaiters.splice(0)) resolve(this.connectionId);
        for (const topic of this.topics.keys()) this.sendSubscribe(topic, socket, resubscribe);
        return;
      }
      case 'subscribed':
      case 'error': {
        const pending = typeof message.requestId === 'string' ? this.pendingSubscribes.get(message.requestId) : undefined;
        if (!pending || pending.socket !== socket) return;
        this.pendingSubscribes.delete(message.requestId);
        const state = this.topics.get(pending.topic);
        if (!state) return;
        const ok = message.type === 'subscribed';
        for (const resolve of state.pendingReady.splice(0)) resolve({ ok, snapshot: message.snapshot, code: message.code });
        if (ok) {
          for (const listener of [...state.listeners]) listener.onSnapshot?.(message.snapshot, { resubscribe: pending.resubscribe });
        }
        return;
      }
      case 'event': {
        const state = this.topics.get(message.topic);
        if (!state) return;
        for (const listener of [...state.listeners]) listener.onEvent(message as RealtimeEventMessage);
        return;
      }
      default:
        return;
    }
  }
}

function defaultRealtimeUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

let sharedClient: RealtimeClient | null = null;

/** 整个标签页共用一条实时连接。 */
export function getRealtimeClient(): RealtimeClient {
  if (!sharedClient) sharedClient = new RealtimeClient({ url: defaultRealtimeUrl });
  return sharedClient;
}

/** 登录态变化时断开（下一次使用时按新的 cookie 重新连）。 */
export function resetRealtimeClient(): void {
  sharedClient?.close();
  sharedClient = null;
}
