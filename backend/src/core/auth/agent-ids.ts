/**
 * 授权里的「Agent」id 形状（用户 ↔ Agent 授权表 `user_agents.agent_id` 与判定共用）。
 *
 * - OpenClaw Agent：角色 id 本身（`main`、`writer`…）；
 * - 外部运行时：**伪 Agent id `ext:<运行时>`**（`ext:claude-code`、`ext:codex`…）。授权它 = 授权这个运行时在所有表面上的活动：
 *   该运行时的外部运行时单聊（会话行 `external_runtime`）、群里用该运行时的成员、工作流里该运行时的节点、看板里该运行时负责的任务。
 *
 * 表面上出现的外部运行时 id 带着后缀（群成员 `ext:<运行时>:<成员 Agent>`、工作流节点 `ext:<运行时>:workflow`），
 * 判定前一律归一成 `ext:<运行时>`。授权表里只有归一形状才生效：写进 `ext:claude-code:workflow` 这种带后缀的 id 不授权任何东西。
 */

export const EXTERNAL_RUNTIME_AGENT_PREFIX = 'ext:';

/** 运行时 id → 可授权的伪 Agent id。 */
export function externalRuntimeAgentId(runtime: string): string {
  return `${EXTERNAL_RUNTIME_AGENT_PREFIX}${runtime}`;
}

/** 表面上的 Agent id → 授权判定用的 id（外部运行时归一到 `ext:<运行时>`，其余原样）。 */
export function accessAgentId(agentId: string): string {
  if (!agentId.startsWith(EXTERNAL_RUNTIME_AGENT_PREFIX)) return agentId;
  const rest = agentId.slice(EXTERNAL_RUNTIME_AGENT_PREFIX.length);
  const runtime = rest.split(':', 1)[0];
  return runtime ? externalRuntimeAgentId(runtime) : agentId;
}

/** 群成员 → 授权判定用的 id：OpenClaw 成员是它的 Agent，外部成员（含远程 OpenClaw）是 `ext:<运行时>`。 */
export function groupMemberAccessAgentId(member: { agent_id?: string; agentId?: string; runtime?: string | null }): string {
  const runtime = member.runtime && member.runtime !== 'openclaw' ? member.runtime : null;
  return runtime ? externalRuntimeAgentId(runtime) : String(member.agent_id ?? member.agentId ?? '');
}

/** 单聊会话 → 授权判定用的 id：外部运行时单聊是 `ext:<运行时>`，其余是会话的 Agent。 */
export function chatSessionAccessAgentId(session: { agentId: string; external_runtime?: string | null }): string {
  return session.external_runtime ? externalRuntimeAgentId(session.external_runtime) : session.agentId;
}
