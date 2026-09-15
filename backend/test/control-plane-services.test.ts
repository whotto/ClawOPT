/**
 * 控制面服务的规则用例：模型目录缓存、连通性测试加固、服务商编辑器（版本号 + 凭据只进不出）、
 * MCP / 频道的凭据脱敏、插件安装规格、SKILL.md 读取闸门、头像魔数、导出 / 克隆的凭据跳过、
 * 日志前缀与过滤、用量去重、网关状态「旧数据先回」。
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyControlPlaneSchema } from '../src/core/db/control-plane-schema';
import { SafeFileStore } from '../src/core/files/safe-file-store';
import { computeRevision } from '../src/core/http';
import { createModelCatalogStore, hiddenModels, planCatalogRefresh } from '../src/control/models/model-catalog';
import { buildCatalogRequest, extractModelIds, probeProviderCatalog } from '../src/control/models/provider-probe';
import { applyContextLengths, applyProviderSave, createProviderEditor, ProviderRevisionConflict, providerView } from '../src/control/models/provider-editor';
import { createProviderAudit, sanitizeAuditDetails } from '../src/control/models/provider-audit';
import { MCP_SECRET_PLACEHOLDER, redactMcpConfig, restoreMcpSecrets, validateMcpConfig } from '../src/control/mcp/mcp-service';
import { buildChannelAddArgs, findCredentialPaths, redactChannelCredentials } from '../src/control/channels/channels-service';
import { assertInstallSpec } from '../src/control/plugins/plugins-service';
import { readEngineSkillMarkdown } from '../src/control/skills/skills-service';
import { decodeAvatarDataUrl, sniffImageMime } from '../src/control/agents/agent-avatar-store';
import { normalizeBindings } from '../src/control/agents/agent-clone';
import { buildAgentEntry } from '../src/control/packs/agent-pack';
import { filterLogLines, stripJsonPrefixes } from '../src/control/logs/logs-service';
import { aggregateSessions, normalizeUsageCost } from '../src/control/usage/usage-service';
import { createGatewayStatusCache } from '../src/control/logs/gateway-status-cache';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-control-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function memoryDb() {
  const sqlite = new Database(':memory:');
  applyControlPlaneSchema(sqlite);
  return { connection: () => sqlite } as any;
}

describe('模型目录缓存', () => {
  it('空结果算探测失败，不是「全删了」', () => {
    expect(() => planCatalogRefresh({ currentModels: ['a'], currentUnavailable: [], fetched: [], protectedModels: [] })).toThrowError(/models.catalogEmpty/);
  });

  it('会移除模型时要确认；受保护模型不移除、保留为 unavailable', () => {
    const plan = planCatalogRefresh({ currentModels: ['gpt-a', 'gpt-b', 'gpt-c'], currentUnavailable: [], fetched: ['gpt-a', 'gpt-d'], protectedModels: ['gpt-b'] });
    expect(plan.diff).toEqual({ added: ['gpt-d'], removed: ['gpt-c'], unchanged: ['gpt-a'], keptUnavailable: ['gpt-b'] });
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.next).toEqual({ models: ['gpt-a', 'gpt-d'], unavailableModels: ['gpt-b'] });
    const onlyProtectedMissing = planCatalogRefresh({ currentModels: ['gpt-a', 'gpt-b'], currentUnavailable: [], fetched: ['gpt-a'], protectedModels: ['gpt-b'] });
    expect(onlyProtectedMissing.requiresConfirmation).toBe(false);
  });

  it('一步撤销：只有列表变了才写快照；撤销后快照清空', () => {
    let now = 1;
    const store = createModelCatalogStore({ db: memoryDb(), now: () => now });
    store.apply('openai', 'https://api', { models: ['a'], unavailableModels: [] });
    expect(store.get('openai')?.restoreAvailable).toBe(false);
    now = 2;
    store.apply('openai', 'https://api', { models: ['a'], unavailableModels: [] });
    expect(store.get('openai')?.restoreAvailable).toBe(false);
    now = 3;
    store.apply('openai', 'https://api', { models: ['a', 'b'], unavailableModels: [] });
    expect(store.get('openai')).toMatchObject({ models: ['a', 'b'], restoreAvailable: true });
    expect(store.restore('openai')).toMatchObject({ models: ['a'], restoreAvailable: false });
    expect(() => store.restore('openai')).toThrowError(/catalogNoSnapshot/);
  });

  it('可见性白名单失效时放开', () => {
    expect([...hiddenModels(['a', 'b', 'c'], { mode: 'include', models: ['a'] })]).toEqual(['b', 'c']);
    expect([...hiddenModels(['a', 'b'], { mode: 'include', models: ['gone'] })]).toEqual([]);
    expect([...hiddenModels(['a'], undefined)]).toEqual([]);
  });
});

describe('连通性测试加固', () => {
  const response = (status: number, body = '', headers: Record<string, string> = {}) => new Response(body || null, { status, headers });

  it('重定向到别的源一律拦下（不把 key 带过去）', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).Authorization ?? ''}`);
      return response(302, '', { location: 'https://evil.example/collect' });
    }) as unknown as typeof fetch;
    const result = await probeProviderCatalog({ baseUrl: 'https://api.example/v1', api: 'openai-completions', apiKey: 'sk-secret', fetchImpl });
    expect(result).toMatchObject({ ok: false, errorCode: 'models.redirectBlocked' });
    expect(seen).toHaveLength(1);
  });

  it('同源重定向跟随；404 = 可达但没有目录', async () => {
    const fetchImpl = (async (url: string) => (url.endsWith('/v1/models') ? response(301, '', { location: '/v2/models' }) : response(404))) as unknown as typeof fetch;
    await expect(probeProviderCatalog({ baseUrl: 'https://api.example/v1', api: 'openai-completions', fetchImpl })).resolves.toMatchObject({ ok: true, catalogUnavailable: true });
  });

  it('401 单列认证失败；目录去掉 models/ 前缀并去重', async () => {
    const unauthorized = (async () => response(401)) as unknown as typeof fetch;
    await expect(probeProviderCatalog({ baseUrl: 'https://api.example', api: 'openai-completions', fetchImpl: unauthorized })).resolves.toMatchObject({ ok: false, errorCode: 'models.authFailed' });
    expect(extractModelIds({ models: [{ name: 'models/gemini-pro' }, { name: 'gemini-pro' }, { id: 'b' }] })).toEqual(['b', 'gemini-pro']);
  });

  it('Gemini 的 key 放头里而不是查询串；带用户信息的地址拒绝', async () => {
    const request = buildCatalogRequest('https://generativelanguage.googleapis.com/v1beta', 'google-generative-ai', 'AIza-key');
    expect(request.url).not.toContain('AIza-key');
    expect(request.headers['x-goog-api-key']).toBe('AIza-key');
    await expect(probeProviderCatalog({ baseUrl: 'https://user:pass@api.example', api: 'openai', fetchImpl: (async () => response(200, '{}')) as any })).resolves.toMatchObject({ errorCode: 'models.invalidBaseUrl' });
  });
});

describe('服务商编辑器', () => {
  it('视图只有 hasApiKey；版本号含 key 值', () => {
    const view = providerView('openai', { baseUrl: 'https://api', apiKey: 'sk-live', api: 'openai-completions', models: [{ id: 'gpt', contextWindow: 128000 }] });
    expect(JSON.stringify(view)).not.toContain('sk-live');
    expect(view).toMatchObject({ hasApiKey: true, contextLengths: { gpt: 128000 } });
    expect(providerView('openai', { baseUrl: 'https://api', apiKey: 'sk-rotated', api: 'openai-completions', models: [{ id: 'gpt', contextWindow: 128000 }] }).revision).not.toBe(view.revision);
  });

  it('保存：空 key = 保持；非法地址拒绝；上下文长度 null 删除覆盖', () => {
    expect(applyProviderSave({ baseUrl: 'https://old', apiKey: 'sk-keep', api: 'x', models: [{ id: 'm' }] }, { baseUrl: 'https://new', api: 'openai-completions', apiKey: '' }))
      .toEqual({ baseUrl: 'https://new', apiKey: 'sk-keep', api: 'openai-completions', models: [{ id: 'm' }] });
    expect(() => applyProviderSave(null, { baseUrl: 'javascript:alert(1)', api: 'openai-completions' })).toThrowError(/invalidBaseUrl/);
    const entry = applyContextLengths({ models: [{ id: 'm', contextWindow: 1000 }] }, { m: null, n: 32000 });
    expect(entry.models).toEqual([{ id: 'm' }, { id: 'n', name: 'n', contextWindow: 32000 }]);
    expect(() => applyContextLengths({ models: [] }, { m: -1 })).toThrowError(/invalidContextLength/);
  });

  it('锁内比版本号：过期版本 412（带当前视图），配置不变；缺版本号同样冲突', async () => {
    const configPath = path.join(dir, 'openclaw.json');
    const initial = { models: { providers: { openai: { baseUrl: 'https://api', apiKey: 'sk-1', api: 'openai-completions', models: [] } } } };
    fs.writeFileSync(configPath, JSON.stringify(initial));
    const editor = createProviderEditor({
      fileStore: new SafeFileStore({ crossProcess: false }),
      configPath: () => configPath,
      readConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf-8')),
    });
    const revision = computeRevision(initial.models.providers.openai);
    await expect(editor.save('openai', { baseUrl: 'https://api2', api: 'openai-completions', apiKey: '' }, 'stale')).rejects.toBeInstanceOf(ProviderRevisionConflict);
    await expect(editor.save('openai', { baseUrl: 'https://api2', api: 'openai-completions', apiKey: '' }, null)).rejects.toBeInstanceOf(ProviderRevisionConflict);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual(initial);
    const saved = await editor.save('openai', { baseUrl: 'https://api2', api: 'openai-completions', apiKey: '' }, revision);
    expect(saved.fields).toEqual(['baseUrl']);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).models.providers.openai).toMatchObject({ baseUrl: 'https://api2', apiKey: 'sk-1' });
    const created = await editor.save('deepseek', { baseUrl: 'https://ds', api: 'openai-completions', apiKey: 'sk-ds' }, null);
    expect(created.created).toBe(true);
  });

  it('审计：details 脱敏（key 与 URL 查询串），写失败不抛', () => {
    expect(sanitizeAuditDetails({ apiKey: 'sk-x', baseUrl: 'https://u:p@api.example/v1?key=abc#x', nested: { token: 't' } }))
      .toEqual({ apiKey: '[redacted]', baseUrl: 'https://api.example/v1', nested: { token: '[redacted]' } });
    const audit = createProviderAudit({ db: memoryDb() });
    audit.record({ identity: { userId: 1, username: 'root', role: 'super_admin', implicit: false, mustChangePassword: false }, providerId: 'openai', action: 'provider.update', result: 'success', fields: ['apiKey'], details: { apiKey: 'sk-x' } });
    expect(audit.list()).toMatchObject([{ providerId: 'openai', fields: ['apiKey'], details: { apiKey: '[redacted]' }, actor: { username: 'root' } }]);
    const broken = createProviderAudit({ db: { connection: () => ({ prepare: () => { throw new Error('disk full'); } }) } as any, log: () => undefined });
    expect(() => broken.record({ identity: null, providerId: 'x', action: 'provider.test', result: 'failed' })).not.toThrow();
  });
});

describe('MCP 凭据只出不进', () => {
  it('env / headers 的值换成占位符；写回时占位符还原成原值', () => {
    const current = { command: 'npx', args: ['server'], env: { API_KEY: 'sk-real', EMPTY: '' }, headers: { Authorization: 'Bearer abc' } };
    const view = redactMcpConfig(current);
    expect(JSON.stringify(view)).not.toContain('sk-real');
    expect(view.env).toEqual({ API_KEY: MCP_SECRET_PLACEHOLDER, EMPTY: '' });
    const edited = { ...view, args: ['server', '--verbose'], env: { ...(view.env as object), NEW_VAR: 'plain' } };
    expect(restoreMcpSecrets(edited, current)).toEqual({ command: 'npx', args: ['server', '--verbose'], env: { API_KEY: 'sk-real', EMPTY: '', NEW_VAR: 'plain' }, headers: { Authorization: 'Bearer abc' } });
  });

  it('原来没有的键写占位符 → 拒绝；配置必须有 command 或 http(s) url', () => {
    expect(() => restoreMcpSecrets({ command: 'x', env: { NEW: MCP_SECRET_PLACEHOLDER } }, { command: 'x' })).toThrowError(/placeholderWithoutValue/);
    expect(() => validateMcpConfig({ args: [] })).toThrowError(/commandOrUrlRequired/);
    expect(() => validateMcpConfig({ url: 'file:///etc/passwd' })).toThrowError(/invalidUrl/);
    expect(validateMcpConfig({ url: 'https://mcp.example/sse' })).toEqual({ url: 'https://mcp.example/sse' });
  });
});

describe('频道凭据', () => {
  it('凭据形状的键换成 hasXxx', () => {
    expect(redactChannelCredentials({ accountId: 'bot1', botToken: '123:abc', nested: { appSecret: '' }, allowFrom: ['me'] }))
      .toEqual({ accountId: 'bot1', hasBotToken: true, nested: { hasAppSecret: false }, allowFrom: ['me'] });
  });

  it('清空凭据只找凭据路径，行为设置不动', () => {
    const config = { enabled: true, botToken: 'x', requireMention: true, allowFrom: ['a'], accounts: { work: { token: 'y', name: 'Work' } }, proxy: { password: 'p', host: 'h' } };
    expect(findCredentialPaths(config)).toEqual([['botToken'], ['accounts', 'work', 'token'], ['proxy', 'password']]);
  });

  it('添加：空凭据不传（= 不修改），传了的进 secrets 以便报错脱敏；换行拒绝', () => {
    const { args, secrets } = buildChannelAddArgs({ channel: 'telegram', account: 'work', botToken: '123:abc', password: '' });
    expect(args).toEqual(['channels', 'add', '--channel', 'telegram', '--account', 'work', '--bot-token', '123:abc']);
    expect(secrets).toEqual(['123:abc']);
    expect(() => buildChannelAddArgs({ channel: 'telegram', botToken: 'a\nb' })).toThrowError(/invalidCredential/);
    expect(() => buildChannelAddArgs({ channel: 'Tele gram' })).toThrowError(/invalidChannel/);
  });
});

describe('插件安装规格与 SKILL.md 闸门', () => {
  it('只接受包规格，不接受本机路径', () => {
    for (const spec of ['@openclaw/codex', 'openclaw-plugin-x@1.2.3', 'clawhub:owner/pkg', 'https://github.com/o/r.git']) expect(assertInstallSpec(spec)).toBe(spec);
    for (const spec of ['/etc/passwd', './plugin', '~/x', '../x', 'a b']) expect(() => assertInstallSpec(spec)).toThrow();
  });

  it('SKILL.md：必须正好是 baseDir/SKILL.md，软链逃逸、别的文件名都拒绝', () => {
    const base = path.join(dir, 'skill');
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, 'SKILL.md'), '# ok');
    expect(readEngineSkillMarkdown(path.join(base, 'SKILL.md'), base)).toBe('# ok');
    expect(readEngineSkillMarkdown(path.join(dir, 'other', 'SKILL.md'), base)).toBeNull();
    fs.writeFileSync(path.join(dir, 'secret'), 'nope');
    const evil = path.join(dir, 'evil');
    fs.mkdirSync(evil);
    fs.symlinkSync(path.join(dir, 'secret'), path.join(evil, 'SKILL.md'));
    expect(readEngineSkillMarkdown(path.join(evil, 'SKILL.md'), evil)).toBeNull();
    expect(readEngineSkillMarkdown(path.join(base, 'openclaw.json'), base)).toBeNull();
  });
});

describe('头像、导出与克隆', () => {
  it('头像按魔数认类型：声明成 png 的 SVG 拒绝；超大拒绝', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(sniffImageMime(png)).toBe('image/png');
    expect(decodeAvatarDataUrl(`data:image/png;base64,${png.toString('base64')}`).mime).toBe('image/png');
    const svg = Buffer.from('<svg onload="alert(1)"></svg>');
    expect(() => decodeAvatarDataUrl(`data:image/png;base64,${svg.toString('base64')}`)).toThrowError(/avatarInvalid/);
    expect(() => decodeAvatarDataUrl(`data:image/png;base64,${Buffer.concat([png, Buffer.alloc(600 * 1024)]).toString('base64')}`)).toThrowError(/avatarTooLarge/);
  });

  it('导出 / 克隆的组装跳过凭据文件与 memory/', () => {
    const workspace = path.join(dir, 'ws');
    fs.mkdirSync(path.join(workspace, 'skills', 'deploy'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'SOUL.md'), '# soul');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# private');
    fs.writeFileSync(path.join(workspace, 'memory', '2026-09-14.md'), 'diary');
    fs.writeFileSync(path.join(workspace, 'skills', 'deploy', 'SKILL.md'), '# deploy');
    for (const name of ['.env', '.env.production', 'auth-profiles.json', 'auth.json', '.npmrc', 'id_rsa', 'server.pem']) {
      fs.writeFileSync(path.join(workspace, 'skills', 'deploy', name), 'SECRET');
    }
    const warnings: any[] = [];
    const entry = buildAgentEntry('writer', 'Writer', workspace, { includeMemory: false }, warnings);
    expect(entry.files.map((file) => file.path).sort()).toEqual(['SOUL.md', 'skills/deploy/SKILL.md']);
    expect(entry.files.some((file) => file.content.includes('SECRET'))).toBe(false);
  });

  it('绑定解析兼容两种形状', () => {
    expect(normalizeBindings({ bindings: [{ agentId: 'a', match: { channel: 'telegram', accountId: 'bot' } }] })).toEqual([{ channel: 'telegram', accountId: 'bot' }]);
    expect(normalizeBindings([{ channel: 'discord' }])).toEqual([{ channel: 'discord', accountId: null }]);
  });
});

describe('日志与用量', () => {
  it('剥掉网关日志的 JSON 前缀；按级别与关键字过滤', () => {
    expect(stripJsonPrefixes('{"subsystem":"gateway"} {"jobId":"x"} cron: job updated')).toBe('cron: job updated');
    expect(stripJsonPrefixes('{"a":"}"} tail')).toBe('tail');
    expect(stripJsonPrefixes('plain')).toBe('plain');
    const lines = [
      { ts: null, level: 'info', source: 'gateway' as const, subsystem: 'cron', message: 'job updated' },
      { ts: null, level: 'warn', source: 'gateway' as const, subsystem: 'plugins', message: 'allow list empty' },
      { ts: null, level: 'error', source: 'gateway' as const, subsystem: 'cron', message: 'job failed' },
    ];
    expect(filterLogLines(lines, 'warn', '').map((line) => line.level)).toEqual(['warn', 'error']);
    expect(filterLogLines(lines, 'all', 'CRON').map((line) => line.message)).toEqual(['job updated', 'job failed']);
  });

  it('按会话去重累计，按模型 / Agent 分组', () => {
    const sessions = [
      { agentId: 'a', key: 's1', modelProvider: 'openai', model: 'gpt', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { agentId: 'a', key: 's1', modelProvider: 'openai', model: 'gpt', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { agentId: 'b', key: 's1', modelProvider: 'openai', model: 'gpt', inputTokens: 1, outputTokens: 1 },
      { agentId: 'b', key: 's2', model: 'local' },
    ];
    const result = aggregateSessions(sessions);
    expect(result.sessionCount).toBe(3);
    expect(result.byModel).toEqual([
      { key: 'openai/gpt', sessions: 2, inputTokens: 11, outputTokens: 6, totalTokens: 17 },
      { key: 'local', sessions: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ]);
    expect(result.byAgent.map((row) => [row.key, row.totalTokens])).toEqual([['a', 15], ['b', 2]]);
    expect(normalizeUsageCost({ totals: { totalTokens: 9, totalCost: 0.5 }, daily: [{ date: '2026-09-14', input: 1 }, { bad: true }] }).daily).toHaveLength(1);
  });

  it('网关状态：有缓存先回缓存并后台刷新；刷新中的请求合并；失败保留旧数据', async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    let release!: () => void;
    const cli = {
      runJson: async () => {
        calls += 1;
        if (calls === 2) await new Promise<void>((resolve) => { release = resolve; });
        if (fail) throw Object.assign(new Error('x'), { errorCode: 'openclaw.cliTimeout' });
        return { gateway: { version: `v${calls}`, port: 1 }, rpc: { ok: true } };
      },
    } as any;
    const cache = createGatewayStatusCache({ openclawCli: cli, now: () => now, staleMs: 100 });
    const first = await cache.get();
    expect(first).toMatchObject({ summary: { gatewayVersion: 'v1' }, refreshing: false });
    now = 500;
    const stale = await cache.get();
    expect(stale).toMatchObject({ summary: { gatewayVersion: 'v1' }, refreshing: true });
    await cache.get({ refresh: true });
    await cache.get({ refresh: true });
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(3);
    fail = true;
    now = 2000;
    await cache.get({ refresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterFailure = await cache.get();
    expect(afterFailure.summary?.gatewayVersion).toBe('v3');
  });
});
