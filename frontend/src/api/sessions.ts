import { apiFetch, apiJsonWithTimeout, jsonInit } from './client';

export function listSessions() {
  return apiFetch('/sessions');
}

/** 应用启动时拉会话列表；超时即放弃，调用方按原样 catch。 */
export function listSessionsWithTimeout<T>(timeoutMs: number) {
  return apiJsonWithTimeout<T>('/sessions', timeoutMs);
}

export function createSession(body: unknown) {
  return apiFetch('/sessions', jsonInit('POST', body));
}

export function updateSession(sessionId: string, body: unknown) {
  return apiFetch(`/sessions/${sessionId}`, jsonInit('PUT', body));
}

export function deleteSession(sessionId: string) {
  return apiFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
}

export function resetSession(sessionId: string) {
  return apiFetch(`/sessions/${sessionId}/reset`, { method: 'POST' });
}

export function getSessionConfigs(sessionId: string) {
  return apiFetch(`/sessions/${sessionId}/configs`);
}

export function reorderSessions(ids: string[]) {
  return apiFetch('/sessions/reorder', jsonInit('POST', { ids }));
}

/** 会话组织视图（按用户）：分类、每个看得见的会话的分类 / 归档 / 对话标题 / 来历 / 分叉血缘 / 最近活动。 */
export function getSessionOrganization(signal?: AbortSignal) {
  return apiFetch('/session-organization', { signal });
}

export function createSessionCategory(name: string) {
  return apiFetch('/session-categories', jsonInit('POST', { name }));
}

export function renameSessionCategory(categoryId: number, name: string) {
  return apiFetch(`/session-categories/${categoryId}`, jsonInit('PUT', { name }));
}

export function deleteSessionCategory(categoryId: number) {
  return apiFetch(`/session-categories/${categoryId}`, { method: 'DELETE' });
}

export function moveSessionToCategory(sessionId: string, categoryId: number | null) {
  return apiFetch(`/sessions/${encodeURIComponent(sessionId)}/category`, jsonInit('PUT', { categoryId }));
}

export function setSessionArchived(sessionId: string, archived: boolean) {
  return apiFetch(`/sessions/${encodeURIComponent(sessionId)}/archive`, jsonInit('PUT', { archived }));
}

export function setSessionPinned(sessionId: string, pinned: boolean) {
  return apiFetch(`/sessions/${encodeURIComponent(sessionId)}/pin`, jsonInit('PUT', { pinned }));
}

export function renameSessionTitle(sessionId: string, title: string) {
  return apiFetch(`/sessions/${encodeURIComponent(sessionId)}/title`, jsonInit('PUT', { title }));
}

export function batchDeleteSessions(ids: string[]) {
  return apiFetch('/sessions/batch-delete', jsonInit('POST', { ids }));
}

export function forkSession(sessionId: string, title?: string) {
  return apiFetch(`/sessions/${encodeURIComponent(sessionId)}/fork`, jsonInit('POST', title ? { title } : {}));
}

/** 导出地址（浏览器按附件下载；鉴权走同源 cookie）。 */
export function sessionExportUrl(sessionId: string, format: 'json' | 'markdown') {
  return `/api/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`;
}

/** 看得见的单聊会话是否在跑、上一轮怎么结束（完成提醒的轮询兜底）。 */
export function getSessionActivity() {
  return apiFetch('/sessions/activity');
}
