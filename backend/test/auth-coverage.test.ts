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
import { attachRealtimeServer } from '../src/bootstrap/realtime';
import { attachTerminalServer } from '../src/bootstrap/terminal';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { createTerminalService } from '../src/workspace';
import { RealtimeHub } from '../src/core/realtime';
import { AUTH_PUBLIC_PATHS, createAuthMiddleware } from '../src/core/auth';
import { LocalProviderProxy } from '../src/runtime';
import type { RouteRecord } from '../src/core/http';
import { createStubContext } from './helpers/stub-context';

const configManager = { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) };
// 只有这一个令牌是有效的：公开面清单照旧按匿名算，/ws 的正反两面都能验到。
// 这个令牌没有 userId、库里也没有用户：按多用户之前的单主人会话解析（与 HTTP 同一条身份判据）。
const authStore = {
  verify: (token: string) => token === 'valid-session-token',
  resolve: (token: string) => (token === 'valid-session-token' ? { userId: null } : null),
};
const userStore = { count: () => 0, get: () => null, firstActiveSuperAdmin: () => null, hasAgent: () => false };

let server: http.Server;
let baseUrl = '';
let records: RouteRecord[] = [];
let realtime: ReturnType<typeof attachRealtimeServer>;
let terminalWs: ReturnType<typeof attachTerminalServer>;
const terminal = createTerminalService({ db: { connection: () => new Database(':memory:') } as any, hostCapabilities: async () => ({}) as any });
const providerProxy = new LocalProviderProxy({ publicBaseUrl: () => 'http://127.0.0.1:9', log: () => {} });

beforeAll(async () => {
  // 401 走的是原有错误处理中间件，它会 console.error 每一次——这里只关心状态码。
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const auth = createAuthMiddleware({ configManager, authStore, userStore } as any);
  const ctx = createStubContext({ configManager, authStore, userStore, auth, realtime: new RealtimeHub(), providerProxy, terminal });
  const built = buildApp(ctx);
  records = built.routes.list();
  server = http.createServer(built.app);
  realtime = attachRealtimeServer(server, ctx);
  terminalWs = attachTerminalServer(server, ctx);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await realtime.close();
  await terminalWs.close();
  await terminal.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 发一个 WebSocket 升级请求，只看服务端回的 HTTP 状态（101 = 升级成功）。 */
function upgradeStatus(headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/ws`, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    });
    request.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
    request.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    request.on('error', reject);
    request.end();
  });
}

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
  // 本地模型代理（P2）：外部 CLI 带不了登录 cookie，靠处理器里的每目标令牌。见下方专门的用例。
  'GET /api/runtime-proxy/anthropic/:key/v1/models',
  'POST /api/runtime-proxy/anthropic/:key/v1/messages',
  'GET /api/runtime-proxy/responses/:key/v1/models',
  'POST /api/runtime-proxy/responses/:key/v1/responses',
  // P4a：入站钩子与本机测试收件箱。注册在闸门之后、靠白名单放行；安全性在处理器里（签名 / 回环 + 令牌）。
  'POST /api/hooks/workflows/:hookId',
  'POST /api/hooks/webhook-test/:token',
  // P6：MCP 桥接口。安全性在处理器里（本机回环 + 每运行范围令牌 + 操作白名单），用例在 test/mcp-server/。
  'GET /api/mcp-bridge/tools',
  'POST /api/mcp-bridge/call',
  // P3：访客页。概况 / 加入只认邀请码，其余认访客令牌头；安全性在处理器里（room-share-routes / relay-routes）。
  'GET /api/share/rooms/:code',
  'POST /api/share/rooms/:code/join',
  'GET /api/share/rooms/:code/me',
  'GET /api/share/rooms/:code/messages',
  'POST /api/share/rooms/:code/messages',
  'POST /api/share/rooms/:code/messages/:msgId/retract',
  'GET /api/share/rooms/:code/queue',
  'GET /api/share/rooms/:code/events',
  'GET /api/share/rooms/:code/interactions',
  'POST /api/share/rooms/:code/interactions/:interactionId/respond',
  'POST /api/share/rooms/:code/uploads',
  'GET /api/share/rooms/:code/uploads/:uploadId',
  'PUT /api/share/rooms/:code/uploads/:uploadId',
  'POST /api/share/rooms/:code/uploads/:uploadId/complete',
  'GET /api/share/rooms/:code/files/:storedName',
  'POST /api/share/rooms/:code/relay/pairings',
  'GET /api/share/rooms/:code/relay/pairings',
  'DELETE /api/share/rooms/:code/relay/connectors/:connectorId',
  // P3：远程 Agent relay。配对回调认请求密钥，远程工作区认每跳令牌；安全性在处理器里（relay-routes / relay-host）。
  'POST /api/relay/v1/pairings/:requestId/submit',
  'GET /api/relay/v1/pairings/:requestId/status',
  'POST /api/relay/v1/pairings/:requestId/failure',
  'POST /api/room-relay/workspace/actions',
  'GET /api/room-relay/workspace/file',
  'PUT /api/room-relay/workspace/file',
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

  it('WebSocket /ws 不在公开面：匿名升级 401，查询串带令牌也不行；cookie 里的会话令牌才放行', async () => {
    // 它不是 Express 路由，上面两条按登记表逐条打的用例覆盖不到——单独钉住。
    expect(await upgradeStatus()).toBe(401);
    const tokenInQuery = await new Promise<number>((resolve, reject) => {
      const request = http.request(`${baseUrl}/ws?token=valid-session-token`, {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64') },
      });
      request.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
      request.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      request.on('error', reject);
      request.end();
    });
    expect(tokenInQuery, '查询串令牌会进访问日志，不能被接受').toBe(401);
    expect(await upgradeStatus({ Cookie: 'clawopt_session=valid-session-token' })).toBe(101);
  });

  it('WebSocket /ws/terminal（P6）：匿名 401、URL 带票据或令牌 400；登录通过后没有有效一次性票据照样 4401 断开', async () => {
    const status = (path: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
      const request = http.request(`${baseUrl}${path}`, {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'), ...headers },
      });
      request.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
      request.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      request.on('error', reject);
      request.end();
    });
    expect(await status('/ws/terminal')).toBe(401);
    expect(await status('/ws/terminal?ticket=whatever', { Cookie: 'clawopt_session=valid-session-token' })).toBe(400);
    expect(await status('/ws/terminal?token=valid-session-token')).toBe(400);
    const closeCodeFor = (ticket: string) => new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/terminal`, { headers: { Cookie: 'clawopt_session=valid-session-token' } });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', ticket })));
      ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'ready') { ws.close(); resolve(1000); } });
      ws.on('close', (code) => resolve(code));
      ws.on('error', reject);
    });
    expect(await closeCodeFor('not-a-real-ticket-000000000000')).toBe(4401);
    // 同一个身份签发的票据：第一次放行，重用断开。
    const { ticket } = terminal.issueTicket({ userId: null, username: null, role: 'super_admin' });
    expect(await closeCodeFor(ticket)).toBe(1000);
    expect(await closeCodeFor(ticket)).toBe(4401);
  });

  it('白名单只放行显式列出的路径', () => {
    expect([...AUTH_PUBLIC_PATHS].sort()).toEqual([
      '/api/auth/check',
      '/api/auth/login',
      '/api/hooks/webhook-test/:token',
      '/api/hooks/workflows/:hookId',
      '/api/mcp-bridge/call',
      '/api/mcp-bridge/tools',
      '/api/relay/v1/pairings/:requestId/failure',
      '/api/relay/v1/pairings/:requestId/status',
      '/api/relay/v1/pairings/:requestId/submit',
      '/api/room-relay/workspace/actions',
      '/api/room-relay/workspace/file',
      '/api/runtime-proxy/anthropic/:key/v1/messages',
      '/api/runtime-proxy/anthropic/:key/v1/models',
      '/api/runtime-proxy/responses/:key/v1/models',
      '/api/runtime-proxy/responses/:key/v1/responses',
      '/api/share/rooms/:code',
      '/api/share/rooms/:code/events',
      '/api/share/rooms/:code/files/:storedName',
      '/api/share/rooms/:code/interactions',
      '/api/share/rooms/:code/interactions/:interactionId/respond',
      '/api/share/rooms/:code/join',
      '/api/share/rooms/:code/me',
      '/api/share/rooms/:code/messages',
      '/api/share/rooms/:code/messages/:msgId/retract',
      '/api/share/rooms/:code/queue',
      '/api/share/rooms/:code/relay/connectors/:connectorId',
      '/api/share/rooms/:code/relay/pairings',
      '/api/share/rooms/:code/uploads',
      '/api/share/rooms/:code/uploads/:uploadId',
      '/api/share/rooms/:code/uploads/:uploadId/complete',
      '/api/version',
      '/livez',
      '/readyz',
    ]);
  });

  it('代理路由越过登录闸门但过不了令牌：匿名打到的是代理自己的 404/401；多一段、空一段仍被闸门拦', async () => {
    const registered = providerProxy.register({
      provider: 'openai', model: 'm', baseUrl: 'https://upstream.test/v1', apiKey: 'k', apiMode: 'chat_completions', runtime: 'codex', runId: 'r', sessionId: 's',
    });
    const unknown = await fetch(`${baseUrl}/api/runtime-proxy/anthropic/unknown-key/v1/models`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.type).toBe('not_found_error');
    const noToken = await fetch(`${baseUrl}/api/runtime-proxy/responses/${registered.routeKey}/v1/models`);
    expect(noToken.status).toBe(401);
    expect((await noToken.json()).error.type).toBe('authentication_error');
    const withToken = await fetch(`${baseUrl}/api/runtime-proxy/responses/${registered.routeKey}/v1/models`, { headers: { authorization: `Bearer ${registered.token}` } });
    expect(withToken.status).toBe(200);

    for (const sneaky of [
      `/api/runtime-proxy/anthropic/${registered.routeKey}/extra/v1/models`,
      '/api/runtime-proxy/anthropic//v1/models',
      `/api/runtime-proxy/responses/${registered.routeKey}/v1/models/extra`,
    ]) {
      const res = await fetch(`${baseUrl}${sneaky}`);
      expect(res.status, sneaky).toBe(401);
      expect((await res.json()).errorCode, sneaky).toBe('auth.loginRequired');
    }
  });
});
