// 工作流节点的运行时选择（纯函数）：换 Agent / 换模式时哪些值要清掉，节点上怎么显示。
// 选项来自后端节点名册（外部运行时 = 运行时平台登记处），与群成员运行时、外部运行时单聊同一套取值。
import type { AgentEntry, AgentRef, WorkflowNodeData } from './types';

export type NodeRuntimeMode = 'global' | 'scoped';

/** 这个 Agent 支持的模式；OpenClaw 与老后端（没给 modes）只有 global。 */
export function nodeModes(entry: AgentEntry | undefined): NodeRuntimeMode[] {
  if (!entry || entry.ref.kind !== 'external') return ['global'];
  const modes = (entry.modes ?? []).filter((mode): mode is NodeRuntimeMode => mode === 'global' || mode === 'scoped');
  return modes.length ? modes : ['global'];
}

/**
 * 选中名册里的一项 → 节点的 agent / model 补丁。换了 Agent，模型绑定一律清掉（不同运行时的模型名不通用）；
 * 同一个外部运行时重选时保留模式与模型。
 */
export function pickAgentPatch(current: Pick<WorkflowNodeData, 'agent' | 'model'>, entry: AgentEntry): Pick<WorkflowNodeData, 'agent' | 'model'> {
  if (entry.ref.kind !== 'external') return { agent: { kind: 'openclaw', id: entry.ref.id }, model: undefined };
  const same = current.agent.kind === 'external' && current.agent.id === entry.ref.id;
  const mode = same && current.agent.mode && nodeModes(entry).includes(current.agent.mode) ? current.agent.mode : undefined;
  const agent: AgentRef = { kind: 'external', id: entry.ref.id, runtime: entry.ref.id, ...(mode === 'scoped' ? { mode } : {}) };
  return { agent, model: same ? current.model : undefined };
}

/** 切模式：global 的模型是 CLI 自己的模型名，scoped 的是 `<端点>/<模型>`，两者不通用，切换时清掉。 */
export function switchNodeMode(current: Pick<WorkflowNodeData, 'agent' | 'model'>, mode: NodeRuntimeMode): Pick<WorkflowNodeData, 'agent' | 'model'> {
  const currentMode = current.agent.mode === 'scoped' ? 'scoped' : 'global';
  if (current.agent.kind !== 'external' || currentMode === mode) return { agent: current.agent, model: current.model };
  const { mode: _mode, ...rest } = current.agent;
  return { agent: mode === 'scoped' ? { ...rest, mode } : rest, model: undefined };
}

/** 只读画布上的一行：`Codex · 托管 · vllm/model`。 */
export function nodeRuntimeSummary(data: Pick<WorkflowNodeData, 'agent' | 'model'>, entry: AgentEntry | undefined, modeLabel: (mode: NodeRuntimeMode) => string): string {
  const name = entry?.name ?? data.agent.id;
  if (data.agent.kind !== 'external') return name;
  return [name, modeLabel(data.agent.mode === 'scoped' ? 'scoped' : 'global'), data.model].filter(Boolean).join(' · ');
}
