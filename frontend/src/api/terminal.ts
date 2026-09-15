// Web 终端的网络出口：HTTP（状态、shell、会话、票据、审计）与 `/ws/terminal` 客户端（协议见 backend/src/workspace/terminal/terminal-ws.ts）。
//
// 不做就会出错的几件事：
// 1. **URL 里不带任何凭据**：连上以后第一条消息发 `auth{ticket}`，票据每次连接前现取（一次性、30 秒）；
// 2. **断线自动重连并接回**：抖动退避（与 /ws 同一套），重连后对每个还开着的会话发 `attach{sinceOffset}`，服务端只补差额；
// 3. **按字节偏移去重**：同一段输出不写两遍（`end <= 已写到` 的丢掉），偏移早于缓冲起点时服务端标 truncated，界面先清屏再重放；
// 4. 旧 socket 晚到的回调一律丢弃。
import { apiFetch } from './client';
import { reconnectDelayMs, type WebSocketLike } from './ws';

export type TerminalShellOption = { id: string; label: string; isDefault: boolean };

export type TerminalSessionInfo = {
  id: string;
  shellId: string;
  shellLabel: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
  attached: number;
  exited: boolean;
  exitCode: number | null;
  bufferStart: number;
  bufferEnd: number;
};

export type TerminalAuditEntry = {
  id: number;
  ts: number;
  userId: number | null;
  username: string | null;
  sessionId: string | null;
  event: string;
  shell: string | null;
  detail: string | null;
};

export const terminalApi = {
  status: (refresh = false) => apiFetch(`/terminal/status${refresh ? '?refresh=1' : ''}`),
  shells: () => apiFetch('/terminal/shells'),
  sessions: () => apiFetch('/terminal/sessions'),
  audit: (limit = 100) => apiFetch(`/terminal/audit?limit=${limit}`),
  issueTicket: () => apiFetch('/terminal/tickets', { method: 'POST' }),
};

export type TerminalConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unauthorized';

export type TerminalClientEvents = {
  onState?: (state: TerminalConnectionState) => void;
  onReady?: (sessions: TerminalSessionInfo[], shells: TerminalShellOption[]) => void;
  onCreated?: (session: TerminalSessionInfo, requestId: string | undefined) => void;
  /** 接回的重放：`reset` 为真时先清屏（首次接回或缓冲已被挤掉）。 */
  onReplay?: (sessionId: string, data: string, info: { reset: boolean; session: TerminalSessionInfo }) => void;
  onOutput?: (sessionId: string, data: string) => void;
  onExit?: (sessionId: string, exitCode: number | null) => void;
  onClosed?: (sessionId: string) => void;
  onError?: (code: string, info: { sessionId?: string; requestId?: string }) => void;
};

export type TerminalClientOptions = {
  url?: () => string;
  createSocket?: (url: string) => WebSocketLike;
  /** 现取一次性票据；回 null 表示没有权限（不再重连）。 */
  fetchTicket?: () => Promise<string | null>;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

const OPEN = 1;
const CLOSE_UNAUTHORIZED = 4401;

export function terminalSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/terminal`;
}

export async function fetchTerminalTicket(): Promise<string | null> {
  const response = await terminalApi.issueTicket();
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
  const body = await response.json();
  return typeof body.ticket === 'string' ? body.ticket : null;
}

export class TerminalSocketClient {
  private socket: WebSocketLike | null = null;
  private authed = false;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private closedByUser = false;
  private requestSeq = 0;
  /** 本客户端要保持接回的会话 → 已写到的字节偏移（null = 还没写过，接回时整段重放）。 */
  private readonly offsets = new Map<string, number | null>();
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly fetchTicket: () => Promise<string | null>;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly events: TerminalClientEvents, private readonly options: TerminalClientOptions = {}) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.fetchTicket = options.fetchTicket ?? fetchTerminalTicket;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  connect(): void {
    this.closedByUser = false;
    if (this.socket || this.reconnectTimer) return;
    void this.open(false);
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.authed = false;
    socket?.close(1000, 'client closed');
    this.events.onState?.('closed');
  }

  /** 新建会话；服务端建好会自动接上并回 created + 重放。 */
  create(shellId: string | null, cols: number, rows: number): string {
    const requestId = `c${++this.requestSeq}`;
    this.send({ type: 'create', requestId, shellId: shellId ?? undefined, cols, rows });
    return requestId;
  }

  /** 接上一个已有会话（刷新页面后接回别处留下的会话）。 */
  attach(sessionId: string): void {
    if (!this.offsets.has(sessionId)) this.offsets.set(sessionId, null);
    this.send({ type: 'attach', requestId: `a${++this.requestSeq}`, sessionId, sinceOffset: this.offsets.get(sessionId) ?? undefined });
  }

  /** 不再看这个会话（shell 继续在服务端跑，空闲超时后回收）。 */
  detach(sessionId: string): void {
    this.offsets.delete(sessionId);
    this.send({ type: 'detach', sessionId });
  }

  input(sessionId: string, data: string): void {
    this.send({ type: 'input', sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', sessionId, cols, rows });
  }

  close(sessionId: string): void {
    this.offsets.delete(sessionId);
    this.send({ type: 'close', requestId: `x${++this.requestSeq}`, sessionId });
  }

  private send(message: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== OPEN || !this.authed) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private async open(reconnecting: boolean): Promise<void> {
    this.events.onState?.(reconnecting ? 'reconnecting' : 'connecting');
    let ticket: string | null;
    try {
      ticket = await this.fetchTicket();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.closedByUser) return;
    if (ticket === null) {
      this.events.onState?.('unauthorized');
      return;
    }
    const socket = this.createSocket((this.options.url ?? terminalSocketUrl)());
    this.socket = socket;
    this.authed = false;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ type: 'auth', ticket }));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.handle(message);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.authed = false;
      if (this.closedByUser) return;
      // 4401 可能是票据过期 / 登录被吊销：重取票据时会见分晓（没权限就停下）。
      if (event.code === CLOSE_UNAUTHORIZED && this.attempt > 3) {
        this.events.onState?.('unauthorized');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    this.events.onState?.('reconnecting');
    const delay = reconnectDelayMs(this.attempt, this.random);
    this.attempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      void this.open(true);
    }, delay);
  }

  private handle(message: any): void {
    switch (message?.type) {
      case 'ready': {
        this.authed = true;
        this.attempt = 0;
        this.events.onState?.('open');
        this.events.onReady?.(Array.isArray(message.sessions) ? message.sessions : [], Array.isArray(message.shells) ? message.shells : []);
        // 断线前开着的会话：逐个接回，只补差额。
        const alive = new Set<string>((message.sessions ?? []).map((session: TerminalSessionInfo) => session.id));
        for (const [sessionId, offset] of [...this.offsets]) {
          if (!alive.has(sessionId)) {
            this.offsets.delete(sessionId);
            this.events.onClosed?.(sessionId);
            continue;
          }
          this.send({ type: 'attach', requestId: `a${++this.requestSeq}`, sessionId, sinceOffset: offset ?? undefined });
        }
        return;
      }
      case 'created':
        if (message.session?.id) this.offsets.set(message.session.id, null);
        this.events.onCreated?.(message.session, message.requestId);
        return;
      case 'attached': {
        const sessionId = message.session?.id as string | undefined;
        if (!sessionId || !this.offsets.has(sessionId)) return;
        const previous = this.offsets.get(sessionId) ?? null;
        const reset = previous === null || message.truncated === true;
        this.offsets.set(sessionId, typeof message.end === 'number' ? message.end : previous);
        this.events.onReplay?.(sessionId, typeof message.data === 'string' ? message.data : '', { reset, session: message.session });
        return;
      }
      case 'output': {
        const sessionId = message.sessionId as string;
        if (!this.offsets.has(sessionId)) return;
        const written = this.offsets.get(sessionId);
        if (typeof message.end === 'number' && typeof written === 'number' && message.end <= written) return;
        if (typeof message.end === 'number') this.offsets.set(sessionId, message.end);
        this.events.onOutput?.(sessionId, String(message.data ?? ''));
        return;
      }
      case 'exit':
        this.events.onExit?.(message.sessionId, typeof message.exitCode === 'number' ? message.exitCode : null);
        return;
      case 'closed':
        this.offsets.delete(message.sessionId);
        this.events.onClosed?.(message.sessionId);
        return;
      case 'error':
        if (message.code === 'terminal.sessionNotFound' && message.sessionId) {
          this.offsets.delete(message.sessionId);
          this.events.onClosed?.(message.sessionId);
        }
        this.events.onError?.(String(message.code ?? 'terminal.internalError'), { sessionId: message.sessionId, requestId: message.requestId });
        return;
      default:
    }
  }
}
