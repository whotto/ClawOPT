/**
 * 按路径出文件与上传的数据面授权（登录开启、真组装应用、库里真用户）。
 *
 * 两道门，顺序固定：可服务路径闸门在前（凭据类文件对谁都是 `files.notServable` / 闸门文案），
 * 数据面授权在后（Agent 工作区看 Agent、群工作区看群、上传目录看 `files` 表登记的会话 / 群、无主文件只给 admin）。
 *
 * 场景：member 授权 `main`。会话 s-main（main）/ s-other（other）；群 g-main（main + other）/ g-other（other）。
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
const tokens: Record<'admin' | 'member', string> = { admin: '', member: '' };
const files: Record<string, string> = {};

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const b64url = (value: string) => b64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h = await startAppHarness();
  const { ctx, home } = h;
  const admin = ctx.userStore.create({ username: 'admin2', password: 'admin-pass-1234', role: 'admin' });
  const member = ctx.userStore.create({ username: 'member', password: 'member-pass-1234', role: 'member' });
  ctx.userStore.update(member.id, { agentIds: ['main'] });
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

  const openclaw = path.join(home, '.openclaw');
  const uploads = path.join(home, '.clawopt-test', 'uploads');
  const write = (key: string, file: string, content = `content of ${key}`) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    files[key] = file;
  };
  write('agentMine', path.join(openclaw, 'workspace-main', 'output', 'mine.html'), '<p>mine</p>');
  write('agentOther', path.join(openclaw, 'workspace-other', 'output', 'other.html'), '<p>other</p>');
  write('groupVisible', path.join(openclaw, 'workspace-group-g-main', 'output', 'team.html'), '<p>team</p>');
  write('groupHidden', path.join(openclaw, 'workspace-group-g-other', 'output', 'hidden.html'), '<p>hidden</p>');
  write('unowned', path.join(openclaw, 'workspace', 'loose.html'), '<p>loose</p>');
  write('uploadMine', path.join(uploads, '1-mine.html'), '<p>up mine</p>');
  write('uploadOther', path.join(uploads, '2-other.html'), '<p>up other</p>');
  write('uploadUnregistered', path.join(uploads, '3-orphan.html'), '<p>orphan</p>');
  // 外部运行时单聊的缺省工作区（工作区 diff 面板「查看文件」走的就是这里）：目录名 = 会话 id
  const externalRoot = path.join(home, '.clawopt-test', 'workspaces', 'external');
  write('externalMine', path.join(externalRoot, 's-main', 'notes.md'), '# mine');
  write('externalOther', path.join(externalRoot, 's-other', 'notes.md'), '# other');
  write('externalOrphan', path.join(externalRoot, 'no-such-session', 'notes.md'), '# orphan');
  write('credential', path.join(openclaw, 'workspace-other', '.env'), 'SECRET=1');
  ctx.db.saveFile({ sessionKey: 's-main', originalName: 'mine.html', storedPath: files.uploadMine });
  ctx.db.saveFile({ sessionKey: 's-other', originalName: 'other.html', storedPath: files.uploadOther });
  ctx.db.saveFile({ sessionKey: 'g-other', originalName: 'hidden.html', storedPath: files.groupHidden });
});

afterAll(async () => {
  await h?.close();
  vi.restoreAllMocks();
});

async function get(token: string, url: string) {
  const response = await fetch(`${h.baseUrl}${url}`, { headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } });
  const text = await response.text();
  let messageCode = '';
  try { messageCode = JSON.parse(text).errorCode ?? ''; } catch { /* 文件正文或纯文本错误 */ }
  return { code: response.status, messageCode, text };
}

/** 一个文件经各个出口的地址。 */
function exits(file: string): string[] {
  const openclawRoot = path.join(h.home, '.openclaw');
  const name = path.basename(file);
  const out = [
    `/api/files/download?path=${encodeURIComponent(b64(file))}`,
    `/api/files/preview?path=${encodeURIComponent(b64(file))}&mode=source`,
    `/api/files/preview-data?path=${encodeURIComponent(b64(file))}&mode=source`,
    `/api/files/html-preview/path/${b64url(file)}/__claw_preview_root__/${encodeURIComponent(name)}`,
  ];
  if (file.startsWith(openclawRoot)) out.push(`/openclaw/${path.relative(openclawRoot, file).split(path.sep).map(encodeURIComponent).join('/')}`);
  return out;
}

/** 按上传文件名的出口（`/uploads`、按 filename 预览、HTML 预览 upload 形态）。 */
const uploadExits = (file: string) => {
  const name = encodeURIComponent(path.basename(file));
  return [
    `/uploads/${name}`,
    `/api/files/preview?filename=${name}&mode=source`,
    `/api/files/preview-data?filename=${name}&mode=source`,
    `/api/files/html-preview/upload/${name}/__claw_preview_root__/${name}`,
  ];
};

async function matrix(token: string, urls: string[]) {
  const out: string[] = [];
  for (const url of urls) {
    const { code, messageCode } = await get(token, url);
    out.push(`${url} → ${code}${messageCode ? ` ${messageCode}` : ''}`);
  }
  return out;
}

describe('按路径出文件：可服务路径闸门在前，数据面授权在后', () => {
  it('member：自己 Agent 的工作区、看得见的群工作区、自己会话登记的上传照常', async () => {
    const urls = [...exits(files.agentMine), ...exits(files.groupVisible), ...exits(files.uploadMine), ...uploadExits(files.uploadMine), ...exits(files.externalMine)];
    expect(await matrix(tokens.member, urls)).toEqual(urls.map((url) => `${url} → 200`));
  });

  it('member：别人 Agent 的工作区、看不见的群、别人会话 / 群登记的上传、未登记的上传、无主目录一律 403 auth.agentForbidden', async () => {
    const urls = [
      ...exits(files.agentOther),
      ...exits(files.groupHidden),
      ...exits(files.uploadOther),
      ...uploadExits(files.uploadOther),
      ...uploadExits(files.groupHidden),
      ...exits(files.uploadUnregistered),
      ...uploadExits(files.uploadUnregistered),
      ...exits(files.unowned),
      ...exits(files.externalOther),
      ...exits(files.externalOrphan),
    ];
    expect(await matrix(tokens.member, urls)).toEqual(urls.map((url) => `${url} → 403 auth.agentForbidden`));
  });

  it('admin：以上全部 200', async () => {
    const urls = [
      ...exits(files.agentOther), ...exits(files.groupHidden), ...exits(files.uploadOther),
      ...uploadExits(files.uploadOther), ...exits(files.uploadUnregistered), ...exits(files.unowned),
      ...exits(files.externalOther), ...exits(files.externalOrphan),
    ];
    expect(await matrix(tokens.admin, urls)).toEqual(urls.map((url) => `${url} → 200`));
  });

  it('凭据类文件先被闸门挡下（对 admin 与 member 同一个结果，不是授权错误）', async () => {
    for (const token of [tokens.admin, tokens.member]) {
      const preview = await get(token, `/api/files/preview?path=${encodeURIComponent(b64(files.credential))}&mode=source`);
      expect(preview).toMatchObject({ code: 403, messageCode: 'files.notServable' });
      const download = await get(token, `/api/files/download?path=${encodeURIComponent(b64(files.credential))}`);
      expect(download.code).toBe(403);
      expect(download.messageCode).toBe('');
    }
  });

  it('HTML 预览的子资源也按归属判：自己入口目录里指向别人工作区的软链不行', async () => {
    const entry = files.agentMine;
    const dir = path.dirname(entry);
    fs.writeFileSync(path.join(dir, 'asset.css'), 'p{}');
    fs.symlinkSync(files.agentOther, path.join(dir, 'borrowed.html'));
    const sub = (name: string) => `/api/files/html-preview/path/${b64url(entry)}/__claw_preview_root__/${name}`;
    expect((await get(tokens.member, sub('asset.css'))).code).toBe(200);
    // 字面路径在入口目录内（越界检查放行），realpath 落在 workspace-other（闸门放行），归属是 other → 授权挡下
    expect(await get(tokens.member, sub('borrowed.html'))).toMatchObject({ code: 403, messageCode: 'auth.agentForbidden' });
    expect((await get(tokens.admin, sub('borrowed.html'))).code).toBe(200);
  });
});

describe('上传与上传记录', () => {
  const upload = async (token: string, fields: Record<string, string>) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('files', new Blob(['hello']), 'note.txt');
    const response = await fetch(`${h.baseUrl}/api/files/upload`, { method: 'POST', body: form, headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } });
    const body = await response.json() as any;
    return { code: response.status, messageCode: body.errorCode ?? '', body };
  };
  const listUploads = (dir: string) => { try { return fs.readdirSync(dir); } catch { return []; } };

  it('member 往看不见的会话 / 群、或不带上下文上传一律 403，且不落盘、不登记', async () => {
    const before = h.ctx.db.getFiles(300).length;
    const denied = [
      { contextType: 'session', sessionId: 's-other' },
      { contextType: 'session', sessionId: 'does-not-exist' },
      { contextType: 'group', groupId: 'g-other' },
      {},
    ];
    for (const fields of denied) {
      expect(await upload(tokens.member, fields)).toMatchObject({ code: 403, messageCode: 'auth.agentForbidden' });
    }
    expect(listUploads(path.join(h.home, '.openclaw', 'workspace-other', 'uploads'))).toEqual([]);
    expect(listUploads(path.join(h.home, '.openclaw', 'workspace-group-g-other', 'uploads'))).toEqual([]);
    expect(h.ctx.db.getFiles(300)).toHaveLength(before);
  });

  it('member 往自己的会话、看得见的群上传照常；admin 不带上下文照常', async () => {
    expect((await upload(tokens.member, { contextType: 'session', sessionId: 's-main' })).code).toBe(200);
    expect((await upload(tokens.member, { contextType: 'group', groupId: 'g-main' })).code).toBe(200);
    expect((await upload(tokens.admin, {})).code).toBe(200);
  });

  it('上传记录列表：member 只见看得见的会话 / 群里的；admin 全部', async () => {
    const memberRows = JSON.parse((await get(tokens.member, '/api/files')).text).files.map((row: any) => row.session_key);
    expect(new Set(memberRows)).toEqual(new Set(['s-main', 'g-main']));
    const adminRows = JSON.parse((await get(tokens.admin, '/api/files')).text).files.map((row: any) => row.session_key);
    expect(adminRows).toEqual(expect.arrayContaining(['s-main', 's-other', 'g-other', 'g-main', null]));
  });
});
