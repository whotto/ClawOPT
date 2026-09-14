import { describe, expect, it } from 'vitest';
import {
  formatAppPath,
  legacyHashToPath,
  parseAppPath,
  resolveRouteState,
  shouldReplaceHistory,
  storedSelectionToState,
  type AppRouteState,
} from './routeState';

const base: AppRouteState = { view: 'chat', settingsTab: 'gateway', sessionId: 's-remembered', groupId: 'g-remembered' };

describe('parseAppPath', () => {
  it('parses chat with and without session id', () => {
    expect(parseAppPath('/chat')).toEqual({ view: 'chat', sessionId: null });
    expect(parseAppPath('/chat/abc')).toEqual({ view: 'chat', sessionId: 'abc' });
    expect(parseAppPath('/chat/a%20b/')).toEqual({ view: 'chat', sessionId: 'a b' });
  });

  it('parses groups with and without group id', () => {
    expect(parseAppPath('/groups')).toEqual({ view: 'groups', groupId: null });
    expect(parseAppPath('/groups/team-1')).toEqual({ view: 'groups', groupId: 'team-1' });
  });

  it('parses every settings tab and flags unknown tabs', () => {
    for (const tab of ['gateway', 'general', 'models', 'presets', 'commands', 'about'] as const) {
      expect(parseAppPath(`/settings/${tab}`)).toEqual({ view: 'settings', tab });
    }
    expect(parseAppPath('/settings')).toEqual({ view: 'settings', tab: null });
    expect(parseAppPath('/settings/nope')).toEqual({ view: 'settings', tab: null });
  });

  it('returns null for root, unknown and too-deep paths', () => {
    expect(parseAppPath('/')).toBeNull();
    expect(parseAppPath('/login')).toBeNull();
    expect(parseAppPath('/chat/a/b')).toBeNull();
    expect(parseAppPath('/chat/%E0%A4%A')).toEqual({ view: 'chat', sessionId: null });
  });
});

describe('formatAppPath', () => {
  it('formats each view', () => {
    expect(formatAppPath({ ...base, view: 'chat', sessionId: '' })).toBe('/chat');
    expect(formatAppPath({ ...base, view: 'chat', sessionId: 'a b' })).toBe('/chat/a%20b');
    expect(formatAppPath({ ...base, view: 'groups', groupId: null })).toBe('/groups');
    expect(formatAppPath({ ...base, view: 'groups', groupId: 'g1' })).toBe('/groups/g1');
    expect(formatAppPath({ ...base, view: 'settings', settingsTab: 'models' })).toBe('/settings/models');
  });

  it('round-trips through parse + resolve', () => {
    const states: AppRouteState[] = [
      { ...base, view: 'chat', sessionId: 'x/y' },
      { ...base, view: 'groups', groupId: 'g:1' },
      { ...base, view: 'settings', settingsTab: 'about' },
    ];
    for (const state of states) {
      const resolved = resolveRouteState(parseAppPath(formatAppPath(state)), base);
      expect(formatAppPath(resolved)).toBe(formatAppPath(state));
    }
  });
});

describe('resolveRouteState', () => {
  it('lets the URL win over remembered selection', () => {
    expect(resolveRouteState({ view: 'chat', sessionId: 'from-url' }, base).sessionId).toBe('from-url');
    expect(resolveRouteState({ view: 'groups', groupId: 'from-url' }, base).groupId).toBe('from-url');
  });

  it('fills missing segments from the fallback', () => {
    expect(resolveRouteState({ view: 'chat', sessionId: null }, base)).toEqual({ ...base, view: 'chat' });
    expect(resolveRouteState({ view: 'groups', groupId: null }, base)).toEqual({ ...base, view: 'groups' });
    expect(resolveRouteState({ view: 'settings', tab: null }, base)).toEqual({ ...base, view: 'settings', settingsTab: 'gateway' });
  });

  it('keeps the remembered view at root and resets tab outside settings', () => {
    expect(resolveRouteState(null, { ...base, view: 'settings', settingsTab: 'models' })).toMatchObject({ view: 'settings', settingsTab: 'models' });
    expect(resolveRouteState(null, { ...base, view: 'groups', settingsTab: 'models' })).toMatchObject({ view: 'groups', settingsTab: 'gateway' });
    expect(resolveRouteState({ view: 'chat', sessionId: 'a' }, { ...base, settingsTab: 'about' }).settingsTab).toBe('gateway');
  });
});

describe('shouldReplaceHistory', () => {
  it('pushes when switching view, tab or between two real selections', () => {
    expect(shouldReplaceHistory({ view: 'chat', sessionId: 'a' }, { ...base, view: 'settings' })).toBe(false);
    expect(shouldReplaceHistory({ view: 'settings', tab: 'gateway' }, { ...base, view: 'settings', settingsTab: 'models' })).toBe(false);
    expect(shouldReplaceHistory({ view: 'chat', sessionId: 'a' }, { ...base, sessionId: 'b' })).toBe(false);
    expect(shouldReplaceHistory({ view: 'groups', groupId: 'a' }, { ...base, view: 'groups', groupId: 'b' })).toBe(false);
  });

  it('replaces when only filling in missing or transitional segments', () => {
    expect(shouldReplaceHistory(null, base)).toBe(true);
    expect(shouldReplaceHistory({ view: 'settings', tab: null }, { ...base, view: 'settings' })).toBe(true);
    expect(shouldReplaceHistory({ view: 'chat', sessionId: null }, { ...base, sessionId: 'a' })).toBe(true);
    expect(shouldReplaceHistory({ view: 'chat', sessionId: 'a' }, { ...base, sessionId: '' })).toBe(true);
    expect(shouldReplaceHistory({ view: 'groups', groupId: 'a' }, { ...base, view: 'groups', groupId: null })).toBe(true);
  });
});

describe('legacyHashToPath', () => {
  it('maps every hash form the old client wrote', () => {
    expect(legacyHashToPath('#chat')).toBe('/chat');
    expect(legacyHashToPath('#groups')).toBe('/groups');
    expect(legacyHashToPath('#group/g1')).toBe('/groups/g1');
    expect(legacyHashToPath('#settings')).toBe('/settings/gateway');
    expect(legacyHashToPath('#settings/presets')).toBe('/settings/presets');
  });

  it('ignores empty and unrelated hashes', () => {
    expect(legacyHashToPath('')).toBeNull();
    expect(legacyHashToPath('#')).toBeNull();
    expect(legacyHashToPath('#section-3')).toBeNull();
  });
});

describe('storedSelectionToState', () => {
  it('sanitizes remembered values', () => {
    expect(storedSelectionToState({ view: 'bogus', settingsTab: 'bogus', sessionId: null, groupId: '' })).toEqual({
      view: 'chat', settingsTab: 'gateway', sessionId: '', groupId: null,
    });
    expect(storedSelectionToState({ view: 'groups', settingsTab: 'about', sessionId: 's', groupId: 'g' })).toEqual({
      view: 'groups', settingsTab: 'about', sessionId: 's', groupId: 'g',
    });
  });
});
