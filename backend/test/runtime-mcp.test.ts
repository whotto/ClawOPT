/**
 * 托管 MCP：各运行时原生配置的塑形（保留用户内容、按标记剥掉重生成）、每次运行前的健康隔离
 * （坏的剔除、探测器异常放行、隔离步骤自身失败放行），以及真实的 stdio / Streamable HTTP 探测。
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';

import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  createMcpInjector,
  parseMcpServerMap,
  probeHttpServer,
  probeStdioServer,
  readMcpEntries,
  removeMcpEntry,
  shapeClaudeMcpConfig,
  shapeCodexMcpConfig,
  shapeDshMcpPatch,
  shapeOpenCodeMcpConfig,
  shapePiMcpConfig,
  upsertMcpEntry,
  type ManagedMcpServer,
} from '../src/runtime/mcp';

const managed: ManagedMcpServer[] = [{ name: 'clawopt-api', transport: 'stdio', command: '/usr/bin/node', args: ['/opt/clawopt/mcp.js', 'api'], env: { CLAWOPT_URL: 'http://127.0.0.1:3100' } }];

describe('JSON 形状（Claude / Pi / OpenCode）', () => {
  it('Claude：只动 mcpServers；旧托管条目（前缀或标记）剥掉重生成；exclude 只从运行副本删', () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcpServers: {
        github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_x' } },
        broken: { command: 'nope' },
        'hermes-studio-api': { command: 'old', env: { CLAWOPT_MANAGED_MCP: '1' } },
        'clawopt-old-name': { command: 'old' },
      },
    });
    const out = JSON.parse(shapeClaudeMcpConfig(existing, managed, { exclude: ['broken'] }));
    expect(out.theme).toBe('dark');
    expect(Object.keys(out.mcpServers).sort()).toEqual(['clawopt-api', 'github']);
    expect(out.mcpServers.github.env.GITHUB_TOKEN).toBe('ghp_x');
    expect(out.mcpServers['clawopt-api']).toEqual({ type: 'stdio', command: '/usr/bin/node', args: ['/opt/clawopt/mcp.js', 'api'], env: { CLAWOPT_URL: 'http://127.0.0.1:3100', CLAWOPT_MANAGED_MCP: '1' } });
    // 幂等：再塑形一次结果不变
    expect(shapeClaudeMcpConfig(JSON.stringify(out), managed)).toBe(`${JSON.stringify(out, null, 2)}\n`);
  });

  it('Pi 托管条目带 lazy；OpenCode 用 local 命令数组 / remote url', () => {
    const pi = JSON.parse(shapePiMcpConfig(null, managed));
    expect(pi.mcpServers['clawopt-api']).toMatchObject({ lifecycle: 'lazy', directTools: false });
    const opencode = JSON.parse(shapeOpenCodeMcpConfig(JSON.stringify({ model: 'x', mcp: { docs: { type: 'remote', url: 'https://docs.example/mcp', enabled: true } } }), managed));
    expect(opencode.model).toBe('x');
    expect(opencode.mcp['clawopt-api']).toMatchObject({ type: 'local', command: ['/usr/bin/node', '/opt/clawopt/mcp.js', 'api'], enabled: true });
    expect(readMcpEntries('opencode-json', JSON.stringify(opencode)).map((e) => [e.name, e.transport, e.managed])).toEqual([['docs', 'http', false], ['clawopt-api', 'stdio', true]]);
  });

  it('读不懂的 JSON 报错而不是覆盖用户文件', () => {
    expect(() => shapeClaudeMcpConfig('{ not json', managed)).toThrow(expect.objectContaining({ messageCode: 'mcp.invalidConfigFile' }));
    expect(() => upsertMcpEntry('claude-json', '[1,2]', { name: 'a', transport: 'stdio', command: 'x' })).toThrow(expect.objectContaining({ messageCode: 'mcp.invalidConfigFile' }));
  });
});

describe('TOML 形状（Codex / Grok）', () => {
  const userToml = [
    '# my codex config',
    'model = "gpt-5-codex"',
    'approval_policy = "on-request"',
    '',
    '[mcp_servers.github]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-github"]',
    '',
    '[mcp_servers.github.env]',
    'GITHUB_TOKEN = "ghp_secret"',
    '',
    '[mcp_servers."clawopt-legacy"]',
    'command = "old"',
    '',
    '[profiles.fast]',
    'model = "gpt-5-mini" # inline comment',
    '',
  ].join('\n');

  it('用户内容逐行保留；遗留托管表剥掉；托管块成对标记、可重复生成；exclude 置 enabled = false', () => {
    const out = shapeCodexMcpConfig(userToml, managed, { exclude: ['github'] });
    expect(out).toContain('# my codex config\nmodel = "gpt-5-codex"\napproval_policy = "on-request"');
    expect(out).toContain('[mcp_servers.github]\nenabled = false\ncommand = "npx"');
    expect(out).toContain('[mcp_servers.github.env]\nGITHUB_TOKEN = "ghp_secret"');
    expect(out).toContain('[profiles.fast]\nmodel = "gpt-5-mini" # inline comment');
    expect(out).not.toContain('clawopt-legacy');
    expect(out.split(MANAGED_BLOCK_BEGIN)).toHaveLength(2);
    expect(out).toContain(`${MANAGED_BLOCK_BEGIN}\n[mcp_servers.clawopt-api]\ncommand = "/usr/bin/node"\nargs = ["/opt/clawopt/mcp.js", "api"]\nenv = { CLAWOPT_URL = "http://127.0.0.1:3100", CLAWOPT_MANAGED_MCP = "1" }\nstartup_timeout_sec = 120\ntool_timeout_sec = 360\n${MANAGED_BLOCK_END}`);
    const again = shapeCodexMcpConfig(out, managed, { exclude: ['github'] });
    expect(again).toBe(out);
    const entries = readMcpEntries('codex-toml', out);
    expect(entries.find((e) => e.name === 'github')).toMatchObject({ enabled: false, env: { GITHUB_TOKEN: 'ghp_secret' } });
    expect(entries.find((e) => e.name === 'clawopt-api')?.managed).toBe(true);
  });

  it('配置页新增 / 删除用户服务：插在托管块之前，其余行不动', () => {
    const shaped = shapeCodexMcpConfig(userToml, managed);
    const added = upsertMcpEntry('codex-toml', shaped, { name: 'docs', transport: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer x' } });
    expect(added.indexOf('[mcp_servers.docs]')).toBeLessThan(added.indexOf(MANAGED_BLOCK_BEGIN));
    expect(readMcpEntries('codex-toml', added).find((e) => e.name === 'docs')).toMatchObject({ transport: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer x' } });
    const removed = removeMcpEntry('codex-toml', added, 'github');
    expect(removed).not.toContain('[mcp_servers.github');
    expect(removed).toContain('[profiles.fast]');
    expect(() => upsertMcpEntry('codex-toml', 'model = "x"\n[mcp_servers.a\n', { name: 'b', transport: 'stdio', command: 'x' })).toThrow(expect.objectContaining({ messageCode: 'mcp.invalidConfigFile' }));
    expect(() => upsertMcpEntry('codex-toml', shaped, { name: 'clawopt-mine', transport: 'stdio', command: 'x' })).toThrow(/reserved/);
  });
});

describe('YAML 行（DSH）与对话框输入', () => {
  it('DSH：用户行保留、托管行成块、exclude 标 disabled', () => {
    const existing = [
      '- name: "@deepseek-ai/dsh-mcp-client"',
      '  key: fs',
      '  config:',
      '    name: fs',
      '    transport: stdio',
      '    command: npx',
      '    args: ["-y", "@modelcontextprotocol/server-filesystem"]',
      '- name: other-plugin',
      '  config:',
      '    enabled: true',
    ].join('\n');
    const out = shapeDshMcpPatch(existing, managed, { exclude: ['fs'] });
    expect(out).toContain('other-plugin');
    expect(out).toContain(MANAGED_BLOCK_BEGIN);
    const entries = readMcpEntries('dsh-yaml', out);
    expect(entries.map((e) => [e.name, e.enabled, e.managed])).toEqual([['fs', false, false], ['clawopt-api', true, true]]);
    expect(() => upsertMcpEntry('dsh-yaml', out, { name: 'x', transport: 'stdio', command: 'y' })).toThrow(expect.objectContaining({ messageCode: 'mcp.readOnlyFormat' }));
  });

  it('对话框接受 JSON 或 YAML 的 { name: config }，形状可以是 Claude 的也可以是 OpenCode 的', () => {
    expect(parseMcpServerMap('{"mcpServers": {"a": {"command": "npx", "args": ["x"]}}}')).toEqual([{ name: 'a', transport: 'stdio', command: 'npx', args: ['x'], env: undefined, enabled: true }]);
    expect(parseMcpServerMap('docs:\n  type: remote\n  url: https://docs.example/mcp\n  enabled: false\nfs:\n  type: local\n  command: [npx, -y, server-fs]\n')).toEqual([
      { name: 'docs', transport: 'http', url: 'https://docs.example/mcp', headers: undefined, enabled: false },
      { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: undefined, enabled: true },
    ]);
    expect(() => parseMcpServerMap('a:\n  args: [x]\n')).toThrow(/command/);
    expect(() => parseMcpServerMap('a: &anchor\n  command: x\n')).toThrow(/Invalid JSON\/YAML/);
  });
});

describe('每次运行前的健康隔离', () => {
  it('坏的剔除并说明原因；单个探测器抛错放行；托管名字不参与探测；隔离步骤自身失败整体放行', async () => {
    const probed: string[] = [];
    const injector = createMcpInjector({
      childEnv: () => ({ PATH: '/usr/bin' }),
      managedServers: () => managed,
      log: () => {},
      probe: async (server) => {
        probed.push(server.name);
        if (server.name === 'broken') return { ok: false, tools: [], error: 'exited with code 1' };
        if (server.name === 'flaky-probe') throw new Error('probe bug');
        return { ok: true, tools: [], error: null };
      },
    });
    const user: ManagedMcpServer[] = [
      { name: 'github', transport: 'stdio', command: 'npx' },
      { name: 'broken', transport: 'stdio', command: 'nope' },
      { name: 'flaky-probe', transport: 'http', url: 'https://x.example/mcp' },
      { name: 'clawopt-api', transport: 'stdio', command: 'stale-copy' },
    ];
    const result = await injector.resolveForRun({ runtime: 'codex', userServers: user });
    expect(result.servers.map((s) => s.name)).toEqual(['clawopt-api', 'github', 'flaky-probe']);
    expect(result.servers[0].command).toBe('/usr/bin/node');
    expect(result.excluded).toEqual([{ name: 'broken', reason: 'exited with code 1' }]);
    expect(probed.sort()).toEqual(['broken', 'flaky-probe', 'github']);

    const failOpen = createMcpInjector({ childEnv: () => { throw new Error('env broke'); }, log: () => {}, probe: async () => ({ ok: false, tools: [], error: 'x' }) });
    const open = await failOpen.resolveForRun({ runtime: 'pi', userServers: user.slice(0, 2) });
    expect(open.servers.map((s) => s.name)).toEqual(['github', 'broken']);
    expect(open.excluded).toEqual([]);
  });

  it('P6：托管服务提供者拿到这次运行的上下文；提供者异步、或自己出错时按「没有托管服务」放行', async () => {
    const seen: unknown[] = [];
    const run = { runId: 'r1', sessionKey: 's1', agentId: 'main', runtime: 'claude-code' };
    const injector = createMcpInjector({
      childEnv: () => ({}),
      log: () => {},
      probe: async () => ({ ok: true, tools: [], error: null }),
      managedServers: async (_runtime, context) => {
        seen.push(context);
        return [{ name: 'clawopt-tools', transport: 'stdio', command: 'node', env: { CLAWOPT_MANAGED_MCP: '1' } }];
      },
    });
    const result = await injector.resolveForRun({ runtime: 'claude-code', userServers: [{ name: 'github', transport: 'stdio', command: 'npx' }], run });
    expect(result.servers.map((server) => server.name)).toEqual(['clawopt-tools', 'github']);
    expect(seen).toEqual([run]);

    const broken = createMcpInjector({ childEnv: () => ({}), log: () => {}, probe: async () => ({ ok: true, tools: [], error: null }), managedServers: () => { throw new Error('token store down'); } });
    const fallback = await broken.resolveForRun({ runtime: 'claude-code', userServers: [{ name: 'github', transport: 'stdio', command: 'npx' }], run });
    expect(fallback.servers.map((server) => server.name)).toEqual(['github']);
  });
});

describe('真实探测', () => {
  const FAKE_STDIO_SERVER = `
    const rl = require('readline').createInterface({ input: process.stdin });
    console.log('log line that is not json');
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }) + '\\n');
      if (msg.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] } }) + '\\n');
    });
  `;

  it('stdio：initialize → tools/list，跳过非 JSON 日志行；不应答的服务按时限失败', async () => {
    const good = await probeStdioServer({ name: 'fake', transport: 'stdio', command: process.execPath, args: ['-e', FAKE_STDIO_SERVER] }, { PATH: process.env.PATH }, 5000);
    expect(good).toEqual({ ok: true, tools: [{ name: 'echo', description: 'Echo', input_schema: { type: 'object' } }], error: null });
    const silent = await probeStdioServer({ name: 'silent', transport: 'stdio', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, { PATH: process.env.PATH }, 400);
    expect(silent.ok).toBe(false);
    expect(silent.error).toMatch(/did not answer within 400 ms/);
    const missing = await probeStdioServer({ name: 'missing', transport: 'stdio', command: '/nonexistent/mcp-server' }, {}, 1000);
    expect(missing.ok).toBe(false);
  });

  it('Streamable HTTP：SSE 形式的应答、带回 mcp-session-id', async () => {
    const seen: Array<{ method: string; session?: string }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const msg = JSON.parse(raw);
        seen.push({ method: msg.method, session: req.headers['mcp-session-id'] as string | undefined });
        if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'h', version: '1' } }
          : { tools: [{ name: 'search' }] };
        res.writeHead(200, { 'content-type': 'text/event-stream', ...(msg.method === 'initialize' ? { 'mcp-session-id': 'sess-42' } : {}) });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      const result = await probeHttpServer({ name: 'h', transport: 'http', url });
      expect(result).toMatchObject({ ok: true, tools: [{ name: 'search' }] });
      expect(seen).toEqual([{ method: 'initialize', session: undefined }, { method: 'notifications/initialized', session: 'sess-42' }, { method: 'tools/list', session: 'sess-42' }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
