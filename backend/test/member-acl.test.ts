/**
 * 数据面按「用户 ↔ Agent」授权（P5a 模型 × P1a 实时通道）：真组装的应用、登录开启、库里真用户。
 *
 * 场景：Agent `main` 授权给 member，`other` 不授权。
 * - 单聊会话 s-main（main）/ s-other（other）；
 * - 群 g-main（成员含 main）/ g-other（只有 other）。
 *
 * 矩阵：super_admin / admin 全部可见；member 只见授权 Agent 的会话、含授权 Agent 的群、授权 Agent 的活动主题；
 * 被停用的用户与被吊销的会话在升级时就 401。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
const tokens: Record<'owner' | 'admin' | 'member', string> = { owner: '', admin: '', member: '' };
let memberId = 0;

beforeAll(async () => {
  h = await startAppHarness({ attachRealtime: true });
  const { ctx } = h;
  const owner = ctx.userStore.create({ username: 'owner', password: 'owner-pass-1234', role: 'super_admin' });
  const admin = ctx.userStore.create({ username: 'admin2', password: 'admin-pass-1234', role: 'admin' });
  const member = ctx.userStore.create({ username: 'member', password: 'member-pass-1234', role: 'member' });
  ctx.userStore.update(member.id, { agentIds: ['main'] });
  memberId = member.id;
  tokens.owner = ctx.authStore.issue('web', owner.id).token;
  tokens.admin = ctx.authStore.issue('web', admin.id).token;
  tokens.member = ctx.authStore.issue('web', member.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });

  ctx.sessionManager.createSession({ id: 's-main', name: 'Main', agentId: 'main' });
  ctx.sessionManager.createSession({ id: 's-other', name: 'Other', agentId: 'other' });
  ctx.db.saveGroupChat({ id: 'g-main', name: 'G main' });
  ctx.db.saveGroupMember({ id: 'gm-main', group_id: 'g-main', agent_id: 'main', display_name: 'Main', position: 0 });
  ctx.db.saveGroupMember({ id: 'gm-other-in-main', group_id: 'g-main', agent_id: 'other', display_name: 'Other', position: 1 });
  ctx.db.saveGroupChat({ id: 'g-other', name: 'G other' });
  ctx.db.saveGroupMember({ id: 'gm-other', group_id: 'g-other', agent_id: 'other', display_name: 'Other', position: 0 });
});

afterAll(async () => { await h?.close(); });

type WsClient = { socket: WebSocket; messages: any[]; request: (message: Record<string, unknown>) => Promise<any>; closed: Promise<number> };

let requestSeq = 0;
function connectWs(token: string | null): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${h.baseUrl.replace('http', 'ws')}/ws`, token ? { headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } } : {});
    const messages: any[] = [];
    const waiters: Array<{ requestId: number; resolve: (m: any) => void }> = [];
    const closed = new Promise<number>((r) => socket.on('close', (code) => r(code)));
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      messages.push(message);
      const waiter = waiters.find((item) => item.requestId === message.requestId);
      if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
    });
    socket.on('error', reject);
    socket.on('open', () => resolve({
      socket,
      messages,
      closed,
      request: (message) => new Promise((res) => {
        const requestId = ++requestSeq;
        waiters.push({ requestId, resolve: res });
        socket.send(JSON.stringify({ ...message, requestId }));
      }),
    }));
  });
}

async function topicVerdicts(token: string, topics: string[]): Promise<Record<string, string>> {
  const client = await connectWs(token);
  const verdicts: Record<string, string> = {};
  for (const topic of topics) {
    const reply = await client.request({ type: 'subscribe', topic });
    verdicts[topic] = reply.type === 'subscribed' ? 'ok' : reply.code;
  }
  client.socket.close();
  return verdicts;
}

const TOPICS = ['session:s-main', 'session:s-other', 'room:g-main', 'room:g-other', 'agent:main', 'agent:other'];

describe('/ws 主题授权按用户 ↔ Agent', () => {
  it('匿名升级 401', async () => {
    await expect(connectWs(null)).rejects.toThrow('401');
  });

  it('super_admin 与 admin 全部可订阅', async () => {
    const all = Object.fromEntries(TOPICS.map((topic) => [topic, 'ok']));
    expect(await topicVerdicts(tokens.owner, TOPICS)).toEqual(all);
    expect(await topicVerdicts(tokens.admin, TOPICS)).toEqual(all);
  });

  it('member：只有授权 Agent 的会话、含授权 Agent 的群、授权 Agent 的活动主题', async () => {
    expect(await topicVerdicts(tokens.member, TOPICS)).toEqual({
      'session:s-main': 'ok',
      'session:s-other': 'realtime.topicForbidden',
      'room:g-main': 'ok',
      'room:g-other': 'realtime.topicForbidden',
      'agent:main': 'ok',
      'agent:other': 'realtime.topicForbidden',
    });
  });

  it('member 不能答复别人会话里的审批', async () => {
    const client = await connectWs(tokens.member);
    const reply = await client.request({ type: 'interaction.respond', sessionKey: 's-other', id: 'ap-x', choice: 'once' });
    expect(reply).toMatchObject({ type: 'result', result: { handled: false, error: 'forbidden' } });
    client.socket.close();
  });

  it('被停用的用户升级即 401；已连上的在心跳复查时断开', async () => {
    const disabled = h.ctx.userStore.create({ username: 'gone', password: 'gone-pass-1234', role: 'member' });
    const token = h.ctx.authStore.issue('web', disabled.id).token;
    const client = await connectWs(token);
    h.ctx.userStore.update(disabled.id, { status: 'disabled' });
    await expect(connectWs(token)).rejects.toThrow('401');
    client.socket.close();
    expect(h.ctx.auth.authenticateHeaders({ cookie: `${AUTH_COOKIE_NAME}=${token}` })).toBeNull();
  });

  it('被吊销的会话升级即 401', async () => {
    const token = h.ctx.authStore.issue('web', memberId).token;
    await (await connectWs(token)).socket.close();
    h.ctx.authStore.revoke(token);
    await expect(connectWs(token)).rejects.toThrow('401');
  });
});
