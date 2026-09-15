/**
 * 引擎视角的 Agent 名册（`openclaw agents list --json`），带短缓存。
 *
 * 控制面要的是「引擎认的 Agent 与它们的工作区」：cron 的 Agent 选择器、工作区文件编辑器、
 * 写入审批的监听目录都以它为准。走 CLI 而不是自己读 `openclaw.json`，是因为名册有
 * 两种存储形状、有默认工作区推导，且 CLI 认 `--profile`（测试隔离靠它）。
 */
import { OpenClawCliError, type OpenClawCliRunner } from '../../openclaw';

export type EngineAgent = {
  id: string;
  workspace: string | null;
  agentDir: string | null;
  isDefault: boolean;
  bindings: number;
};

const CACHE_TTL_MS = 10_000;

export function normalizeEngineAgents(raw: unknown): EngineAgent[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { agents?: unknown })?.agents) ? (raw as { agents: unknown[] }).agents : [];
  const out: EngineAgent[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id) continue;
    out.push({
      id: record.id,
      workspace: typeof record.workspace === 'string' ? record.workspace : null,
      agentDir: typeof record.agentDir === 'string' ? record.agentDir : null,
      isDefault: record.isDefault === true,
      bindings: typeof record.bindings === 'number' ? record.bindings : Array.isArray(record.bindings) ? record.bindings.length : 0,
    });
  }
  return out;
}

export function createEngineRoster(deps: { openclawCli: OpenClawCliRunner; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let cache: { at: number; agents: EngineAgent[] } | null = null;
  let inflight: Promise<EngineAgent[]> | null = null;

  async function list(options: { fresh?: boolean } = {}): Promise<EngineAgent[]> {
    if (!options.fresh && cache && now() - cache.at < CACHE_TTL_MS) return cache.agents;
    if (inflight) return inflight;
    inflight = deps.openclawCli.runJson(['agents', 'list', '--json'])
      .then((raw) => {
        const agents = normalizeEngineAgents(raw);
        cache = { at: now(), agents };
        return agents;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function get(agentId: string): Promise<EngineAgent> {
    const agent = (await list()).find((entry) => entry.id === agentId) ?? (await list({ fresh: true })).find((entry) => entry.id === agentId);
    if (!agent) throw new OpenClawCliError('openclaw.notFound', `agent ${agentId} is not in the engine roster`);
    return agent;
  }

  function invalidate(): void {
    cache = null;
  }

  return { list, get, invalidate };
}

export type EngineRoster = ReturnType<typeof createEngineRoster>;
