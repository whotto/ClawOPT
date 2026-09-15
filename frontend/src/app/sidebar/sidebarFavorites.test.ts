import { describe, expect, it } from 'vitest';
import {
  createFavoritesSync,
  makeSidebarFavoriteKey,
  normalizeSidebarFavorites,
  parseSidebarFavoriteKey,
  pruneSidebarFavorites,
  toggleSidebarFavorite,
} from './sidebarFavorites';

describe('favorite keys', () => {
  it('round-trips type and id, including ids that contain a colon', () => {
    expect(parseSidebarFavoriteKey(makeSidebarFavoriteKey('agents', 'a1'))).toEqual({ type: 'agents', id: 'a1' });
    expect(parseSidebarFavoriteKey(makeSidebarFavoriteKey('groups', 'g:1'))).toEqual({ type: 'groups', id: 'g:1' });
  });

  it('rejects unknown prefixes and empty ids', () => {
    expect(parseSidebarFavoriteKey('other:x')).toBeNull();
    expect(parseSidebarFavoriteKey('agents:')).toBeNull();
  });
});

describe('normalizeSidebarFavorites', () => {
  it('dedupes, drops non-strings, filters unknown order keys and appends missing ones', () => {
    expect(normalizeSidebarFavorites({
      agents: ['a', 'a', 3, 'b'],
      groups: ['g'],
      order: ['groups:g', 'agents:zzz', 'groups:g'],
    })).toEqual({
      agents: ['a', 'b'],
      groups: ['g'],
      order: ['groups:g', 'agents:a', 'agents:b'],
    });
  });

  it('treats garbage as empty', () => {
    expect(normalizeSidebarFavorites(null)).toEqual({ agents: [], groups: [], order: [] });
  });
});

describe('toggleSidebarFavorite', () => {
  it('adds to the end of the order and removes from it', () => {
    const empty = { agents: [], groups: [], order: [] };
    const added = toggleSidebarFavorite(toggleSidebarFavorite(empty, 'groups', 'g'), 'agents', 'a');
    expect(added).toEqual({ agents: ['a'], groups: ['g'], order: ['groups:g', 'agents:a'] });
    expect(toggleSidebarFavorite(added, 'groups', 'g')).toEqual({ agents: ['a'], groups: [], order: ['agents:a'] });
  });
});

describe('pruneSidebarFavorites', () => {
  it('drops favorites whose session or group no longer exists', () => {
    const prev = { agents: ['a', 'gone'], groups: ['g'], order: ['agents:gone', 'groups:g', 'agents:a'] };
    expect(pruneSidebarFavorites(prev, [{ id: 'a' }], [{ id: 'g' }])).toEqual({
      agents: ['a'], groups: ['g'], order: ['groups:g', 'agents:a'],
    });
  });

  it('returns the same object when nothing changes', () => {
    const prev = { agents: ['a'], groups: [], order: ['agents:a'] };
    expect(pruneSidebarFavorites(prev, [{ id: 'a' }], [])).toBe(prev);
  });
});

describe('收藏回写：加载与无变化的清理不写', () => {
  const favorites = (agents: string[]) => ({ agents, groups: [], order: agents.map((id) => makeSidebarFavoriteKey('agents', id)) });

  it('对齐前不写；读到服务端的值后原样出现不写；真正变化才写，且同一个值只写一次', () => {
    const saved: unknown[] = [];
    const sync = createFavoritesSync((value) => saved.push(value));
    expect(sync.changed(favorites(['a']))).toBe(false);
    sync.synced(favorites(['a']));
    expect(sync.changed(favorites(['a']))).toBe(false);
    expect(sync.changed(pruneSidebarFavorites(favorites(['a']), [{ id: 'a' }], []))).toBe(false);
    expect(sync.changed(favorites(['a', 'b']))).toBe(true);
    expect(sync.changed(favorites(['a', 'b']))).toBe(false);
    expect(saved).toEqual([favorites(['a', 'b'])]);
  });

  it('服务端为空而本地有：作为一次真实变化推上去', () => {
    const saved: unknown[] = [];
    const sync = createFavoritesSync((value) => saved.push(value));
    sync.synced({ agents: [], groups: [], order: [] });
    expect(sync.changed(favorites(['local']))).toBe(true);
    expect(saved).toHaveLength(1);
  });
});
