/**
 * 等人答复的运行审批（真组装应用、登录开启、真 Pi 驱动 + 假进程）：
 * 外部运行时单聊里 Pi 发起的真审批进协调器注册表 → `GET /api/run-approvals` 按用户过滤列出 →
 * `/ws` 的 `approvals:runs` 提醒（不带内容）→ `POST /api/run-approvals/:id/respond` 答复写回 Pi 进程。
 *
 * member 只被授权 `ext:pi`：看得见 Pi 单聊的审批、看不见 Hermes 单聊的（admin 两个都见）；答别人的审批 403。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { createPiAdapter } from '../src/runtime/adapters/pi';
import { startAppHarness, type AppHarness } from './helpers/app-harness';
import { flushMicrotasks, harness, type FakeProcess } from './runtime/adapters/_helpers/harness';

let h: AppHarness;
const tokens: Record<'admin' | 'member', string> = { admin: '', member: '' };
const adapterHarness = harness();
const procs: Record<string, FakeProcess> = {};

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h = await startAppHarness({ attachRealtime: true });
  const { ctx } = h;
  const admin = ctx.userStore.create({ username: 'admin2', password: 'admin-pass-1234', role: 'admin' });
  const member = ctx.userStore.create({ username: 'member', password: 'member-pass-1234', role: 'member' });
  ctx.userStore.update(member.id, { agentIds: ['ext:pi'] });
  tokens.admin = ctx.authStore.issue('web', admin.id).token;
  tokens.member = ctx.authStore.issue('web', member.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });
  ctx.sessionManager.createSession({ id: 's-pi', name: 'Pi', agentId: 's-pi', external_runtime: 'pi', external_config: '{"mode":"global"}', external_session_id: '11111111-1111-4111-8111-111111111111' });
  // 第二个会话也用 Pi 的驱动，但会话行记成 Hermes：member 没被授权 ext:hermes。
  ctx.sessionManager.createSession({ id: 's-hermes', name: 'Hermes', agentId: 's-hermes', external_runtime: 'hermes', external_config: '{"mode":"global"}', external_session_id: '22222222-2222-4222-8222-222222222222' });
  const pi = createPiAdapter(adapterHarness.deps);
  ctx.runtimePlatform.createAdapter = () => pi;
});

afterAll(async () => {
  for (const proc of Object.values(procs)) {
    proc.line({ type: 'agent_settled' });
    proc.close(0);
  }
  await flushMicrotasks(10);
  await h?.close();
  vi.restoreAllMocks();
});

const api = (token: string, path: string, init: RequestInit = {}) => fetch(`${h.baseUrl}${path}`, {
  ...init,
  headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const writes = (proc: FakeProcess) => proc.stdin.split('\n').filter(Boolean).map((line) => JSON.parse(line));

async function startTurnWithConfirm(sessionId: string, uiId: string) {
  const response = await api(tokens.admin, '/api/chat', { method: 'POST', body: JSON.stringify({ sessionId, message: 'clean up' }) });
  expect(response.status).toBe(200);
  const proc = await adapterHarness.exec.next();
  procs[sessionId] = proc;
  proc.line({ type: 'extension_ui_request', id: uiId, method: 'confirm', title: `Run rm in ${sessionId}?`, timeout: 60_000 });
  for (let i = 0; i < 100 && !h.ctx.runCoordinator.pendingApprovals().some((item: any) => item.sessionKey === sessionId); i += 1) await flushMicrotasks(1);
  return { response, proc };
}

describe('运行审批：列表、提醒、答复', () => {
  it('member 订阅 approvals:runs 收到提醒；列表只见授权会话的审批，admin 全部；答复写回 Pi', async () => {
    const socket = new WebSocket(`${h.baseUrl.replace('http', 'ws')}/ws`, { headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(tokens.member)}` } });
    const messages: any[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'approvals:runs', requestId: 1 }));
    for (let i = 0; i < 100 && !messages.some((m) => m.requestId === 1); i += 1) await flushMicrotasks(1);
    expect(messages.find((m) => m.requestId === 1)?.type).toBe('subscribed');

    await startTurnWithConfirm('s-pi', 'ui-pi');
    await startTurnWithConfirm('s-hermes', 'ui-hermes');
    for (let i = 0; i < 200 && messages.filter((m) => m.topic === 'approvals:runs' && m.type !== 'subscribed').length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(messages.filter((m) => m.topic === 'approvals:runs' && m.type !== 'subscribed').map((m) => [m.event, m.payload])).toEqual([['run.approvals.changed', {}], ['run.approvals.changed', {}]]);

    const memberList = await (await api(tokens.member, '/api/run-approvals')).json();
    expect(memberList.approvals).toEqual([expect.objectContaining({ sessionKey: 's-pi', runtime: 'pi', surface: 'chat', agentName: 'Pi', title: 'Run rm in s-pi?', choices: ['once', 'deny'] })]);
    const adminList = await (await api(tokens.admin, '/api/run-approvals')).json();
    expect(adminList.approvals.map((item: any) => item.sessionKey).sort()).toEqual(['s-hermes', 's-pi']);
    const hermesApproval = adminList.approvals.find((item: any) => item.sessionKey === 's-hermes');

    expect((await api(tokens.member, `/api/run-approvals/${encodeURIComponent(hermesApproval.id)}/respond`, { method: 'POST', body: JSON.stringify({ choice: 'once' }) })).status).toBe(403);
    expect((await api(tokens.member, '/api/run-approvals/missing/respond', { method: 'POST', body: JSON.stringify({ choice: 'once' }) })).status).toBe(403);
    expect((await api(tokens.admin, '/api/run-approvals/missing/respond', { method: 'POST', body: JSON.stringify({ choice: 'once' }) })).status).toBe(404);
    expect(writes(procs['s-hermes']).some((m) => m.type === 'extension_ui_response')).toBe(false);

    const piApproval = memberList.approvals[0];
    expect((await api(tokens.member, `/api/run-approvals/${encodeURIComponent(piApproval.id)}/respond`, { method: 'POST', body: JSON.stringify({ choice: 'once' }) })).status).toBe(200);
    for (let i = 0; i < 100 && !writes(procs['s-pi']).some((m) => m.type === 'extension_ui_response'); i += 1) await flushMicrotasks(1);
    expect(writes(procs['s-pi']).find((m) => m.type === 'extension_ui_response')).toEqual({ type: 'extension_ui_response', id: 'ui-pi', confirmed: true });
    expect((await (await api(tokens.member, '/api/run-approvals')).json()).approvals).toEqual([]);
    socket.close();
  });
});
