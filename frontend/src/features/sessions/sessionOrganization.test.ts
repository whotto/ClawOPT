import { describe, expect, it } from 'vitest';
import {
  buildSessionSections, clampRecentCount, normalizeOrganization, parseSessionOrgPrefs, summarizeBatchDelete,
} from './sessionOrganization';

const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'diag' }];
const org = normalizeOrganization({
  categories: [{ id: 2, name: 'Zeta' }, { id: 1, name: 'Alpha' }, { id: 3, name: 'Empty' }],
  sessions: {
    a: { categoryId: 1, lastActivityAt: 300 },
    b: { categoryId: 2, lastActivityAt: 500 },
    c: { categoryId: 99, lastActivityAt: 100 },
    d: { archived: true, lastActivityAt: 900 },
    diag: { humanCreated: false, lastActivityAt: 800 },
  },
});

describe('buildSessionSections', () => {
  it('Recent 不从分类里拿走会话；只列非空分类且按名字排；未知分类当未分类；归档单独一组不进 Recent', () => {
    const sections = buildSessionSections(sessions, org, { humanOnly: false, recentCount: 2, showRecent: true });
    expect(sections.map((s) => [s.key, s.items.map((i) => i.id)])).toEqual([
      ['recent', ['diag', 'b']],
      ['category:1', ['a']],
      ['category:2', ['b']],
      ['uncategorized', ['c', 'diag']],
      ['archived', ['d']],
    ]);
  });

  it('只看人建的：诊断 / 自动化会话从所有分组消失；关掉 Recent 不出现 Recent 组', () => {
    const sections = buildSessionSections(sessions, org, { humanOnly: true, recentCount: 5, showRecent: false });
    expect(sections.flatMap((s) => s.items.map((i) => i.id))).not.toContain('diag');
    expect(sections.some((s) => s.kind === 'recent')).toBe(false);
  });

  it('组织视图还没到：全部在未分类，顺序不变', () => {
    expect(buildSessionSections(sessions, null, { humanOnly: false, recentCount: 5, showRecent: true })).toEqual([
      { kind: 'uncategorized', key: 'uncategorized', items: sessions },
    ]);
  });
});

describe('偏好与批量删除提示', () => {
  it('Recent 数量夹在 1–100；偏好读坏了按缺省', () => {
    expect(clampRecentCount(0)).toBe(1);
    expect(clampRecentCount(1000)).toBe(100);
    expect(clampRecentCount('x')).toBe(5);
    expect(parseSessionOrgPrefs('{bad')).toEqual({ collapsed: [], recentCount: 5, showRecent: true, humanOnly: false });
    expect(parseSessionOrgPrefs(JSON.stringify({ collapsed: ['recent', 1], recentCount: 7, humanOnly: true }))).toEqual({ collapsed: ['recent'], recentCount: 7, showRecent: true, humanOnly: true });
  });

  it('部分失败列出失败的名字', () => {
    const names: Record<string, string> = { x: 'X', y: 'Y' };
    expect(summarizeBatchDelete({ deleted: ['x'], failed: ['y'] }, (id) => names[id])).toEqual({ kind: 'partial', deleted: 1, failedNames: ['Y'] });
    expect(summarizeBatchDelete({ deleted: [], failed: ['y'] }, (id) => names[id]).kind).toBe('failed');
    expect(summarizeBatchDelete({ deleted: ['x', 'y'], failed: [] }, (id) => names[id]).kind).toBe('ok');
  });
});

describe('置顶', () => {
  it('置顶组在最上面、后置顶的在上；置顶的会话离开分类与 Recent；归档的会话不算置顶', () => {
    const pinnedOrg = normalizeOrganization({
      categories: [{ id: 1, name: 'Alpha' }],
      sessions: {
        a: { categoryId: 1, lastActivityAt: 300, pinnedAt: 10 },
        b: { lastActivityAt: 500, pinnedAt: 20 },
        c: { categoryId: 1, lastActivityAt: 100 },
        d: { archived: true, pinnedAt: 30, lastActivityAt: 900 },
      },
    });
    const sections = buildSessionSections([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], pinnedOrg, { humanOnly: false, recentCount: 5, showRecent: true });
    expect(sections.map((s) => [s.key, s.items.map((i) => i.id)])).toEqual([
      ['pinned', ['b', 'a']],
      ['recent', ['c']],
      ['category:1', ['c']],
      ['uncategorized', []],
      ['archived', ['d']],
    ]);
  });
});
