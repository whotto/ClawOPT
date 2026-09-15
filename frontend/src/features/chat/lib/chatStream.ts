// 单聊流的统一读取：不管帧从 SSE 响应体来还是从 WebSocket 主题来，调用方拿到的都是同一串 legacy 帧
// （ids / attached / delta / final / error），逐帧处理的代码一行不用分叉。
//
// WebSocket 形态（后端 chat-routes.ts）：POST 带 `X-ClawOPT-Stream: ws` 与连接 id，立刻回 JSON（消息 id）；
// 帧从 `session:<id>` 主题走，负载 `{ frame, end, messageId }`。
// - 先订阅再 POST，订阅确认之前到的帧也收着（按消息 id 过滤）；
// - 带 end 的帧或 `chat.stream.end` 到了就结束；
// - 断线重连：快照里这条消息的运行还在 → 先补接回帧再继续；已经不在 → 结束（调用方回历史对账）。
import type { RealtimeClient, RealtimeEventMessage } from '../../../api/ws';

export type ChatStreamFrame = Record<string, any>;

/** 发送时会话已经在忙：服务端把这一条排进了队列（请求体带 `queue: true`），POST 回 JSON 而不是流。 */
export type QueuedChatTurn = { queueId: string; position: number; clientTurnId: string | null };

export type ChatStreamOpenResult =
  | { ok: true; events: AsyncIterable<ChatStreamFrame> }
  | { ok: false; response: Response }
  | { ok: 'queued'; queued: QueuedChatTurn };

async function readQueuedTurn(response: Response): Promise<QueuedChatTurn | null> {
  if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) return null;
  const data = await response.clone().json().catch(() => null) as any;
  if (data?.queued !== true || typeof data.queueId !== 'string') return null;
  return { queueId: data.queueId, position: Number(data.position) || 1, clientTurnId: typeof data.clientTurnId === 'string' ? data.clientTurnId : null };
}

export const CHAT_FRAME_EVENT = 'chat.frame';
export const CHAT_STREAM_END_EVENT = 'chat.stream.end';
/**
 * 实时通道在这么久里连不上（反向代理没放行 Upgrade、公司网络拦 WebSocket……）就退回 SSE。
 * 开关打开不该让发送按钮在一个连不上的通道上转圈。
 */
export const WS_READY_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}

/** SSE 响应体里的 `data: {...}` 帧。解析失败的行跳过（与原来逐行 try/catch 一致）。 */
export async function* readSseChatFrames(response: Response): AsyncGenerator<ChatStreamFrame> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let frame: ChatStreamFrame | null = null;
      try {
        frame = JSON.parse(line.slice(6));
      } catch {}
      if (frame) yield frame;
    }
  }
}

/** 一个会按需等待的帧队列：生产方 push，消费方 for await。 */
class FrameQueue {
  private items: ChatStreamFrame[] = [];
  private done = false;
  private wake: (() => void) | null = null;

  push(frame: ChatStreamFrame) {
    if (this.done) return;
    this.items.push(frame);
    this.wake?.();
  }

  finish() {
    this.done = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<ChatStreamFrame> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

type SessionSnapshot = {
  activeRun?: { runId?: string; meta?: { messageId?: unknown } } | null;
  attach?: Array<{ type: string; payload?: { frame?: ChatStreamFrame } }>;
};

function snapshotForSession(snapshot: any): SessionSnapshot | null {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  return sessions[0] ?? null;
}

/**
 * 订阅会话主题，把属于某条助手消息的帧排进队列。`messageId` 可以晚一点才知道（POST 回来之后）：
 * 之前到的帧先暂存，知道之后按 id 放行。
 */
function collectSessionFrames(client: RealtimeClient, sessionId: string, signal?: AbortSignal) {
  const queue = new FrameQueue();
  const early: RealtimeEventMessage[] = [];
  let messageId: number | null = null;
  let ended = false;

  const finish = () => {
    if (ended) return;
    ended = true;
    subscription.unsubscribe();
    queue.finish();
  };

  const accept = (event: RealtimeEventMessage) => {
    if (ended) return;
    const payloadMessageId = event.payload?.messageId;
    if (messageId === null) {
      early.push(event);
      return;
    }
    if (payloadMessageId !== messageId) return;
    if (event.event === CHAT_FRAME_EVENT && event.payload?.frame) {
      queue.push(event.payload.frame);
      if (event.payload.end) finish();
    } else if (event.event === CHAT_STREAM_END_EVENT) {
      finish();
    }
  };

  const subscription = client.subscribe(`session:${sessionId}`, {
    onEvent: accept,
    onSnapshot: (snapshot, info) => {
      if (!info.resubscribe || ended || messageId === null) return;
      const session = snapshotForSession(snapshot);
      const runMessageId = session?.activeRun?.meta?.messageId;
      if (runMessageId !== messageId) {
        // 断线期间这一轮已经结束（或压根不在协调器里）：没有终帧可等，交给调用方回历史对账。
        finish();
        return;
      }
      for (const attach of session?.attach ?? []) {
        if (attach.payload?.frame) queue.push(attach.payload.frame);
      }
    },
  });

  signal?.addEventListener('abort', finish, { once: true });

  return {
    ready: subscription.ready,
    bind(id: number) {
      messageId = id;
      for (const event of early.splice(0)) accept(event);
    },
    frames: () => queue.drain(),
    finish,
  };
}

/**
 * 发送 / 重新生成：按通道打开这一轮的帧流。
 * `post(headers)` 发起真正的 HTTP 请求（SSE 模式 headers 为空，与原来完全一致）。
 */
export async function openChatTurnStream(params: {
  transport: 'sse' | 'ws';
  sessionId: string;
  client: () => RealtimeClient;
  post: (headers: Record<string, string>) => Promise<Response>;
  signal?: AbortSignal;
  readyTimeoutMs?: number;
}): Promise<ChatStreamOpenResult> {
  const overSse = async (): Promise<ChatStreamOpenResult> => {
    const response = await params.post({});
    const queued = await readQueuedTurn(response);
    if (queued) return { ok: 'queued', queued };
    if (!response.ok || !response.body) return { ok: false, response };
    return { ok: true, events: readSseChatFrames(response) };
  };
  if (params.transport === 'sse') return overSse();

  const client = params.client();
  const timeoutMs = params.readyTimeoutMs ?? WS_READY_TIMEOUT_MS;
  const connectionId = await withTimeout(client.ready(), timeoutMs);
  if (!connectionId) return overSse();
  const collector = collectSessionFrames(client, params.sessionId, params.signal);
  const ack = await withTimeout(collector.ready, timeoutMs);
  if (!ack?.ok) {
    collector.finish();
    return overSse();
  }
  let response: Response;
  try {
    response = await params.post({ 'X-ClawOPT-Stream': 'ws', 'X-ClawOPT-WS-Connection': connectionId });
  } catch (error) {
    collector.finish();
    throw error;
  }
  if (!response.ok) {
    collector.finish();
    return { ok: false, response };
  }
  const queued = await readQueuedTurn(response);
  if (queued) {
    collector.finish();
    return { ok: 'queued', queued };
  }
  const ids = await response.json().catch(() => null) as { userMsgId?: number; assistantMsgId?: number } | null;
  if (!ids || typeof ids.assistantMsgId !== 'number') {
    collector.finish();
    return { ok: false, response };
  }
  collector.bind(ids.assistantMsgId);
  async function* events(): AsyncGenerator<ChatStreamFrame> {
    yield { type: 'ids', userMsgId: ids!.userMsgId, assistantMsgId: ids!.assistantMsgId };
    yield* collector.frames();
  }
  return { ok: true, events: events() };
}

/**
 * 进入会话时接回仍在跑的运行。WebSocket 模式先看快照：协调器里有运行就从主题接回；
 * 没有（运行已结束，或是直连模型 / 生图这类还不在协调器里的本地操作）就走原来的 HTTP 接回，
 * 由它决定是回 `{ active: false }` 还是 SSE。
 */
export async function openChatAttachStream(params: {
  transport: 'sse' | 'ws';
  sessionId: string;
  client: () => RealtimeClient;
  attachOverHttp: () => Promise<Response>;
  signal?: AbortSignal;
  readyTimeoutMs?: number;
}): Promise<{ kind: 'inactive' } | { kind: 'failed' } | { kind: 'events'; events: AsyncIterable<ChatStreamFrame> }> {
  const overHttp = async () => {
    const response = await params.attachOverHttp();
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return { kind: 'inactive' as const };
    if (!response.ok || !response.body) return { kind: 'failed' as const };
    return { kind: 'events' as const, events: readSseChatFrames(response) };
  };
  if (params.transport === 'sse') return overHttp();

  const client = params.client();
  const timeoutMs = params.readyTimeoutMs ?? WS_READY_TIMEOUT_MS;
  if (!await withTimeout(client.ready(), timeoutMs)) return overHttp();
  const collector = collectSessionFrames(client, params.sessionId, params.signal);
  const ack = await withTimeout(collector.ready, timeoutMs);
  const session = ack?.ok ? snapshotForSession(ack.snapshot) : null;
  const runMessageId = session?.activeRun?.meta?.messageId;
  if (typeof runMessageId !== 'number') {
    collector.finish();
    return overHttp();
  }
  const attachFrames = (session?.attach ?? []).map((item) => item.payload?.frame).filter(Boolean) as ChatStreamFrame[];
  collector.bind(runMessageId);
  async function* events(): AsyncGenerator<ChatStreamFrame> {
    yield* attachFrames;
    yield* collector.frames();
  }
  return { kind: 'events', events: events() };
}
