/**
 * 每用户主题（P6）：
 * 1. 按用户隔离（隐式主人 / 各用户各一份），member 能改自己的；
 * 2. 输入严格：颜色只收 #rrggbb（#rgb 展开）、字号 12–20 整数、模式三选一、不认识的字段拒绝；
 * 3. 背景图按魔数判类型，不信 Content-Type；超 5 MB 回 413；读回时 nosniff + 按上传判出的类型；
 * 4. 登录开启时匿名 401（闸门在前）。
 */
import Database from 'better-sqlite3';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/bootstrap';
import { createAuthMiddleware } from '../src/core/auth';
import { isStructuredRequestError } from '../src/core/http';
import { createThemeService, normalizeHexColor, parseThemeInput, registerThemeRoutes, sniffBackgroundMime, THEME_BACKGROUND_MAX_BYTES } from '../src/control';
import { createStubContext } from './helpers/stub-context';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16, 2)]);

describe('主题输入校验', () => {
  it('颜色只收 #rrggbb，#rgb 展开并小写化', () => {
    expect(normalizeHexColor('#ABC', 'x')).toBe('#aabbcc');
    expect(normalizeHexColor('#1a2B3c', 'x')).toBe('#1a2b3c');
    expect(normalizeHexColor('', 'x')).toBeNull();
    for (const bad of ['red', '#12345', 'url(javascript:1)', '#1234567', 'rgb(0,0,0)', 7]) {
      expect(() => normalizeHexColor(bad, 'theme.invalidColor'), String(bad)).toThrow('theme.invalidColor');
    }
  });

  it('字号 12–20 整数、模式三选一、不认识的字段拒绝', () => {
    expect(parseThemeInput({ mode: 'dark', fontSize: 18 })).toEqual({ mode: 'dark', accentColor: null, textColor: null, fontSize: 18 });
    expect(() => parseThemeInput({ mode: 'dark', fontSize: 11 })).toThrow('theme.invalidFontSize');
    expect(() => parseThemeInput({ mode: 'dark', fontSize: 16.5 })).toThrow('theme.invalidFontSize');
    expect(() => parseThemeInput({ mode: 'neon' })).toThrow('theme.invalidMode');
    expect(() => parseThemeInput({ mode: 'light', css: 'body{}' })).toThrow('theme.invalid');
  });

  it('背景图类型只认魔数', () => {
    expect(sniffBackgroundMime(PNG)).toBe('image/png');
    expect(sniffBackgroundMime(GIF)).toBe('image/gif');
    expect(sniffBackgroundMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffBackgroundMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffBackgroundMime(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
  });
});

describe('主题路由（按用户）', () => {
  let server: http.Server;
  let baseUrl = '';
  /** 当前请求用哪个令牌：null = 登录关闭时的隐式主人（换一个登录关闭的应用实例太重，这里按令牌切换身份）。 */
  let token: string | null = null;
  let loginEnabled = true;

  beforeAll(async () => {
    const sql = new Database(':memory:');
    const theme = createThemeService({ db: { connection: () => sql } as never });
    const users = new Map<number, { id: number; username: string; role: string; status: string; mustChangePassword: boolean }>();
    for (const id of [7, 8, 9, 10, 11]) users.set(id, { id, username: `u${id}`, role: 'member', status: 'active', mustChangePassword: false });
    const auth = createAuthMiddleware({
      configManager: { getConfig: () => ({ loginEnabled, allowedHosts: [] }) },
      authStore: { resolve: (value: string) => (/^t\d+$/.test(value) ? { token: value, userId: Number(value.slice(1)) } : null) },
      userStore: { count: () => users.size, get: (id: number) => users.get(id) ?? null, firstActiveSuperAdmin: () => null, hasAgent: () => false },
    } as never);
    const app = express();
    app.use(express.json());
    app.use('/api', auth.requireSessionAuth);
    registerThemeRoutes(app as never, { auth, theme });
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (isStructuredRequestError(error)) res.status(error.status).json(error.payload);
      else res.status(500).end();
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const as = (next: string | null) => {
    token = next;
    loginEnabled = next !== null;
  };
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...(token ? { 'X-ClawOPT-Auth-Token': token } : {}) });
  const put = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, { method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  const get = (path: string) => fetch(`${baseUrl}${path}`, { headers: headers() });

  it('用户之间互不影响，隐式主人单独一份', async () => {
    as('t7');
    const saved = await (await put('/api/theme', { mode: 'dark', accentColor: '#ff8800', fontSize: 18 })).json() as any;
    expect(saved.theme).toMatchObject({ mode: 'dark', accentColor: '#ff8800', fontSize: 18 });

    as('t8');
    expect((await (await get('/api/theme')).json() as any).theme).toMatchObject({ mode: 'light', accentColor: null, revision: 'default' });

    as(null);
    expect((await (await get('/api/theme')).json() as any).theme.mode).toBe('light');

    as('t7');
    expect((await (await get('/api/theme')).json() as any).theme.accentColor).toBe('#ff8800');
  });

  it('非法颜色 400，不落库', async () => {
    as('t9');
    const response = await put('/api/theme', { mode: 'light', accentColor: 'expression(alert(1))' });
    expect(response.status).toBe(400);
    expect((await response.json() as any).errorCode).toBe('theme.invalidColor');
    expect((await (await get('/api/theme')).json() as any).theme.revision).toBe('default');
  });

  it('背景图：谎报 Content-Type 的 HTML 被拒；PNG 存下后按魔数类型读回，nosniff；超限 413', async () => {
    as('t10');
    const html = await fetch(`${baseUrl}/api/theme/background`, { method: 'PUT', headers: headers({ 'Content-Type': 'image/png' }), body: '<html><script>alert(1)</script></html>' });
    expect(html.status).toBe(400);
    expect((await html.json() as any).errorCode).toBe('theme.backgroundInvalid');

    const ok = await fetch(`${baseUrl}/api/theme/background`, { method: 'PUT', headers: headers({ 'Content-Type': 'text/html' }), body: PNG });
    expect(ok.status).toBe(200);
    const theme = (await ok.json() as any).theme;
    expect(theme.background).toMatchObject({ mime: 'image/png', size: PNG.length });

    const read = await get('/api/theme/background');
    expect(read.headers.get('content-type')).toBe('image/png');
    expect(read.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await read.arrayBuffer()).equals(PNG)).toBe(true);

    const huge = Buffer.concat([PNG, Buffer.alloc(THEME_BACKGROUND_MAX_BYTES, 0)]);
    const tooLarge = await fetch(`${baseUrl}/api/theme/background`, { method: 'PUT', headers: headers({ 'Content-Type': 'application/octet-stream' }), body: huge });
    expect(tooLarge.status).toBe(413);

    // 别的用户读不到这一张。
    as('t11');
    expect((await get('/api/theme/background')).status).toBe(404);
  });
});

describe('登录开启时主题路由在闸门之后', () => {
  it('匿名 401；member 的写入不在控制面管理员闸门清单里（改的是自己）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const configManager = { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) };
    const authStore = { verify: () => false, resolve: () => null };
    const userStore = { count: () => 1, get: () => null, firstActiveSuperAdmin: () => null, hasAgent: () => false };
    const auth = createAuthMiddleware({ configManager, authStore, userStore } as never);
    const built = buildApp(createStubContext({ configManager, authStore, userStore, auth }));
    const records = built.routes.list().filter((record) => record.module === 'control/theme' && record.kind === 'route');
    expect(records.map((record) => `${record.method.toUpperCase()} ${record.path}`).sort()).toEqual([
      'DELETE /api/theme', 'DELETE /api/theme/background', 'GET /api/theme', 'GET /api/theme/background', 'PUT /api/theme', 'PUT /api/theme/background',
    ]);
    expect(records.every((record) => !record.public && !record.adminOnly)).toBe(true);
    const server = http.createServer(built.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${url}/api/theme`)).status).toBe(401);
      expect((await fetch(`${url}/api/theme`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
