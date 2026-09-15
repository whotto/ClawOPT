/**
 * P5a 控制面的授权覆盖（登录开启）：
 *
 * 1. 控制面模块里**每一条改状态的路由**（非 GET）在登记表里都是 adminOnly——新增一条忘了挂闸门，这里红；
 * 2. 真起 HTTP：member 会话打这些路由一律 403（在闸门之后、处理器之前被挡下，替身服务不会被调用）；
 * 3. Agent 作用域的读接口：member 打未授权的 Agent 403；
 * 4. 登记表里不允许出现同方法同路径的两条路由——后注册的那条永远不会被匹配（`/api/gateway/status` 撞过一次）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { buildApp } from '../src/bootstrap';
import { createAuthMiddleware } from '../src/core/auth';
import type { RouteRecord } from '../src/core/http';
import { createStubContext } from './helpers/stub-context';

const CONTROL_PLANE_MODULES = [
  'core/auth',
  'control/models',
  'control/agents',
  'control/workspace-files',
  'control/write-gate',
  'control/cron',
  'control/channels',
  'control/skills',
  'control/mcp',
  'control/plugins',
  'control/logs',
  'control/gateway',
  'control/commands',
];

/** 有意对 member 开放的写接口（改的是自己）。改这份清单 = 改授权面。 */
const MEMBER_WRITABLE = new Set(['POST /api/auth/logout', 'POST /api/auth/login', 'POST /api/auth/change-password']);

const MEMBER_TOKEN = 'member-token';
const configManager = { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) };
const authStore = { verify: (token: string) => token === MEMBER_TOKEN, resolve: (token: string) => (token === MEMBER_TOKEN ? { token, userId: 7, createdAt: 0, expiresAt: Date.now() + 60_000, label: 'web' } : null) };
const userStore = {
  count: () => 1,
  get: (id: number) => (id === 7 ? { id: 7, username: 'mem', role: 'member', status: 'active', mustChangePassword: false } : null),
  firstActiveSuperAdmin: () => null,
  hasAgent: (_id: number, agentId: string) => agentId === 'mine',
};

let server: http.Server;
let baseUrl = '';
let records: RouteRecord[] = [];

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const auth = createAuthMiddleware({ configManager, authStore, userStore } as any);
  const built = buildApp(createStubContext({ configManager, authStore, userStore, auth }));
  records = built.routes.list();
  server = http.createServer(built.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const label = (record: RouteRecord) => `${record.method.toUpperCase()} ${record.path}`;
const concrete = (record: RouteRecord, agentId = 'someone-else') => record.path.replace(':agentId', agentId).replace(/:[A-Za-z0-9_]+/g, 'x');

function controlMutations() {
  return records.filter((record) => record.kind === 'route'
    && record.method !== 'get'
    && CONTROL_PLANE_MODULES.includes(record.module)
    && !MEMBER_WRITABLE.has(label(record)));
}

describe('控制面授权（登录开启）', () => {
  it('控制面里每一条写路由都挂了管理员闸门', () => {
    const mutations = controlMutations();
    expect(mutations.length, '控制面写路由数量异常偏少').toBeGreaterThan(60);
    const unguarded = mutations.filter((record) => !record.adminOnly).map(label);
    expect(unguarded, `这些写路由没有挂 requireAdminAuth / requireSuperAdmin：\n${unguarded.join('\n')}`).toEqual([]);
  });

  it('member 会话打控制面写路由一律 403', async () => {
    const leaks: string[] = [];
    for (const record of controlMutations()) {
      const response = await fetch(`${baseUrl}${concrete(record)}`, {
        method: record.method.toUpperCase(),
        headers: { 'X-ClawOPT-Auth-Token': MEMBER_TOKEN, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (response.status !== 403) leaks.push(`${label(record)} -> ${response.status}`);
    }
    expect(leaks, `member 能打到这些写路由：\n${leaks.join('\n')}`).toEqual([]);
  });

  it('Agent 作用域读接口：未授权的 Agent 403', async () => {
    for (const path of ['/api/agents/someone-else/workspace-files', '/api/agents/someone-else/workspace-files/SOUL.md', '/api/agents/someone-else/avatar']) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { 'X-ClawOPT-Auth-Token': MEMBER_TOKEN } });
      expect(response.status, path).toBe(403);
    }
  });

  it('用户管理与日志只给管理员：member 读也是 403', async () => {
    for (const path of ['/api/users', '/api/auth/locked-ips', '/api/logs', '/api/providers/audit']) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { 'X-ClawOPT-Auth-Token': MEMBER_TOKEN } });
      expect(response.status, path).toBe(403);
    }
  });

  it('没有同方法同路径的重复路由', () => {
    const seen = new Map<string, number>();
    for (const record of records.filter((entry) => entry.kind === 'route')) seen.set(label(record), (seen.get(label(record)) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
    expect(duplicates).toEqual([]);
  });
});
