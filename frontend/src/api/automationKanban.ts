import { apiFetch, jsonInit } from './client';

// 原生看板与出站 Webhook 管理。只返回原始 Response。

export const listBoards = () => apiFetch('/kanban/boards');
export const createBoard = (body: unknown) => apiFetch('/kanban/boards', jsonInit('POST', body));
export const updateBoard = (boardId: string, body: unknown) => apiFetch(`/kanban/boards/${encodeURIComponent(boardId)}`, jsonInit('PATCH', body));
export const listTasks = (boardId: string, query: { status?: string; assignee?: string; q?: string }) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const suffix = params.toString() ? `?${params}` : '';
  return apiFetch(`/kanban/boards/${encodeURIComponent(boardId)}/tasks${suffix}`);
};
export const createTask = (boardId: string, body: unknown) => apiFetch(`/kanban/boards/${encodeURIComponent(boardId)}/tasks`, jsonInit('POST', body));
export const getTask = (taskId: string) => apiFetch(`/kanban/tasks/${encodeURIComponent(taskId)}`);
export const updateTask = (taskId: string, body: unknown) => apiFetch(`/kanban/tasks/${encodeURIComponent(taskId)}`, jsonInit('PATCH', body));
export const taskAction = (taskId: string, body: { action: string; [key: string]: unknown }) =>
  apiFetch(`/kanban/tasks/${encodeURIComponent(taskId)}/actions`, jsonInit('POST', body));
export const addTaskComment = (taskId: string, body: string) => apiFetch(`/kanban/tasks/${encodeURIComponent(taskId)}/comments`, jsonInit('POST', { body }));
export const bulkTasks = (body: unknown) => apiFetch('/kanban/tasks/bulk', jsonInit('POST', body));
export const linkTasks = (parentId: string, childId: string) => apiFetch('/kanban/links', jsonInit('POST', { parent_id: parentId, child_id: childId }));
export const unlinkTasks = (parentId: string, childId: string) => apiFetch('/kanban/links', jsonInit('DELETE', { parent_id: parentId, child_id: childId }));

export const listWebhookEventTypes = () => apiFetch('/webhooks/event-types');
export const listWebhookEndpoints = () => apiFetch('/webhooks/endpoints');
export const createWebhookEndpoint = (body: unknown) => apiFetch('/webhooks/endpoints', jsonInit('POST', body));
export const updateWebhookEndpoint = (id: string, body: unknown) => apiFetch(`/webhooks/endpoints/${encodeURIComponent(id)}`, jsonInit('PATCH', body));
export const deleteWebhookEndpoint = (id: string) => apiFetch(`/webhooks/endpoints/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const testWebhookEndpoint = (id: string) => apiFetch(`/webhooks/endpoints/${encodeURIComponent(id)}/test`, { method: 'POST' });
export const listWebhookDeliveries = (id: string) => apiFetch(`/webhooks/endpoints/${encodeURIComponent(id)}/deliveries`);
export const getWebhookLocalTestTarget = () => apiFetch('/webhooks/local-test-target');
export const listWebhookLocalTestEvents = () => apiFetch('/webhooks/local-test-events');
export const clearWebhookLocalTestEvents = () => apiFetch('/webhooks/local-test-events', { method: 'DELETE' });
