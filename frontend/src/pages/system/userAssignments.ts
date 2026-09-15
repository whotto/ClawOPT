// 用户页「授权的 Agent」选项：OpenClaw Agent + 外部运行时（伪 Agent id `ext:<运行时>`，与后端 core/auth/agent-ids.ts 同形）。
// 授权 `ext:claude-code` = 这个 member 能用 Claude Code 的单聊、群里的 Claude Code 成员、工作流里的 Claude Code 节点。
import type { RuntimeOption } from '../../components/runtime/runtimeSelection';

export const EXTERNAL_RUNTIME_AGENT_PREFIX = 'ext:';

export type AssignableAgent = { id: string; label: string; kind: 'openclaw' | 'external'; available: boolean };

export function externalRuntimeAgentId(runtime: string): string {
  return `${EXTERNAL_RUNTIME_AGENT_PREFIX}${runtime}`;
}

/**
 * 可授权的 Agent：
 * - OpenClaw：会话列表里的 Agent（外部运行时单聊的会话 Agent id 不是 OpenClaw Agent，授权它没有意义，不列）；
 * - 外部运行时：登记处里的全部运行时（本机没装的也能先授权，标出来）。
 * 已授权但两边都找不到的 id（Agent 被删了）仍然列出，免得保存时被悄悄丢掉。
 */
export function assignableAgents(
  sessions: Array<{ id: string; agentId?: string; externalRuntime?: string | null }>,
  runtimes: RuntimeOption[],
  assigned: string[] = [],
): AssignableAgent[] {
  const openclaw = [...new Set(sessions.filter((session) => !session.externalRuntime).map((session) => session.agentId || session.id).filter(Boolean))]
    .map((id) => ({ id, label: id, kind: 'openclaw' as const, available: true }));
  const external = runtimes.map((runtime) => ({ id: externalRuntimeAgentId(runtime.id), label: runtime.name, kind: 'external' as const, available: runtime.available }));
  const known = new Set([...openclaw, ...external].map((entry) => entry.id));
  const orphaned = assigned.filter((id) => !known.has(id)).map((id) => ({
    id,
    label: id,
    kind: id.startsWith(EXTERNAL_RUNTIME_AGENT_PREFIX) ? 'external' as const : 'openclaw' as const,
    available: false,
  }));
  return [...openclaw, ...external, ...orphaned];
}

/** 用户卡片上的授权清单：外部运行时显示运行时名。 */
export function assignmentLabel(id: string, runtimes: RuntimeOption[]): string {
  if (!id.startsWith(EXTERNAL_RUNTIME_AGENT_PREFIX)) return id;
  const runtime = runtimes.find((item) => externalRuntimeAgentId(item.id) === id);
  return runtime ? runtime.name : id;
}
