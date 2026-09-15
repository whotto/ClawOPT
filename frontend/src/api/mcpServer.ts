import { apiFetch, jsonInit } from './client';

// ClawOPT 作为 MCP 服务（P6）的管理面。只返回原始 Response。
export type McpToolset = 'use' | 'memory' | 'api';

export type McpRuntimeSetting = {
  id: string;
  name: string;
  kind: string;
  runtime: string;
  enabled: boolean;
  toolsets: McpToolset[];
  delegateAgents: string[];
  updatedAt: number | null;
};

export type McpServerSettings = {
  runtimes: McpRuntimeSetting[];
  toolsets: McpToolset[];
  operations: Array<{ name: string; toolset: McpToolset }>;
  agentOptions: string[];
  delegationAvailable: boolean;
};

export type McpTokenView = {
  id: string;
  runId: string;
  sessionKey: string;
  agentId: string;
  runtime: string;
  surface: string;
  scope: { agentIds: string[]; sessionKeys: string[]; workflowIds: string[]; roomId: string | null; delegateAgents: string[]; delegated: boolean };
  operations: string[];
  issuedAt: number;
  expiresAt: number;
};

export type McpAuditEntry = { id: number; ts: number; tokenId: string | null; runId: string | null; runtime: string | null; agentId: string | null; operation: string; outcome: string; detail: string | null };

export const mcpServerApi = {
  settings: () => apiFetch('/mcp-server/settings'),
  saveRuntime: (runtime: string, body: { enabled: boolean; toolsets: McpToolset[]; delegateAgents: string[] }) =>
    apiFetch(`/mcp-server/runtimes/${encodeURIComponent(runtime)}`, jsonInit('PUT', body)),
  tokens: () => apiFetch('/mcp-server/tokens'),
  revokeToken: (id: string) => apiFetch(`/mcp-server/tokens/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  audit: (limit = 200) => apiFetch(`/mcp-server/audit?limit=${limit}`),
};
