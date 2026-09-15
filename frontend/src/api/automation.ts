import { API_BASE, apiFetch, jsonInit } from './client';

// 工作流：定义、运行、证据、审批、重跑、导入导出、定时、入站钩子、设置。只返回原始 Response。

const wf = (id: string) => `/workflows/${encodeURIComponent(id)}`;

export const listWorkflows = () => apiFetch('/workflows');
export const getWorkflow = (id: string) => apiFetch(wf(id));
export const createWorkflow = (body: unknown) => apiFetch('/workflows', jsonInit('POST', body));
export const updateWorkflow = (id: string, body: unknown) => apiFetch(wf(id), jsonInit('PATCH', body));
export const deleteWorkflow = (id: string) => apiFetch(wf(id), { method: 'DELETE' });
export const batchDeleteWorkflows = (ids: string[]) => apiFetch('/workflows/batch-delete', jsonInit('POST', { ids }));

export const listWorkflowAgents = () => apiFetch('/workflows/agents');
export const listPendingWorkflowApprovals = () => apiFetch('/workflows/pending-approvals');
export const getWorkflowSettings = () => apiFetch('/workflows/settings');
export const saveWorkflowSettings = (maxConcurrentNodes: number) => apiFetch('/workflows/settings', jsonInit('PUT', { max_concurrent_nodes: maxConcurrentNodes }));

export const runWorkflow = (id: string, body: { input?: string; start_node_ids?: string[]; timeout_ms?: number | null }) =>
  apiFetch(`${wf(id)}/run`, jsonInit('POST', body));
export const listWorkflowRuns = (id: string, limit = 100) => apiFetch(`${wf(id)}/runs?limit=${limit}`);
export const getWorkflowRun = (id: string, runId: string) => apiFetch(`${wf(id)}/runs/${encodeURIComponent(runId)}`);
export const stopWorkflowRun = (id: string, runId: string) => apiFetch(`${wf(id)}/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
export const deleteWorkflowRun = (id: string, runId: string) => apiFetch(`${wf(id)}/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
export const getNodeTranscript = (id: string, runId: string, executionId: string) =>
  apiFetch(`${wf(id)}/runs/${encodeURIComponent(runId)}/transcript?executionId=${encodeURIComponent(executionId)}`);
export const resolveNodeApproval = (id: string, runId: string, nodeId: string, approved: boolean, executionId?: string) =>
  apiFetch(`${wf(id)}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approval`, jsonInit('POST', { approved, execution_id: executionId }));
export const rerunFromNode = (id: string, runId: string, body: { node_id: string; preserve_start_node: boolean; timeout_ms?: number | null }) =>
  apiFetch(`${wf(id)}/runs/${encodeURIComponent(runId)}/rerun-from-node`, jsonInit('POST', body));

/** 状态流（SSE）：先推当前状态，再推增量证据；`since` 让重连从已有序号续上。 */
export function openWorkflowEvents(id: string, since?: { runId: string; seq: number }): EventSource {
  const query = since ? `?runId=${encodeURIComponent(since.runId)}&since=${since.seq}` : '';
  return new EventSource(`${API_BASE}${wf(id)}/events${query}`);
}

export const exportWorkflow = (id: string) => apiFetch(`${wf(id)}/export`);
export const previewWorkflowImport = (documentText: string) =>
  apiFetch('/workflows/import/preview', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: documentText });
export const confirmWorkflowImport = (token: string) => apiFetch('/workflows/import/confirm', jsonInit('POST', { token }));
export const cancelWorkflowImport = (token: string) => apiFetch('/workflows/import/cancel', jsonInit('POST', { token }));

export const listSchedules = (id: string) => apiFetch(`${wf(id)}/schedules`);
export const createSchedule = (id: string, body: unknown) => apiFetch(`${wf(id)}/schedules`, jsonInit('POST', body));
export const updateSchedule = (id: string, scheduleId: string, body: unknown) => apiFetch(`${wf(id)}/schedules/${encodeURIComponent(scheduleId)}`, jsonInit('PATCH', body));
export const deleteSchedule = (id: string, scheduleId: string) => apiFetch(`${wf(id)}/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
export const listScheduleEvents = (id: string, scheduleId: string) => apiFetch(`${wf(id)}/schedules/${encodeURIComponent(scheduleId)}/events`);

export const listHooks = (id: string) => apiFetch(`${wf(id)}/hooks`);
export const createHook = (id: string, body: unknown) => apiFetch(`${wf(id)}/hooks`, jsonInit('POST', body));
export const updateHook = (id: string, hookId: string, body: unknown) => apiFetch(`${wf(id)}/hooks/${encodeURIComponent(hookId)}`, jsonInit('PATCH', body));
export const rotateHookSecret = (id: string, hookId: string) => apiFetch(`${wf(id)}/hooks/${encodeURIComponent(hookId)}/rotate-secret`, { method: 'POST' });
export const deleteHook = (id: string, hookId: string) => apiFetch(`${wf(id)}/hooks/${encodeURIComponent(hookId)}`, { method: 'DELETE' });
