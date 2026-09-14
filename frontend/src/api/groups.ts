import { apiFetch, jsonInit } from './client';

export function listGroups() {
  return apiFetch('/groups');
}

export function createGroup(body: unknown) {
  return apiFetch('/groups', jsonInit('POST', body));
}

export function updateGroup(groupId: string, body: unknown) {
  return apiFetch(`/groups/${groupId}`, jsonInit('PUT', body));
}

export function deleteGroup(groupId: string) {
  return apiFetch(`/groups/${groupId}`, { method: 'DELETE' });
}

export function resetGroup(groupId: string) {
  return apiFetch(`/groups/${groupId}/reset`, { method: 'POST' });
}

export function reorderGroups(ids: string[]) {
  return apiFetch('/groups/reorder', jsonInit('POST', { ids }));
}

/** 群聊历史分页：`beforeId + limit` cursor 协议，与单聊一致。 */
export function getGroupMessages(groupId: string, params: URLSearchParams) {
  return apiFetch(`/groups/${groupId}/messages?${params.toString()}`);
}

export function searchGroupMessages(groupId: string, params: URLSearchParams) {
  return apiFetch(`/groups/${groupId}/messages/search?${params.toString()}`);
}

export function postGroupMessage(groupId: string, body: unknown) {
  return apiFetch(`/groups/${groupId}/messages`, jsonInit('POST', body));
}

export function updateGroupMessage(groupId: string, messageId: string, body: unknown) {
  return apiFetch(`/groups/${groupId}/messages/${messageId}`, jsonInit('PUT', body));
}

export function deleteGroupMessage(groupId: string, messageId: string) {
  return apiFetch(`/groups/${groupId}/messages/${messageId}`, { method: 'DELETE' });
}

export function regenerateGroupMessage(groupId: string, body: unknown) {
  return apiFetch(`/groups/${groupId}/messages/regenerate`, jsonInit('POST', body));
}

export function stopGroupRun(groupId: string) {
  return apiFetch(`/groups/${groupId}/stop`, { method: 'POST' });
}

export function getGroupActiveRun(groupId: string, signal?: AbortSignal) {
  return apiFetch(`/groups/${groupId}/active-run`, { signal });
}
