import { API_BASE, apiFetch, jsonInit } from './client';

// 流式入口集中在这里：返回原始 Response / EventSource，读流循环留在调用方。
//
// 群聊事件用 EventSource：它设不了自定义请求头，所以鉴权只能走 httpOnly cookie。

/**
 * 单聊发送：响应体是 `data: {...}` 行流。
 * `streamHeaders` 非空时（WebSocket 通道）后端改回 JSON，帧从实时通道走，见 features/chat/lib/chatStream.ts。
 */
export function postChatMessage(body: unknown, signal?: AbortSignal, streamHeaders: Record<string, string> = {}) {
  return apiFetch('/chat', withHeaders(jsonInit('POST', body, { signal }), streamHeaders));
}

/** 单聊重新生成：响应体同样是 `data: {...}` 行流（WebSocket 通道同上）。 */
export function regenerateChatMessage(body: unknown, streamHeaders: Record<string, string> = {}) {
  return apiFetch('/chat/regenerate', withHeaders(jsonInit('POST', body), streamHeaders));
}

function withHeaders(init: RequestInit, extra: Record<string, string>): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), ...extra } };
}

/** 接回仍在运行的单聊 run：无活动 run 时返回 JSON，否则返回行流。 */
export function attachChatRun(sessionId: string, signal?: AbortSignal) {
  return apiFetch(`/chat/attach/${sessionId}`, { signal });
}

export function openGroupEvents(groupId: string): EventSource {
  return new EventSource(`${API_BASE}/groups/${groupId}/events`);
}
