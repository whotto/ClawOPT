/**
 * 群聊叫起按发消息的人授权（真组装应用、登录开启）：member 在群里只能**直接**叫起授权给自己的 Agent。
 *
 * 群 g-mix 成员：main（「主程」，授权给 member）、other（「产品」，未授权）。
 * 这里只验「用户发起的第一跳」叫起谁：把引擎的 `executeTurn`（编排器的每 Agent 队列调用它）换成记录调用的替身（不连网关）。
 * P3 起 Agent 回复里的 @ 转交同样按发起人授权逐跳判（编排器用例 `room-orchestrator.test.ts` 守着），`@all` 只给 admin 与房间归属人。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
let engine: any;
const tokens: Record<'admin' | 'member', string> = { admin: '', member: '' };
const woken: string[] = [];

/** 队列是异步排空的：等这个群里没有排队 / 在跑的项。 */
async function settle() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (h.ctx.roomCollab.orchestrator.busyMembers('g-mix').length === 0) return;
  }
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h = await startAppHarness();
  const { ctx } = h;
  const admin = ctx.userStore.create({ username: 'admin2', password: 'admin-pass-1234', role: 'admin' });
  const member = ctx.userStore.create({ username: 'member', password: 'member-pass-1234', role: 'member' });
  ctx.userStore.update(member.id, { agentIds: ['main'] });
  tokens.admin = ctx.authStore.issue('web', admin.id).token;
  tokens.member = ctx.authStore.issue('web', member.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });

  ctx.db.saveGroupChat({ id: 'g-mix', name: 'Mix' });
  ctx.db.saveGroupMember({ id: 'gm-main', group_id: 'g-mix', agent_id: 'main', display_name: '主程', position: 0 });
  ctx.db.saveGroupMember({ id: 'gm-other', group_id: 'g-mix', agent_id: 'other', display_name: '产品', position: 1 });

  // 成员显示名以关联会话名为准（resolveMemberDisplayName）：默认会话若叫别的名字，@主程 就匹配不上。
  const linked = ctx.db.getSessionByAgentId('main');
  if (linked) ctx.sessionManager.updateSession(linked.id, { name: '主程' });

  engine = ctx.rooms.groupChatEngine;
  engine.executeTurn = async (input: any) => { woken.push(input.member.agent_id); return { status: 'completed', messageId: null, text: '' }; };
});

afterAll(async () => {
  await h?.close();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await settle();
  woken.length = 0;
});

async function call(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json() as any;
  await settle();
  return { code: response.status, body: json };
}
const post = (token: string, content: string) => call(token, 'POST', '/api/groups/g-mix/messages', { content });
const lastMessage = () => h.ctx.db.getRecentGroupMessages('g-mix', 1)[0];
const notice = (names: string[]) => ({ messageCode: 'groups.mentionNotPermitted', messageParams: { agents: names.join(', ') }, agentNames: names });

describe('member 在群里发消息：只叫起授权给自己的 Agent', () => {
  it('@ 未授权的成员：正文照样落库，谁也不叫，回结构化提示', async () => {
    const result = await post(tokens.member, '@产品 看看这个');
    expect(result.code).toBe(200);
    expect(result.body.notice).toEqual(notice(['产品']));
    expect(lastMessage()).toMatchObject({ sender_type: 'user', content: '@产品 看看这个' });
    expect(woken).toEqual([]);
  });

  it('同时 @ 授权与未授权的成员：只叫起授权的，提示列出被挡下的', async () => {
    const result = await post(tokens.member, '@主程 @产品 一起看');
    expect(result.body.notice).toEqual(notice(['产品']));
    expect(woken).toEqual(['main']);
  });

  it('@all：member 不是房间归属人 → 403 且不落库；admin 叫起全部', async () => {
    const before = lastMessage()?.id;
    const result = await post(tokens.member, '@all 开会');
    expect(result).toMatchObject({ code: 403, body: { errorCode: 'groups.allMentionForbidden' } });
    expect(lastMessage()?.id).toBe(before);
    expect(woken).toEqual([]);
    expect((await post(tokens.admin, '@all 开会')).code).toBe(200);
    expect([...woken].sort()).toEqual(['main', 'other']);
  });

  it('/new：只发给授权的成员', async () => {
    const result = await post(tokens.member, '/new');
    expect(result.body.notice).toBeUndefined();
    expect(woken).toEqual(['main']);
  });

  it('不 @：上一个发言的是未授权的 Agent 时，改由第一个授权的成员回复；是授权的就回给它', async () => {
    h.ctx.db.saveGroupMessage({ group_id: 'g-mix', sender_type: 'agent', sender_id: 'other', sender_name: '产品', content: '我是产品' });
    expect((await post(tokens.member, '接着说')).body.notice).toBeUndefined();
    expect(woken).toEqual(['main']);

    woken.length = 0;
    h.ctx.db.saveGroupMessage({ group_id: 'g-mix', sender_type: 'agent', sender_id: 'main', sender_name: '主程', content: '我是主程' });
    await post(tokens.member, '继续');
    expect(woken).toEqual(['main']);
  });

  it('admin 不受限：@ 谁叫谁，没有提示', async () => {
    const result = await post(tokens.admin, '@产品 看看');
    expect(result.body.notice).toBeUndefined();
    expect(woken).toEqual(['other']);
  });

  it('重新生成未授权 Agent 的回复 403 且原回复还在；授权 Agent 的照常', async () => {
    const trigger = h.ctx.db.saveGroupMessage({ group_id: 'g-mix', sender_type: 'user', sender_name: '用户', content: '问题' });
    const otherReply = h.ctx.db.saveGroupMessage({ group_id: 'g-mix', parent_id: trigger, sender_type: 'agent', sender_id: 'other', sender_name: '产品', content: '产品的回答' });
    const denied = await call(tokens.member, 'POST', '/api/groups/g-mix/messages/regenerate', { msgId: otherReply });
    expect(denied).toMatchObject({ code: 403, body: { errorCode: 'auth.agentForbidden' } });
    expect(h.ctx.db.getGroupMessageById(otherReply, 'g-mix')).toBeTruthy();
    await settle();
    expect(woken).toEqual([]);

    const mainReply = h.ctx.db.saveGroupMessage({ group_id: 'g-mix', parent_id: trigger, sender_type: 'agent', sender_id: 'main', sender_name: '主程', content: '主程的回答' });
    expect((await call(tokens.member, 'POST', '/api/groups/g-mix/messages/regenerate', { msgId: mainReply })).code).toBe(200);
    await settle();
    expect(woken).toEqual(['main']);
  });

  it('编辑自己的消息触发重跑：同样只叫起授权的成员', async () => {
    const mine = h.ctx.db.saveGroupMessage({ group_id: 'g-mix', parent_id: h.ctx.db.getLatestGroupMessageId('g-mix'), sender_type: 'user', sender_name: '用户', content: '原话' });
    const edited = await call(tokens.member, 'PUT', `/api/groups/g-mix/messages/${mine}`, { content: '@产品 @主程 改过的' });
    expect(edited.body.rerunStarted).toBe(true);
    await settle();
    expect(woken).toEqual(['main']);
  });
});
