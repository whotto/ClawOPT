import { describe, expect, it } from 'vitest';
import { buildDiagnosePrompt, parseRuntimeQuery, resolveApiErrorMessage, runtimeCardActions, type HostCapabilities, type RuntimeStatus } from './runtimeLogic';

const status = (over: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  id: 'opencode', name: 'OpenCode', vendor: 'SST', kind: 'cli', installKind: 'npm', installed: false, version: null, path: null,
  candidates: [], source: null, managed: false, probeError: null, probedAt: '',
  update: { state: 'unknown', currentVersion: null, latestVersion: null, checkedAt: null, error: null },
  autoUpdate: false, locked: false, preparing: 0, adapterRegistered: false, lastOperation: null,
  ...over,
});

const host = (over: Partial<HostCapabilities['gates']> = {}): HostCapabilities => ({
  platform: 'darwin', arch: 'arm64', node: 'v24', memory: { totalMb: 16000, freeMb: 8000 }, modules: { nodePty: false, sharp: true },
  tools: { git: '2', npm: '11', pnpm: null, uv: '0.12', python3: '3.11' },
  gates: { runtimeInstall: { allowed: true, reason: null }, pipRuntimes: { allowed: true, reason: null }, terminal: { allowed: false, reason: 'host.nodePtyMissing' }, ...over },
});

describe('runtimeCardActions', () => {
  it('未安装：安装 + 设置；主机闸门给出拦截原因', () => {
    expect(runtimeCardActions(status(), host())).toEqual({ actions: ['install', 'settings'], installBlockedReason: null });
    expect(runtimeCardActions(status(), host({ runtimeInstall: { allowed: false, reason: 'runtime.hostInsufficientMemory' } })).installBlockedReason).toBe('runtime.hostInsufficientMemory');
    expect(runtimeCardActions(status({ installKind: 'pip' }), host({ pipRuntimes: { allowed: false, reason: 'runtime.pythonMissing' } })).installBlockedReason).toBe('runtime.pythonMissing');
  });

  it('代管的安装：有新版显示升级，否则检查更新；都能卸载。非代管的只能检查更新', () => {
    expect(runtimeCardActions(status({ installed: true, managed: true, update: { state: 'available', currentVersion: '1', latestVersion: '2', checkedAt: null, error: null } }), host()).actions).toEqual(['update', 'uninstall', 'settings']);
    expect(runtimeCardActions(status({ installed: true, managed: true }), host()).actions).toEqual(['checkUpdate', 'uninstall', 'settings']);
    expect(runtimeCardActions(status({ installed: true, managed: false, source: 'external' }), host()).actions).toEqual(['checkUpdate', 'settings']);
    expect(runtimeCardActions(status({ kind: 'remote' }), host()).actions).toEqual([]);
  });
});

describe('buildDiagnosePrompt', () => {
  it('带上操作、命令、脱敏输出与主机信息，按语言出文案', () => {
    const prompt = buildDiagnosePrompt({
      status: status({ installed: false }),
      operation: { op: 'install', ok: false, messageCode: 'runtime.installFailed', command: 'npm install -g opencode-ai@latest', output: 'npm ERR! code EACCES', finishedAt: '' },
      errorMessage: '安装失败',
      host: host(),
      locale: 'zh-CN',
    });
    expect(prompt).toContain('OpenCode');
    expect(prompt).toContain('npm install -g opencode-ai@latest');
    expect(prompt).toContain('npm ERR! code EACCES');
    expect(prompt).toContain('可用内存 8000 MB');
    const en = buildDiagnosePrompt({ status: status(), operation: null, errorMessage: 'failed', host: null, locale: 'en' });
    expect(en).toContain('Operation: (none)');
    expect(en).not.toContain('```');
  });
});

describe('resolveApiErrorMessage / parseRuntimeQuery', () => {
  const t = (key: string) => (key === 'runtime.notManagedByClawopt' ? 'Installed outside ClawOPT' : key);
  it('能翻译的码翻译，翻不出来退回码本身', () => {
    expect(resolveApiErrorMessage({ errorCode: 'runtime.notManagedByClawopt', errorDetail: '/opt/x' }, t, 'fallback')).toEqual({ message: 'Installed outside ClawOPT', detail: '/opt/x' });
    expect(resolveApiErrorMessage({ errorCode: 'runtime.new' }, t, 'fallback').message).toBe('runtime.new');
    expect(resolveApiErrorMessage(null, t, 'fallback').message).toBe('fallback');
  });

  it('查询串只认合法的运行时 id 与分区', () => {
    expect(parseRuntimeQuery('?runtime=codex&section=mcp')).toEqual({ runtimeId: 'codex', section: 'mcp' });
    expect(parseRuntimeQuery('?runtime=../etc&section=x')).toEqual({ runtimeId: null, section: 'settings' });
  });
});
