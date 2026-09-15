/**
 * 文件管理器用例的公共装配：一次性 HOME（`~/.openclaw/workspace-<id>` 在临时目录里）、内存 SQLite、
 * 真的鉴权中间件与数据面授权（用户 / 角色 / Agent 授权是替身），真 Express。
 */
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import { createAuthMiddleware, createResourceAccess } from '../../src/core/auth';
import { buildStructuredApiError, isStructuredRequestError } from '../../src/core/http';
import { createFileManagerService, registerFileManagerRoutes } from '../../src/workspace/files/manager';
import type { FileManagerServiceDeps } from '../../src/workspace/files/manager';

export type Role = 'super_admin' | 'admin' | 'member';

export const USERS: Record<string, { id: number; role: Role; agents: string[] }> = {
  'super-token': { id: 1, role: 'super_admin', agents: [] },
  'admin-token': { id: 2, role: 'admin', agents: [] },
  'admin2-token': { id: 4, role: 'admin', agents: [] },
  'member-token': { id: 3, role: 'member', agents: ['alice'] },
};

export type FmHarness = {
  home: string;
  dataDir: string;
  workspace: (agentId: string) => string;
  outside: string;
  baseUrl: string;
  service: ReturnType<typeof createFileManagerService>;
  request: (token: string, method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any; text: string; headers: Headers }>;
  close: () => Promise<void>;
};

export async function startFileManagerHarness(overrides: Partial<FileManagerServiceDeps> = {}): Promise<FmHarness> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-fm-home-')));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const dataDir = path.join(home, '.clawopt-test');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.mkdirSync(path.join(home, 'custom-carol'), { recursive: true });
  fs.writeFileSync(path.join(home, 'custom-carol', 'notes.txt'), 'carol');
  const workspace = (agentId: string) => path.join(home, '.openclaw', `workspace-${agentId}`);
  for (const agent of ['alice', 'bob']) {
    fs.mkdirSync(path.join(workspace(agent), 'docs'), { recursive: true });
    fs.writeFileSync(path.join(workspace(agent), 'README.md'), `# ${agent}\n`);
  }

  const users = Object.fromEntries(Object.values(USERS).map((user) => [user.id, user]));
  const auth = createAuthMiddleware({
    configManager: { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) },
    authStore: { resolve: (token: string) => (USERS[token] ? { token, userId: USERS[token].id, createdAt: 0, expiresAt: Date.now() + 60_000 } : null) },
    userStore: {
      count: () => 3,
      get: (id: number) => (users[id] ? { id, username: `u${id}`, role: users[id].role, status: 'active', mustChangePassword: false } : null),
      firstActiveSuperAdmin: () => null,
      hasAgent: (id: number, agentId: string) => Boolean(users[id]?.agents.includes(agentId)),
    },
  } as any);
  const access = createResourceAccess({
    canAccessAgent: auth.canAccessAgent,
    lookup: { chatSessionAgentId: () => null, roomAgentIds: () => null, runSessionAgentId: () => null, uploadSessionKey: () => null },
  });
  const db = new Database(':memory:');
  const service = createFileManagerService({
    db: { connection: () => db } as any,
    access,
    // carol 的工作区不在 ~/.openclaw 下（名册里自定义的路径）：列目录可以，发内容要过可服务路径闸门，过不去。
    listAgentWorkspaces: async () => [...['alice', 'bob'].map((agentId) => ({ agentId, workspace: workspace(agentId) })), { agentId: 'carol', workspace: path.join(home, 'custom-carol') }],
    hostCapabilities: async () => ({ gates: { fileManagerSsh: { allowed: true, reason: null }, fileManagerDocker: { allowed: false, reason: 'host.dockerMissing' } } }) as any,
    dataDir,
    homeDir: home,
    gitRunner: async () => ({ code: 128, stdout: '', missing: false, timedOut: false }),
    ...overrides,
  });

  const app = express();
  app.use(express.json());
  app.use('/api', auth.requireSessionAuth);
  registerFileManagerRoutes(app as any, { auth, fileManager: service });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isStructuredRequestError(error)) return res.status(error.status).json(error.payload);
    return res.status(500).json(buildStructuredApiError('test.unhandled'));
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    home,
    dataDir,
    workspace,
    outside,
    baseUrl,
    service,
    async request(token, method, url, body, headers = {}) {
      const isBuffer = Buffer.isBuffer(body);
      const response = await fetch(`${baseUrl}${url}`, {
        method,
        headers: {
          'X-ClawOPT-Auth-Token': token,
          ...(body !== undefined ? { 'Content-Type': isBuffer ? 'application/octet-stream' : 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : isBuffer ? (body as Buffer) : JSON.stringify(body),
      });
      const text = await response.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* 下载是字节 */ }
      return { status: response.status, json, text, headers: response.headers };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.stop();
      db.close();
      process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export const q = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;
