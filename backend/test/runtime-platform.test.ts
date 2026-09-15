/**
 * 外部运行时底座的其余几块：每运行时配置页（凭据不出服务端、版本号、认证文件只报在不在）、
 * 运行时目录回收、远程 OpenClaw 成员（地址策略、只写令牌、适配器失败带 messageCode、群聊派发走登记处）、
 * 成员配置清洗。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroupChatEngine } from '../src/collab/rooms/group-chat-engine';
import { RealtimeHub } from '../src/core/realtime';
import { RunCoordinator } from '../src/runtime/coordinator';
import {
  RuntimeAdapterRegistry,
  RemoteMemberSecretStore,
  createRemoteOpenClawRuntimeAdapter,
  registerBuiltinAdapters,
  sanitizeMemberExternalConfig,
  testRemoteOpenClawConnection,
} from '../src/runtime';
import {
  BUILTIN_RUNTIME_DESCRIPTORS,
  RuntimeHomes,
  authFilePresence,
  listMcpServers,
  listSkills,
  readNativeFile,
  saveMcpServers,
  writeNativeFile,
} from '../src/runtime/manager';
import { FakeGatewayClient } from './helpers/fake-gateway';
import { MemoryRunStore } from './helpers/scripted-adapter';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tmp(prefix = 'kb-clawopt-platform-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}
const descriptor = (id: string) => BUILTIN_RUNTIME_DESCRIPTORS.find((d) => d.id === id)!;

describe('每运行时配置页：原生文件', () => {
  it('凭据值换成标记再出服务端；保存时按序号从磁盘换回；标记对不上 400；版本号不符 412', () => {
    const home = tmp();
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const original = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-verysecretvalue', ANTHROPIC_BASE_URL: 'https://gw.example' }, apiKeyHelper: '/usr/local/bin/key-helper', model: 'opus' }, null, 2);
    fs.writeFileSync(settings, original, { mode: 0o600 });

    const view = readNativeFile(descriptor('claude-code'), 'config', { home });
    expect(view.path).toBe('~/.claude/settings.json');
    expect(view.exists).toBe(true);
    expect(view.content).not.toContain('verysecretvalue');
    expect(view.content).not.toContain('/usr/local/bin/key-helper');
    expect(view.content).toContain('"ANTHROPIC_BASE_URL": "https://gw.example"');
    expect(view.redactedCount).toBe(2);

    const edited = view.content.replace('"model": "opus"', '"model": "sonnet"');
    const saved = writeNativeFile(descriptor('claude-code'), 'config', { content: edited, revision: view.revision }, { home });
    const onDisk = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(onDisk).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-verysecretvalue', ANTHROPIC_BASE_URL: 'https://gw.example' }, apiKeyHelper: '/usr/local/bin/key-helper', model: 'sonnet' });
    expect(fs.statSync(settings).mode & 0o777).toBe(0o600);

    expect(() => writeNativeFile(descriptor('claude-code'), 'config', { content: edited, revision: view.revision }, { home })).toThrow(expect.objectContaining({ messageCode: 'REVISION_CONFLICT', status: 412 }));
    expect(() => writeNativeFile(descriptor('claude-code'), 'config', { content: saved.content.replace('<clawopt:redacted:1>', '<clawopt:redacted:9>'), revision: saved.revision }, { home })).toThrow(expect.objectContaining({ messageCode: 'runtimeConfig.redactionMismatch', status: 400 }));
    expect(() => writeNativeFile(descriptor('claude-code'), 'config', { content: '{ broken', revision: saved.revision }, { home })).toThrow(expect.objectContaining({ messageCode: 'runtimeConfig.invalidJson' }));
    expect(fs.readFileSync(settings, 'utf-8')).not.toContain('redacted');
  });

  it('TOML / dotenv 形状的凭据同样抹掉；还没创建的文件报 exists=false，可以新建；CODEX_HOME 覆盖路径', () => {
    const home = tmp();
    const codexHome = tmp('kb-clawopt-codex-home-');
    const env = { HOME: home, CODEX_HOME: codexHome };
    const absent = readNativeFile(descriptor('codex'), 'config', { home, env });
    expect(absent).toMatchObject({ exists: false, content: '', path: path.join(codexHome, 'config.toml') });
    writeNativeFile(descriptor('codex'), 'config', { content: 'model = "gpt-5"\n[model_providers.x]\nexperimental_bearer_token = "cwp_abcdefghijklmnop"\n', revision: absent.revision }, { home, env });
    const view = readNativeFile(descriptor('codex'), 'config', { home, env });
    expect(view.content).toContain('experimental_bearer_token = "<clawopt:redacted:0>"');
    const hermesHome = path.join(home, '.hermes');
    fs.mkdirSync(hermesHome);
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: x\n  api_key: sk-hermes-abcdefghijk\nmcp_servers:\n  fs:\n    command: npx\n');
    expect(readNativeFile(descriptor('hermes'), 'config', { home, env: { HOME: home } }).content).toContain('api_key: <clawopt:redacted:0>');
  });

  it('认证文件只报在不在；技能目录只列名字，共用目录标只读', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"tokens":{"access_token":"secret"}}');
    fs.mkdirSync(path.join(home, '.agents', 'skills', 'pdf'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'skills', 'pdf', 'SKILL.md'), '# pdf');
    const env = { HOME: home };
    expect(authFilePresence(descriptor('codex'), { home, env })).toEqual([{ path: '~/.codex/auth.json', exists: true }]);
    expect(JSON.stringify(authFilePresence(descriptor('codex'), { home, env }))).not.toContain('secret');
    expect(listSkills(descriptor('codex'), { home, env })).toEqual([
      { path: '~/.agents/skills', shared: true, absent: false, skills: [{ name: 'pdf', hasSkillFile: true }] },
      { path: '~/.codex/skills', shared: false, absent: true, skills: [] },
    ]);
  });

  it('MCP 面板：列表不回 env / headers 的值；保存时占位值沿用磁盘上的原值', () => {
    const home = tmp();
    const file = path.join(home, '.pi', 'agent', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { github: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_realsecret' } } } }));
    const listed = listMcpServers(descriptor('pi'), { home, env: { HOME: home } });
    expect(listed.servers[0].env).toEqual({ GITHUB_TOKEN: '<clawopt:redacted>' });
    expect(JSON.stringify(listed)).not.toContain('ghp_realsecret');
    saveMcpServers(descriptor('pi'), JSON.stringify({ github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '<clawopt:redacted>', EXTRA: '1' } } }), { home, env: { HOME: home } });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers.github).toEqual({ command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'ghp_realsecret', EXTRA: '1' } });
  });
});

describe('运行时目录回收', () => {
  it('归属删了立刻回收；清扫删孤儿与超期空闲；没有标记的目录与软链一概不碰', () => {
    let now = Date.parse('2026-09-01T00:00:00Z');
    const root = tmp();
    const homes = new RuntimeHomes(root, () => now);
    const a = homes.ensureHome('codex', { kind: 'room-member', groupId: 'g1', memberId: 'gm_g1_a' });
    const b = homes.ensureHome('pi', { kind: 'room-member', groupId: 'g1', memberId: 'gm_g1_b' });
    const s = homes.ensureHome('codex', { kind: 'session', sessionId: 's1' });
    expect(a.startsWith(path.join(root, 'codex'))).toBe(true);
    expect(homes.ensureHome('codex', { kind: 'room-member', groupId: 'g1', memberId: 'gm_g1_a' })).toBe(a);
    fs.mkdirSync(path.join(root, 'codex', 'user-made-dir'), { recursive: true });
    const outside = tmp('kb-clawopt-outside-');
    fs.symlinkSync(outside, path.join(root, 'codex', 'sneaky-link'));

    expect(homes.releaseOwner({ kind: 'room-member', groupId: 'g1', memberId: 'gm_g1_a' })).toBe(1);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(true);

    now += 10 * 24 * 60 * 60 * 1000;
    homes.ensureHome('pi', { kind: 'room-member', groupId: 'g1', memberId: 'gm_g1_b' }); // 刚用过
    homes.saveSettings({ idleDays: 7 });
    const removed = homes.sweep((owner) => owner.kind !== 'session' || owner.sessionId !== 'gone');
    expect(removed).toEqual([{ runtime: 'codex', hash: path.basename(s), reason: 'idle' }]);
    expect(fs.existsSync(b)).toBe(true);
    expect(fs.existsSync(path.join(root, 'codex', 'user-made-dir'))).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);

    const orphan = homes.ensureHome('grok', { kind: 'session', sessionId: 'gone' });
    expect(homes.sweep((owner) => !(owner.kind === 'session' && owner.sessionId === 'gone'))).toEqual([{ runtime: 'grok', hash: path.basename(orphan), reason: 'orphaned' }]);
    expect(homes.releaseOwner({ kind: 'room-member', groupId: 'g1' })).toBe(1);
    expect(() => homes.ensureHome('proxy-targets', { kind: 'session', sessionId: 'x' })).toThrow();
  });
});

describe('远程 OpenClaw 成员', () => {
  it('令牌只写不读：落盘是密文、AAD 绑定群与成员、群或成员不在了就清掉', () => {
    const dataDir = tmp();
    const store = new RemoteMemberSecretStore(dataDir);
    store.set('g1', 'remote-writer', 'gw-token-canary-123');
    expect(store.get('g1', 'remote-writer')).toBe('gw-token-canary-123');
    const raw = fs.readFileSync(path.join(dataDir, 'remote-openclaw-secrets.json'), 'utf-8');
    expect(raw).not.toContain('gw-token-canary-123');
    const parsed = JSON.parse(raw);
    parsed.members['g2 remote-writer'] = parsed.members['g1 remote-writer'];
    fs.writeFileSync(path.join(dataDir, 'remote-openclaw-secrets.json'), JSON.stringify(parsed));
    expect(store.get('g2', 'remote-writer'), '挪到别的成员名下的密文解不开').toBeNull();
    expect(store.prune((groupId) => groupId === 'g1')).toBe(1);
    store.set('g1', 'remote-writer', '');
    expect(store.has('g1', 'remote-writer')).toBe(false);
  });

  it('连接测试：只收 ws/wss；内网地址要显式受信任的局域网；没令牌直接报码；鉴权失败分类', async () => {
    const lookup = async () => ['192.168.1.20'];
    expect(await testRemoteOpenClawConnection({ gatewayUrl: 'http://gw.lan:18789', token: 't', trustedLan: true }, { lookup })).toMatchObject({ ok: false, messageCode: 'remoteOpenclaw.urlBlocked' });
    expect(await testRemoteOpenClawConnection({ gatewayUrl: 'ws://gw.lan:18789', token: 't', trustedLan: false }, { lookup })).toMatchObject({ ok: false, messageCode: 'remoteOpenclaw.privateAddressNeedsTrustedLan' });
    expect(await testRemoteOpenClawConnection({ gatewayUrl: 'ws://gw.lan:18789', token: '', trustedLan: true }, { lookup })).toMatchObject({ ok: false, messageCode: 'remoteOpenclaw.tokenMissing' });
    const denied = await testRemoteOpenClawConnection({ gatewayUrl: 'ws://gw.lan:18789', token: 'bad', trustedLan: true }, {
      lookup,
      createClient: () => ({ connect: async () => { throw new Error('unauthorized: gateway token mismatch'); }, disconnect: () => {} }),
    });
    expect(denied).toMatchObject({ ok: false, messageCode: 'remoteOpenclaw.authFailed' });
    const good = await testRemoteOpenClawConnection({ gatewayUrl: 'wss://gw.example', token: 'ok', trustedLan: false, remoteAgentId: 'writer' }, {
      lookup: async () => ['93.184.216.34'],
      createClient: () => ({ connect: async () => {}, call: async () => ({ agents: [{ id: 'main' }, { id: 'writer' }] }), disconnect: () => {} }),
    });
    expect(good).toMatchObject({ ok: true, agentFound: true, agents: ['main', 'writer'] });
  });

  function runRemote(options: { token?: string | null; config?: Record<string, unknown>; client?: FakeGatewayClient; connectError?: string }) {
    const secrets = { get: vi.fn(() => (options.token === undefined ? 'tok' : options.token)) };
    const client = options.client ?? new FakeGatewayClient();
    const adapter = createRemoteOpenClawRuntimeAdapter({
      secrets,
      lookup: async () => ['192.168.1.20'],
      createClient: () => {
        if (options.connectError) {
          const failing: any = new FakeGatewayClient();
          failing.connect = async () => { throw new Error(options.connectError); };
          return failing;
        }
        return client as any;
      },
    });
    const events: any[] = [];
    const controller = new AbortController();
    const handle = adapter.start({
      runId: 'r1', runMarker: 'm1', sessionKey: 'room:g1:member:gm_g1_writer', agentId: 'ext:remote-openclaw:writer', signal: controller.signal,
      emit: (event) => events.push(event),
      request: {
        sessionId: 'sess-uuid-1', prompt: '群里的上下文 + 任务', workingDir: '/tmp', resume: false,
        runtimeConfig: options.config ?? { gatewayUrl: 'ws://gw.lan:18789', remoteAgentId: 'writer', trustedLan: true },
        owner: { kind: 'room-member', groupId: 'g1', memberId: 'gm_g1_writer', agentId: 'writer' },
      },
    });
    return { handle, events, secrets, client };
  }

  it('适配器：令牌按（群, 成员 Agent）取；准备段的每种失败都带 messageCode 而不是挂住', async () => {
    const noToken = runRemote({ token: null });
    expect(await noToken.handle.done).toMatchObject({ kind: 'failed', code: 'remoteOpenclaw.tokenMissing' });
    expect(noToken.secrets.get).toHaveBeenCalledWith('g1', 'writer');

    expect(await runRemote({ config: { gatewayUrl: 'ws://gw.lan:18789', remoteAgentId: 'writer', trustedLan: false } }).handle.done)
      .toMatchObject({ kind: 'failed', code: 'remoteOpenclaw.privateAddressNeedsTrustedLan' });
    expect(await runRemote({ config: { gatewayUrl: '', remoteAgentId: 'writer' } }).handle.done).toMatchObject({ kind: 'failed', code: 'remoteOpenclaw.gatewayUrlRequired' });
    expect(await runRemote({ connectError: 'pairing required: device identity missing' }).handle.done).toMatchObject({ kind: 'failed', code: 'remoteOpenclaw.pairingRequired' });
    expect(await runRemote({ connectError: 'connect ECONNREFUSED 192.168.1.20:18789' }).handle.done).toMatchObject({ kind: 'failed', code: 'remoteOpenclaw.connectFailed' });
  });

  it('适配器：对面网关的会话键用远程 Agent；流式文本翻译成规范事件；对面运行失败带 remoteOpenclaw.runFailed', async () => {
    const client = new FakeGatewayClient();
    const ok = runRemote({ client });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(client.sent[0]).toMatchObject({ agentId: 'writer', message: '群里的上下文 + 任务', sessionKey: 'agent:writer:chat:sess-uuid-1' });
    client.delta('你好');
    client.final('你好，已完成');
    const outcome = await ok.handle.done;
    expect(outcome).toMatchObject({ kind: 'completed', outputText: '你好，已完成' });
    expect(ok.events.some((e) => e.event.type === 'response.output_text.snapshot' || e.event.type === 'response.output_text.delta')).toBe(true);
    await vi.waitFor(() => expect(client.disconnectCount).toBeGreaterThan(0), { timeout: 4000 });

    const failingClient = new FakeGatewayClient();
    const failing = runRemote({ client: failingClient });
    await vi.waitFor(() => expect(failingClient.sent).toHaveLength(1));
    failingClient.failRun('No API key found for provider "anthropic"');
    expect(await failing.handle.done).toMatchObject({ kind: 'failed', code: 'remoteOpenclaw.runFailed' });

    // 真机实测：没配服务商的网关把失败当成一条助手回复发回来
    const noProviderClient = new FakeGatewayClient();
    const noProvider = runRemote({ client: noProviderClient });
    await vi.waitFor(() => expect(noProviderClient.sent).toHaveLength(1));
    noProviderClient.final('⚠️ Agent failed before reply: No API key found for provider "openai". Auth store: /Users/remote/.openclaw/agents/main/agent/openclaw-agent.sqlite');
    expect(await noProvider.handle.done).toMatchObject({ kind: 'failed', code: 'remoteOpenclaw.runFailed' });
  }, 15000);

  it('群聊派发：适配器按 member.runtime 从登记处取；没登记的运行时明说失败，不静默退回 OpenClaw', async () => {
    const registry = new RuntimeAdapterRegistry();
    registerBuiltinAdapters(registry);
    expect(registry.list().map((entry) => entry.descriptor.id)).toEqual(['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'hermes', 'remote-openclaw']);
    expect(() => registry.registerAdapter(registry.get('claude-code')!.descriptor, () => null as any)).toThrow(/already registered/);

    const engine: any = Object.create(GroupChatEngine.prototype);
    const updates: string[] = [];
    engine.db = {
      getResumableExternalSession: () => null,
      setExternalSession: vi.fn(),
      markExternalSessionUnusable: vi.fn(),
      saveGroupMessage: () => 1,
      setGroupMessageRunMarker: vi.fn(),
      updateGroupMessage: (_id: number, content: string) => updates.push(content),
      getGroupChat: () => ({ id: 'g1', max_chain_depth: 6, system_prompt: '' }),
      getGroupMessages: () => [],
    };
    engine.emit = () => {};
    engine.getPreferredLanguage = () => 'zh-CN';
    engine.canUseHostTakeover = () => false;
    engine.useRunCoordinator(new RunCoordinator({ hub: new RealtimeHub(), store: new MemoryRunStore(), log: () => {} }));
    const requested: string[] = [];
    engine.useRuntimeAdapters((runtime: string) => {
      requested.push(runtime);
      return runtime === 'remote-openclaw'
        ? createRemoteOpenClawRuntimeAdapter({ secrets: { get: () => null }, lookup: async () => ['192.168.1.20'] })
        : null;
    });
    const member = (runtime: string) => ({
      id: `gm_g1_${runtime}`, group_id: 'g1', agent_id: `agent-${runtime}`, display_name: `M-${runtime}`, role_description: '', position: 0, runtime,
      external_config: JSON.stringify({ gatewayUrl: 'ws://gw.lan:18789', remoteAgentId: 'writer', trustedLan: true }),
    });
    const run = (m: any) => engine.runExternalMember({ groupId: 'g1', groupName: 'G', member: m, allMembers: [m], triggerMsg: 'x', triggerSenderName: 'u', depth: 0 });

    await run(member('remote-openclaw'));
    expect(updates.at(-1)).toBe('M-remote-openclaw 执行失败（remoteOpenclaw.tokenMissing）');
    await run(member('mystery-cli'));
    expect(updates.at(-1)).toBe('M-mystery-cli 执行失败（runtime.unknown: mystery-cli）');
    expect(requested).toEqual(['remote-openclaw', 'mystery-cli']);
  });

  it('成员 external_config 写入时剥掉凭据类键（GET /api/groups 会把它原样回给前端）', () => {
    expect(JSON.parse(sanitizeMemberExternalConfig(JSON.stringify({ gatewayUrl: 'ws://x', token: 'leak', password: 'p', remoteAgentId: 'w' }))!)).toEqual({ gatewayUrl: 'ws://x', remoteAgentId: 'w' });
    expect(JSON.parse(sanitizeMemberExternalConfig({ workingDir: '/srv', apiKey: 'sk-x' })!)).toEqual({ workingDir: '/srv' });
    expect(sanitizeMemberExternalConfig(undefined)).toBeNull();
    expect(sanitizeMemberExternalConfig('not json')).toBe('not json');
  });
});
