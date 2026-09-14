/**
 * /livez 与 /readyz：公开；/readyz 在「数据库就绪 + 已监听」之前一律 503。
 * 登录开启、匿名请求下验证——探针不该被登录挡住。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { buildApp } from '../src/bootstrap';
import { createReadiness } from '../src/bootstrap/health';
import { AUTH_PUBLIC_PATHS, createAuthMiddleware } from '../src/core/auth';
import { createStubContext } from './helpers/stub-context';

const configManager = { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) };
const authStore = { verify: () => false };
const readiness = createReadiness();

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  const auth = createAuthMiddleware({ configManager, authStore } as any);
  const ctx = createStubContext({ configManager, authStore, auth, connections: new Map() });
  server = http.createServer(buildApp(ctx, { readiness }).app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('存活与就绪探针', () => {
  it('/livez 永远 200，且不需要登录', async () => {
    const response = await fetch(`${baseUrl}/livez`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('/readyz：数据库未就绪 → 503；只就绪一半 → 仍 503；两项都好 → 200', async () => {
    let response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'starting', checks: { dbReady: false, listening: false } });

    readiness.markDbReady();
    response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);

    readiness.markListening();
    response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', checks: { dbReady: true, listening: true } });
  });

  it('两条探针都登记在 AUTH_PUBLIC_PATHS 里', () => {
    expect(AUTH_PUBLIC_PATHS.has('/livez')).toBe(true);
    expect(AUTH_PUBLIC_PATHS.has('/readyz')).toBe(true);
  });

  it('原有 /health 形状不变', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['connections', 'status', 'timestamp']);
    expect(body.connections).toBe(0);
  });
});
