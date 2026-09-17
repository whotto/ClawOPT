/**
 * 文件管理器 HTTP 面：授权矩阵、路径闸门、软链逃逸、敏感文件两头判、版本号、分块上传、额外根闸门、下载头。
 * 全部在一次性 HOME 下跑，不碰真实 ~/.openclaw。
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { q, startFileManagerHarness, type FmHarness } from './helpers';

let h: FmHarness;

beforeAll(async () => { h = await startFileManagerHarness(); });
afterAll(async () => { await h?.close(); });

const SUPER = 'super-token';
const ADMIN = 'admin-token';
const ADMIN2 = 'admin2-token';
const MEMBER = 'member-token';

describe('根与授权', () => {
  it('member 只看见自己 Agent 的工作区，且不可写；admin 全部可写', async () => {
    const member = await h.request(MEMBER, 'GET', '/api/fs/roots');
    expect(member.status).toBe(200);
    expect(member.json.roots.map((root: any) => root.id)).toEqual(['agent:alice']);
    expect(member.json.roots[0].writable).toBe(false);
    const admin = await h.request(ADMIN, 'GET', '/api/fs/roots');
    expect(admin.json.roots.filter((root: any) => root.kind === 'agent').map((root: any) => [root.id, root.writable])).toEqual([['agent:alice', true], ['agent:bob', true], ['agent:carol', true]]);
  });

  it('member 读别人 Agent 的根 403；不存在的 Agent 对 member 同样 403（不泄露存在性）', async () => {
    for (const root of ['agent:bob', 'agent:nobody']) {
      const response = await h.request(MEMBER, 'GET', `/api/fs/list${q({ root, path: '' })}`);
      expect(response.status, root).toBe(403);
    }
    expect((await h.request(MEMBER, 'GET', `/api/fs/list${q({ root: 'agent:alice', path: '' })}`)).status).toBe(200);
    expect((await h.request(MEMBER, 'GET', `/api/fs/read${q({ root: 'agent:bob', path: 'README.md' })}`)).status).toBe(403);
    expect((await h.request(MEMBER, 'GET', `/api/fs/download${q({ root: 'agent:bob', path: 'README.md' })}`)).status).toBe(403);
  });

  it('member 打任何改动路由 403（闸门在处理器之前），自己 Agent 的根也一样', async () => {
    const calls: Array<[string, string, unknown]> = [
      ['PUT', '/api/fs/write', { root: 'agent:alice', path: 'x.txt', content: 'x' }],
      ['POST', '/api/fs/mkdir', { root: 'agent:alice', path: 'new' }],
      ['POST', '/api/fs/rename', { root: 'agent:alice', from: 'README.md', to: 'R.md' }],
      ['POST', '/api/fs/copy', { root: 'agent:alice', from: 'README.md', to: 'R.md' }],
      ['POST', '/api/fs/delete', { root: 'agent:alice', path: 'README.md' }],
      ['POST', '/api/fs/uploads', { root: 'agent:alice', dir: '', name: 'a.txt', size: 1 }],
      ['GET', '/api/fs/config', undefined],
      ['POST', '/api/fs/extra-roots', { path: h?.outside }],
    ];
    for (const [method, url, body] of calls) {
      const response = await h.request(MEMBER, method, url, body);
      expect(response.status, `${method} ${url}`).toBe(403);
    }
    expect(fs.existsSync(path.join(h.workspace('alice'), 'README.md'))).toBe(true);
  });

  it('服务层自己也复查：绕过路由直接调服务，member 的改动一样被拒', async () => {
    const member = { userId: 3, username: 'u3', role: 'member' as const, implicit: false, mustChangePassword: false };
    await expect(h.service.remove(member, { root: 'agent:alice', path: 'README.md', recursive: false })).rejects.toMatchObject({ errorCode: 'auth.forbidden' });
  });

  it('额外根、远端连接配置只给 super_admin：admin 403', async () => {
    expect((await h.request(ADMIN, 'GET', '/api/fs/config')).status).toBe(403);
    expect((await h.request(SUPER, 'GET', '/api/fs/config')).status).toBe(200);
  });
});

describe('Agent 工作区发内容的两道门', () => {
  it('工作区不在可服务路径白名单里（名册自定义路径）：能列目录，读内容 / 下载 / 预览一律拒绝，admin 也一样', async () => {
    expect((await h.request(ADMIN, 'GET', `/api/fs/list${q({ root: 'agent:carol', path: '' })}`)).status).toBe(200);
    for (const url of ['/api/fs/read', '/api/fs/download', '/api/fs/preview-link']) {
      const response = await h.request(ADMIN, 'GET', `${url}${q({ root: 'agent:carol', path: 'notes.txt' })}`);
      expect(response.status, url).toBe(403);
    }
  });

  it('预览地址走 /api/files/download（那条路由自己再过两道门）', async () => {
    const response = await h.request(MEMBER, 'GET', `/api/fs/preview-link${q({ root: 'agent:alice', path: 'README.md' })}`);
    expect(response.status).toBe(200);
    expect(response.json.url).toBe(`/api/files/download?path=${encodeURIComponent(path.join(h.workspace('alice'), 'README.md'))}`);
  });
});

describe('路径闸门', () => {
  it('拒绝 `..`、绝对路径、NUL、反斜杠', async () => {
    for (const bad of ['../workspace-bob/README.md', 'docs/../../x', '/etc/passwd', 'a\0b', 'docs\\..\\..\\x']) {
      const response = await h.request(ADMIN, 'GET', `/api/fs/read${q({ root: 'agent:alice', path: bad })}`);
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(response.json.errorCode).toBe('fileManager.invalidPath');
    }
  });

  it('根内指向根外的软链（文件与目录）读不到、列不进、写不穿', async () => {
    const ws = h.workspace('alice');
    fs.symlinkSync(path.join(h.outside, 'secret.txt'), path.join(ws, 'leak.txt'));
    fs.symlinkSync(h.outside, path.join(ws, 'leakdir'));
    expect((await h.request(ADMIN, 'GET', `/api/fs/read${q({ root: 'agent:alice', path: 'leak.txt' })}`)).status).toBe(403);
    expect((await h.request(ADMIN, 'GET', `/api/fs/download${q({ root: 'agent:alice', path: 'leak.txt' })}`)).status).toBe(403);
    expect((await h.request(ADMIN, 'GET', `/api/fs/list${q({ root: 'agent:alice', path: 'leakdir' })}`)).status).toBe(403);
    expect((await h.request(ADMIN, 'GET', `/api/fs/read${q({ root: 'agent:alice', path: 'leakdir/secret.txt' })}`)).status).toBe(403);
    const write = await h.request(ADMIN, 'PUT', '/api/fs/write', { root: 'agent:alice', path: 'leakdir/planted.txt', content: 'x' }, { 'If-Match': '"absent"' });
    expect(write.status).toBe(403);
    expect(fs.existsSync(path.join(h.outside, 'planted.txt'))).toBe(false);
    const overwrite = await h.request(ADMIN, 'PUT', '/api/fs/write', { root: 'agent:alice', path: 'leak.txt', content: 'x' }, { 'If-Match': '"absent"' });
    expect(overwrite.status).toBe(403);
    expect(fs.readFileSync(path.join(h.outside, 'secret.txt'), 'utf8')).toBe('top secret');
    const copy = await h.request(ADMIN, 'POST', '/api/fs/copy', { root: 'agent:alice', from: 'leakdir', to: 'stolen' });
    expect(copy.status).toBe(403);
    // 删除软链只删链接本身。
    expect((await h.request(ADMIN, 'POST', '/api/fs/delete', { root: 'agent:alice', path: 'leakdir' })).status).toBe(200);
    expect(fs.existsSync(path.join(h.outside, 'secret.txt'))).toBe(true);
    fs.unlinkSync(path.join(ws, 'leak.txt'));
  });

  it('软链在根内但指向敏感文件：按真实目标判（额外根没有可服务路径闸门兜底，只靠这一道）', async () => {
    const dir = path.join(h.home, 'extra-symlink-root');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=1');
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'innocent.txt'));
    const added = await h.request(SUPER, 'POST', '/api/fs/extra-roots', { name: 'links', path: dir });
    expect(added.status).toBe(200);
    const root = `extra:${added.json.root.id}`;
    for (const url of ['/api/fs/read', '/api/fs/download']) {
      const response = await h.request(ADMIN, 'GET', `${url}${q({ root, path: 'innocent.txt' })}`);
      expect(response.status, url).toBe(403);
      expect(response.json.errorCode).toBe('fileManager.deniedFile');
    }
    expect((await h.request(SUPER, 'DELETE', `/api/fs/extra-roots/${added.json.root.id}`)).status).toBe(200);
  });

  it('敏感文件：源与目标两头都判（改名成 .env、复制成 id_rsa、新建 .ssh 目录都拒绝），列表里也不出现', async () => {
    const ws = h.workspace('alice');
    fs.writeFileSync(path.join(ws, 'config.pem'), 'PEM');
    const cases: Array<[string, string, unknown, Record<string, string>?]> = [
      ['POST', '/api/fs/rename', { root: 'agent:alice', from: 'README.md', to: '.env' }],
      ['POST', '/api/fs/rename', { root: 'agent:alice', from: 'README.md', to: 'docs/.env.local' }],
      ['POST', '/api/fs/copy', { root: 'agent:alice', from: 'README.md', to: 'id_rsa' }],
      ['POST', '/api/fs/copy', { root: 'agent:alice', from: 'config.pem', to: 'plain.txt' }],
      ['POST', '/api/fs/mkdir', { root: 'agent:alice', path: '.ssh' }],
      ['PUT', '/api/fs/write', { root: 'agent:alice', path: 'openclaw.json', content: '{}' }, { 'If-Match': '"absent"' }],
      ['POST', '/api/fs/uploads', { root: 'agent:alice', dir: '', name: 'server.key', size: 1 }],
    ];
    for (const [method, url, body, headers] of cases) {
      const response = await h.request(ADMIN, method, url, body, headers);
      expect(response.status, `${method} ${url} ${JSON.stringify(body)}`).toBe(403);
      expect(response.json.errorCode).toBe('fileManager.deniedFile');
    }
    expect(fs.existsSync(path.join(ws, '.env'))).toBe(false);
    const listed = await h.request(ADMIN, 'GET', `/api/fs/list${q({ root: 'agent:alice', path: '' })}`);
    expect(listed.json.entries.map((entry: any) => entry.name)).not.toContain('config.pem');
    fs.unlinkSync(path.join(ws, 'config.pem'));
  });
});

describe('读写与版本号', () => {
  it('写必须带读到时的版本号：缺 428、不符 412 带当前内容、符合才写', async () => {
    const read = await h.request(ADMIN, 'GET', `/api/fs/read${q({ root: 'agent:alice', path: 'README.md' })}`);
    expect(read.status).toBe(200);
    const revision = read.json.file.revision;
    expect((await h.request(ADMIN, 'PUT', '/api/fs/write', { root: 'agent:alice', path: 'README.md', content: 'v2' })).status).toBe(428);
    fs.writeFileSync(path.join(h.workspace('alice'), 'README.md'), 'changed elsewhere');
    const stale = await h.request(ADMIN, 'PUT', '/api/fs/write', { root: 'agent:alice', path: 'README.md', content: 'v2' }, { 'If-Match': `"${revision}"` });
    expect(stale.status).toBe(412);
    expect(stale.json.current.value.content).toBe('changed elsewhere');
    const ok = await h.request(ADMIN, 'PUT', '/api/fs/write', { root: 'agent:alice', path: 'README.md', content: 'v2' }, { 'If-Match': `"${stale.json.current.revision}"` });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(path.join(h.workspace('alice'), 'README.md'), 'utf8')).toBe('v2');
    const created = await h.request(ADMIN, 'PUT', '/api/fs/write', { root: 'agent:alice', path: 'docs/new.md', content: 'hi' }, { 'If-Match': '"absent"' });
    expect(created.status).toBe(200);
  });

  it('member 读自己 Agent 的文本文件；下载带附件头、nosniff 与 RFC 5987 文件名', async () => {
    fs.writeFileSync(path.join(h.workspace('alice'), 'docs', '报告 "1".txt'), 'hello');
    const read = await h.request(MEMBER, 'GET', `/api/fs/read${q({ root: 'agent:alice', path: 'docs/报告 "1".txt' })}`);
    expect(read.json.file.content).toBe('hello');
    const download = await h.request(MEMBER, 'GET', `/api/fs/download${q({ root: 'agent:alice', path: 'docs/报告 "1".txt' })}`);
    expect(download.status).toBe(200);
    expect(download.text).toBe('hello');
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="__ _1_.txt"; filename\*=UTF-8''%E6%8A%A5%E5%91%8A%20%221%22.txt$/);
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('列目录：目录在前，按名字排序', async () => {
    const listed = await h.request(ADMIN, 'GET', `/api/fs/list${q({ root: 'agent:alice', path: '' })}`);
    const kinds = listed.json.entries.map((entry: any) => entry.kind);
    expect(kinds.indexOf('file')).toBeGreaterThan(kinds.lastIndexOf('dir'));
  });
});

describe('可续传分块上传', () => {
  it('严格偏移、断点续传、完成后原子落位、不覆盖已有文件', async () => {
    const begin = await h.request(ADMIN, 'POST', '/api/fs/uploads', { root: 'agent:alice', dir: 'docs', name: 'big.bin', size: 10 });
    expect(begin.status).toBe(200);
    const id = begin.json.upload.id;
    expect(begin.json.upload.nextOffset).toBe(0);
    const partDir = path.join(h.dataDir, 'file-manager', 'uploads');
    expect(fs.readdirSync(partDir)).toContain(`${id}.part`);
    expect(fs.existsSync(path.join(h.workspace('alice'), 'docs', 'big.bin'))).toBe(false);

    expect((await h.request(ADMIN, 'PUT', `/api/fs/uploads/${id}/chunks?offset=0`, Buffer.from('01234'))).json.upload.nextOffset).toBe(5);
    const wrongOffset = await h.request(ADMIN, 'PUT', `/api/fs/uploads/${id}/chunks?offset=0`, Buffer.from('01234'));
    expect(wrongOffset.status).toBe(409);
    expect(wrongOffset.json.errorParams.nextOffset).toBe(5);
    const skipped = await h.request(ADMIN, 'PUT', `/api/fs/uploads/${id}/chunks?offset=7`, Buffer.from('7'));
    expect(skipped.status).toBe(409);
    // 断线后按状态接口续传。
    const status = await h.request(ADMIN, 'GET', `/api/fs/uploads/${id}`);
    expect(status.json.upload.nextOffset).toBe(5);
    expect((await h.request(ADMIN, 'POST', `/api/fs/uploads/${id}/complete`)).status).toBe(409);
    const overflow = await h.request(ADMIN, 'PUT', `/api/fs/uploads/${id}/chunks?offset=5`, Buffer.from('567890'));
    expect(overflow.status).toBe(413);
    expect((await h.request(ADMIN, 'PUT', `/api/fs/uploads/${id}/chunks?offset=5`, Buffer.from('56789'))).json.upload.nextOffset).toBe(10);
    const done = await h.request(ADMIN, 'POST', `/api/fs/uploads/${id}/complete`);
    expect(done.status).toBe(200);
    expect(fs.readFileSync(path.join(h.workspace('alice'), 'docs', 'big.bin'), 'utf8')).toBe('0123456789');
    expect(fs.readdirSync(partDir)).not.toContain(`${id}.part`);
    expect((await h.request(ADMIN, 'GET', `/api/fs/uploads/${id}`)).status).toBe(404);

    const again = await h.request(ADMIN, 'POST', '/api/fs/uploads', { root: 'agent:alice', dir: 'docs', name: 'big.bin', size: 1 });
    expect(again.status).toBe(409);
  });

  it('会话归用户：另一个管理员拿同一个 id 403；abort 删掉临时文件', async () => {
    const begin = await h.request(ADMIN, 'POST', '/api/fs/uploads', { root: 'agent:alice', dir: '', name: 'owned.txt', size: 3 });
    const id = begin.json.upload.id;
    for (const [method, url, body] of [
      ['GET', `/api/fs/uploads/${id}`, undefined],
      ['PUT', `/api/fs/uploads/${id}/chunks?offset=0`, Buffer.from('abc')],
      ['POST', `/api/fs/uploads/${id}/complete`, undefined],
      ['DELETE', `/api/fs/uploads/${id}`, undefined],
    ] as const) {
      expect((await h.request(ADMIN2, method, url, body)).status, `${method} ${url}`).toBe(403);
    }
    expect((await h.request(ADMIN, 'DELETE', `/api/fs/uploads/${id}`)).status).toBe(200);
    expect(fs.existsSync(path.join(h.dataDir, 'file-manager', 'uploads', `${id}.part`))).toBe(false);
    expect(fs.existsSync(path.join(h.workspace('alice'), 'owned.txt'))).toBe(false);
  });

  it('块超过上限回结构化 413', async () => {
    const begin = await h.request(ADMIN, 'POST', '/api/fs/uploads', { root: 'agent:alice', dir: '', name: 'huge.bin', size: 5 * 1024 * 1024 });
    const response = await h.request(ADMIN, 'PUT', `/api/fs/uploads/${begin.json.upload.id}/chunks?offset=0`, Buffer.alloc(1024 * 1024 + 10));
    expect(response.status).toBe(413);
    expect(response.json.errorCode).toBe('fileManager.tooLarge');
  });
});

describe('额外根', () => {
  it('拒绝文件系统根、家目录及其祖先、~/.openclaw、ClawOPT 数据目录、系统目录、敏感目录名；接受普通目录', async () => {
    fs.mkdirSync(path.join(h.home, '.ssh'), { recursive: true });
    fs.mkdirSync(h.dataDir, { recursive: true });
    const refused = ['/', h.home, path.dirname(h.home), path.join(h.home, '.openclaw'), h.workspace('alice'), h.dataDir, '/etc', path.join(h.home, '.ssh'), 'relative/dir', path.join(h.home, 'missing')];
    for (const candidate of refused) {
      const response = await h.request(SUPER, 'POST', '/api/fs/extra-roots', { path: candidate });
      expect(response.status, candidate).toBe(400);
    }
    const added = await h.request(SUPER, 'POST', '/api/fs/extra-roots', { name: 'Outside', path: h.outside });
    expect(added.status).toBe(200);
    const rootId = `extra:${added.json.root.id}`;
    expect((await h.request(ADMIN, 'GET', `/api/fs/read${q({ root: rootId, path: 'secret.txt' })}`)).json.file.content).toBe('top secret');
    expect((await h.request(MEMBER, 'GET', `/api/fs/list${q({ root: rootId, path: '' })}`)).status).toBe(403);
    expect((await h.request(MEMBER, 'GET', '/api/fs/roots')).json.roots.some((root: any) => root.id === rootId)).toBe(false);
  });
});

describe('额外根闸门（单独判据）', () => {
  it('家目录本身与它的祖先：即使家目录里没有 ~/.openclaw、数据目录在别处，也拒绝', async () => {
    const { validateExtraRootPath } = await import('../../src/workspace/files/manager/file-manager-service');
    const bareHome = path.join(h.home, 'bare-home');
    fs.mkdirSync(path.join(bareHome, 'projects'), { recursive: true });
    const context = { home: bareHome, dataDir: path.join(h.home, 'elsewhere-data') };
    await expect(validateExtraRootPath(bareHome, context)).rejects.toMatchObject({ errorCode: 'fileManager.extraRootForbidden' });
    await expect(validateExtraRootPath(path.dirname(bareHome), context)).rejects.toMatchObject({ errorCode: 'fileManager.extraRootForbidden' });
    await expect(validateExtraRootPath(path.join(bareHome, 'projects'), context)).resolves.toBe(path.join(bareHome, 'projects'));
  });
});

describe('远端连接配置', () => {
  it('不认得的字段（想关主机密钥校验的）一律拒绝；私钥路径永不回给前端', async () => {
    const bad = await h.request(SUPER, 'POST', '/api/fs/connections', { kind: 'ssh', name: 'x', host: 'example.com', user: 'deploy', rootPath: '/srv', strictHostKeyChecking: 'no' });
    expect(bad.status).toBe(400);
    expect(bad.json.errorParams.field).toBe('strictHostKeyChecking');
    const injected = await h.request(SUPER, 'POST', '/api/fs/connections', { kind: 'ssh', name: 'x', host: '-oProxyCommand=touch /tmp/pwn', user: 'deploy', rootPath: '/srv' });
    expect(injected.status).toBe(400);
    const keyFile = path.join(h.home, 'deploy_key_file');
    fs.writeFileSync(keyFile, 'KEY');
    const saved = await h.request(SUPER, 'POST', '/api/fs/connections', { kind: 'ssh', name: 'box', host: 'example.com', port: 2222, user: 'deploy', rootPath: '/srv/app', keyPath: keyFile });
    expect(saved.status).toBe(200);
    const config = await h.request(SUPER, 'GET', '/api/fs/config');
    expect(config.text).not.toContain(keyFile);
    expect(config.json.connections[0]).toMatchObject({ name: 'box', hasKey: true, port: 2222 });
  });
});
