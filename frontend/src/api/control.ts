import { apiFetch, jsonInit } from './client';

// P5a 控制面接口。按资源分组，一律只返回原始 Response；解析与错误本地化在 pages/control/useControlApi.ts。

const enc = encodeURIComponent;

/** 带版本号的写入：版本号放 If-Match 头（后端也认 body.revision，这里统一走头）。 */
function withRevision(method: string, body: unknown, revision: string | null | undefined): RequestInit {
  const init = jsonInit(method, body);
  return revision ? { ...init, headers: { ...(init.headers as Record<string, string>), 'If-Match': `"${revision}"` } } : init;
}

// ---- 当前用户 / 用户与权限 ----
export const authApi = {
  me: () => apiFetch('/auth/me'),
};

export const usersApi = {
  list: () => apiFetch('/users'),
  create: (body: unknown) => apiFetch('/users', jsonInit('POST', body)),
  update: (id: number, body: unknown) => apiFetch(`/users/${id}`, jsonInit('PUT', body)),
  remove: (id: number) => apiFetch(`/users/${id}`, { method: 'DELETE' }),
  lockedIps: () => apiFetch('/auth/locked-ips'),
  unlockIp: (ip: string | null) => apiFetch('/auth/locked-ips', jsonInit('DELETE', ip ? { ip } : {})),
};

// ---- 定时任务 ----
export const cronApi = {
  status: () => apiFetch('/cron/status'),
  list: () => apiFetch('/cron/jobs'),
  create: (body: unknown) => apiFetch('/cron/jobs', jsonInit('POST', body)),
  update: (id: string, body: unknown, revision: string) => apiFetch(`/cron/jobs/${enc(id)}`, withRevision('PUT', body, revision)),
  enable: (id: string) => apiFetch(`/cron/jobs/${enc(id)}/enable`, { method: 'POST' }),
  disable: (id: string) => apiFetch(`/cron/jobs/${enc(id)}/disable`, { method: 'POST' }),
  run: (id: string) => apiFetch(`/cron/jobs/${enc(id)}/run`, { method: 'POST' }),
  remove: (id: string) => apiFetch(`/cron/jobs/${enc(id)}`, { method: 'DELETE' }),
  runs: (id: string) => apiFetch(`/cron/jobs/${enc(id)}/runs?limit=50`),
};

// ---- 引擎名册 / 克隆 / 头像 / 工作区身份文件 / 写入审批 ----
export const rosterApi = {
  engineAgents: () => apiFetch('/engine/agents'),
  clone: (agentId: string, body: { newAgentId: string; name?: string }) => apiFetch(`/agents/${enc(agentId)}/clone`, jsonInit('POST', body)),
  avatars: () => apiFetch('/agent-avatars'),
  avatarUrl: (agentId: string, version: number) => `/api/agents/${enc(agentId)}/avatar?v=${version}`,
  setAvatar: (agentId: string, dataUrl: string) => apiFetch(`/agents/${enc(agentId)}/avatar`, jsonInit('PUT', { dataUrl })),
  removeAvatar: (agentId: string) => apiFetch(`/agents/${enc(agentId)}/avatar`, { method: 'DELETE' }),
  workspaceFiles: (agentId: string) => apiFetch(`/agents/${enc(agentId)}/workspace-files`),
  workspaceFile: (agentId: string, name: string) => apiFetch(`/agents/${enc(agentId)}/workspace-files/${enc(name)}`),
  saveWorkspaceFile: (agentId: string, name: string, content: string, revision: string) =>
    apiFetch(`/agents/${enc(agentId)}/workspace-files/${enc(name)}`, withRevision('PUT', { content }, revision)),
};

export const writeGateApi = {
  settings: () => apiFetch('/write-gate/settings'),
  setEnabled: (agentId: string, enabled: boolean) => apiFetch(`/write-gate/settings/${enc(agentId)}`, jsonInit('PUT', { enabled })),
  pending: () => apiFetch('/write-gate/pending'),
  review: (id: string) => apiFetch(`/write-gate/pending/${enc(id)}`),
  approve: (id: string, body: { baseHash: string | null; proposedHash: string | null }) => apiFetch(`/write-gate/pending/${enc(id)}/approve`, jsonInit('POST', body)),
  reject: (id: string) => apiFetch(`/write-gate/pending/${enc(id)}/reject`, { method: 'POST' }),
};

// ---- 频道 / 技能 / MCP / 插件 ----
export const channelsApi = {
  list: (all: boolean) => apiFetch(`/channels${all ? '?all=1' : ''}`),
  status: () => apiFetch('/channels/status'),
  probe: () => apiFetch('/channels/probe', { method: 'POST' }),
  capabilities: (channel: string) => apiFetch(`/channels/${enc(channel)}/capabilities`),
  add: (body: unknown) => apiFetch('/channels', jsonInit('POST', body)),
  login: (channel: string, account?: string) => apiFetch(`/channels/${enc(channel)}/login`, jsonInit('POST', { account })),
  logout: (channel: string, account?: string) => apiFetch(`/channels/${enc(channel)}/logout`, jsonInit('POST', { account })),
  clearCredentials: (channel: string) => apiFetch(`/channels/${enc(channel)}/clear-credentials`, { method: 'POST' }),
  remove: (channel: string, body: { account?: string; delete: boolean }) => apiFetch(`/channels/${enc(channel)}`, jsonInit('DELETE', body)),
};

export const skillsApi = {
  list: (agent: string) => apiFetch(`/skills${agent ? `?agent=${enc(agent)}` : ''}`),
  check: (agent: string) => apiFetch(`/skills/check${agent ? `?agent=${enc(agent)}` : ''}`),
  info: (name: string, agent: string) => apiFetch(`/skills/${enc(name)}${agent ? `?agent=${enc(agent)}` : ''}`),
  search: (query: string) => apiFetch(`/skills/search?q=${enc(query)}`),
  install: (body: unknown) => apiFetch('/skills/install', jsonInit('POST', body)),
  update: (body: unknown) => apiFetch('/skills/update', jsonInit('POST', body)),
  verify: (body: unknown) => apiFetch('/skills/verify', jsonInit('POST', body)),
  setEnabled: (key: string, enabled: boolean) => apiFetch(`/skills/${enc(key)}/enabled`, jsonInit('PUT', { enabled })),
};

export const mcpApi = {
  list: () => apiFetch('/mcp/servers'),
  save: (name: string, config: unknown, options: { create: boolean; revision?: string }) =>
    apiFetch(`/mcp/servers/${enc(name)}`, withRevision('PUT', { config, create: options.create }, options.revision)),
  remove: (name: string) => apiFetch(`/mcp/servers/${enc(name)}`, { method: 'DELETE' }),
  probe: (name: string) => apiFetch(`/mcp/servers/${enc(name)}/probe`, { method: 'POST' }),
  reload: () => apiFetch('/mcp/reload', { method: 'POST' }),
};

export const pluginsApi = {
  list: (refresh: boolean) => apiFetch(`/plugins${refresh ? '?refresh=1' : ''}`),
  inspect: (id: string) => apiFetch(`/plugins/${enc(id)}`),
  enable: (id: string) => apiFetch(`/plugins/${enc(id)}/enable`, { method: 'POST' }),
  disable: (id: string) => apiFetch(`/plugins/${enc(id)}/disable`, { method: 'POST' }),
  install: (body: { spec: string; acknowledgeRisk: boolean }) => apiFetch('/plugins/install', jsonInit('POST', body)),
  update: (id: string) => apiFetch(`/plugins/${enc(id)}/update`, { method: 'POST' }),
  updateAll: () => apiFetch('/plugins/update-all', { method: 'POST' }),
  uninstall: (id: string) => apiFetch(`/plugins/${enc(id)}`, { method: 'DELETE' }),
};

// ---- 用量 / 日志 / 网关状态卡 ----
export const observabilityApi = {
  usage: (days: number) => apiFetch(`/usage/summary?days=${days}`),
  logs: (params: { source: string; level: string; q: string; limit: number }) =>
    apiFetch(`/logs?source=${enc(params.source)}&level=${enc(params.level)}&q=${enc(params.q)}&limit=${params.limit}`),
  gatewayServiceStatus: (refresh: boolean) => apiFetch(`/gateway/service-status${refresh ? '?refresh=1' : ''}`),
};

// ---- 模型与服务商补强 ----
export const providersApi = {
  catalog: (id: string) => apiFetch(`/providers/${enc(id)}/catalog`),
  refreshCatalog: (id: string, confirm: boolean) => apiFetch(`/providers/${enc(id)}/catalog/refresh`, jsonInit('POST', { confirm })),
  restoreCatalog: (id: string) => apiFetch(`/providers/${enc(id)}/catalog/restore`, { method: 'POST' }),
  setVisibility: (id: string, body: { mode: 'all' | 'include'; models: string[] }) => apiFetch(`/providers/${enc(id)}/visibility`, jsonInit('PUT', body)),
  setContextLengths: (id: string, contextLengths: Record<string, number | null>, revision: string) =>
    apiFetch(`/providers/${enc(id)}/context-lengths`, withRevision('PUT', { contextLengths }, revision)),
  audit: (limit: number) => apiFetch(`/providers/audit?limit=${limit}`),
  aliases: () => apiFetch('/models/aliases'),
  setAlias: (alias: string, model: string) => apiFetch(`/models/aliases/${enc(alias)}`, jsonInit('PUT', { model })),
  removeAlias: (alias: string) => apiFetch(`/models/aliases/${enc(alias)}`, { method: 'DELETE' }),
};
