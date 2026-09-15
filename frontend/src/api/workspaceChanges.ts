import { apiFetch } from './client';

/** 单聊里这些助手消息挂着的工作区改动摘要（不带 patch 正文）。 */
export function listWorkspaceChanges(sessionId: string, messageIds: string[], init?: RequestInit) {
  const query = new URLSearchParams({ messageIds: messageIds.join(',') });
  return apiFetch(`/sessions/${encodeURIComponent(sessionId)}/workspace-changes?${query.toString()}`, init);
}

/** 点开某个文件时才取它的 patch。 */
export function getWorkspaceChangeFile(sessionId: string, changeId: string, fileId: number, init?: RequestInit) {
  return apiFetch(`/sessions/${encodeURIComponent(sessionId)}/workspace-changes/${encodeURIComponent(changeId)}/files/${fileId}`, init);
}
