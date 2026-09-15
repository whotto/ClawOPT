import { describe, expect, it } from 'vitest';
import { diagnoseSessionId, pickDiagnoseTarget } from '../../pages/team/runtimes/runtimeLogic';
import {
  chatCapableRuntimes,
  cleanSelectionConfig,
  effectiveMode,
  groupModelsByEndpoint,
  runtimeOptionLabel,
  supportedModes,
  switchMode,
  type RuntimeOption,
} from './runtimeSelection';

const claude: RuntimeOption = { id: 'claude-code', name: 'Claude Code', kind: 'cli', available: true, version: '2.1.272', modes: ['global', 'scoped'] };
const remote: RuntimeOption = { id: 'remote-openclaw', name: 'Remote OpenClaw', kind: 'remote', available: false, version: null, modes: [] };
const t = (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}`;

describe('外部运行时选择', () => {
  it('模式按能力：后端没给就只认 global；选了不支持的回落到第一个支持的', () => {
    expect(supportedModes({ ...claude, modes: undefined })).toEqual(['global']);
    expect(effectiveMode({ ...claude, modes: ['global'] }, { mode: 'scoped' })).toBe('global');
    expect(effectiveMode(claude, { mode: 'scoped' })).toBe('scoped');
  });

  it('切模式清掉模型（scoped 的是 <端点>/<模型>，global 的是 CLI 自己的模型名）', () => {
    expect(switchMode({ mode: 'global', model: 'haiku', workingDir: '/w' }, 'scoped')).toEqual({ mode: 'scoped', workingDir: '/w' });
    expect(switchMode({ mode: 'scoped', model: 'a/b' }, 'scoped')).toEqual({ mode: 'scoped', model: 'a/b' });
  });

  it('模型按端点分组；清洗去空串、推理强度只收合法值、CLI 运行时总带模式', () => {
    expect(groupModelsByEndpoint([{ id: 'deepseek/v4', alias: 'DS' }, { id: 'deepseek/v3' }, { id: 'bare' }])).toEqual([
      { endpoint: 'deepseek', models: [{ id: 'deepseek/v4', label: 'DS (v4)' }, { id: 'deepseek/v3', label: 'v3' }] },
      { endpoint: '', models: [{ id: 'bare', label: 'bare' }] },
    ]);
    expect(cleanSelectionConfig({ model: ' ', reasoningEffort: 'turbo', workingDir: ' /srv ' }, claude)).toEqual({ workingDir: '/srv', mode: 'global' });
    expect(cleanSelectionConfig({ gatewayUrl: 'wss://x' }, remote)).toEqual({ gatewayUrl: 'wss://x' });
  });

  it('选项文案带检测状态；单聊只列本机 CLI', () => {
    expect(runtimeOptionLabel(claude, t)).toBe('groupRuntime.installedOption{"name":"Claude Code","version":"2.1.272"}');
    expect(runtimeOptionLabel({ ...claude, available: false }, t)).toBe('groupRuntime.notInstalledOption{"name":"Claude Code"}');
    expect(runtimeOptionLabel(remote, t)).toBe('groupRuntime.remoteOption');
    expect(chatCapableRuntimes([claude, remote]).map((o) => o.id)).toEqual(['claude-code']);
  });

  it('「让 AI 诊断」：选运行时时新开 / 复用固定 id 的诊断单聊；选已有会话就直接用', () => {
    expect(diagnoseSessionId('codex')).toBe('diagnose-codex');
    expect(pickDiagnoseTarget('runtime:codex', [{ id: 'main', name: 'Main' }])).toEqual({ sessionId: 'diagnose-codex', createRuntime: 'codex' });
    expect(pickDiagnoseTarget('runtime:codex', [{ id: 'diagnose-codex', name: 'Codex 诊断' }])).toEqual({ sessionId: 'diagnose-codex', createRuntime: null });
    expect(pickDiagnoseTarget('main', [])).toEqual({ sessionId: 'main', createRuntime: null });
  });
});
