/**
 * 访客页（`/share/rooms/:code`）的接口：没有登录 cookie，靠访客令牌头 `x-clawopt-guest-token`。
 * 令牌存在本机 localStorage（按邀请码分键）；服务端回 401 时清掉，回到加入页。
 * 事件流不能用 EventSource（带不了头），用 fetch 读 `text/event-stream` 并自己拆 `data:` 行。
 */
import { readJson, type PairingView, type QueueSnapshot, type RoomInteraction } from '../api';

export const GUEST_TOKEN_HEADER = 'x-clawopt-guest-token';
const TOKEN_PREFIX = 'clawopt.guest.token.';

export type GuestRoomInfo = {
  id: string;
  name: string;
  agents: Array<{ id: string; name: string; description: string; online: boolean }>;
  guests: Array<{ id: string; name: string; avatar: string | null }>;
  allowGuestAgents: boolean;
  maxGuestAgentsPerMember: number;
};
export type GuestSelf = { id: string; name: string; avatar: string | null };

export function loadGuestToken(code: string): string | null {
  try { return window.localStorage.getItem(TOKEN_PREFIX + code); } catch { return null; }
}
export function storeGuestToken(code: string, token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_PREFIX + code, token);
    else window.localStorage.removeItem(TOKEN_PREFIX + code);
  } catch { /* 隐私模式：本次会话内有效 */ }
}

export function createGuestApi(code: string, token: () => string | null) {
  const base = `/api/share/rooms/${encodeURIComponent(code)}`;
  const headers = (json = false): Record<string, string> => ({
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(token() ? { [GUEST_TOKEN_HEADER]: token() as string } : {}),
  });
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
  return {
    base,
    headers,
    info: async () => readJson<{ room: GuestRoomInfo }>(await fetch(base)),
    join: async (name: string, avatar: string) => readJson<{ guest: GuestSelf; guestToken: string; room: GuestRoomInfo }>(await post('/join', { name, avatar })),
    me: async () => readJson<{ guest: GuestSelf; room: GuestRoomInfo }>(await fetch(`${base}/me`, { headers: headers() })),
    messages: async (beforeId?: number) => readJson<any>(await fetch(`${base}/messages?limit=60${beforeId ? `&beforeId=${beforeId}` : ''}`, { headers: headers() })),
    send: async (content: string, mentions: unknown, queueCapability: string) => readJson<{ messageId: number; notice?: { messageCode: string; agentNames: string[] } }>(await post('/messages', { content, mentions, queueCapability })),
    retract: async (messageId: number, queueCapability: string) => readJson(await post(`/messages/${messageId}/retract`, { queueCapability })),
    queue: async () => readJson<QueueSnapshot>(await fetch(`${base}/queue`, { headers: headers() })),
    interactions: async () => readJson<{ interactions: RoomInteraction[] }>(await fetch(`${base}/interactions`, { headers: headers() })),
    respond: async (id: string, response: { choice?: string; text?: string }) => readJson(await post(`/interactions/${encodeURIComponent(id)}/respond`, response)),
    pairings: async () => readJson<{ pairings: PairingView[]; connectors: Array<{ id: string; memberId: string; status: string; descriptor: { name: string; runtime: string }; online: boolean }> }>(await fetch(`${base}/relay/pairings`, { headers: headers() })),
    createPairing: async () => readJson<{ pairingCode: string; requestId: string; expiresAt: number }>(await fetch(`${base}/relay/pairings`, { method: 'POST', headers: headers() })),
    revokeConnector: async (id: string) => readJson(await fetch(`${base}/relay/connectors/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() })),
    fileUrl: (storedName: string) => `${base}/files/${encodeURIComponent(storedName)}`,
  };
}

export type GuestApi = ReturnType<typeof createGuestApi>;

/** 读一个 SSE 响应体，逐帧回调；返回时流已结束（调用方决定是否重连）。 */
export async function readEventStream(response: Response, onFrame: (frame: any) => void, signal: AbortSignal): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) {
        try { onFrame(JSON.parse(data)); } catch { /* 坏帧跳过 */ }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

/** 消息正文里的 `/uploads/<存储名>` 换成访客可读的地址（图片经带令牌的 fetch 取 blob，见 GuestImage）。 */
export function storedNameFromUploadUrl(url: string): string | null {
  const match = /^\/uploads\/([0-9a-f]{32}(?:\.[a-z0-9]{1,10})?)$/i.exec(url);
  return match ? match[1] : null;
}
