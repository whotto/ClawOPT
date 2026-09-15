// 单聊流走哪条通道：SSE（默认）或 WebSocket（P1a 起可选）。
//
// 按浏览器记在 localStorage，设置 → 通用里切换：WebSocket 通道要先在真实主机（反向代理、
// 移动网络）上验过再改默认，所以这一版默认仍是 SSE，切换只影响当前浏览器。

export type ChatStreamTransport = 'sse' | 'ws';

export const CHAT_STREAM_TRANSPORT_STORAGE_KEY = 'clawopt_chat_stream_transport';
export const DEFAULT_CHAT_STREAM_TRANSPORT: ChatStreamTransport = 'sse';

export function normalizeChatStreamTransport(value: unknown): ChatStreamTransport {
  return value === 'ws' ? 'ws' : DEFAULT_CHAT_STREAM_TRANSPORT;
}

export function readChatStreamTransport(): ChatStreamTransport {
  if (typeof window === 'undefined') return DEFAULT_CHAT_STREAM_TRANSPORT;
  try {
    return normalizeChatStreamTransport(window.localStorage.getItem(CHAT_STREAM_TRANSPORT_STORAGE_KEY));
  } catch {
    return DEFAULT_CHAT_STREAM_TRANSPORT;
  }
}

export function persistChatStreamTransport(value: unknown): ChatStreamTransport {
  const next = normalizeChatStreamTransport(value);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(CHAT_STREAM_TRANSPORT_STORAGE_KEY, next);
    } catch {}
  }
  return next;
}
