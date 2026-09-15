/**
 * 群附件（P3 任务 8）：可续传分块上传、单文件 / 每群配额、限流、会话绑定发起人、服务端路径重绑、旧上传接口同一套上限。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_ROOM_BYTES, ATTACHMENT_RATE_LIMIT } from '../src/collab/rooms/room-attachments';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h = await startAppHarness();
  const { ctx } = h;
  const admin = ctx.userStore.create({ username: 'admin2', password: 'admin-pass-1234', role: 'admin' });
  const other = ctx.userStore.create({ username: 'other', password: 'other-pass-12345', role: 'admin' });
  tokens.admin = ctx.authStore.issue('web', admin.id).token;
  tokens.other = ctx.authStore.issue('web', other.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });
  for (const id of ['g-att', 'g-other', 'g-quota', 'g-rate']) {
    ctx.db.saveGroupChat({ id, name: id });
    ctx.db.saveGroupMember({ id: `${id}-m`, group_id: id, agent_id: 'main', display_name: 'Main', position: 0 });
  }
  // 只验入口：执行替身不连网关。
  ctx.rooms.groupChatEngine.executeTurn = async () => ({ status: 'completed', messageId: null, text: '' });
});

afterAll(async () => {
  await h?.close();
  vi.restoreAllMocks();
});

const api = (token: string, url: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${h.baseUrl}${url}`, {
  ...init,
  headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const json = async (response: Response) => ({ status: response.status, body: await response.json() as any });

async function upload(token: string, groupId: string, name: string, data: Buffer) {
  const opened = await json(await api(token, `/api/groups/${groupId}/attachments/uploads`, { method: 'POST', body: JSON.stringify({ name, size: data.length }) }));
  if (opened.status !== 200) return opened;
  for (let offset = 0; offset < data.length; offset += ATTACHMENT_CHUNK_BYTES) {
    const chunk = data.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
    const put = await api(token, `/api/groups/${groupId}/attachments/uploads/${opened.body.uploadId}?offset=${offset}`, { method: 'PUT', body: chunk, headers: { 'content-type': 'application/octet-stream' } });
    expect(put.status).toBe(200);
  }
  return json(await api(token, `/api/groups/${groupId}/attachments/uploads/${opened.body.uploadId}/complete`, { method: 'POST', body: JSON.stringify({ sha256: crypto.createHash('sha256').update(data).digest('hex') }) }));
}

describe('分块上传与续传', () => {
  it('多块上传、断线后按状态续传、偏移错位 409、别人续不了、完成后是群上传目录里的随机存储名', async () => {
    const data = crypto.randomBytes(ATTACHMENT_CHUNK_BYTES * 2 + 1000);
    const opened = await json(await api(tokens.admin, '/api/groups/g-att/attachments/uploads', { method: 'POST', body: JSON.stringify({ name: '../报告.pdf', size: data.length }) }));
    expect(opened.body).toMatchObject({ chunkSize: ATTACHMENT_CHUNK_BYTES, received: 0 });
    const id = opened.body.uploadId;
    const put = (token: string, offset: number, chunk: Buffer) => api(token, `/api/groups/g-att/attachments/uploads/${id}?offset=${offset}`, { method: 'PUT', body: chunk, headers: { 'content-type': 'application/octet-stream' } });
    expect((await put(tokens.admin, 0, data.subarray(0, ATTACHMENT_CHUNK_BYTES))).status).toBe(200);
    // 「断线」：客户端不知道收到多少，先问状态。
    const status = await json(await api(tokens.admin, `/api/groups/g-att/attachments/uploads/${id}`));
    expect(status.body.received).toBe(ATTACHMENT_CHUNK_BYTES);
    expect((await put(tokens.admin, 0, data.subarray(0, 10))).status).toBe(409);
    expect((await put(tokens.other, ATTACHMENT_CHUNK_BYTES, data.subarray(ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES * 2))).status).toBe(404);
    expect((await put(tokens.admin, ATTACHMENT_CHUNK_BYTES, data.subarray(ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES * 2))).status).toBe(200);
    expect((await json(await api(tokens.admin, `/api/groups/g-att/attachments/uploads/${id}/complete`, { method: 'POST', body: '{}' }))).status).toBe(409);
    expect((await put(tokens.admin, ATTACHMENT_CHUNK_BYTES * 2, data.subarray(ATTACHMENT_CHUNK_BYTES * 2))).status).toBe(200);
    const done = await json(await api(tokens.admin, `/api/groups/g-att/attachments/uploads/${id}/complete`, { method: 'POST', body: '{}' }));
    expect(done.body.attachment).toMatchObject({ name: '.._报告.pdf', size: data.length, mediaType: 'application/pdf', kind: 'file' });
    expect(done.body.attachment.url).toMatch(/^\/uploads\/[0-9a-f]{32}\.pdf$/);
    const stored = path.join(h.home, '.openclaw', 'workspace-group-g-att', 'uploads', done.body.attachment.url.slice('/uploads/'.length));
    expect(fs.readFileSync(stored).equals(data)).toBe(true);
    expect(fs.statSync(stored).mode & 0o777).toBe(0o600);
  });

  it('哈希对不上：拒收并丢弃', async () => {
    const data = Buffer.from('hello');
    const opened = await json(await api(tokens.admin, '/api/groups/g-att/attachments/uploads', { method: 'POST', body: JSON.stringify({ name: 'a.txt', size: data.length }) }));
    await api(tokens.admin, `/api/groups/g-att/attachments/uploads/${opened.body.uploadId}?offset=0`, { method: 'PUT', body: data, headers: { 'content-type': 'application/octet-stream' } });
    const done = await json(await api(tokens.admin, `/api/groups/g-att/attachments/uploads/${opened.body.uploadId}/complete`, { method: 'POST', body: JSON.stringify({ sha256: 'f'.repeat(64) }) }));
    expect(done.body.errorCode).toBe('groups.attachmentHashMismatch');
  });
});

describe('上限', () => {
  it('单文件超 20 MB 413；每群合计超 500 MB 413（进行中的上传也占配额）', async () => {
    expect((await json(await api(tokens.admin, '/api/groups/g-quota/attachments/uploads', { method: 'POST', body: JSON.stringify({ name: 'big.bin', size: ATTACHMENT_MAX_FILE_BYTES + 1 }) }))).body.errorCode).toBe('groups.attachmentTooLarge');
    h.ctx.db.connection().prepare(`INSERT INTO room_attachments (id, group_id, stored_name, original_name, media_type, size, sha256, uploader_kind, created_at)
      VALUES ('fill', 'g-quota', 'fill', 'fill', 'x', ?, 'x', 'user', 0)`).run(ATTACHMENT_MAX_ROOM_BYTES - 10);
    expect((await json(await api(tokens.admin, '/api/groups/g-quota/attachments/uploads', { method: 'POST', body: JSON.stringify({ name: 'a.bin', size: 11 }) }))).body.errorCode).toBe('groups.attachmentQuotaExceeded');
  });

  it('每群每分钟 30 次，第 31 次 429；别的群不受影响', async () => {
    for (let i = 0; i < ATTACHMENT_RATE_LIMIT; i += 1) {
      expect((await api(tokens.admin, '/api/groups/g-rate/attachments/uploads', { method: 'POST', body: JSON.stringify({ name: `f${i}.txt`, size: 1 }) })).status).toBe(200);
    }
    expect((await json(await api(tokens.admin, '/api/groups/g-rate/attachments/uploads', { method: 'POST', body: JSON.stringify({ name: 'x.txt', size: 1 }) }))).body.errorCode).toBe('groups.attachmentRateLimited');
    expect((await api(tokens.admin, '/api/groups/g-other/attachments/uploads', { method: 'POST', body: JSON.stringify({ name: 'x.txt', size: 1 }) })).status).toBe(200);
  });

  it('旧上传接口（/api/files/upload）的群上传同一套单文件上限', async () => {
    const form = new FormData();
    form.append('contextType', 'group');
    form.append('groupId', 'g-other');
    form.append('files', new Blob([Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES + 1)]), 'big.bin');
    const response = await fetch(`${h.baseUrl}/api/files/upload`, { method: 'POST', body: form, headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(tokens.admin)}` } });
    expect(response.status).toBe(413);
    expect(fs.readdirSync(path.join(h.home, '.openclaw', 'workspace-group-g-other', 'uploads')).filter((name) => name.endsWith('big.bin'))).toEqual([]);
  });
});

describe('服务端路径重绑', () => {
  it('消息只能引用本群登记过的上传；别的群的、不存在的、带路径的一律 400 且不落库', async () => {
    const mine = await upload(tokens.admin, 'g-att', 'pic.png', Buffer.from('png-bytes'));
    const theirs = await upload(tokens.admin, 'g-other', 'pic.png', Buffer.from('other-bytes'));
    const ok = await json(await api(tokens.admin, '/api/groups/g-att/messages', { method: 'POST', body: JSON.stringify({ content: `看图 ![pic](${mine.body.attachment.url})` }) }));
    expect(ok.status).toBe(200);
    expect(h.ctx.roomCollab.messages.getMeta(ok.body.messageId).attachments).toEqual([expect.objectContaining({ id: mine.body.attachment.id, kind: 'image' })]);
    const before = h.ctx.db.getLatestGroupMessageId('g-att');
    // Agent 直接写进上传目录、没经上传接口登记的文件，也不能被消息引用。
    fs.writeFileSync(path.join(h.home, '.openclaw', 'workspace-group-g-att', 'uploads', 'abcdefabcdefabcdefabcdefabcdefab.png'), 'planted');
    for (const content of ['![x](/uploads/abcdefabcdefabcdefabcdefabcdefab.png)', `![x](${theirs.body.attachment.url})`,'[x](/uploads/0123456789abcdef0123456789abcdef.png)', '[x](/uploads/..%2F..%2Fopenclaw.json)']) {
      const bad = await json(await api(tokens.admin, '/api/groups/g-att/messages', { method: 'POST', body: JSON.stringify({ content }) }));
      expect(bad.status, content).toBe(400);
      expect(bad.body.errorCode).toBe('groups.attachmentInvalid');
    }
    expect(h.ctx.db.getLatestGroupMessageId('g-att')).toBe(before);
  });
});
