/**
 * 记忆服务行为用例（spec 06 §4.7 的验收清单，ClawOPT 版）。
 *
 * 每条守卫都证过红（把防护改回有缺陷的写法 → 用例失败 → 还原），记录在 P6 报告里。
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMemoryService,
  detectMemoryIntent,
  isListAllQuery,
  MemoryError,
  type EmbeddingProvider,
  type MemoryHostContext,
  type MemoryScopeRef,
  type MemoryService,
} from '../../src/memory';

let dir: string;
let dbPath: string;
let service: MemoryService;
let clock: number;

const profile = (id = 'agent-a'): MemoryScopeRef => ({ type: 'profile', id });
const room = (id = 'g1'): MemoryScopeRef => ({ type: 'context', namespace: 'clawopt.group-chat', id });

function ctx(overrides: Partial<MemoryHostContext> = {}): MemoryHostContext {
  const profileId = overrides.profileId ?? 'agent-a';
  return {
    profileId,
    origin: { host: 'clawopt', namespace: 'single-chat', contextId: 's1' },
    recallScopes: [profile(profileId)],
    writeScopes: [profile(profileId)],
    defaultWriteScope: profile(profileId),
    evidence: [{ id: 'm1', role: 'user', content: '请记住：我喜欢深色主题' }],
    policy: 'automatic',
    actor: `agent:${profileId}`,
    ...overrides,
  };
}

async function expectMemoryError(promise: Promise<unknown>, code: string): Promise<MemoryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryError);
    expect((error as MemoryError).code).toBe(code);
    return error as MemoryError;
  }
  throw new Error(`expected ${code}`);
}

const create = (kind: string, fields: Record<string, unknown> = {}) => ({ op: 'create' as const, kind, title: `${kind} title`, content: `${kind} content`, ...fields });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-memory-'));
  dbPath = path.join(dir, 'memory', 'memory.sqlite');
  clock = Date.parse('2026-09-15T00:00:00Z');
  service = createMemoryService({ dbPath, now: () => (clock += 1000), log: () => {} });
});

afterEach(() => {
  service.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('存储与 sidecar', () => {
  it('独立 SQLite 文件、WAL、目录 0700；FTS5 可用', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
    expect(service.storeInfo()).toEqual({ ephemeral: false, fts: true });
    const raw = new Database(dbPath, { readonly: true });
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    raw.close();
  });

  it('临时库：写与忘拒绝，检索标 degraded（不是「空库」）', async () => {
    const ephemeral = createMemoryService({ dbPath: ':memory:', log: () => {} });
    await expectMemoryError(ephemeral.write(ctx(), { operations: [create('general_preference', { itemKey: 'theme' })] }), 'memoryService.ephemeralStore');
    await expectMemoryError(ephemeral.forget(ctx({ evidence: [{ id: 'x', role: 'user', content: '忘掉这个' }] }), { id: 'mem_x', revision: 1 }), 'memoryService.ephemeralStore');
    const result = await ephemeral.search(ctx(), { query: '主题' });
    expect(result.degraded).toBe('ephemeralStore');
    const recall = await ephemeral.recall(ctx(), { query: 'x' });
    expect(recall.text).toContain('ephemeral');
    ephemeral.close();
  });
});

describe('槽位与规范键', () => {
  it('键由服务端生成：调用方给的 domain / category / type / key 一律忽略', async () => {
    const { results } = await service.write(ctx(), {
      operations: [{ ...create('tool_preference', { itemKey: '  Code Editor ' }), domain: 'hacked', categoryPath: 'x/y', type: 'decision', key: 'custom:key' } as never],
    });
    const card = results[0].card!;
    expect(card.key).toBe('tool_preference:code-editor');
    expect(card.domain).toBe('tools');
    expect(card.categoryPath).toBe('tools/preference');
    expect(card.type).toBe('preference');
  });

  it('未知种类、多值种类缺 itemKey、结构化值不合形状都拒绝', async () => {
    await expectMemoryError(service.write(ctx(), { operations: [create('made_up')] }), 'memoryService.unknownKind');
    await expectMemoryError(service.write(ctx(), { operations: [create('habit')] }), 'memoryService.itemKeyRequired');
    await expectMemoryError(service.write(ctx(), { operations: [create('home_location', { value: { street: 'x' } })] }), 'memoryService.invalidValue');
    await expectMemoryError(service.write(ctx(), { operations: [create('home_location', { value: { country: 'CN' } })] }), 'memoryService.invalidValue');
  });

  it('interaction_contract 始终是一张卡（再写是 supersede，不是第二张）', async () => {
    await service.write(ctx(), { operations: [create('interaction_contract', { value: { addressUserAs: '老王' } })] });
    await service.write(ctx(), { operations: [create('interaction_contract', { value: { addressUserAs: '王总' }, content: 'call me 王总' })] });
    const all = service.listAllForProfile('agent-a').filter((card) => card.kind === 'interaction_contract');
    expect(all.filter((card) => card.status === 'active')).toHaveLength(1);
    expect(all).toHaveLength(2);
    expect(all.find((card) => card.status === 'active')!.revision).toBe(2);
  });
});

describe('写入规则', () => {
  it('同值同内容 = noop；不同 = supersede（revision+1、链接、来源合并、旧卡 superseded）', async () => {
    const first = await service.write(ctx(), { operations: [create('general_preference', { itemKey: 'theme', value: 'dark' })] });
    const again = await service.write(ctx(), { operations: [create('general_preference', { itemKey: 'theme', value: 'dark' })] });
    expect(again.results[0].outcome).toBe('noop');
    expect(again.results[0].card!.id).toBe(first.results[0].card!.id);
    const changed = await service.write(ctx({ evidence: [{ id: 'm2', role: 'user', content: '以后改成浅色' }] }), { operations: [create('general_preference', { itemKey: 'theme', value: 'light', content: 'light now' })] });
    const next = changed.results[0].card!;
    expect(changed.results[0].outcome).toBe('superseded');
    expect(next.revision).toBe(2);
    expect(next.supersedesId).toBe(first.results[0].card!.id);
    expect(next.parentId).toBe(first.results[0].card!.id);
    expect(next.sourceMessageIds).toEqual(['m1', 'm2']);
    expect(service.getCard(first.results[0].card!.id)!.status).toBe('superseded');
  });

  it('更新要求 expectedRevision 且与当前一致：陈旧版本号拒绝（「先搜再改」）', async () => {
    const card = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'run' })] })).results[0].card!;
    await expectMemoryError(service.write(ctx(), { operations: [{ op: 'update', targetId: card.id, expectedRevision: 2, content: 'x' }] }), 'memoryService.revisionMismatch');
    await expectMemoryError(service.write(ctx(), { operations: [{ op: 'update', targetId: card.id, content: 'x' } as never] }), 'memoryService.revisionRequired');
    const updated = await service.write(ctx(), { operations: [{ op: 'update', targetId: card.id, expectedRevision: 1, content: 'runs daily' }] });
    expect(updated.results[0].card!.revision).toBe(2);
    await expectMemoryError(service.write(ctx(), { operations: [{ op: 'update', targetId: card.id, expectedRevision: 1, content: 'y' }] }), 'memoryService.targetNotActive');
  });

  it('改值必须同时给新的 title 与 content；valuePatch / unsetValueFields 局部改结构化值', async () => {
    const card = (await service.write(ctx(), { operations: [create('interaction_contract', { value: { userRole: 'PM', addressUserAs: '老王' } })] })).results[0].card!;
    await expectMemoryError(service.write(ctx(), { operations: [{ op: 'update', targetId: card.id, expectedRevision: 1, valuePatch: { userRole: 'CTO' } }] }), 'memoryService.titleContentRequired');
    const patched = await service.write(ctx(), { operations: [{ op: 'update', targetId: card.id, expectedRevision: 1, valuePatch: { userRole: 'CTO' }, unsetValueFields: ['addressUserAs'], title: 'contract', content: 'user is CTO' }] });
    expect(patched.results[0].card!.value).toEqual({ userRole: 'CTO' });
  });

  it('批量原子：一条非法整批不生效，报失败序号', async () => {
    const error = await expectMemoryError(service.write(ctx(), {
      operations: [create('habit', { itemKey: 'a' }), create('habit', { itemKey: 'b' }), create('nope')],
    }), 'memoryService.unknownKind');
    expect(error.detail.index).toBe(2);
    expect(service.list({ profileId: 'agent-a' }).total).toBe(0);
  });

  it('批量原子：事务内失败（陈旧版本号）也回滚前面已做的改动', async () => {
    const card = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'a' })] })).results[0].card!;
    const error = await expectMemoryError(service.write(ctx(), {
      operations: [create('habit', { itemKey: 'b' }), { op: 'update', targetId: card.id, expectedRevision: 9, content: 'x' }],
    }), 'memoryService.revisionMismatch');
    expect(error.detail.index).toBe(1);
    expect(service.list({ profileId: 'agent-a' }).cards.map((item) => item.key)).toEqual(['habit:a']);
  });

  it('同一批里两条操作碰同一个槽位或同一张卡：拒绝', async () => {
    await expectMemoryError(service.write(ctx(), { operations: [create('habit', { itemKey: 'x' }), create('habit', { itemKey: 'X ' })] }), 'memoryService.batchConflict');
    const card = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'y' })] })).results[0].card!;
    await expectMemoryError(service.write(ctx(), { operations: [create('habit', { itemKey: 'y', content: 'new' }), { op: 'expire', targetId: card.id, expectedRevision: 1 }] }), 'memoryService.batchConflict');
  });

  it('成功返回 done:true 与「不要重复调用」提示', async () => {
    const result = await service.write(ctx(), { operations: [create('habit', { itemKey: 'z' })] });
    expect(result.done).toBe(true);
    expect(result.note).toMatch(/do not call memory_write again/);
  });

  it('来源：sourceMessageIds 必须是本轮可信用户证据的子集，缺省即证据 id；伪造拒绝', async () => {
    await expectMemoryError(service.write(ctx(), { operations: [create('habit', { itemKey: 'q', sourceMessageIds: ['m1', 'forged'] })] }), 'memoryService.sourceNotEvidence');
    const assistantId = ctx({ evidence: [{ id: 'm1', role: 'user', content: '记住' }, { id: 'a1', role: 'assistant', content: 'ok' }] });
    await expectMemoryError(service.write(assistantId, { operations: [create('habit', { itemKey: 'q', sourceMessageIds: ['a1'] })] }), 'memoryService.sourceNotEvidence');
    const ok = await service.write(ctx(), { operations: [create('habit', { itemKey: 'q' })] });
    expect(ok.results[0].card!.sourceMessageIds).toEqual(['m1']);
  });

  it('证据落 memory_messages：确定性 id、重复不重复写', async () => {
    await service.write(ctx(), { operations: [create('habit', { itemKey: 'e1' })] });
    await service.write(ctx(), { operations: [create('habit', { itemKey: 'e2' })] });
    const raw = new Database(dbPath, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM memory_messages').get()).toEqual({ n: 1 });
    raw.close();
  });

  it('来历由宿主盖章', async () => {
    const card = (await service.write(ctx({ origin: { host: 'clawopt', namespace: 'group-chat', contextId: 'g1' } }), { operations: [create('habit', { itemKey: 'o' })] })).results[0].card!;
    expect(card.origin).toEqual({ host: 'clawopt', namespace: 'group-chat', contextId: 'g1' });
  });

  it('作用域必须在宿主给的可写作用域里', async () => {
    await expectMemoryError(service.write(ctx(), { operations: [create('habit', { itemKey: 's', scope: room() })] }), 'memoryService.scopeNotWritable');
  });

  it('软删 revision+1 留行；硬删移除行、FTS 行与嵌入', async () => {
    const forgetCtx = ctx({ evidence: [{ id: 'f', role: 'user', content: '把这条删掉，忘掉它' }] });
    const [soft, hard] = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'soft', title: '晨跑习惯' }), create('habit', { itemKey: 'hard', title: '夜跑习惯' })] })).results.map((entry) => entry.card!);
    await service.write(forgetCtx, { operations: [{ op: 'delete', targetId: soft.id, expectedRevision: 1 }, { op: 'delete', targetId: hard.id, expectedRevision: 1, hard: true }] });
    expect(service.getCard(soft.id)).toMatchObject({ status: 'deleted', revision: 2 });
    expect(service.getCard(hard.id)).toBeNull();
    const raw = new Database(dbPath, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM memory_nodes_fts WHERE node_id IN (?, ?)').get(soft.id, hard.id)).toEqual({ n: 0 });
    raw.close();
  });

  it('同一槽位两张 active 卡在库层就不可能（唯一部分索引）', async () => {
    const card = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'uniq' })] })).results[0].card!;
    const raw = new Database(dbPath);
    expect(() => raw.prepare("INSERT INTO memory_nodes (id, profile_id, scope_type, scope_ns, scope_id, kind, domain, category_path, type, key, revision, title, content, status, confidence, importance, created_at, updated_at) SELECT 'dup', profile_id, scope_type, scope_ns, scope_id, kind, domain, category_path, type, key, 1, title, content, 'active', 1, 1, created_at, updated_at FROM memory_nodes WHERE id = ?").run(card.id)).toThrow(/UNIQUE/);
    raw.close();
  });
});

describe('意图闸门（中英文、否定句）', () => {
  it('「清掉你所有的记忆」是全部忘掉', () => {
    expect(detectMemoryIntent('清掉你所有的记忆')).toMatchObject({ forget: true, forgetAll: true });
    expect(detectMemoryIntent('forget everything you know about me')).toMatchObject({ forget: true, forgetAll: true });
    expect(detectMemoryIntent('Please delete all of your memories.')).toMatchObject({ forget: true, forgetAll: true });
  });

  it('否定的删除不算：「别忘了」「不要删除记忆」「don’t forget」', () => {
    for (const text of ['别忘了明天开会', '不要删除我的记忆', "don't forget my birthday", 'Do not forget this', '千万别忘记带伞', '我忘了带钥匙']) {
      expect(detectMemoryIntent(text).forget, text).toBe(false);
    }
    expect(detectMemoryIntent('忘掉我刚才说的地址').forget).toBe(true);
    expect(detectMemoryIntent('忘掉我刚才说的地址').forgetAll).toBe(false);
  });

  it('记住：中英文命中，否定的不算', () => {
    expect(detectMemoryIntent('记住我叫小明').remember).toBe(true);
    expect(detectMemoryIntent('From now on, reply in English').remember).toBe(true);
    expect(detectMemoryIntent('不要记住这个').remember).toBe(false);
    expect(detectMemoryIntent("don't remember this").remember).toBe(false);
    expect(detectMemoryIntent('今天天气不错').remember).toBe(false);
  });

  it('删除与 forget 需要忘掉意图；all 需要全部忘掉；界面动作不经闸门', async () => {
    const card = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'g' })] })).results[0].card!;
    await expectMemoryError(service.write(ctx({ evidence: [{ id: 'n', role: 'user', content: '别忘了这个习惯' }] }), { operations: [{ op: 'delete', targetId: card.id, expectedRevision: 1 }] }), 'memoryService.forgetIntentRequired');
    await expectMemoryError(service.forget(ctx({ evidence: [{ id: 'n', role: 'user', content: '忘掉这个习惯' }] }), { all: true }), 'memoryService.forgetAllIntentRequired');
    const ui = await service.forget(ctx({ evidence: [], explicitUserAction: true, actor: 'user:admin' }), { id: card.id, revision: 1 });
    expect(ui.deleted).toBe(1);
  });

  it('全部忘掉：原子、只动可写作用域、带审计', async () => {
    const both = ctx({ writeScopes: [profile(), room()], recallScopes: [profile(), room()] });
    await service.write(both, { operations: [create('habit', { itemKey: 'p1' }), create('habit', { itemKey: 'r1', scope: room() })] });
    const result = await service.forget(ctx({ evidence: [{ id: 'z', role: 'user', content: '清掉你所有的记忆' }] }), { all: true });
    expect(result.deleted).toBe(1);
    expect(service.list({ profileId: 'agent-a', status: 'active' }).cards.map((card) => card.key)).toEqual(['habit:r1']);
    expect(service.auditEvents({ profileId: 'agent-a' }).filter((event) => event.action === 'forget')).toHaveLength(1);
  });

  it('forget 选择器必须恰好一个', async () => {
    const forgetCtx = ctx({ evidence: [{ id: 'z', role: 'user', content: 'forget that' }] });
    await expectMemoryError(service.forget(forgetCtx, {}), 'memoryService.invalidForgetSelector');
    await expectMemoryError(service.forget(forgetCtx, { all: true, id: 'x', revision: 1 }), 'memoryService.invalidForgetSelector');
  });

  it('explicit-only：没有「记住」意图拒写，检索照常', async () => {
    const strict = ctx({ policy: 'explicit-only', evidence: [{ id: 'q', role: 'user', content: '我今天去跑步了' }] });
    await expectMemoryError(service.write(strict, { operations: [create('habit', { itemKey: 'run' })] }), 'memoryService.explicitIntentRequired');
    await expect(service.search(strict, { query: '跑步' })).resolves.toMatchObject({ exact: [], relevant: [] });
    const asked = ctx({ policy: 'explicit-only', evidence: [{ id: 'q2', role: 'user', content: '记住我每天跑步' }] });
    const saved = await service.write(asked, { operations: [create('habit', { itemKey: 'run' })] });
    expect(saved.results[0].card!.confidence).toBeCloseTo(0.98);
  });
});

describe('作用域隔离', () => {
  it('不同作用域里相同的键互不影响', async () => {
    const both = ctx({ writeScopes: [profile(), room()], recallScopes: [profile(), room()] });
    await service.write(both, { operations: [create('general_preference', { itemKey: 'tone', value: 'formal' }), create('general_preference', { itemKey: 'tone', value: 'casual', scope: room() })] });
    const active = service.list({ profileId: 'agent-a', status: 'active' }).cards;
    expect(active).toHaveLength(2);
    expect(active.every((card) => card.revision === 1)).toBe(true);
  });

  it('profile 之间隔离：别的 Agent 搜不到、get 不到、改不了', async () => {
    const card = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'secret', title: '秘密习惯' })] })).results[0].card!;
    const other = ctx({ profileId: 'agent-b' });
    expect(await service.search(other, { all: true })).toMatchObject({ exact: [], relevant: [] });
    expect(await service.get(other, { id: card.id })).toBeNull();
    await expectMemoryError(service.write(other, { operations: [{ op: 'update', targetId: card.id, expectedRevision: 1, content: 'x' }] }), 'memoryService.targetNotFound');
  });

  it('群聊默认写到群 context：只读 profile 的召回里看不到', async () => {
    const group = ctx({ recallScopes: [profile(), room()], writeScopes: [profile(), room()], defaultWriteScope: room(), evidence: [{ id: 'g', role: 'user', content: '记住这个群的发布日是周五' }] });
    const saved = await service.write(group, { operations: [create('project_context', { itemKey: 'release-day', title: '发布日周五', content: '这个群的项目每周五发布' })] });
    expect(saved.results[0].card!.scope).toEqual(room());
    const profileOnly = await service.recall(ctx(), { query: '发布日是哪天' });
    expect(profileOnly.cards).toHaveLength(0);
    const inRoom = await service.recall(group, { query: '发布日是哪天' });
    expect(inRoom.cards.map((card) => card.key)).toEqual(['project_context:release-day']);
  });
});

describe('检索', () => {
  it('limit 最多 50', async () => {
    await service.write(ctx(), { operations: Array.from({ length: 50 }, (_, index) => create('custom_fact', { itemKey: `f${index}` })) });
    await service.write(ctx(), { operations: Array.from({ length: 10 }, (_, index) => create('custom_fact', { itemKey: `g${index}` })) });
    const result = await service.search(ctx(), { all: true, limit: 500 });
    expect(result.exact).toHaveLength(50);
    expect(result.omitted.filter((entry) => entry.reason === 'over_limit')).toHaveLength(10);
  });

  it('列出全部的说法按枚举处理', async () => {
    await service.write(ctx(), { operations: [create('habit', { itemKey: 'a1' }), create('custom_fact', { itemKey: 'b1' })] });
    expect(isListAllQuery('列出你所有的记忆')).toBe(true);
    expect(isListAllQuery('list all memories')).toBe(true);
    const result = await service.search(ctx(), { query: '列出你所有的记忆' });
    expect(result.exact).toHaveLength(2);
  });

  it('查询按关键词种类命中 exact、按词法命中 relevant（汉字二元组），零分丢弃', async () => {
    await service.write(ctx(), { operations: [
      create('profile_name', { value: '小明', title: '用户叫小明', content: '用户的名字是小明' }),
      create('custom_fact', { itemKey: 'cat', title: '家里有只橘猫', content: '橘猫叫胖虎' }),
      create('custom_fact', { itemKey: 'car', title: 'drives a car', content: 'blue car' }),
    ] });
    const byName = await service.search(ctx(), { query: '我叫什么名字' });
    expect(byName.exact.map((card) => card.kind)).toEqual(['profile_name']);
    const byWord = await service.search(ctx(), { query: '橘猫' });
    expect(byWord.relevant.map((card) => card.key)).toEqual(['custom_fact:cat']);
  });

  it('被取代的历史版本进 omitted（superseded），不进结果', async () => {
    await service.write(ctx(), { operations: [create('custom_fact', { itemKey: 'phone', title: '手机型号', content: '旧手机型号' })] });
    await service.write(ctx(), { operations: [create('custom_fact', { itemKey: 'phone', title: '手机型号', content: '新手机型号' })] });
    const result = await service.search(ctx(), { query: '手机型号' });
    expect(result.relevant.map((card) => card.content)).toEqual(['新手机型号']);
    expect(result.omitted.map((entry) => entry.reason)).toContain('superseded');
  });

  it('FTS 与卡片同步：supersede 后旧行离开、新行进入；过期离开', async () => {
    const first = (await service.write(ctx(), { operations: [create('custom_fact', { itemKey: 'fts', title: '甲乙丙', content: '甲乙丙' })] })).results[0].card!;
    const second = (await service.write(ctx(), { operations: [create('custom_fact', { itemKey: 'fts', title: '甲乙丙', content: '丁戊己' })] })).results[0].card!;
    const raw = new Database(dbPath, { readonly: true });
    const ids = () => (raw.prepare('SELECT node_id FROM memory_nodes_fts').all() as { node_id: string }[]).map((row) => row.node_id);
    expect(ids()).toEqual([second.id]);
    expect(ids()).not.toContain(first.id);
    await service.write(ctx(), { operations: [{ op: 'expire', targetId: second.id, expectedRevision: 2 }] });
    expect(ids()).toEqual([]);
    raw.close();
  });

  it('get：可读作用域内按 id 取', async () => {
    const card = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'get' })] })).results[0].card!;
    expect((await service.get(ctx(), { id: card.id }))!.id).toBe(card.id);
    expect(await service.get(ctx({ recallScopes: [room()] }), { id: card.id })).toBeNull();
  });

  it('嵌入钩子：接了提供者后按语义重排（词法相同时余弦高的在前）', async () => {
    service.close();
    const vectors: Record<string, number[]> = { apple: [1, 0], orange: [0, 1] };
    const provider: EmbeddingProvider = {
      id: 'fake',
      embed: async (texts) => texts.map((text) => (text.includes('苹果') || text.includes('apple') ? vectors.apple : vectors.orange)),
    };
    service = createMemoryService({ dbPath, now: () => (clock += 1000), log: () => {}, embeddings: provider });
    await service.write(ctx(), { operations: [
      create('custom_fact', { itemKey: 'f2', title: 'fruit note', content: '苹果很脆' }),
      // 橙子那张更新：只按词法与新旧排的话它会排在前面。
      create('custom_fact', { itemKey: 'f1', title: 'fruit note', content: '橙子很甜' }),
    ] });
    const semantic = await service.search(ctx(), { query: 'fruit apple' });
    expect(semantic.relevant.map((card) => card.key)).toEqual(['custom_fact:f2', 'custom_fact:f1']);
  });
});

describe('召回', () => {
  it('按 token 预算装箱并报告省略数', async () => {
    await service.write(ctx(), { operations: Array.from({ length: 40 }, (_, index) => create('hard_constraint', { itemKey: `c${index}`, title: `约束${index}`, content: '这是一条很长的约束说明'.repeat(10) })) });
    const small = await service.recall(ctx(), { tokenBudget: 400 });
    expect(small.cards.length).toBeGreaterThan(0);
    expect(small.cards.length).toBeLessThan(40);
    expect(small.omittedCount).toBe(40 - small.cards.length);
    const large = await service.recall(ctx(), { tokenBudget: 100_000 });
    expect(large.cards).toHaveLength(40);
    expect(large.omittedCount).toBe(0);
  });

  it('很久以前的相关事实在大量更重要的卡之后仍能召回（不按重要度窗口截断）', async () => {
    const low = ctx({ evidence: [{ id: 'old', role: 'user', content: '我的狗叫旺财' }] });
    await service.write(low, { operations: [create('relationship', { itemKey: 'dog', title: '狗叫旺财', content: '用户养了一条狗叫旺财' })] });
    for (let batch = 0; batch < 3; batch += 1) {
      await service.write(ctx(), { operations: Array.from({ length: 40 }, (_, index) => create('custom_fact', { itemKey: `n${batch}-${index}`, title: `别的事${batch}-${index}`, content: '无关内容' })) });
    }
    const result = await service.recall(ctx(), { query: '旺财' });
    expect(result.cards.map((card) => card.key)).toContain('relationship:dog');
  });

  it('普通偏好只在相关时召回；always 种类与 correction 总带上', async () => {
    await service.write(ctx(), { operations: [
      create('general_preference', { itemKey: 'music', title: '喜欢爵士乐', content: '用户喜欢爵士乐' }),
      create('language', { value: 'zh-CN', title: '说中文', content: '回复用中文' }),
      create('correction', { itemKey: 'name-spelling', title: '名字写法', content: '名字是「晓明」不是「小明」' }),
    ] });
    const unrelated = await service.recall(ctx(), { query: '帮我写个 SQL' });
    expect(unrelated.cards.map((card) => card.kind).sort()).toEqual(['correction', 'language']);
    const related = await service.recall(ctx(), { query: '我喜欢什么音乐' });
    expect(related.cards.map((card) => card.kind)).toContain('general_preference');
    expect(related.text).toMatch(/### Active constraints[\s\S]*name-spelling/);
  });

  it('置信度低于 0.35 不召回', async () => {
    const card = (await service.write(ctx(), { operations: [create('language', { value: 'en' })] })).results[0].card!;
    const raw = new Database(dbPath);
    raw.prepare('UPDATE memory_nodes SET confidence = 0.2 WHERE id = ?').run(card.id);
    raw.close();
    expect((await service.recall(ctx(), {})).cards).toHaveLength(0);
    expect((await service.search(ctx(), { all: true })).omitted).toEqual([{ id: card.id, reason: 'low_confidence' }]);
  });
});

describe('审计与管理面', () => {
  it('create / supersede / update / expire / delete 都写审计事件', async () => {
    const card = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'audit' })] })).results[0].card!;
    const next = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'audit', content: 'changed' })] })).results[0].card!;
    const updated = (await service.write(ctx(), { operations: [{ op: 'update', targetId: next.id, expectedRevision: 2, content: 'again' }] })).results[0].card!;
    await service.write(ctx(), { operations: [{ op: 'expire', targetId: updated.id, expectedRevision: 3 }] });
    const other = (await service.write(ctx(), { operations: [create('habit', { itemKey: 'audit-2' })] })).results[0].card!;
    await service.write(ctx({ explicitUserAction: true, actor: 'user:admin' }), { operations: [{ op: 'delete', targetId: other.id, expectedRevision: 1 }] });
    const actions = service.auditEvents({ profileId: 'agent-a' }).map((event) => event.action).reverse();
    expect(actions).toEqual(['create', 'supersede', 'update', 'expire', 'create', 'delete']);
    expect(service.auditEvents({ nodeId: other.id })[0].actor).toBe('user:admin');
    // 过期是原地改状态（revision+1），不是新版本。
    expect(service.revisionChain(card.id).map((entry) => [entry.revision, entry.status])).toEqual([[1, 'superseded'], [2, 'superseded'], [4, 'expired']]);
  });

  it('图谱：版本链、同源、同实体三种边', async () => {
    const group = ctx({ evidence: [{ id: 'shared', role: 'user', content: '记住这些' }] });
    await service.write(group, { operations: [
      create('custom_fact', { itemKey: 'a', entities: ['ClawOPT'] }),
      create('custom_fact', { itemKey: 'b', entities: ['clawopt'] }),
    ] });
    await service.write(ctx(), { operations: [create('custom_fact', { itemKey: 'a', content: 'v2', entities: ['ClawOPT'] })] });
    const { cards, edges } = service.graph('agent-a');
    expect(cards).toHaveLength(3);
    expect(new Set(edges.map((edge) => edge.kind))).toEqual(new Set(['revision', 'source', 'entity']));
  });
});
