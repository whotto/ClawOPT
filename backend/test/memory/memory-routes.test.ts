/**
 * 记忆浏览管理面：只给管理员（member 403）；编辑 / 删除带版本号，不符 412 + 当前卡片；「记住」是人显式发起的写入。
 */
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAuthMiddleware } from '../../src/core/auth';
import { createMemoryService, registerMemoryRoutes, type MemoryService } from '../../src/memory';

const ADMIN = 'admin-token';
const MEMBER = 'member-token';
const users: Record<number, { id: number; username: string; role: string; status: string; mustChangePassword: boolean }> = {
  1: { id: 1, username: 'boss', role: 'admin', status: 'active', mustChangePassword: false },
  2: { id: 2, username: 'mem', role: 'member', status: 'active', mustChangePassword: false },
};
const tokens: Record<string, number> = { [ADMIN]: 1, [MEMBER]: 2 };

let server: http.Server;
let baseUrl = '';
let memory: MemoryService;
let dir: string;

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-memory-routes-'));
  memory = createMemoryService({ dbPath: path.join(dir, 'memory.sqlite'), log: () => {} });
  const auth = createAuthMiddleware({
    configManager: { getConfig: () => ({ loginEnabled: true }) },
    authStore: { resolve: (token: string) => (tokens[token] ? { token, userId: tokens[token], createdAt: 0, expiresAt: Date.now() + 60_000, label: 'web' } : null) },
    userStore: { count: () => 2, get: (id: number) => users[id] ?? null, firstActiveSuperAdmin: () => null, hasAgent: () => true },
  } as never);
  const app = express();
  app.use(express.json());
  registerMemoryRoutes(app, { auth, memory });
  app.use((error: { status?: number; payload?: unknown }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json(error.payload ?? {});
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  memory.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, url: string, token: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'X-ClawOPT-Auth-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
};

describe('记忆管理面授权', () => {
  it('member 打每一条记忆接口都是 403', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/memory/profiles'], ['GET', '/api/memory/cards'], ['GET', '/api/memory/cards/x'], ['GET', '/api/memory/graph?profileId=a'],
      ['POST', '/api/memory/cards'], ['PATCH', '/api/memory/cards/x'], ['DELETE', '/api/memory/cards/x'], ['GET', '/api/memory/audit'],
    ];
    for (const [method, url] of routes) {
      expect((await call(method, url, MEMBER, method === 'GET' ? undefined : {})).status, `${method} ${url}`).toBe(403);
    }
  });

  it('「记住」→ 编辑（版本号）→ 陈旧版本号 412 带当前卡片 → 软删除 → 审计记操作者', async () => {
    const created = await call('POST', '/api/memory/cards', ADMIN, { profileId: 'main', kind: 'general_preference', itemKey: 'editor', title: '用 Vim', content: '用户用 Vim' });
    expect(created.status).toBe(201);
    const card = created.body.result.card;
    expect(card).toMatchObject({ revision: 1, scope: { type: 'profile', id: 'main' }, confidence: 0.98 });

    const edited = await call('PATCH', `/api/memory/cards/${card.id}`, ADMIN, { expectedRevision: 1, content: '用户改用 Neovim' });
    expect(edited.status).toBe(200);
    const next = edited.body.result.card;
    expect(next.revision).toBe(2);

    const stale = await call('PATCH', `/api/memory/cards/${next.id}`, ADMIN, { expectedRevision: 1, content: 'x' });
    expect(stale.status).toBe(412);
    expect(stale.body.errorCode).toBe('memoryService.revisionMismatch');
    expect(stale.body.current).toMatchObject({ id: next.id, revision: 2 });

    const missing = await call('DELETE', `/api/memory/cards/${next.id}`, ADMIN, {});
    expect(missing.status).toBe(412);

    const deleted = await call('DELETE', `/api/memory/cards/${next.id}`, ADMIN, { expectedRevision: 2 });
    expect(deleted.status).toBe(200);
    expect(deleted.body.result.card).toMatchObject({ status: 'deleted', revision: 3 });

    const detail = await call('GET', `/api/memory/cards/${card.id}`, ADMIN);
    expect(detail.body.revisions.map((entry: any) => entry.revision)).toEqual([1, 3]);
    const audit = await call('GET', '/api/memory/audit?profileId=main', ADMIN);
    expect(audit.body.events.map((event: any) => event.actor)).toEqual(['user:boss', 'user:boss', 'user:boss']);

    const list = await call('GET', '/api/memory/cards?profileId=main&status=all', ADMIN);
    expect(list.body.total).toBe(2);
    const graph = await call('GET', '/api/memory/graph?profileId=main&includeDeleted=1', ADMIN);
    expect(graph.body.edges.map((edge: any) => edge.kind)).toEqual(['revision']);
  });

  it('非法输入回结构化错误码', async () => {
    const bad = await call('POST', '/api/memory/cards', ADMIN, { profileId: 'main', kind: 'nope', title: 't', content: 'c' });
    expect(bad).toMatchObject({ status: 400, body: { errorCode: 'memoryService.unknownKind' } });
    expect((await call('GET', '/api/memory/graph', ADMIN)).body.errorCode).toBe('memoryService.invalidInput');
    expect((await call('GET', '/api/memory/cards/none', ADMIN)).status).toBe(404);
  });
});
