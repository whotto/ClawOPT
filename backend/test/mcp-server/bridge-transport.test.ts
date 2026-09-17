/**
 * MCP 桥的传输层（P6）：
 * 1. 真 HTTP：桥接口只认 Bearer 范围令牌——登录 cookie / CLI 会话头不放行；带转发头（本机反向代理转进来的外部请求）拒绝；
 *    管理面挂管理员闸门；登录开启时桥接口在公开白名单里（调用方带不了 cookie），其余 MCP 管理路由匿名 401；
 * 2. 真子进程：`bin/clawopt-mcp` 的 stdio JSON-RPC 往返（initialize → tools/list → tools/call → stdin 关闭即退出），
 *    令牌不进 argv、不进输出。
 */
import { spawn } from 'child_process';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/bootstrap';
import { AUTH_COOKIE_NAME, AUTH_PUBLIC_PATHS, createAuthMiddleware } from '../../src/core/auth';
import { MCP_BRIDGE_CALL_PATH, MCP_BRIDGE_TOOLS_PATH, registerMcpServerRoutes } from '../../src/mcp-server';
import { createStubContext } from '../helpers/stub-context';
import { createWorld, issue } from './helpers';

const listen = async (app: express.Express | http.RequestListener) => {
  const server = http.createServer(app as http.RequestListener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

describe('桥接口（真 HTTP）', () => {
  let world: ReturnType<typeof createWorld>;
  let token = '';
  let base = '';
  let server: http.Server;

  beforeAll(async () => {
    world = createWorld();
    token = issue(world).token;
    const auth = createAuthMiddleware({
      configManager: { getConfig: () => ({ loginEnabled: false, allowedHosts: [] }) },
      authStore: { resolve: () => null },
      userStore: { count: () => 0, get: () => null, firstActiveSuperAdmin: () => null, hasAgent: () => false },
    } as never);
    const app = express();
    app.use(express.json());
    registerMcpServerRoutes(app as never, { auth, mcpServer: world.service });
    ({ server, url: base } = await listen(app));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const callBridge = (headers: Record<string, string>) => fetch(`${base}${MCP_BRIDGE_CALL_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ operation: 'sessions_list', arguments: {} }),
  });

  it('Bearer 范围令牌放行；登录 cookie、CLI 会话头、没有令牌一律 401', async () => {
    const ok = await callBridge({ Authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).result.currentSessionKey).toBe('s-mine');
    expect((await callBridge({ Cookie: `${AUTH_COOKIE_NAME}=${token}` })).status).toBe(401);
    expect((await callBridge({ 'X-ClawOPT-Auth-Token': token })).status).toBe(401);
    expect((await callBridge({})).status).toBe(401);
    expect((await fetch(`${base}${MCP_BRIDGE_TOOLS_PATH}`)).status).toBe(401);
  });

  it('带转发头（本机反向代理转进来的外部请求）拒绝，即使令牌是对的', async () => {
    for (const header of ['X-Forwarded-For', 'Forwarded', 'X-Real-IP']) {
      const response = await callBridge({ Authorization: `Bearer ${token}`, [header]: header === 'Forwarded' ? 'for=203.0.113.9' : '203.0.113.9' });
      expect(response.status, header).toBe(403);
    }
  });

  it('tools/list 只列令牌允许的操作', async () => {
    const body = await (await fetch(`${base}${MCP_BRIDGE_TOOLS_PATH}`, { headers: { Authorization: `Bearer ${token}` } })).json() as any;
    const names = body.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('memory_write');
    expect(names).not.toContain('chat_run');
  });
});

describe('登录开启时的公开面', () => {
  it('只有两条桥接口公开；MCP 管理路由都挂管理员闸门', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(AUTH_PUBLIC_PATHS.has(MCP_BRIDGE_CALL_PATH)).toBe(true);
    expect(AUTH_PUBLIC_PATHS.has(MCP_BRIDGE_TOOLS_PATH)).toBe(true);
    const configManager = { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) };
    const authStore = { resolve: () => null };
    const userStore = { count: () => 1, get: () => null, firstActiveSuperAdmin: () => null, hasAgent: () => false };
    const auth = createAuthMiddleware({ configManager, authStore, userStore } as never);
    const built = buildApp(createStubContext({ configManager, authStore, userStore, auth }));
    const records = built.routes.list().filter((record) => record.module === 'mcp-server' && record.kind === 'route');
    expect(records.filter((record) => record.public).map((record) => record.path).sort()).toEqual([MCP_BRIDGE_CALL_PATH, MCP_BRIDGE_TOOLS_PATH].sort());
    expect(records.filter((record) => !record.public).every((record) => record.adminOnly)).toBe(true);
    const { server, url } = await listen(built.app);
    try {
      expect((await fetch(`${url}/api/mcp-server/settings`)).status).toBe(401);
      // 公开的桥接口没带令牌：处理器自己回 401，不碰服务（登记期替身被调用会抛 500）。
      expect((await fetch(`${url}${MCP_BRIDGE_TOOLS_PATH}`)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('bin/clawopt-mcp（真子进程）', () => {
  it('initialize → tools/list → tools/call → stdin 关闭即退出；令牌不进 argv 与输出', async () => {
    const TOKEN = 'test-token-0123456789abcdef-should-never-leak';
    const seen: Array<{ path: string; auth: string | undefined; body: string }> = [];
    const fake = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/mcp-bridge/tools') {
          res.end(JSON.stringify({ success: true, tools: [{ name: 'memory_search', description: 'search', inputSchema: { type: 'object' }, toolset: 'memory' }] }));
        } else if (JSON.parse(body).operation === 'memory_search') {
          res.end(JSON.stringify({ success: true, result: { exact: [], relevant: [{ id: 'c1' }], omitted: [] } }));
        } else {
          res.statusCode = 403;
          res.end(JSON.stringify({ success: false, errorCode: 'mcpServer.operationNotAllowed' }));
        }
      });
    });
    try {
      const bin = path.join(__dirname, '..', '..', 'bin', 'clawopt-mcp');
      const child = spawn(process.execPath, [bin], {
        env: { PATH: process.env.PATH, CLAWOPT_MCP_URL: fake.url, CLAWOPT_MCP_TOKEN: TOKEN, CLAWOPT_MCP_TOOLSETS: 'memory' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(child.spawnargs.join(' ')).not.toContain(TOKEN);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
      const lines = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'tea' } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'users_delete', arguments: {} } },
        { jsonrpc: '2.0', id: 5, method: 'nope' },
      ];
      child.stdin.write(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
      child.stdin.end();
      const code = await exited;
      expect(code).toBe(0);
      const replies = new Map(stdout.trim().split('\n').map((line) => JSON.parse(line)).map((message) => [message.id, message]));
      expect(replies.get(1).result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'clawopt' } });
      expect(replies.get(2).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['memory_search']);
      expect(replies.get(3).result.isError).toBe(false);
      expect(JSON.parse(replies.get(3).result.content[0].text).relevant[0].id).toBe('c1');
      expect(replies.get(4).result).toMatchObject({ isError: true });
      expect(replies.get(4).result.content[0].text).toContain('mcpServer.operationNotAllowed');
      expect(replies.get(5).error.code).toBe(-32601);
      expect(seen.every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
      expect(stdout + stderr).not.toContain(TOKEN);
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });
});
