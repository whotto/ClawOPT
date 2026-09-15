/**
 * 工作流节点名册：外部运行时从运行时平台登记处取（不是另一份清单），可用性按本机检测与模式判。
 */
import { describe, expect, it } from 'vitest';

import { createAgentDirectory } from '../../src/automation/runner/agent-directory';

function directory(installed: Record<string, boolean>) {
  const refreshed: string[] = [];
  const dir = createAgentDirectory({
    sessionManager: { getAllSessions: () => [{ id: 's1', name: 'Main', agentId: 'main' }, { id: 'cc-1', name: 'CC chat', agentId: 'cc-1', external_runtime: 'claude-code' }] as any },
    workspacePathFor: () => '/nonexistent',
    homeDir: '/nonexistent',
    runtimes: {
      list: () => [
        { id: 'codex', name: 'Codex', modes: ['global', 'scoped'], approvals: false },
        { id: 'pi', name: 'Pi', modes: ['global', 'scoped'], approvals: true },
        { id: 'global-only', name: 'Global only', modes: ['global'], approvals: false },
      ],
      installed: (id) => installed[id] === true,
      refresh: async () => { refreshed.push('all'); },
    },
  });
  return { dir, refreshed };
}

describe('节点名册', () => {
  it('列表：OpenClaw Agent + 登记处的运行时（带模式与审批能力），刷新检测后再列', async () => {
    const { dir, refreshed } = directory({ codex: true, pi: false, 'global-only': true });
    const list = await dir.list();
    expect(refreshed).toEqual(['all']);
    expect(list.filter((entry) => entry.ref.kind === 'openclaw').map((entry) => entry.ref.id)).toEqual(['main']);
    expect(list.map((entry) => `${entry.ref.kind}:${entry.ref.id}:${entry.available}`)).toEqual(expect.arrayContaining(['external:codex:true', 'external:pi:false', 'external:global-only:true']));
    expect(list.find((entry) => entry.ref.id === 'pi')).toMatchObject({ modes: ['global', 'scoped'], approvals: true, reason: 'runtime pi is not installed on this host' });
  });

  it('可用性：没登记的运行时、本机没装、模式不支持各自说清楚', () => {
    const { dir } = directory({ codex: true, 'global-only': true });
    expect(dir.availability({ kind: 'external', id: 'grok', runtime: 'grok' })).toEqual({ available: false, reason: 'runtime grok has no adapter' });
    expect(dir.availability({ kind: 'external', id: 'pi', runtime: 'pi' })).toMatchObject({ available: false });
    expect(dir.availability({ kind: 'external', id: 'codex', runtime: 'codex', mode: 'scoped' })).toEqual({ available: true });
    expect(dir.availability({ kind: 'external', id: 'global-only', runtime: 'global-only', mode: 'scoped' })).toEqual({ available: false, reason: 'runtime global-only does not support scoped mode' });
  });
});
