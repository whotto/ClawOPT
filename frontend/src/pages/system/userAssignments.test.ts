import { describe, expect, it } from 'vitest';
import { assignableAgents, assignmentLabel } from './userAssignments';

const runtimes = [
  { id: 'claude-code', name: 'Claude Code', kind: 'cli' as const, available: true, version: '2.1.272' },
  { id: 'codex', name: 'Codex', kind: 'cli' as const, available: false, version: null },
];

describe('用户页可授权的 Agent', () => {
  it('OpenClaw Agent 来自普通会话；外部运行时单聊的会话 id 不列；外部运行时按 ext:<运行时> 列出', () => {
    const options = assignableAgents([
      { id: 's1', agentId: 'main' },
      { id: 's2', agentId: 'main' },
      { id: 'cc-1', agentId: 'cc-1', externalRuntime: 'claude-code' },
    ], runtimes);
    expect(options).toEqual([
      { id: 'main', label: 'main', kind: 'openclaw', available: true },
      { id: 'ext:claude-code', label: 'Claude Code', kind: 'external', available: true },
      { id: 'ext:codex', label: 'Codex', kind: 'external', available: false },
    ]);
  });

  it('已授权但找不到的 id 仍然列出（保存时不被悄悄丢掉）', () => {
    expect(assignableAgents([], [], ['gone', 'ext:hermes']).map((entry) => `${entry.kind}:${entry.id}`)).toEqual(['openclaw:gone', 'external:ext:hermes']);
  });

  it('卡片上外部运行时显示名字', () => {
    expect(assignmentLabel('ext:codex', runtimes)).toBe('Codex');
    expect(assignmentLabel('main', runtimes)).toBe('main');
    expect(assignmentLabel('ext:unknown', runtimes)).toBe('ext:unknown');
  });
});
