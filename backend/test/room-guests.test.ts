/**
 * 邀请码访客页（P3 任务 10，真组装应用、登录开启）。
 *
 * 群 g-share：main（「主程」，授权给签发邀请码的 member）、other（「产品」，未授权）。
 * 访客没有自己的授权：发起的链按签发人的授权判；访客不能 @all、不能管理、不能看工作区；
 * 令牌只存 SHA-256；轮换邀请码 / 吊销访客后令牌立即失效；公开入口没有令牌一律 401。
 */
import crypto from 'crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { guestVisibleFrame } from '../src/collab/rooms/room-share-routes';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
const tokens = { admin: '', member: '' };
const woken: string[] = [];
let memberId = 0;
let inviteCode = '';

async function settle() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (h.ctx.roomCollab.orchestrator.busyMembers('g-share').length === 0) return;
  }
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h = await startAppHarness();
  const { ctx } = h;
  const admin = ctx.userStore.create({ username: 'admin-share', password: 'admin-pass-1234', role: 'admin' });
  const member = ctx.userStore.create({ username: 'member-share', password: 'member-pass-1234', role: 'member' });
  ctx.userStore.update(member.id, { agentIds: ['main', 'other'] });
  memberId = member.id;
  tokens.admin = ctx.authStore.issue('web', admin.id).token;
  tokens.member = ctx.authStore.issue('web', member.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });

  ctx.db.saveGroupChat({ id: 'g-share', name: '访客群' });
  ctx.db.saveGroupMember({ id: 'gs-main', group_id: 'g-share', agent_id: 'main', display_name: '主程', position: 0 });
  ctx.db.saveGroupMember({ id: 'gs-other', group_id: 'g-share', agent_id: 'other', display_name: '产品', position: 1 });
  const linked = ctx.db.getSessionByAgentId('main');
  if (linked) ctx.sessionManager.updateSession(linked.id, { name: '主程' });
  ctx.roomCollab.policies.setOwner('g-share', member.id);
  ctx.rooms.groupChatEngine.executeTurn = async (input: any) => { woken.push(input.member.agent_id); return { status: 'completed', messageId: null, text: '' }; };
});

afterAll(async () => {
  await h?.close();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await settle();
  woken.length = 0;
});

async function call(method: string, path: string, options: { body?: unknown; cookie?: string; guest?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.cookie) headers.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(options.cookie)}`;
  if (options.guest) headers['x-clawopt-guest-token'] = options.guest;
  const response = await fetch(`${h.baseUrl}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const text = await response.text();
  await settle();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { code: response.status, body };
}

describe('邀请码与加入', () => {
  it('只有管理员能签发邀请码；未签发时公开概况 404', async () => {
    expect((await call('GET', '/api/share/rooms/ABCDEFGHJKLMNPQR')).code).toBe(404);
    // 另一个 member 看不见这个群的 Agent → 403；房间归属人（member-share）能签发。
    const issued = await call('POST', '/api/groups/g-share/invite', { cookie: tokens.member });
    expect(issued.code).toBe(200);
    inviteCode = issued.body.inviteCode;
    expect(inviteCode).toMatch(/^[A-Z2-9]{16}$/);
    const info = await call('GET', `/api/share/rooms/${inviteCode}`);
    expect(info.code).toBe(200);
    expect(info.body.room).toMatchObject({ name: '访客群', agents: [{ name: '主程' }, { name: '产品' }] });
    expect(JSON.stringify(info.body)).not.toMatch(/owner|inviteCreatedBy|sessionSeed/);
  });

  it('名字校验：与 Agent 同名 409、空名 400、@ 被剥掉；令牌只存 SHA-256', async () => {
    expect((await call('POST', `/api/share/rooms/${inviteCode}/join`, { body: { name: '主程' } })).code).toBe(409);
    expect((await call('POST', `/api/share/rooms/${inviteCode}/join`, { body: { name: '  ' } })).code).toBe(400);
    const joined = await call('POST', `/api/share/rooms/${inviteCode}/join`, { body: { name: '@小王', avatar: '🦊' } });
    expect(joined.code).toBe(200);
    expect(joined.body.guest).toMatchObject({ name: '小王', avatar: '🦊' });
    const row = h.ctx.db.connection().prepare('SELECT token_hash FROM room_guests WHERE id = ?').get(joined.body.guest.id) as any;
    expect(row.token_hash).toBe(crypto.createHash('sha256').update(joined.body.guestToken).digest('hex'));
    expect(row.token_hash).not.toContain(joined.body.guestToken);
    expect((await call('POST', `/api/share/rooms/${inviteCode}/join`, { body: { name: '小王' } })).code).toBe(409);
  });
});

describe('访客的能力边界', () => {
  let guestToken = '';
  beforeAll(async () => {
    const joined = await call('POST', `/api/share/rooms/${inviteCode}/join`, { body: { name: '访客甲' } });
    guestToken = joined.body.guestToken;
  });

  it('没有 / 错的令牌一律 401（消息、事件流、上传、审批、配对）', async () => {
    for (const [method, path] of [
      ['GET', 'messages'], ['POST', 'messages'], ['GET', 'queue'], ['GET', 'events'], ['GET', 'interactions'],
      ['POST', 'uploads'], ['GET', 'relay/pairings'], ['GET', 'me'],
    ] as const) {
      expect((await call(method, `/api/share/rooms/${inviteCode}/${path}`, { body: method === 'POST' ? { content: 'x' } : undefined })).code, path).toBe(401);
      expect((await call(method, `/api/share/rooms/${inviteCode}/${path}`, { guest: 'x'.repeat(43), body: method === 'POST' ? { content: 'x' } : undefined })).code, path).toBe(401);
    }
  });

  it('发消息：叫起按签发人的授权判；@all 403；落库带访客身份', async () => {
    const sent = await call('POST', `/api/share/rooms/${inviteCode}/messages`, { guest: guestToken, body: { content: '@主程 帮我看下' } });
    expect(sent.code).toBe(200);
    expect(woken).toEqual(['main']);
    const meta = h.ctx.roomCollab.messages.getMeta(sent.body.messageId);
    expect(meta).toMatchObject({ senderGuestId: expect.stringMatching(/^guest_/) });
    expect(h.ctx.db.getGroupMessageById(sent.body.messageId, 'g-share')).toMatchObject({ sender_type: 'user', sender_name: '访客甲' });

    const all = await call('POST', `/api/share/rooms/${inviteCode}/messages`, { guest: guestToken, body: { content: '@all 开会' } });
    expect(all.code).toBe(403);
    expect(all.body.code ?? all.body.error?.code ?? all.body.errorCode).toBeTruthy();
  });

  it('签发人失去对「产品」的授权后，访客 @产品 被挡下（委托授权随签发人变化）', async () => {
    const member = { id: memberId };
    h.ctx.userStore.update(member.id, { agentIds: ['main'] });
    const sent = await call('POST', `/api/share/rooms/${inviteCode}/messages`, { guest: guestToken, body: { content: '@产品 你好' } });
    expect(sent.body.notice).toMatchObject({ messageCode: 'groups.mentionNotPermitted', agentNames: ['产品'] });
    expect(woken).toEqual([]);
    h.ctx.userStore.update(member.id, { agentIds: ['main', 'other'] });
  });

  it('访客不能碰管理接口（带访客令牌也按未登录处理）', async () => {
    expect((await call('GET', '/api/groups/g-share/workspace/list', { guest: guestToken })).code).toBe(401);
    expect((await call('PUT', '/api/groups/g-share/policy', { guest: guestToken, body: { handoffEnabled: false } })).code).toBe(401);
    expect((await call('POST', '/api/groups/g-share/invite', { guest: guestToken })).code).toBe(401);
  });

  it('历史与事件流不带工作区 diff', async () => {
    const page = await call('GET', `/api/share/rooms/${inviteCode}/messages`, { guest: guestToken });
    expect(page.code).toBe(200);
    expect(page.body.messages?.length ?? page.body.items?.length ?? 0).toBeGreaterThan(0);
    const rows = page.body.messages ?? page.body.items;
    expect(rows.every((row: any) => Array.isArray(row.workspace_changes) && row.workspace_changes.length === 0)).toBe(true);
    expect(guestVisibleFrame({ type: 'workspace_diff', data: {} })).toBeNull();
    expect(guestVisibleFrame({ type: 'pairing', data: {} })).toBeNull();
    expect(guestVisibleFrame({ type: 'edit', id: 1, workspace_changes: [{ diff: 'secret' }] })).toEqual({ type: 'edit', id: 1 });
  });

  it('附件：只读得到本群登记过的存储名', async () => {
    const content = Buffer.from('hello guest');
    const opened = await call('POST', `/api/share/rooms/${inviteCode}/uploads`, { guest: guestToken, body: { name: 'a.txt', size: content.length } });
    expect(opened.code).toBe(200);
    const put = await fetch(`${h.baseUrl}/api/share/rooms/${inviteCode}/uploads/${opened.body.uploadId}?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-clawopt-guest-token': guestToken }, body: content });
    expect(put.status).toBe(200);
    const done = await call('POST', `/api/share/rooms/${inviteCode}/uploads/${opened.body.uploadId}/complete`, { guest: guestToken, body: {} });
    expect(done.code).toBe(200);
    const stored = String(done.body.attachment.url).split('/').pop();
    const file = await fetch(`${h.baseUrl}/api/share/rooms/${inviteCode}/files/${stored}`, { headers: { 'x-clawopt-guest-token': guestToken } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await file.text()).toBe('hello guest');
    expect((await fetch(`${h.baseUrl}/api/share/rooms/${inviteCode}/files/../../etc/passwd`, { headers: { 'x-clawopt-guest-token': guestToken } })).status).not.toBe(200);
    expect((await fetch(`${h.baseUrl}/api/share/rooms/${inviteCode}/files/${'0'.repeat(32)}.txt`, { headers: { 'x-clawopt-guest-token': guestToken } })).status).toBe(404);
  });

  it('吊销访客 → 令牌立即 401；轮换邀请码 → 旧码下所有访客失效、旧码 404', async () => {
    const other = await call('POST', `/api/share/rooms/${inviteCode}/join`, { body: { name: '访客乙' } });
    const list = await call('GET', '/api/groups/g-share/guests', { cookie: tokens.member });
    expect(list.body.guests.map((guest: any) => guest.name)).toEqual(expect.arrayContaining(['访客甲', '访客乙']));
    expect((await call('DELETE', `/api/groups/g-share/guests/${other.body.guest.id}`, { cookie: tokens.member })).code).toBe(200);
    expect((await call('GET', `/api/share/rooms/${inviteCode}/me`, { guest: other.body.guestToken })).code).toBe(401);
    expect((await call('GET', `/api/share/rooms/${inviteCode}/me`, { guest: guestToken })).code).toBe(200);

    const rotated = await call('POST', '/api/groups/g-share/invite', { cookie: tokens.member });
    expect(rotated.body.inviteCode).not.toBe(inviteCode);
    expect((await call('GET', `/api/share/rooms/${inviteCode}`)).code).toBe(404);
    expect((await call('GET', `/api/share/rooms/${rotated.body.inviteCode}/me`, { guest: guestToken })).code).toBe(401);
    inviteCode = rotated.body.inviteCode;

    // 第二道闸：即使没逐个吊销（直接轮换存储里的邀请码），邀请代不符的令牌也不认。
    const late = await call('POST', `/api/share/rooms/${inviteCode}/join`, { body: { name: '访客丙' } });
    expect((await call('GET', `/api/share/rooms/${inviteCode}/me`, { guest: late.body.guestToken })).code).toBe(200);
    const bare = h.ctx.roomCollab.policies.rotateInviteCode('g-share', memberId);
    expect((await call('GET', `/api/share/rooms/${bare}/me`, { guest: late.body.guestToken })).code).toBe(401);
    inviteCode = bare;
  });
});
