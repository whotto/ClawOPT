/**
 * Web 终端 WebSocket 端到端（真 node-pty；本机加载不了时整组跳过并说明原因）：
 * - 升级：URL 带凭据 400、未登录 401、非 super_admin 403；第一条消息必须是 auth、票据一次性且绑定用户；
 * - **断线接回**：建会话 → `echo ok` → 掐断 socket → 新票据重连 → attach → 重放里看得到 ok；带偏移接回只补差额；
 * - 别的用户接不到；空闲回收整组杀掉（后台子进程也死）；审计有生命周期、没有按键。
 */
import Database from 'better-sqlite3';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { attachTerminalWebSocketServer, createTerminalService, type TerminalService } from '../../src/workspace/terminal';
import { loadNodePty, probePty } from '../../src/workspace/terminal/pty-loader';

const IDENTITIES: Record<string, { userId: number | null; username: string | null; role: string }> = {
  alice: { userId: 1, username: 'alice', role: 'super_admin' },
  bob: { userId: 2, username: 'bob', role: 'super_admin' },
  mallory: { userId: 3, username: 'mallory', role: 'admin' },
};

async function ptyUsable(): Promise<string | null> {
  const loaded = loadNodePty();
  if (!loaded.ok) return loaded.detail;
  const probe = await probePty(loaded.pty, '/bin/sh');
  return probe.ok ? null : probe.detail;
}

const skipReason = await ptyUsable();

function waitFor<T>(ws: WebSocket, predicate: (message: any) => T | undefined, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('timed out waiting for message')); }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      const hit = predicate(message);
      if (hit !== undefined) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(hit);
      }
    };
    ws.on('message', onMessage);
  });
}

const closeCode = (ws: WebSocket) => new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

describe.skipIf(skipReason !== null)(`终端 WebSocket（真 node-pty）${skipReason ? `——跳过：${skipReason}` : ''}`, () => {
  let server: http.Server;
  let terminal: TerminalService;
  let wsServer: ReturnType<typeof attachTerminalWebSocketServer>;
  let base = '';
  const sql = new Database(':memory:');

  beforeAll(async () => {
    terminal = createTerminalService({ db: { connection: () => sql } as any, hostCapabilities: async () => ({}) as any, idleMs: 800, killGraceMs: 300 });
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
    wsServer = attachTerminalWebSocketServer(server, {
      terminal,
      authenticate: (req) => IDENTITIES[String(req.headers['x-test-user'] ?? '')] ?? null,
      isHostAllowed: () => true,
      authTimeoutMs: 500,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await wsServer.close();
    await terminal.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function upgradeStatus(path: string, user?: string): Promise<number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${base}${path}`, { headers: user ? { 'x-test-user': user } : {} });
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => undefined);
    });
  }

  async function connect(user: string): Promise<{ ws: WebSocket; ready: any }> {
    const ws = new WebSocket(`${base}/ws/terminal`, { headers: { 'x-test-user': user } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const { ticket } = terminal.issueTicket(IDENTITIES[user]);
    const readyPromise = waitFor(ws, (m) => (m.type === 'ready' ? m : undefined));
    ws.send(JSON.stringify({ type: 'auth', ticket }));
    return { ws, ready: await readyPromise };
  }

  it('升级：URL 带凭据 400，未登录 401，不是 super_admin 403', async () => {
    expect(await upgradeStatus('/ws/terminal?ticket=abc', 'alice')).toBe(400);
    expect(await upgradeStatus('/ws/terminal?token=abc', 'alice')).toBe(400);
    expect(await upgradeStatus('/ws/terminal')).toBe(401);
    expect(await upgradeStatus('/ws/terminal', 'mallory')).toBe(403);
    expect(await upgradeStatus('/ws/terminal', 'alice')).toBe(101);
  });

  it('第一条消息不是 auth、票据不对、票据重用、别人的票据、超时：一律 4401', async () => {
    const notAuth = new WebSocket(`${base}/ws/terminal`, { headers: { 'x-test-user': 'alice' } });
    await new Promise((resolve) => notAuth.once('open', resolve));
    const notAuthClosed = closeCode(notAuth);
    notAuth.send(JSON.stringify({ type: 'create', shellId: 'sh' }));
    expect(await notAuthClosed).toBe(4401);

    const { ticket } = terminal.issueTicket(IDENTITIES.alice);
    const first = await connectWithTicket('alice', ticket);
    expect(first.code).toBe('ready');
    const reused = await connectWithTicket('alice', ticket);
    expect(reused.code).toBe(4401);

    const bobs = terminal.issueTicket(IDENTITIES.bob).ticket;
    expect((await connectWithTicket('alice', bobs)).code).toBe(4401);

    const silent = new WebSocket(`${base}/ws/terminal`, { headers: { 'x-test-user': 'alice' } });
    expect(await closeCode(silent)).toBe(4401);
  });

  async function connectWithTicket(user: string, ticket: string): Promise<{ code: 'ready' | number; ws: WebSocket }> {
    const ws = new WebSocket(`${base}/ws/terminal`, { headers: { 'x-test-user': user } });
    await new Promise((resolve) => ws.once('open', resolve));
    return new Promise((resolve) => {
      ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'ready') { resolve({ code: 'ready', ws }); ws.close(); } });
      ws.on('close', (code) => resolve({ code, ws }));
      ws.send(JSON.stringify({ type: 'auth', ticket }));
    });
  }

  it('断线接回：echo ok → 掐断 → 新票据重连 → attach 重放里有 ok；带偏移只补差额', async () => {
    const { ws } = await connect('alice');
    ws.send(JSON.stringify({ type: 'create', requestId: 'c1', shellId: 'sh', cols: 80, rows: 24 }));
    const created = await waitFor(ws, (m) => (m.type === 'created' ? m.session : undefined));
    let lastEnd = 0;
    const sawOk = waitFor(ws, (m) => {
      if (m.type === 'output' && m.sessionId === created.id) lastEnd = m.end;
      return m.type === 'output' && /\bok\b/.test(m.data) ? true : undefined;
    });
    ws.send(JSON.stringify({ type: 'input', sessionId: created.id, data: 'echo o""k\r' }));
    await sawOk;
    // 让输出落定，再掐断（不是正常关闭）。
    await new Promise((r) => setTimeout(r, 150));
    ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    expect(terminal.listSessions(IDENTITIES.alice).find((s) => s.id === created.id)?.attached).toBe(0);

    const again = await connect('alice');
    expect(again.ready.sessions.map((s: any) => s.id)).toContain(created.id);
    again.ws.send(JSON.stringify({ type: 'attach', requestId: 'a1', sessionId: created.id }));
    const replay = await waitFor(again.ws, (m) => (m.type === 'attached' ? m : undefined));
    expect(replay.data).toMatch(/\bok\b/);
    expect(replay.end).toBeGreaterThanOrEqual(lastEnd);

    // 带着已经写到的偏移再接一次：只补差额（这里没有新输出，所以是空）。
    again.ws.send(JSON.stringify({ type: 'attach', requestId: 'a2', sessionId: created.id, sinceOffset: replay.end }));
    const delta = await waitFor(again.ws, (m) => (m.type === 'attached' && m.requestId === 'a2' ? m : undefined));
    expect(delta.data).toBe('');
    expect(delta.truncated).toBe(false);

    again.ws.send(JSON.stringify({ type: 'close', requestId: 'x', sessionId: created.id }));
    await waitFor(again.ws, (m) => (m.type === 'closed' ? true : undefined));
    again.ws.close();
  });

  it('别的用户接不到、写不进这个会话', async () => {
    const { ws } = await connect('alice');
    ws.send(JSON.stringify({ type: 'create', requestId: 'c', shellId: 'sh' }));
    const created = await waitFor(ws, (m) => (m.type === 'created' ? m.session : undefined));
    const bob = await connect('bob');
    expect(bob.ready.sessions).toEqual([]);
    bob.ws.send(JSON.stringify({ type: 'attach', requestId: 'b', sessionId: created.id }));
    expect(await waitFor(bob.ws, (m) => (m.type === 'error' ? m.code : m.type === 'attached' ? 'ATTACHED' : undefined))).toBe('terminal.sessionNotFound');
    bob.ws.send(JSON.stringify({ type: 'input', sessionId: created.id, data: 'echo pwned\r' }));
    expect(await waitFor(bob.ws, (m) => (m.type === 'error' ? m.code : undefined))).toBe('terminal.sessionNotFound');
    bob.ws.close();
    ws.send(JSON.stringify({ type: 'close', sessionId: created.id }));
    ws.close();
  });

  it('脱离后空闲超时：整棵进程树被杀（另一个进程组里、忽略 SIGHUP 的后台任务也没了），审计记 kill_idle，不记按键', async () => {
    const { ws } = await connect('alice');
    ws.send(JSON.stringify({ type: 'create', requestId: 'c', shellId: 'sh' }));
    const created = await waitFor(ws, (m) => (m.type === 'created' ? m.session : undefined));
    const bgPid = waitFor(ws, (m) => {
      const match = m.type === 'output' ? /BG=(\d+)/.exec(m.data) : null;
      return match ? Number(match[1]) : undefined;
    });
    ws.send(JSON.stringify({ type: 'input', sessionId: created.id, data: 'trap "" HUP; sleep 300 & echo BG=$(jobs -p)\r' }));
    const pid = await bgPid;
    expect(() => process.kill(pid, 0)).not.toThrow();
    ws.terminate();
    // idleMs 800 + 宽限 300。
    await new Promise((r) => setTimeout(r, 1800));
    expect(() => process.kill(pid, 0), '后台子进程应随进程组被杀').toThrow();
    expect(terminal.listSessions(IDENTITIES.alice).some((s) => s.id === created.id)).toBe(false);
    const events = terminal.audit(500).filter((row) => row.sessionId === created.id).map((row) => row.event);
    expect(events).toEqual(expect.arrayContaining(['open', 'attach', 'detach', 'kill_idle']));
    expect(JSON.stringify(terminal.audit(500))).not.toContain('sleep 300');
  });
});
