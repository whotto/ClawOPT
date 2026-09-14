import { apiFetch, jsonInit } from './client';

// 单聊的非流式接口。流式入口（发送、重新生成、接回运行中的 run）在 stream.ts。

/** 单聊历史分页：`beforeId + limit` cursor 协议，与群聊一致。 */
export function getChatHistory(sessionId: string, params: URLSearchParams) {
  return apiFetch(`/history/${sessionId}?${params.toString()}`);
}

export function searchChatHistory(sessionId: string, params: URLSearchParams) {
  return apiFetch(`/history/${sessionId}/search?${params.toString()}`);
}

export function getChatActiveRun(sessionId: string, signal?: AbortSignal) {
  return apiFetch(`/chat/${sessionId}/active-run`, { signal });
}

export function stopChat(sessionId: string) {
  return apiFetch('/chat/stop', jsonInit('POST', { sessionId }));
}

export function updateMessage(messageId: string, body: unknown) {
  return apiFetch(`/messages/${messageId}`, jsonInit('PUT', body));
}

export function deleteMessage(messageId: string) {
  return apiFetch(`/messages/${messageId}`, { method: 'DELETE' });
}
