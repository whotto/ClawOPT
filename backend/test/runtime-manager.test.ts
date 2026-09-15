/**
 * 运行时管理器：子进程白名单环境（修正参考实现的泄露）、PATH 发现、准备计数与升级锁、
 * 安装 / 升级 / 卸载的命令形状、并发 409、非代管安装的拒绝、更新检查、自动升级的空闲判据。
 *
 * 真 npm / pip 不在这里跑：执行器换成脚本（`ProcessRunner`），可执行文件用临时目录里的假脚本。
 * 真机隔离 prefix 的安装卸载验证记在 P2-platform 报告里。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalRuntimeManager,
  PathAugmenter,
  compareVersions,
  sanitizeProcessOutput,
  whichAll,
  type ProcessResult,
  type ProcessRunner,
} from '../src/runtime/manager';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix = 'kb-clawopt-manager-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

function executable(file: string, body = '#!/bin/sh\necho "1.2.3"\n'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

const ok = (stdout = ''): ProcessResult => ({ code: 0, stdout, stderr: '', timedOut: false });

type Call = { command: string; args: string[]; env: NodeJS.ProcessEnv };

function scriptedRunner(handler: (call: Call) => ProcessResult | Promise<ProcessResult>): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = async (command, args, options) => {
    const call = { command, args, env: options.env };
    calls.push(call);
    return handler(call);
  };
  return { runner, calls };
}

function manager(options: { binDir: string; runner: ProcessRunner; env?: NodeJS.ProcessEnv; isRuntimeBusy?: (id: string) => boolean; now?: () => number; hostFreeMb?: number }) {
  const dataDir = tmp('kb-clawopt-manager-data-');
  return new LocalRuntimeManager({
    dataDir,
    runner: options.runner,
    platform: 'linux',
    env: { PATH: options.binDir, HOME: tmp('kb-clawopt-home-'), ...options.env },
    isRuntimeBusy: options.isRuntimeBusy,
    now: options.now,
    log: () => {},
    includeHostBins: false,
    fetchJson: async () => ({ info: { version: '0.20.0' } }),
    hostProbe: async () => ({
      probedAt: '', platform: 'linux', arch: 'x64', node: 'v', cpus: 1,
      memory: { totalMb: 4096, freeMb: options.hostFreeMb ?? 2048 },
      modules: { nodePty: false, sharp: true },
      tools: { git: '2', npm: '10', pnpm: null, uv: '0.12', python3: '3.12' },
      gates: { runtimeInstall: { allowed: true, reason: null }, pipRuntimes: { allowed: true, reason: null }, terminal: { allowed: false, reason: 'x' } },
    }),
  });
}

describe('子进程环境：白名单 + 扩充 PATH', () => {
  it('ClawOPT 进程里的凭据与业务变量不进外部 CLI；只有 PATH 被换成扩充版', async () => {
    const binDir = tmp();
    const { runner } = scriptedRunner(() => ok('/opt/fake-npm-prefix\n'));
    const m = manager({
      binDir,
      runner,
      env: {
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        OPENAI_API_KEY: 'sk-live-should-not-leak',
        CLAWOPT_DATA_DIR: '.clawopt',
        ANTHROPIC_API_KEY: 'sk-ant-leak',
        LC_ALL: 'en_US.UTF-8',
        HTTPS_PROXY: 'http://proxy.local:8080',
        npm_config_prefix: '/tmp/prefix-for-installer-only',
      },
    });
    await m.warmup();
    const env = m.childEnv({ CODEX_HOME: '/tmp/codex-home' });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAWOPT_DATA_DIR).toBeUndefined();
    expect(env.npm_config_prefix, '包管理器的配置只给安装器，不给 Agent').toBeUndefined();
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.HTTPS_PROXY).toBe('http://proxy.local:8080');
    expect(env.CODEX_HOME).toBe('/tmp/codex-home');
    const entries = env.PATH!.split(path.delimiter);
    expect(entries).toContain('/opt/fake-npm-prefix/bin');
    expect(entries.filter((entry) => entry === '/opt/fake-npm-prefix/bin')).toHaveLength(1);
    expect(entries).toContain(path.dirname(process.execPath));
    // 原 PATH 在最前：检测到的可执行文件就是 ClawOPT 起子进程时会跑的那一个。
    expect(entries[0]).toBe(binDir);
    const allowed = new Set(['PATH', 'HOME', 'LC_ALL', 'HTTPS_PROXY', 'CODEX_HOME']);
    expect(Object.keys(env).filter((key) => !allowed.has(key))).toEqual([]);
  });

  it('还没预热时的同步兜底也不带白名单外的变量', () => {
    const { runner } = scriptedRunner(() => ok(''));
    const m = manager({ binDir: tmp(), runner, env: { SECRET_TOKEN: 'x' } });
    const env = m.childEnv({});
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.PATH).toContain(path.dirname(process.execPath));
  });

  it('macOS 取登录 shell 的 PATH（只取最后一行）并与常见 bin 去重', async () => {
    const { runner, calls } = scriptedRunner((call) => (call.args[0] === 'prefix' ? ok('/usr/local\n') : ok('Welcome banner\n/Users/me/.cargo/bin:/usr/local/bin:/usr/bin')));
    const augmenter = new PathAugmenter({ runner, env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', HOME: '/Users/me' }, platform: 'darwin', home: '/Users/me' });
    const value = (await augmenter.augmentedPath()).split(':');
    expect(calls.some((call) => call.command === '/bin/zsh' && call.args.join(' ') === '-lc printf %s "$PATH"')).toBe(true);
    expect(value).toContain('/Users/me/.cargo/bin');
    expect(value.filter((entry) => entry === '/usr/local/bin')).toHaveLength(1);
    expect(value).not.toContain('Welcome banner');
  });

  it('which -a：沿 PATH 找所有可执行的同名文件，不可执行的不算', () => {
    const a = tmp();
    const b = tmp();
    executable(path.join(a, 'opencode'));
    fs.writeFileSync(path.join(b, 'opencode'), 'not executable', { mode: 0o644 });
    const c = tmp();
    executable(path.join(c, 'opencode'));
    expect(whichAll('opencode', [a, b, c].join(path.delimiter), 'linux')).toEqual([path.join(a, 'opencode'), path.join(c, 'opencode')]);
  });
});

describe('版本与脱敏', () => {
  it('预发布排在同号正式版之前，rc 按数值比', () => {
    expect(compareVersions('0.1.5-rc.2', '0.1.5-rc.10')).toBeLessThan(0);
    expect(compareVersions('0.1.5', '0.1.5-rc.10')).toBeGreaterThan(0);
    expect(compareVersions('1.18.31', '1.18.4')).toBeGreaterThan(0);
    expect(compareVersions('v2.1.272', '2.1.272')).toBe(0);
  });

  it('输出脱敏：ANSI、Bearer、sk- key、赋值、URL userinfo、家目录', () => {
    const text = '[31merror[0m Authorization: Bearer abcdefghijklmnop\nOPENAI_API_KEY=sk-proj-abcdefghijklmnop\nhttps://user:pass@registry.example/x\n/Users/me/.npm/_logs/x.log';
    const out = sanitizeProcessOutput(text, { home: '/Users/me' });
    expect(out).not.toMatch(/abcdefghijklmnop|user:pass||\/Users\/me/);
    expect(out).toContain('~/.npm/_logs/x.log');
  });
});

describe('准备计数与升级锁', () => {
  it('锁住期间 beginRun 抛 runtime.updating；有运行在准备时升级拒绝 runtime.busy', async () => {
    const prefix = tmp();
    const bin = path.join(prefix, 'bin');
    const real = executable(path.join(prefix, 'lib', 'node_modules', 'opencode-ai', 'bin', 'opencode'));
    fs.mkdirSync(bin);
    fs.symlinkSync(real, path.join(bin, 'opencode'));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runner } = scriptedRunner(async (call) => {
      if (call.args[0] === 'install') { await gate; return ok('added 1 package'); }
      if (call.args[0] === 'view') return ok('1.18.31');
      if (call.args[0] === 'prefix') return ok('/nonexistent');
      return ok('1.18.0');
    });
    const m = manager({ binDir: bin, runner });

    const done = m.beginRun('opencode');
    await expect(m.install('opencode', { mode: 'update' })).rejects.toMatchObject({ messageCode: 'runtime.busy', status: 409 });
    done();

    const updating = m.install('opencode', { mode: 'update' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => m.beginRun('opencode')).toThrow(expect.objectContaining({ messageCode: 'runtime.updating' }));
    await expect(m.install('opencode', { mode: 'update' })).rejects.toMatchObject({ messageCode: 'runtime.operationInProgress', status: 409 });
    release();
    await updating;
    expect(() => m.beginRun('opencode')()).not.toThrow();
  });
});

describe('安装 / 升级 / 卸载', () => {
  function npmPrefixFixture() {
    const prefix = tmp('kb-clawopt-npmprefix-');
    const bin = path.join(prefix, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const install = () => {
      const real = executable(path.join(prefix, 'lib', 'node_modules', 'opencode-ai', 'bin', 'opencode'), '#!/bin/sh\necho "1.18.31"\n');
      if (!fs.existsSync(path.join(bin, 'opencode'))) fs.symlinkSync(real, path.join(bin, 'opencode'));
    };
    const uninstall = () => {
      fs.rmSync(path.join(bin, 'opencode'), { force: true });
      fs.rmSync(path.join(prefix, 'lib'), { recursive: true, force: true });
    };
    return { prefix, bin, install, uninstall };
  }

  it('npm：官方源 + @latest（不钉版本）；安装器环境带 npm_config_*；装完探测到版本与 npm-global 来源；卸载按 prefix', async () => {
    const fixture = npmPrefixFixture();
    const { runner, calls } = scriptedRunner((call) => {
      if (call.args[0] === 'install') { fixture.install(); return ok('added 1 package'); }
      if (call.args[0] === 'uninstall') { fixture.uninstall(); return ok('removed 1 package'); }
      if (call.args[0] === 'view') return ok('1.18.31\n');
      if (call.args[0] === 'prefix') return ok(`${fixture.prefix}\n`);
      if (call.command.endsWith('opencode')) return ok('1.18.31');
      return ok('');
    });
    const m = manager({ binDir: fixture.bin, runner, env: { npm_config_prefix: fixture.prefix } });

    expect((await m.status('opencode')).installed).toBe(false);
    const installed = await m.install('opencode');
    const installCall = calls.find((call) => call.args[0] === 'install')!;
    expect(installCall.args).toEqual(['install', '-g', 'opencode-ai@latest', '--registry=https://registry.npmjs.org']);
    expect(installCall.env.npm_config_prefix).toBe(fixture.prefix);
    expect(installed.status).toMatchObject({ installed: true, version: '1.18.31', source: 'npm-global', managed: true });
    expect(installed.operation).toMatchObject({ op: 'install', ok: true, command: 'npm install -g opencode-ai@latest --registry=https://registry.npmjs.org' });
    expect(installed.status.update.state).toBe('current');

    const removed = await m.uninstall('opencode');
    const uninstallCall = calls.find((call) => call.args[0] === 'uninstall')!;
    expect(uninstallCall.args).toEqual(['uninstall', '-g', '--prefix', fixture.prefix, 'opencode-ai']);
    expect(removed.status.installed).toBe(false);
  });

  it('装完仍找不到命令 → runtime.installedButNotFound；失败输出脱敏', async () => {
    const binDir = tmp();
    const { runner } = scriptedRunner((call) => {
      if (call.args[0] === 'install' && call.args[2] === '@xai-official/grok@latest') return { code: 1, stdout: '', stderr: 'npm ERR! 403 token sk-ant-secretsecretsecret', timedOut: false };
      if (call.args[0] === 'prefix') return ok('/nonexistent');
      return ok('added 1 package');
    });
    const m = manager({ binDir, runner });
    await expect(m.install('opencode')).rejects.toMatchObject({ messageCode: 'runtime.installedButNotFound' });
    const failed = await m.install('grok').catch((error) => error);
    expect(failed.messageCode).toBe('runtime.installFailed');
    expect(failed.detail).toContain('npm ERR! 403');
    expect(failed.detail).not.toContain('secretsecret');
    expect(m.lastOperation('grok')).toMatchObject({ ok: false, messageCode: 'runtime.installFailed' });
  });

  it('不是 ClawOPT 代管的安装（如 Homebrew cask）升级与卸载一律拒绝', async () => {
    const binDir = tmp();
    executable(path.join(binDir, 'codex'), '#!/bin/sh\necho "codex-cli 0.153.4"\n');
    const { runner } = scriptedRunner((call) => (call.command.endsWith('codex') ? ok('codex-cli 0.153.4') : ok('/nonexistent')));
    const m = manager({ binDir, runner });
    expect(await m.status('codex')).toMatchObject({ installed: true, version: '0.153.4', source: 'external', managed: false });
    await expect(m.install('codex', { mode: 'update' })).rejects.toMatchObject({ messageCode: 'runtime.notManagedByClawopt', status: 409 });
    await expect(m.uninstall('codex')).rejects.toMatchObject({ messageCode: 'runtime.notManagedByClawopt' });
  });

  it('pip 运行时装进数据目录里的 venv（uv），从不调系统 pip', async () => {
    const binDir = tmp();
    const uv = executable(path.join(binDir, 'uv'));
    const { runner, calls } = scriptedRunner((call) => {
      if (call.command === uv && call.args[0] === 'pip') {
        const python = call.args[call.args.indexOf('--python') + 1];
        executable(path.join(path.dirname(python), 'hermes'), '#!/bin/sh\necho "Hermes Agent v0.19.0 (2026-09-01)"\n');
      }
      if (call.command.endsWith('hermes')) return ok('Hermes Agent v0.19.0 (2026-09-01)');
      return ok('/nonexistent');
    });
    const m = manager({ binDir, runner });
    const result = await m.install('hermes');
    const uvCalls = calls.filter((call) => call.command === uv);
    expect(uvCalls[0].args.slice(0, 3)).toEqual(['venv', '--python', '>=3.11,<3.14']);
    expect(uvCalls[0].args[3]).toMatch(/runtime-data-|kb-clawopt-manager-data-.*venvs\/hermes$/);
    expect(uvCalls[1].args).toEqual(['pip', 'install', '--python', path.join(uvCalls[0].args[3], 'bin', 'python'), '--upgrade', 'hermes-agent']);
    expect(calls.some((call) => /(^|\/)pip3?$/.test(call.command))).toBe(false);
    expect(result.status).toMatchObject({ installed: true, version: '0.19.0', source: 'managed-venv', managed: true });
    expect(result.status.update).toMatchObject({ state: 'available', latestVersion: '0.20.0' });
  });

  it('可用内存不足时拒绝安装', async () => {
    const { runner } = scriptedRunner(() => ok('/nonexistent'));
    const m = manager({ binDir: tmp(), runner, hostFreeMb: 120 });
    await expect(m.install('opencode')).rejects.toMatchObject({ messageCode: 'runtime.hostInsufficientMemory' });
  });
});

describe('更新检查与自动升级', () => {
  it('查失败报 failed 不报 current；预发布只对 prereleaseAware 的运行时算升级', async () => {
    const binDir = tmp();
    executable(path.join(binDir, 'dsh'));
    executable(path.join(binDir, 'pi'));
    let viewFails = true;
    const { runner } = scriptedRunner((call) => {
      if (call.args[0] === 'view') return viewFails ? { code: 1, stdout: '', stderr: 'ETIMEDOUT', timedOut: false } : ok(call.args[1] === '@deepseek-ai/dsh' ? '0.1.5-rc.2' : '0.86.0-beta.1');
      if (call.command.endsWith('dsh')) return ok('0.1.5-rc.1');
      if (call.command.endsWith('pi')) return ok('0.85.1');
      return ok('/nonexistent');
    });
    const m = manager({ binDir, runner });
    expect((await m.checkUpdate('dsh')).state).toBe('failed');
    viewFails = false;
    expect(await m.checkUpdate('dsh')).toMatchObject({ state: 'available', currentVersion: '0.1.5-rc.1', latestVersion: '0.1.5-rc.2' });
    expect(await m.checkUpdate('pi')).toMatchObject({ state: 'current', latestVersion: '0.86.0-beta.1' });
  });

  it('只在连续空闲 60 秒且活动版本号没变时自动升级；期间有运行开始就重新计时；关掉策略就不装', async () => {
    const prefix = tmp('kb-clawopt-npmprefix-');
    const bin = path.join(prefix, 'bin');
    fs.mkdirSync(bin);
    const real = executable(path.join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    fs.symlinkSync(real, path.join(bin, 'codex'));
    let now = 100_000_000;
    let busy = false;
    const { runner, calls } = scriptedRunner((call) => {
      if (call.args[0] === 'view') return ok('0.154.0');
      if (call.args[0] === 'install') return ok('changed 1 package');
      if (call.args[0] === 'prefix') return ok('/nonexistent');
      return ok(calls.some((c) => c.args[0] === 'install') ? '0.154.0' : '0.153.4');
    });
    const m = manager({ binDir: bin, runner, now: () => now, isRuntimeBusy: () => busy });
    m.setAutoUpdate('codex', true);
    const installs = () => calls.filter((call) => call.args[0] === 'install').length;

    await m.tick();
    expect(m.updateStatuses().codex.state).toBe('waiting');
    busy = true;
    now += 61_000;
    await m.tick();
    expect(installs()).toBe(0);
    busy = false;
    await m.tick(); // 重新开始计时
    now += 30_000;
    const release = m.beginRun('codex');
    release();
    now += 31_000;
    await m.tick(); // 活动版本号变了：再次重新计时
    expect(installs()).toBe(0);
    now += 61_000;
    m.setAutoUpdate('codex', false);
    await m.tick();
    expect(installs()).toBe(0);
    m.setAutoUpdate('codex', true);
    await m.tick();
    now += 61_000;
    await m.tick();
    expect(installs()).toBe(1);
    expect(m.updateStatuses().codex).toMatchObject({ state: 'current', currentVersion: '0.154.0', autoUpdate: true });
  });

  it('同一拍里更新检查还在进行时关掉策略：上锁前的同步复查拦住安装', async () => {
    const prefix = tmp('kb-clawopt-npmprefix-');
    const bin = path.join(prefix, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(executable(path.join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')), path.join(bin, 'codex'));
    let now = 100_000_000;
    let gate: Promise<void> | null = null;
    let viewStarted: () => void = () => {};
    const { runner, calls } = scriptedRunner(async (call) => {
      if (call.args[0] === 'view') {
        viewStarted();
        if (gate) await gate;
        return ok('0.154.0');
      }
      if (call.args[0] === 'install') return ok('changed 1 package');
      if (call.args[0] === 'prefix') return ok('/nonexistent');
      return ok('0.153.4');
    });
    const m = manager({ binDir: bin, runner, now: () => now });
    m.setAutoUpdate('codex', true);
    await m.tick(); // 检查 → available → 开始计空闲
    now += 7 * 60 * 60 * 1000; // 空闲早已超过 60 秒，且到了下一次更新检查的时间
    let release: () => void = () => {};
    gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { viewStarted = resolve; });
    const ticking = m.tick();
    await started;
    m.setAutoUpdate('codex', false); // 检查还没回来时关掉
    release();
    await ticking;
    expect(calls.filter((call) => call.args[0] === 'install')).toHaveLength(0);
  });
});
