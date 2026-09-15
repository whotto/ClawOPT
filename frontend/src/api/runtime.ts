import { apiFetch, jsonInit } from './client';

// 外部运行时底座：运行时管理、每运行时配置、运行时目录回收、远程 OpenClaw 成员（后端 runtime/platform-routes.ts）。

export function listRuntimes() {
  return apiFetch('/runtime/runtimes');
}

export function refreshRuntimes() {
  return apiFetch('/runtime/runtimes/refresh', { method: 'POST' });
}

export function installRuntime(id: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/install`, { method: 'POST' });
}

export function updateRuntime(id: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/update`, { method: 'POST' });
}

export function uninstallRuntime(id: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function checkRuntimeUpdate(id: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/check-update`, { method: 'POST' });
}

export function setRuntimeAutoUpdate(id: string, autoUpdate: boolean) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/update-policy`, jsonInit('PUT', { autoUpdate }));
}

export function listMemberRuntimes() {
  return apiFetch('/runtime/member-runtimes');
}

export function getRuntimeConfig(id: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/config`);
}

export function getRuntimeFile(id: string, key: 'preference' | 'config') {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/config/files/${key}`);
}

export function saveRuntimeFile(id: string, key: 'preference' | 'config', content: string, revision: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/config/files/${key}`, jsonInit('PUT', { content, revision }));
}

export function listRuntimeMcp(id: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/mcp`);
}

export function saveRuntimeMcp(id: string, text: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/mcp`, jsonInit('PUT', { text }));
}

export function deleteRuntimeMcp(id: string, name: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export function testRuntimeMcp(id: string, name: string) {
  return apiFetch(`/runtime/runtimes/${encodeURIComponent(id)}/mcp/${encodeURIComponent(name)}/test`, { method: 'POST' });
}

export function getRuntimeHomes() {
  return apiFetch('/runtime/homes');
}

export function saveRuntimeHomesSettings(idleDays: number) {
  return apiFetch('/runtime/homes/settings', jsonInit('PUT', { idleDays }));
}

export function sweepRuntimeHomes() {
  return apiFetch('/runtime/homes/sweep', { method: 'POST' });
}

export function getRemoteMemberSecret(groupId: string, agentId: string) {
  return apiFetch(`/runtime/remote-openclaw/members/${encodeURIComponent(groupId)}/${encodeURIComponent(agentId)}`);
}

export function setRemoteMemberToken(groupId: string, agentId: string, token: string) {
  return apiFetch(`/runtime/remote-openclaw/members/${encodeURIComponent(groupId)}/${encodeURIComponent(agentId)}/token`, jsonInit('PUT', { token }));
}

export function testRemoteOpenClaw(body: { gatewayUrl: string; token?: string; trustedLan: boolean; remoteAgentId?: string; groupId?: string; agentId?: string }) {
  return apiFetch('/runtime/remote-openclaw/test', jsonInit('POST', body));
}

/** 等人答复的运行审批（真审批运行时的单聊 / 群成员），服务端按用户过滤。 */
export function listRunApprovals() {
  return apiFetch('/run-approvals');
}

export function respondRunApproval(id: string, choice: string) {
  return apiFetch(`/run-approvals/${encodeURIComponent(id)}/respond`, jsonInit('POST', { choice }));
}
