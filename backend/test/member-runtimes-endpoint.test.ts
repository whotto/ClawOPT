/**
 * 运行时清单只有一个接口：`GET /api/runtime/member-runtimes`（登记处 + 管理器检测）。
 *
 * 集成 v1.9 时删掉了并存的 `GET /api/external-runtimes`（适配器清单 + 原始 PATH 探测，且注册在登录闸门之前、匿名可达）。
 * 两份清单的探测判据不同（原始 PATH vs 扩充 PATH），同一台主机上会给出不同的「装没装」。
 * 这里钉住：清单来自登记处（七个编码类运行时 + 远程 OpenClaw），检测结果来自管理器缓存，能力按登记处的元数据给。
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CODING_AGENT_DEFINITIONS, RuntimeAdapterRegistry, registerBuiltinAdapters, registerRuntimePlatformRoutes } from '../src/runtime';

let server: http.Server;
let baseUrl = '';
const probed: string[] = [];

beforeAll(async () => {
  const registry = new RuntimeAdapterRegistry();
  registerBuiltinAdapters(registry);
  const manager = {
    cachedStatus: (id: string) => (id === 'claude-code' ? { installed: true, version: '2.1.272', probedAt: '2026-09-15T00:00:00.000Z' } : null),
    status: async (id: string) => { probed.push(id); return { installed: id === 'codex', version: id === 'codex' ? '0.153.4' : null, probedAt: '2026-09-15T00:00:01.000Z' }; },
  };
  const app = express();
  registerRuntimePlatformRoutes(app as any, { runtimePlatform: { registry, manager } as any, auth: { requireAdminAuth: (_req, res) => { res.status(403).end(); } } });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/runtime/member-runtimes', () => {
  it('清单 = 登记处（七个编码类运行时 + 远程 OpenClaw），检测优先用管理器缓存，没缓存才探测', async () => {
    const res = await fetch(`${baseUrl}/api/runtime/member-runtimes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.runtimes.map((runtime: { id: string }) => runtime.id);
    expect(ids).toEqual([...CODING_AGENT_DEFINITIONS.map((definition) => definition.descriptor.id), 'remote-openclaw']);
    const byId = Object.fromEntries(body.runtimes.map((runtime: any) => [runtime.id, runtime]));
    expect(byId['claude-code']).toMatchObject({ name: 'Claude Code', kind: 'cli', available: true, version: '2.1.272', modes: ['global', 'scoped'], approvals: false });
    expect(byId.codex).toMatchObject({ available: true, version: '0.153.4' });
    expect(byId.pi).toMatchObject({ available: false, approvals: true });
    expect(byId.hermes).toMatchObject({ approvals: true });
    expect(byId['remote-openclaw']).toMatchObject({ kind: 'remote' });
    expect(probed).not.toContain('claude-code');
    for (const runtime of body.runtimes) expect(runtime.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('另一份清单接口已删除', async () => {
    const res = await fetch(`${baseUrl}/api/external-runtimes`);
    expect(res.status).toBe(404);
  });
});
