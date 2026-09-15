/**
 * 鉴权覆盖：登录开启时，登记表里标成「受保护」的每一条路由，匿名请求都必须拿到 401。
 *
 * AGENTS.md 的纪律是「默认全保护 + 白名单放行」。拆分之后路由散在十几个文件里，
 * 一条路由受不受保护取决于它注册在闸门之前还是之后——这件事在任何单个文件里都看不出来。
 * 所以这里不信注释、也不信登记表的推断，而是真的起一个 HTTP 服务、逐条匿名去打。
 *
 * 公开面单独列成清单：新增公开路由必须改这里，那一刻就有人看见了。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { buildApp } from '../src/bootstrap';
import { AUTH_PUBLIC_PATHS, createAuthMiddleware } from '../src/core/auth';
import type { RouteRecord } from '../src/core/http';
import { createStubContext } from './helpers/stub-context';

const configManager = { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) };
const authStore = { verify: () => false, resolve: () => null };
const userStore = { count: () => 0, get: () => null, firstActiveSuperAdmin: () => null, hasAgent: () => false };

let server: http.Server;
let baseUrl = '';
let records: RouteRecord[] = [];

beforeAll(async () => {
  // 401 走的是原有错误处理中间件，它会 console.error 每一次——这里只关心状态码。
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const auth = createAuthMiddleware({ configManager, authStore, userStore } as any);
  const ctx = createStubContext({ configManager, authStore, userStore, auth });
  const built = buildApp(ctx);
  records = built.routes.list();
  server = http.createServer(built.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function concretePath(record: RouteRecord): string {
  if (record.path.startsWith('/^')) return '/openclaw/some/file.txt';
  return record.path.replace(/:[A-Za-z0-9_]+/g, 'x').replace(/\*$/, 'x');
}

/** 当前的公开面（登录开启时匿名可达）。改这份清单 = 改公开面。 */
const EXPECTED_PUBLIC_ROUTES = [
  'GET /livez',
  'GET /readyz',
  'GET /health',
  'GET /api/version',
  'GET /api/external-runtimes',
  // TODO(鉴权)：注释声称受保护，实际注册在闸门之前。P0 不改行为，见 diagnostics-routes.ts。
  'GET /api/diagnostics',
  'GET /api/version/latest',
  'GET /api/openclaw/version/latest',
  // 下面这些注册在闸门之前，但各自挂了 requireAdminAuth，登录开启时同样 401。
  'GET /api/openclaw/update/status',
  'POST /api/openclaw/update/start',
  'POST /api/openclaw/update/cancel',
  'POST /api/openclaw/update/reset',
  'GET /api/update/status',
  'POST /api/update/start',
  'POST /api/update/cancel',
  'POST /api/update/reset',
  'POST /api/update/restart-service',
  'GET /api/config',
  'POST /api/config',
  'GET /api/sidebar/favorites',
  'POST /api/sidebar/favorites',
  'GET /api/auth/check',
  'POST /api/auth/login',
  'GET *',
];

describe('鉴权覆盖（登录开启、匿名请求）', () => {
  it('公开面与签入的清单一致', () => {
    const publicRoutes = records
      .filter((r) => r.kind === 'route' && r.public)
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(publicRoutes).toEqual(EXPECTED_PUBLIC_ROUTES);
  });

  it('每一条受保护的路由匿名访问都是 401', async () => {
    const protectedRoutes = records.filter((r) => r.kind === 'route' && !r.public);
    expect(protectedRoutes.length, '受保护路由数量异常偏少').toBeGreaterThan(90);
    const leaks: string[] = [];
    for (const record of protectedRoutes) {
      const response = await fetch(`${baseUrl}${concretePath(record)}`, { method: record.method.toUpperCase() });
      if (response.status !== 401) leaks.push(`${record.method.toUpperCase()} ${record.path} -> ${response.status}`);
    }
    expect(leaks, `这些路由匿名可达：\n${leaks.join('\n')}`).toEqual([]);
  });

  it('管理员路由即使注册在闸门之前，匿名访问也是 401', async () => {
    const adminBeforeGate = records.filter((r) => r.kind === 'route' && r.public && r.adminOnly);
    expect(adminBeforeGate.map((r) => r.path)).toContain('/api/config');
    for (const record of adminBeforeGate) {
      const response = await fetch(`${baseUrl}${concretePath(record)}`, { method: record.method.toUpperCase() });
      expect(response.status, `${record.method} ${record.path}`).toBe(401);
    }
  });

  it('白名单只放行显式列出的路径', () => {
    expect([...AUTH_PUBLIC_PATHS].sort()).toEqual(['/api/auth/check', '/api/auth/login', '/api/version', '/livez', '/readyz']);
  });
});
