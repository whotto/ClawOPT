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

/** 看得见的单聊会话是否在跑、上一轮怎么结束（完成提醒的轮询兜底）。 */
export function getSessionActivity() {
  return apiFetch('/sessions/activity');
}
