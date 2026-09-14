import { describe, expect, it } from 'vitest';
import {
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
