/**
 * 每个运行时的 ClawOPT MCP 服务设置：开关、启用的工具集、可委派的目标 Agent。
 *
 * 缺省**关闭**：给一个外部 CLI 发能调 ClawOPT 的令牌是显式决定，由管理员在界面上打开，不因为升级悄悄生效。
 */
import type Database from 'better-sqlite3';

export const MCP_TOOLSETS = ['use', 'memory', 'api'] as const;
export type McpToolset = (typeof MCP_TOOLSETS)[number];
/** 打开时缺省启用的工具集。 */
export const DEFAULT_ENABLED_TOOLSETS: McpToolset[] = ['use', 'memory'];

export type McpRuntimeSettings = {
  runtime: string;
  enabled: boolean;
  toolsets: McpToolset[];
  delegateAgents: string[];
  updatedAt: number | null;
};

type Row = { runtime: string; enabled: number; toolsets_json: string; delegate_agents_json: string; updated_at: number };

const AGENT_REF = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;

function parseJsonList(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export class McpSettingsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'McpSettingsError';
  }
}

export function normalizeToolsets(value: unknown): McpToolset[] {
  if (!Array.isArray(value)) throw new McpSettingsError('mcpServer.invalidToolsets');
  const out: McpToolset[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(MCP_TOOLSETS as readonly string[]).includes(item)) throw new McpSettingsError('mcpServer.invalidToolsets');
    if (!out.includes(item as McpToolset)) out.push(item as McpToolset);
  }
  return out;
}

export function normalizeDelegateAgents(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw new McpSettingsError('mcpServer.invalidDelegateAgents');
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !AGENT_REF.test(item.trim())) throw new McpSettingsError('mcpServer.invalidDelegateAgents');
    if (!out.includes(item.trim())) out.push(item.trim());
  }
  return out;
}

export function createMcpSettingsStore(db: Database.Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;

  function get(runtime: string): McpRuntimeSettings {
    const row = db.prepare('SELECT * FROM mcp_server_settings WHERE runtime = ?').get(runtime) as Row | undefined;
    if (!row) return { runtime, enabled: false, toolsets: [...DEFAULT_ENABLED_TOOLSETS], delegateAgents: [], updatedAt: null };
    const toolsets = parseJsonList(row.toolsets_json).filter((item): item is McpToolset => (MCP_TOOLSETS as readonly string[]).includes(item));
    return { runtime, enabled: row.enabled === 1, toolsets, delegateAgents: parseJsonList(row.delegate_agents_json), updatedAt: row.updated_at };
  }

  function save(runtime: string, input: { enabled: unknown; toolsets: unknown; delegateAgents?: unknown }): McpRuntimeSettings {
    if (typeof input.enabled !== 'boolean') throw new McpSettingsError('mcpServer.invalidEnabled');
    const toolsets = normalizeToolsets(input.toolsets);
    const delegateAgents = normalizeDelegateAgents(input.delegateAgents);
    db.prepare(`INSERT INTO mcp_server_settings (runtime, enabled, toolsets_json, delegate_agents_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(runtime) DO UPDATE SET enabled = excluded.enabled, toolsets_json = excluded.toolsets_json, delegate_agents_json = excluded.delegate_agents_json, updated_at = excluded.updated_at`)
      .run(runtime, input.enabled ? 1 : 0, JSON.stringify(toolsets), JSON.stringify(delegateAgents), now());
    return get(runtime);
  }

  return { get, save };
}

export type McpSettingsStore = ReturnType<typeof createMcpSettingsStore>;
