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

/** 这些助手消息所在运行的工具调用摘要（线上截断）。 */
export function getChatToolCalls(sessionId: string, messageIds: string[], signal?: AbortSignal) {
  return apiFetch(`/chat/${encodeURIComponent(sessionId)}/tool-calls?messageIds=${encodeURIComponent(messageIds.join(','))}`, { signal });
}

/** 单个工具调用的完整参数与结果（复制完整内容）。 */
export function getToolCallFull(sessionId: string, callRowId: number) {
  return apiFetch(`/chat/${encodeURIComponent(sessionId)}/tool-calls/${callRowId}`);
}

/** 上下文占用：运行时报的最近一次模型调用占用 + 模型配置里的窗口。 */
export function getChatContextUsage(sessionId: string, signal?: AbortSignal) {
  return apiFetch(`/chat/${encodeURIComponent(sessionId)}/context-usage`, { signal });
}

/** 单聊运行控制快照：活跃运行、服务端队列、插入状态、待答审批（P1b）。 */
export function getChatRunState(sessionId: string, signal?: AbortSignal) {
  return apiFetch(`/chat/${encodeURIComponent(sessionId)}/state`, { signal });
}

export function cancelQueuedChatMessage(sessionId: string, queueId: string) {
  return apiFetch(`/chat/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`, { method: 'DELETE' });
}

/** 「立即插入」：让当前这一轮尽快让出，排队的这一条接着开始。 */
export function insertQueuedChatMessage(sessionId: string, queueId: string) {
  return apiFetch(`/chat/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}/insert`, { method: 'POST' });
}
