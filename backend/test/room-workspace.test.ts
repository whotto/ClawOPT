/**
 * 群共享工作区（P3 任务 7）：路径闸门、SHA-256 乐观并发、每次运行的 diff、管理员才能操作。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { diffWorkspaceSnapshots, normalizeRelativePath, sha256, takeWorkspaceSnapshot, WorkspaceFiles, WorkspacePathError } from '../src/collab/rooms/room-workspace';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-ws-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-ws-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const code = async (promise: Promise<unknown> | (() => unknown)) => {
  try {
    if (typeof promise === 'function') promise();
    else await promise;
    return 'ok';
  } catch (error) {
    return error instanceof WorkspacePathError ? error.code : String(error);
  }
};

describe('路径闸门', () => {
  it('不收绝对路径、..、敏感名字', () => {
    expect(() => normalizeRelativePath('/etc/passwd')).toThrow(WorkspacePathError);
    expect(() => normalizeRelativePath('a/../../b')).toThrow(/parent/);
    expect(() => normalizeRelativePath('config/.env')).toThrow(/permissionDenied/);
    expect(() => normalizeRelativePath('keys/server.pem')).toThrow(/permissionDenied/);
    expect(() => normalizeRelativePath('.git/config')).toThrow(/permissionDenied/);
    expect(normalizeRelativePath('./src//a.ts')).toBe('src/a.ts');
  });

  it('软链接逃不出去：读、写、列目录都拒绝', async () => {
    const files = new WorkspaceFiles(() => root);
    fs.symlinkSync(outside, path.join(root, 'escape'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    expect(await code(() => files.readText('escape/secret.txt'))).toBe('workspace.permissionDenied');
    expect(await code(() => files.readText('link.txt'))).not.toBe('ok');
    expect(await code(files.write('escape/new.txt', Buffer.from('x'), null))).toBe('workspace.permissionDenied');
    expect(files.list('').entries.map((e) => e.name)).not.toContain('escape');
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });
});

describe('SHA-256 乐观并发', () => {
  it('新建不带哈希；覆盖必须带对得上的哈希；删除同理', async () => {
    const files = new WorkspaceFiles(() => root);
    const created = await files.write('docs/a.md', Buffer.from('v1'), null);
    expect(created).toMatchObject({ created: true, sha256: sha256('v1') });
    expect(await code(files.write('docs/a.md', Buffer.from('v2'), null))).toBe('workspace.conflict');
    expect(await code(files.write('docs/a.md', Buffer.from('v2'), sha256('stale')))).toBe('workspace.conflict');
    expect(await files.write('docs/a.md', Buffer.from('v2'), sha256('v1'))).toMatchObject({ created: false });
    expect(await code(files.remove('docs/a.md', sha256('v1')))).toBe('workspace.conflict');
    await files.remove('docs/a.md', sha256('v2'));
    expect(fs.existsSync(path.join(root, 'docs/a.md'))).toBe(false);
  });

  it('同一路径的并发写按顺序执行：第二个拿着旧哈希的写被拒', async () => {
    const files = new WorkspaceFiles(() => root);
    await files.write('race.txt', Buffer.from('base'), null);
    const results = await Promise.allSettled([
      files.write('race.txt', Buffer.from('one'), sha256('base')),
      files.write('race.txt', Buffer.from('two'), sha256('base')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
});

describe('每次运行的 diff', () => {
  it('新增 / 修改 / 删除，统计行数，跳过 node_modules 与敏感文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-diff-'));
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\n');
    const before = takeWorkspaceSnapshot(dir);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nB\nc\nd\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    fs.writeFileSync(path.join(dir, 'new.txt'), 'hello\n');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'ignored');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    const change = diffWorkspaceSnapshots(before, takeWorkspaceSnapshot(dir), 'completed');
    expect(change.files.map((f) => [f.path, f.changeType])).toEqual([['gone.txt', 'deleted'], ['keep.txt', 'modified'], ['new.txt', 'added']]);
    const keep = change.files.find((f) => f.path === 'keep.txt')!;
    expect([keep.additions, keep.deletions]).toEqual([2, 1]);
    expect(keep.patch).toContain('+B');
    expect(JSON.stringify(change)).not.toContain('SECRET');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('工作区接口：管理员才能操作（真组装应用）', () => {
  let h: AppHarness;
  const tokens: Record<string, string> = {};
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
    ctx.db.saveGroupChat({ id: 'g-ws', name: 'WS' });
    ctx.db.saveGroupMember({ id: 'gm-main', group_id: 'g-ws', agent_id: 'main', display_name: 'Main', position: 0 });
    ctx.db.saveGroupMember({ id: 'gm-other', group_id: 'g-ws', agent_id: 'other', display_name: 'Other', position: 1 });
  });
  afterAll(async () => {
    await h?.close();
    vi.restoreAllMocks();
  });
  const api = (token: string, url: string, init: RequestInit = {}) => fetch(`${h.baseUrl}${url}`, { ...init, headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`, 'content-type': 'application/json' } });

  it('admin 写、列、读、下载；member（群里还有没授权的 Agent，不是管理员）一律 403', async () => {
    expect((await api(tokens.admin, '/api/groups/g-ws/workspace/file', { method: 'PUT', body: JSON.stringify({ path: 'notes/plan.md', content: '# 计划' }) })).status).toBe(200);
    const list = await (await api(tokens.admin, '/api/groups/g-ws/workspace/list?path=notes')).json() as any;
    expect(list.entries.map((e: any) => e.name)).toEqual(['plan.md']);
    const file = await (await api(tokens.admin, '/api/groups/g-ws/workspace/file?path=notes/plan.md')).json() as any;
    expect(file.file).toMatchObject({ content: '# 计划', sha256: sha256('# 计划') });
    const download = await api(tokens.admin, '/api/groups/g-ws/workspace/download?path=notes/plan.md');
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('# 计划');
    expect((await api(tokens.admin, '/api/groups/g-ws/workspace/file?path=../openclaw.json')).status).toBe(400);

    for (const url of ['/api/groups/g-ws/workspace/list', '/api/groups/g-ws/workspace/file?path=notes/plan.md', '/api/groups/g-ws/workspace/download?path=notes/plan.md']) {
      expect((await api(tokens.member, url)).status, url).toBe(403);
    }
    expect((await api(tokens.member, '/api/groups/g-ws/workspace/file', { method: 'PUT', body: JSON.stringify({ path: 'x.md', content: 'x' }) })).status).toBe(403);
  });
});
