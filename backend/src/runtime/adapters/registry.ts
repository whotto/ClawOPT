/**
 * 编码类外部运行时清单：唯一一处列出「ClawOPT 认识哪些编码类外部运行时」。
 *
 * 成员运行时选择器、群聊派发、运行时管理器的描述符都从适配器登记处（`adapter-registry.ts`）取，
 * 登记处里的七个编码类运行时就是从这里登记进去的——不各写一份清单。两份清单迟早分家，
 * 分家的症状是「选了但不生效」（v1.3.0）。
 */
import type { RuntimeAdapterRegistry } from '../adapter-registry';
import { createCodingAgentAdapter, type RuntimeDefinition } from './_shared/cli-adapter';
import { CLAUDE_CODE_DEFINITION } from './claude-code';
import { CODEX_DEFINITION } from './codex';
import { DSH_DEFINITION } from './dsh';
import { GROK_DEFINITION } from './grok';
import { HERMES_DEFINITION } from './hermes';
import { OPENCODE_DEFINITION } from './opencode';
import { PI_DEFINITION } from './pi';

export const CODING_AGENT_DEFINITIONS: readonly RuntimeDefinition[] = [
  CLAUDE_CODE_DEFINITION,
  CODEX_DEFINITION,
  PI_DEFINITION,
  GROK_DEFINITION,
  OPENCODE_DEFINITION,
  DSH_DEFINITION,
  HERMES_DEFINITION,
];

export function codingAgentDefinition(runtime: string): RuntimeDefinition | undefined {
  return CODING_AGENT_DEFINITIONS.find((definition) => definition.descriptor.id === runtime);
}

/** 把七个编码类运行时登记进适配器登记处（已登记的跳过：同一个进程里平台可能被组装多次，例如用例）。 */
export function registerCodingAgentAdapters(registry: RuntimeAdapterRegistry): void {
  for (const definition of CODING_AGENT_DEFINITIONS) {
    if (registry.get(definition.descriptor.id)) continue;
    registry.registerAdapter(definition.descriptor, (deps) => createCodingAgentAdapter(definition, deps), {
      capabilities: definition.capabilities,
    });
  }
}
