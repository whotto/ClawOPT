import { describe, expect, it } from 'vitest';
import { nodeModes, nodeRuntimeSummary, pickAgentPatch, switchNodeMode } from './nodeRuntime';
import type { AgentEntry } from './types';

const codex: AgentEntry = { ref: { kind: 'external', id: 'codex', runtime: 'codex' }, name: 'Codex', available: true, skills: [], modes: ['global', 'scoped'] };
const pi: AgentEntry = { ref: { kind: 'external', id: 'pi', runtime: 'pi' }, name: 'Pi', available: true, skills: [], modes: ['global'], approvals: true };
const main: AgentEntry = { ref: { kind: 'openclaw', id: 'main' }, name: 'Main', available: true, skills: [] };

describe('工作流节点的运行时选择', () => {
  it('模式来自名册能力；OpenClaw 与没给能力的只有 global', () => {
    expect(nodeModes(codex)).toEqual(['global', 'scoped']);
    expect(nodeModes(pi)).toEqual(['global']);
    expect(nodeModes(main)).toEqual(['global']);
    expect(nodeModes({ ...codex, modes: undefined })).toEqual(['global']);
  });

  it('换 Agent 清模型；同一个运行时重选保留模式与模型；目标不支持的模式丢掉', () => {
    const scopedCodex = { agent: { kind: 'external' as const, id: 'codex', runtime: 'codex', mode: 'scoped' as const }, model: 'vllm/m' };
    expect(pickAgentPatch(scopedCodex, codex)).toEqual(scopedCodex);
    expect(pickAgentPatch(scopedCodex, pi)).toEqual({ agent: { kind: 'external', id: 'pi', runtime: 'pi' }, model: undefined });
    expect(pickAgentPatch(scopedCodex, main)).toEqual({ agent: { kind: 'openclaw', id: 'main' }, model: undefined });
  });

  it('切模式清模型（两种模式的模型名不通用），global 不写 mode 键', () => {
    const globalCodex = { agent: { kind: 'external' as const, id: 'codex', runtime: 'codex' }, model: 'gpt-5.4' };
    expect(switchNodeMode(globalCodex, 'scoped')).toEqual({ agent: { kind: 'external', id: 'codex', runtime: 'codex', mode: 'scoped' }, model: undefined });
    expect(switchNodeMode({ agent: { kind: 'external', id: 'codex', runtime: 'codex', mode: 'scoped' }, model: 'vllm/m' }, 'global')).toEqual({ agent: { kind: 'external', id: 'codex', runtime: 'codex' }, model: undefined });
    expect(switchNodeMode(globalCodex, 'global')).toEqual(globalCodex);
  });

  it('只读摘要', () => {
    const label = (mode: string) => (mode === 'scoped' ? '托管' : '全局');
    expect(nodeRuntimeSummary({ agent: { kind: 'external', id: 'codex', mode: 'scoped' }, model: 'vllm/m' }, codex, label)).toBe('Codex · 托管 · vllm/m');
    expect(nodeRuntimeSummary({ agent: { kind: 'openclaw', id: 'main' } }, main, label)).toBe('Main');
  });
});
