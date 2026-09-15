/**
 * 性能监控（P6）：
 * 1. 解析：vm_stat 可回收内存、/proc/meminfo 的 MemAvailable、ps 全表 → 本进程子孙（带深度、认出运行时）；
 * 2. 快照：活跃运行按运行时 / Agent 分组、排队长度；任何一块取不到只在那一块报错，整张快照照样返回；
 * 3. 闸门：只给 super_admin——admin 与 member 都 403（登记表里是 adminOnly，能力清单是 super_admin）。
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/bootstrap';
import { createAuthMiddleware } from '../src/core/auth';
import { cpuPercentBetween, createPerformanceService, descendantsOf, parseMeminfoAvailable, parsePsOutput, parseVmStatAvailable } from '../src/control';
import { createStubContext } from './helpers/stub-context';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
Pages active:                             5000.
Pages inactive:                           2000.
Pages speculative:                         300.
Pages throttled:                             0.
Pages wired down:                         4000.
Pages purgeable:                           100.
`;

const PS = `    1     0   0.0  1200 10-01:00:00 /sbin/launchd
  500     1   2.5 90000    01:00:00 /usr/local/bin/node
  600   500  10.0 150000    00:30 /opt/homebrew/bin/claude
  601   600   0.5  40000    00:29 node
  700   500   0.0  3000    00:10 /bin/zsh
  800     1   0.0  2000    00:05 /usr/bin/other
garbage line
`;

describe('解析', () => {
  it('vm_stat：free + inactive + speculative + purgeable', () => {
    expect(parseVmStatAvailable(VM_STAT)).toBe((1000 + 2000 + 300 + 100) * 16384);
    expect(parseVmStatAvailable('nonsense')).toBeNull();
  });

  it('/proc/meminfo：取 MemAvailable 而不是 MemFree', () => {
    expect(parseMeminfoAvailable('MemTotal: 2048000 kB\nMemFree: 100000 kB\nMemAvailable: 768000 kB\n')).toBe(768000 * 1024);
    expect(parseMeminfoAvailable('MemTotal: 2048000 kB\nMemFree: 100000 kB\n')).toBeNull();
  });

  it('ps：本进程的子孙（不含自己与无关进程），命令名只留 basename', () => {
    const rows = parsePsOutput(PS);
    expect(rows).toHaveLength(6);
    const descendants = descendantsOf(rows, 500);
    expect(descendants.map((row) => [row.pid, row.command, row.depth])).toEqual([[600, 'claude', 1], [700, 'zsh', 1], [601, 'node', 2]]);
  });

  it('CPU 差值', () => {
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 150, total: 400 })).toBe(75);
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBeNull();
  });
});

describe('快照', () => {
  const cpu = (idle: number, user: number) => [{ model: 'x', speed: 1, times: { user, nice: 0, sys: 0, idle, irq: 0 } }];

  it('活跃运行分组、排队长度、子进程认出运行时；工作流活跃运行数', async () => {
    let tick = 0;
    const service = createPerformanceService({
      runCoordinator: {
        activeRuns: () => [
          { sessionKey: 's1', runtime: 'claude-code', agentId: 'ext:claude-code', phase: 'running', aborting: false, startedAt: 1 },
          { sessionKey: 'room:g:member:m', runtime: 'claude-code', agentId: 'ext:claude-code', phase: 'running', aborting: false, startedAt: 2 },
          { sessionKey: 's3', runtime: 'openclaw', agentId: 'main', phase: 'preparing', aborting: false, startedAt: 3 },
        ],
        snapshot: (key) => ({ queue: key === 's1' ? [{}, {}] : [] }),
      },
      runtimePlatform: { manager: { descriptors: () => [{ id: 'claude-code', command: 'claude' }] } },
      automation: { runStore: { listActiveRuns: () => [{}] } },
      cpus: () => (tick++ === 0 ? cpu(100, 100) : cpu(150, 250)) as never,
      runCommand: async (file) => (file === 'ps' ? PS : VM_STAT),
      platform: 'darwin',
      pid: 500,
      sleep: async () => {},
    });
    const snapshot = await service.snapshot();
    expect(snapshot.runs.byRuntime).toEqual({ 'claude-code': 2, openclaw: 1 });
    expect(snapshot.runs.byAgent).toEqual({ 'ext:claude-code': 2, main: 1 });
    expect(snapshot.runs.queuedTotal).toBe(2);
    expect(snapshot.runs.workflowActiveRuns).toBe(1);
    expect(snapshot.children.rows.find((row) => row.pid === 600)?.runtime).toBe('claude-code');
    expect(snapshot.children.totalRssKb).toBe(150000 + 40000 + 3000);
    expect(snapshot.system.memory.source).toBe('vm_stat');
    expect(snapshot.system.cpuPercent).toBe(75);
    expect(snapshot.errors).toEqual([]);
  });

  it('取不到的块只在那一块报错：ps 失败、协调器抛错，快照照样返回', async () => {
    const service = createPerformanceService({
      runCoordinator: { activeRuns: () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }); }, snapshot: () => ({ queue: [] }) },
      runtimePlatform: { manager: { descriptors: () => [] } },
      automation: { runStore: { listActiveRuns: () => [] } },
      runCommand: async () => { throw Object.assign(new Error('no ps'), { code: 'ENOENT' }); },
      readText: () => null,
      platform: 'linux',
      sleep: async () => {},
    });
    const snapshot = await service.snapshot();
    expect(snapshot.runs.error).toBe('EBOOM');
    expect(snapshot.children.error).toBe('ENOENT');
    expect(snapshot.system.memory.source).toBe('os');
    expect(snapshot.process.pid).toBe(process.pid);
  });
});

describe('闸门：只给 super_admin', () => {
  let server: http.Server;
  let baseUrl = '';
  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const roles: Record<string, string> = { 'admin-token': 'admin', 'member-token': 'member' };
    const ids: Record<string, number> = { 'admin-token': 1, 'member-token': 2 };
    const configManager = { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) };
    const authStore = { resolve: (token: string) => (roles[token] ? { token, userId: ids[token] } : null) };
    const userStore = {
      count: () => 2,
      get: (id: number) => ({ id, username: `u${id}`, role: id === 1 ? 'admin' : 'member', status: 'active', mustChangePassword: false }),
      firstActiveSuperAdmin: () => null,
      hasAgent: () => false,
    };
    const auth = createAuthMiddleware({ configManager, authStore, userStore } as never);
    const built = buildApp(createStubContext({ configManager, authStore, userStore, auth }));
    const record = built.routes.list().find((entry) => entry.path === '/api/performance/runtime');
    expect(record?.adminOnly).toBe(true);
    server = http.createServer(built.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('admin 403、member 403、匿名 401', async () => {
    expect((await fetch(`${baseUrl}/api/performance/runtime`, { headers: { 'X-ClawOPT-Auth-Token': 'admin-token' } })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/performance/runtime`, { headers: { 'X-ClawOPT-Auth-Token': 'member-token' } })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/performance/runtime`)).status).toBe(401);
  });
});
