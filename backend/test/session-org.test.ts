/**
 * P1b 会话组织：分类（按用户、幂等、删分类事务）、归档、标题优先级（手动 > 运行时 > 自动）、「人建的」判据、
 * 导出、批量删除的部分失败报告、分叉的能力门控。
 */
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deriveAutoTitle,
  isHumanCreatedSession,
  normalizeCategoryName,
  resolveTitleUpdate,
  SessionOrgStore,
} from '../src/collab/sessions/session-org-store';
import { checkForkable, forkSessionId } from '../src/collab/sessions/session-org-routes';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

function memoryStore() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return { db, store: new SessionOrgStore(db) };
}

describe('分类（按用户）', () => {
  it('名称空白折叠、≤40 字符；同名不分大小写幂等；不同用户互不影响', () => {
    expect(normalizeCategoryName('  Work   stuff ')).toEqual({ ok: true, name: 'Work stuff', key: 'work stuff' });
    expect(normalizeCategoryName('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeCategoryName('x'.repeat(41))).toEqual({ ok: false, reason: 'tooLong' });
    const { store } = memoryStore();
    const first = store.createCategory('user:1', 'Work', 'work');
    const again = store.createCategory('user:1', 'WORK', 'work');
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, category: { id: first.category.id } });
    expect(store.createCategory('user:2', 'Work', 'work').created).toBe(true);
    expect(store.listCategories('user:1')).toHaveLength(1);
  });

  it('删分类与把会话挪回未分类在同一个事务里；挪到别人的分类按不存在', () => {
    const { store } = memoryStore();
    const { category } = store.createCategory('user:1', 'Work', 'work');
    const other = store.createCategory('user:2', 'Mine', 'mine').category;
    expect(store.setCategory('user:1', 's1', category.id)).toBe('ok');
    expect(store.setCategory('user:1', 's2', other.id)).toBe('category_not_found');
    store.setArchived('user:1', 's1', true);
    expect(store.deleteCategory('user:1', category.id)).toBe(true);
    expect(store.entries('user:1').get('s1')).toEqual({ categoryId: null, archived: true });
    expect(store.deleteCategory('user:1', category.id)).toBe(false);
  });

  it('改名撞名 409（conflict），不存在 not_found', () => {
    const { store } = memoryStore();
    const a = store.createCategory('user:1', 'A', 'a').category;
    store.createCategory('user:1', 'B', 'b');
    expect(store.renameCategory('user:1', a.id, 'b', 'b')).toBe('conflict');
    expect(store.renameCategory('user:1', 999, 'c', 'c')).toBe('not_found');
    expect(store.renameCategory('user:1', a.id, 'C', 'c')).toBe('ok');
  });
});

describe('标题', () => {
  it('优先级：自动只在没有标题时写；运行时提议只替换自动 / 运行时；手动永远赢', () => {
    expect(resolveTitleUpdate({ title: null, titleSource: null }, { title: 'auto', source: 'auto' })).toEqual({ title: 'auto', titleSource: 'auto' });
    expect(resolveTitleUpdate({ title: 'auto', titleSource: 'auto' }, { title: 'again', source: 'auto' })).toBeNull();
    expect(resolveTitleUpdate({ title: 'auto', titleSource: 'auto' }, { title: 'rt', source: 'runtime' })).toEqual({ title: 'rt', titleSource: 'runtime' });
    expect(resolveTitleUpdate({ title: 'mine', titleSource: 'manual' }, { title: 'rt', source: 'runtime' })).toBeNull();
    expect(resolveTitleUpdate({ title: 'mine', titleSource: 'manual' }, { title: 'new mine', source: 'manual' })).toEqual({ title: 'new mine', titleSource: 'manual' });
  });

  it('第一条用户消息推自动标题：去掉引用块、图片、链接地址；只有附件时不给', () => {
    expect(deriveAutoTitle('<quoted_message sender="AI">old</quoted_message>\n\nFix the login bug')).toBe('Fix the login bug');
    expect(deriveAutoTitle('![a.png](/uploads/a.png)')).toBeNull();
    expect(deriveAutoTitle('see [doc](/uploads/x.pdf) now')).toBe('see doc now');
    expect([...deriveAutoTitle('长'.repeat(80))!]).toHaveLength(61);
    const { store } = memoryStore();
    store.recordUserMessageForTitle('s1', 'first question');
    store.recordUserMessageForTitle('s1', 'second question');
    expect(store.getMeta('s1')).toMatchObject({ title: 'first question', titleSource: 'auto' });
    store.proposeTitle('s1', 'Renamed', 'manual');
    store.clearGeneratedTitle('s1');
    expect(store.getMeta('s1')?.title).toBe('Renamed');
  });

  it('「人建的」：有来历按来历；没有来历时只有 diagnose-<运行时> 的外部单聊算诊断会话', () => {
    expect(isHumanCreatedSession({ id: 'diagnose-claude-code', external_runtime: 'claude-code' }, null)).toBe(false);
    expect(isHumanCreatedSession({ id: 'diagnose-claude-code', external_runtime: null }, null)).toBe(true);
    expect(isHumanCreatedSession({ id: 'x' }, { origin: 'automation' })).toBe(false);
    expect(isHumanCreatedSession({ id: 'x' }, { origin: 'human' })).toBe(true);
  });
});

describe('分叉门控', () => {
  const deps = (over: { nativeFork?: boolean; busy?: boolean; messages?: number; confirmed?: boolean } = {}) => ({
    db: { getMessages: () => Array.from({ length: over.messages ?? 2 }) } as any,
    runCoordinator: { isBusy: () => over.busy ?? false },
    runtimePlatform: {
      registry: { get: () => ({ capabilities: { nativeFork: over.nativeFork ?? true } }) },
      hasConfirmedNativeSession: () => over.confirmed ?? true,
    } as any,
  });
  const session = { id: 'cc-1', external_runtime: 'claude-code' } as any;

  it('只对声明 nativeFork、空闲、有确认过的原生会话的外部单聊放行', () => {
    expect(checkForkable(deps(), session)).toBeNull();
    expect(checkForkable(deps({ nativeFork: false }), session)?.status).toBe(400);
    expect(checkForkable(deps(), { id: 'main', external_runtime: null } as any)?.status).toBe(400);
    expect(checkForkable(deps({ busy: true }), session)?.status).toBe(409);
    expect(checkForkable(deps({ confirmed: false }), session)?.status).toBe(409);
    expect(checkForkable(deps({ messages: 0 }), session)?.status).toBe(409);
    expect(forkSessionId('cc-1', new Date('2026-09-15T01:02:03Z'))).toMatch(/^cc-1-fork-20260915010203-[0-9a-f]{6}$/);
  });
});

describe('会话组织接口（真实路由，单用户）', () => {
  let h: AppHarness;
  beforeAll(async () => { h = await startAppHarness(); });
  afterAll(async () => { await h.close(); });
  const json = (path: string, init?: RequestInit) => fetch(`${h.baseUrl}${path}`, { ...init, headers: { 'content-type': 'application/json' } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers }));

  it('分类建 / 挪 / 归档 / 改标题，组织视图带回；导出 JSON 与 Markdown', async () => {
    h.ctx.sessionManager.createSession({ id: 'org-s1', name: 'Tester', agentId: 'main' });
    h.ctx.db.saveMessage({ session_key: 'org-s1', role: 'user', content: 'How do I deploy?' });
    h.ctx.db.saveMessage({ session_key: 'org-s1', role: 'assistant', content: 'Run the script.' });
    const created = await json('/api/session-categories', { method: 'POST', body: JSON.stringify({ name: 'Ops' }) });
    expect(created.status).toBe(201);
    expect((await json('/api/sessions/org-s1/category', { method: 'PUT', body: JSON.stringify({ categoryId: 99999 }) })).status).toBe(404);
    expect((await json('/api/sessions/org-s1/category', { method: 'PUT', body: JSON.stringify({ categoryId: created.body.category.id }) })).status).toBe(200);
    expect((await json('/api/sessions/org-s1/archive', { method: 'PUT', body: JSON.stringify({ archived: true }) })).status).toBe(200);
    expect((await json('/api/sessions/org-s1/title', { method: 'PUT', body: JSON.stringify({ title: 'Deploy notes' }) })).body).toMatchObject({ title: 'Deploy notes', titleSource: 'manual' });
    const org = await json('/api/session-organization');
    expect(org.body.sessions['org-s1']).toMatchObject({ categoryId: created.body.category.id, archived: true, title: 'Deploy notes', titleSource: 'manual', humanCreated: true });

    const exportedJson = await fetch(`${h.baseUrl}/api/sessions/org-s1/export?format=json`);
    expect(exportedJson.headers.get('content-disposition')).toContain('attachment');
    const body = await exportedJson.json() as any;
    expect(JSON.stringify(body)).toContain('Run the script.');
    const exportedMd = await (await fetch(`${h.baseUrl}/api/sessions/org-s1/export?format=markdown`)).text();
    expect(exportedMd).toContain('How do I deploy?');
    expect((await fetch(`${h.baseUrl}/api/sessions/org-s1/export?format=zip`)).status).toBe(400);
  });

  it('批量删除：逐个判权与删除，部分失败报告（main 不能删、不存在 404）', async () => {
    h.ctx.sessionManager.createSession({ id: 'org-del-1', name: 'D1', agentId: 'org-del-1', external_runtime: 'claude-code', external_config: '{}' });
    const result = await json('/api/sessions/batch-delete', { method: 'POST', body: JSON.stringify({ ids: ['org-del-1', 'main', 'org-missing'] }) });
    expect(result.status).toBe(200);
    expect(result.body.deleted).toEqual(['org-del-1']);
    expect(result.body.failed).toEqual(['main', 'org-missing']);
    expect(result.body.success).toBe(false);
    expect(h.ctx.sessionManager.getSession('org-del-1')).toBeFalsy();
    expect((await json('/api/sessions/batch-delete', { method: 'POST', body: JSON.stringify({ ids: [] }) })).status).toBe(400);
  });
});
