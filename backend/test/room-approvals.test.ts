/**
 * 群里的审批与澄清路由（P3 任务 5；真组装应用、登录开启、真 Pi 驱动 + 假进程）。
 *
 * 群 g-pi 的归属人是 owner（admin）；member 被授权 ext:pi，看得见群、能叫起 Pi。
 * member 在群里叫起 Pi → Pi 发 confirm（审批）→ 只有 Agent 主人（= 房间归属人 owner）看得见、答得了；
 * member 在全局待办列表里也看不到、答复 403、订阅会话主题被拒；owner 答复写回 Pi。
 * Pi 发 select（澄清）→ 只给房间管理员。运行被中止 → 审批自动拒绝。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { createPiAdapter } from '../src/runtime/adapters/pi';
import { startAppHarness, type AppHarness } from './helpers/app-harness';
import { flushMicrotasks, harness, type FakeProcess } from './runtime/adapters/_helpers/harness';

let h: AppHarness;
const tokens: Record<'owner' | 'member', string> = { owner: '', member: '' };
const adapterHarness = harness();
let proc: FakeProcess | null = null;

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h = await startAppHarness({ attachRealtime: true });
  const { ctx } = h;
  const owner = ctx.userStore.create({ username: 'owner', password: 'owner-pass-1234', role: 'admin' });
  const member = ctx.userStore.create({ username: 'member', password: 'member-pass-1234', role: 'member' });
  ctx.userStore.update(member.id, { agentIds: ['ext:pi'] });
  tokens.owner = ctx.authStore.issue('web', owner.id).token;
  tokens.member = ctx.authStore.issue('web', member.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });
  ctx.db.saveGroupChat({ id: 'g-pi', name: 'Pi room' });
  ctx.roomCollab.policies.setOwner('g-pi', owner.id);
  ctx.db.saveGroupMember({ id: 'gm-pi', group_id: 'g-pi', agent_id: 'pi', display_name: 'Pi', runtime: 'pi', external_config: '{"mode":"global","workingDir":"/tmp"}', position: 0 });
  // 群里还有一个没授权给 member 的 OpenClaw Agent：member 看得见群、叫得起 Pi，但不是房间管理员（管理员要求每个本机 Agent 都授权）。
  ctx.db.saveGroupMember({ id: 'gm-main', group_id: 'g-pi', agent_id: 'main', display_name: 'Main', position: 1 });
  ctx.runtimePlatform.createAdapter = () => createPiAdapter(adapterHarness.deps);
});

afterAll(async () => {
  if (proc) {
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
const json = async (response: Response) => response.json() as Promise<any>;
const writes = (p: FakeProcess) => p.stdin.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
};

async function subscribeVerdict(token: string, topic: string): Promise<string> {
  const socket = new WebSocket(`${h.baseUrl.replace('http', 'ws')}/ws`, { headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } });
  const messages: any[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });
  socket.send(JSON.stringify({ type: 'subscribe', topic, requestId: 7 }));
  await waitFor(() => messages.some((m) => m.requestId === 7 || m.topic === topic));
  socket.close();
  const reply = messages.find((m) => m.requestId === 7);
  return reply?.type === 'subscribed' ? 'ok' : 'denied';
}

describe('审批只给 Agent 主人，澄清只给管理员', () => {
  it('member 叫起 Pi：审批只有房间归属人看得见、答得了；member 列表为空、答复 403、会话主题订阅被拒', async () => {
    const sent = await api(tokens.member, '/api/groups/g-pi/messages', { method: 'POST', body: JSON.stringify({ content: '@Pi 清理一下' }) });
    expect(sent.status).toBe(200);
    proc = await adapterHarness.exec.next();
    proc.line({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Run rm -rf build?', timeout: 60_000 });
    await waitFor(async () => (await json(await api(tokens.owner, '/api/groups/g-pi/interactions'))).interactions.length === 1);

    const ownerList = await json(await api(tokens.owner, '/api/groups/g-pi/interactions'));
    expect(ownerList.interactions[0]).toMatchObject({ kind: 'approval', memberId: 'gm-pi', agentName: 'Pi', title: 'Run rm -rf build?', choices: ['once', 'deny'] });
    const interactionId = ownerList.interactions[0].id;

    expect((await json(await api(tokens.member, '/api/groups/g-pi/interactions'))).interactions).toEqual([]);
    expect((await json(await api(tokens.member, '/api/run-approvals'))).approvals).toEqual([]);
    expect((await api(tokens.member, `/api/groups/g-pi/interactions/${encodeURIComponent(interactionId)}/respond`, { method: 'POST', body: JSON.stringify({ choice: 'once' }) })).status).toBe(403);
    expect((await api(tokens.member, `/api/run-approvals/${encodeURIComponent(interactionId)}/respond`, { method: 'POST', body: JSON.stringify({ choice: 'once' }) })).status).toBe(403);
    expect(await subscribeVerdict(tokens.member, 'session:room:g-pi:member:gm-pi')).toBe('denied');
    expect(await subscribeVerdict(tokens.owner, 'session:room:g-pi:member:gm-pi')).toBe('ok');
    expect(writes(proc).some((m) => m.type === 'extension_ui_response')).toBe(false);

    const answered = await json(await api(tokens.owner, `/api/groups/g-pi/interactions/${encodeURIComponent(interactionId)}/respond`, { method: 'POST', body: JSON.stringify({ choice: 'once' }) }));
    expect(answered).toMatchObject({ resolved: true, stale: false });
    await waitFor(() => writes(proc!).some((m) => m.type === 'extension_ui_response'));
    expect(writes(proc).find((m) => m.type === 'extension_ui_response')).toEqual({ type: 'extension_ui_response', id: 'ui-1', confirmed: true });
    // 过时的答复不报错，回 stale。
    expect(await json(await api(tokens.owner, `/api/groups/g-pi/interactions/${encodeURIComponent(interactionId)}/respond`, { method: 'POST', body: JSON.stringify({ choice: 'once' }) }))).toMatchObject({ stale: true });
  });

  it('澄清（select）只给房间管理员；中断成员后待决请求自动拒绝', async () => {
    proc!.line({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: '选哪个分支？', options: ['main', 'dev'], timeout: 60_000 });
    await waitFor(async () => (await json(await api(tokens.owner, '/api/groups/g-pi/interactions'))).interactions.length === 1);
    expect((await json(await api(tokens.owner, '/api/groups/g-pi/interactions'))).interactions[0]).toMatchObject({ kind: 'clarify' });
    expect((await json(await api(tokens.member, '/api/groups/g-pi/interactions'))).interactions).toEqual([]);

    const interrupt = api(tokens.owner, '/api/groups/g-pi/members/gm-pi/interrupt', { method: 'POST' });
    await waitFor(() => proc!.terminateCalls > 0);
    proc!.close(null, 'SIGINT');
    expect((await interrupt).status).toBe(200);
    await waitFor(async () => (await json(await api(tokens.owner, '/api/groups/g-pi/interactions'))).interactions.length === 0);
    proc = null;
  });
});
