/**
 * 编码类外部运行时登记表：唯一一处列出「ClawOPT 认识哪些外部运行时」。
 *
 * 成员运行时选择器（`GET /api/external-runtimes`）、群聊派发、运行时管理器的描述符注册都从这里取，
 * 不各写一份清单——两份清单迟早分家，分家的症状是「选了但不生效」（v1.3.0）。
 */
import type { RuntimeManager } from './_platform-types';
import { createCodingAgentAdapter, type CodingAgentRuntimeAdapter, type RuntimeDefinition } from './_shared/cli-adapter';
import type { CodingAgentAdapterDeps } from './_shared/types';
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

export type CodingAgentAdapterLookup = (runtime: string) => CodingAgentRuntimeAdapter | undefined;

/** 按同一组依赖构造全部适配器，并把描述符登记给运行时管理器。 */
export function createCodingAgentAdapters(deps: CodingAgentAdapterDeps & { manager: RuntimeManager }): CodingAgentAdapterLookup {
  const adapters = new Map<string, CodingAgentRuntimeAdapter>();
  for (const definition of CODING_AGENT_DEFINITIONS) {
    deps.manager.register(definition.descriptor);
    adapters.set(definition.descriptor.id, createCodingAgentAdapter(definition, deps));
  }
  return (runtime) => adapters.get(runtime);
}
