import { describe, expect, it } from 'vitest';
import {
  SETTINGS_TABS,
  enforceRouteCapabilities,
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

  it('控制面页签都在清单里（新增页签必须同时进路由表与侧栏）', () => {
    expect([...SETTINGS_TABS].sort()).toEqual(['about', 'agents', 'channels', 'commands', 'cron', 'gateway', 'general', 'logs', 'mcp', 'models', 'plugins', 'presets', 'runtimes', 'skills', 'usage', 'users']);
  });

  it('parses every settings tab and flags unknown tabs', () => {
    for (const tab of SETTINGS_TABS) {
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
      { ...base, view: 'settings', settingsTab: 'cron' },
      { ...base, view: 'settings', settingsTab: 'users' },
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
      view: 'chat', settingsTab: 'gateway', sessionId: '', groupId: null, automationSection: 'workflows', workflowId: null,
    });
    expect(storedSelectionToState({ view: 'groups', settingsTab: 'about', sessionId: 's', groupId: 'g' })).toEqual({
      view: 'groups', settingsTab: 'about', sessionId: 's', groupId: 'g', automationSection: 'workflows', workflowId: null,
    });
    expect(storedSelectionToState({ view: 'automation', settingsTab: null, sessionId: null, groupId: null, automationSection: 'kanban', workflowId: 'w1' })).toMatchObject({
      view: 'automation', automationSection: 'kanban', workflowId: 'w1',
    });
    expect(storedSelectionToState({ view: 'automation', settingsTab: null, sessionId: null, groupId: null, automationSection: 'nope' }).automationSection).toBe('workflows');
  });
});

describe('automation routes', () => {
  it('parses every automation section and the workflow id', () => {
    expect(parseAppPath('/automation')).toEqual({ view: 'automation', section: null, workflowId: null });
    expect(parseAppPath('/automation/workflows')).toEqual({ view: 'automation', section: 'workflows', workflowId: null });
    expect(parseAppPath('/automation/workflows/wf%201')).toEqual({ view: 'automation', section: 'workflows', workflowId: 'wf 1' });
    expect(parseAppPath('/automation/kanban')).toEqual({ view: 'automation', section: 'kanban', workflowId: null });
    expect(parseAppPath('/automation/webhooks')).toEqual({ view: 'automation', section: 'webhooks', workflowId: null });
    expect(parseAppPath('/automation/nope')).toEqual({ view: 'automation', section: null, workflowId: null });
  });

  it('rejects ids on sections that have none and too-deep paths', () => {
    expect(parseAppPath('/automation/kanban/x')).toBeNull();
    expect(parseAppPath('/automation/workflows/a/b')).toBeNull();
  });

  it('formats and round-trips', () => {
    const states: AppRouteState[] = [
      { ...base, view: 'automation', automationSection: 'workflows', workflowId: 'w/1' },
      { ...base, view: 'automation', automationSection: 'workflows', workflowId: null },
      { ...base, view: 'automation', automationSection: 'kanban', workflowId: 'ignored' },
      { ...base, view: 'automation', automationSection: 'webhooks' },
    ];
    expect(formatAppPath(states[0])).toBe('/automation/workflows/w%2F1');
    expect(formatAppPath(states[2])).toBe('/automation/kanban');
    for (const state of states) {
      const resolved = resolveRouteState(parseAppPath(formatAppPath(state)), base);
      expect(formatAppPath(resolved)).toBe(formatAppPath(state));
    }
  });

  it('fills a bare /automation from the remembered section and workflow', () => {
    const remembered = { ...base, automationSection: 'workflows' as const, workflowId: 'w-remembered' };
    expect(resolveRouteState(parseAppPath('/automation'), remembered)).toMatchObject({ view: 'automation', automationSection: 'workflows', workflowId: 'w-remembered' });
    expect(resolveRouteState(parseAppPath('/automation'), { ...base, automationSection: 'kanban' })).toMatchObject({ automationSection: 'kanban', workflowId: null });
    expect(resolveRouteState(parseAppPath('/automation/workflows'), remembered).workflowId).toBeNull();
  });

  it('replaces history only when filling or clearing the workflow selection', () => {
    const next = { ...base, view: 'automation' as const, automationSection: 'workflows' as const, workflowId: 'w1' };
    expect(shouldReplaceHistory({ view: 'automation', section: null, workflowId: null }, next)).toBe(true);
    expect(shouldReplaceHistory({ view: 'automation', section: 'workflows', workflowId: 'w0' }, next)).toBe(false);
    expect(shouldReplaceHistory({ view: 'automation', section: 'kanban', workflowId: null }, next)).toBe(false);
    expect(shouldReplaceHistory({ view: 'automation', section: 'workflows', workflowId: 'w0' }, { ...next, workflowId: null })).toBe(true);
    expect(shouldReplaceHistory({ view: 'chat', sessionId: 'a' }, next)).toBe(false);
  });
});

describe('enforceRouteCapabilities', () => {
  const member = new Set(['settings.agents', 'settings.about', 'automation.workflows', 'automation.kanban']);
  const navOrder = ['agents', 'presets', 'about'] as const;

  it('能力未加载：不纠偏', () => {
    const state: AppRouteState = { ...base, view: 'settings', settingsTab: 'users' };
    expect(enforceRouteCapabilities(state, null)).toBe(state);
  });

  it('进了没有入口的设置页签：换到侧栏顺序里第一个有入口的', () => {
    expect(enforceRouteCapabilities({ ...base, view: 'settings', settingsTab: 'users' }, member, navOrder)).toMatchObject({ view: 'settings', settingsTab: 'agents' });
    expect(enforceRouteCapabilities({ ...base, view: 'settings', settingsTab: 'gateway' }, new Set(['settings.about']), navOrder)).toMatchObject({ view: 'settings', settingsTab: 'about' });
  });

  it('有入口的页签原样；设置区一个入口都没有就回对话', () => {
    const allowed: AppRouteState = { ...base, view: 'settings', settingsTab: 'about' };
    expect(enforceRouteCapabilities(allowed, member, navOrder)).toBe(allowed);
    expect(enforceRouteCapabilities({ ...base, view: 'settings', settingsTab: 'logs' }, new Set(), navOrder)).toMatchObject({ view: 'chat' });
  });

  it('自动化区：没有入口的页面换到第一个有入口的并清掉选中的工作流；一个都没有回对话', () => {
    expect(enforceRouteCapabilities({ ...base, view: 'automation', automationSection: 'webhooks', workflowId: 'wf' }, member)).toMatchObject({ view: 'automation', automationSection: 'workflows', workflowId: null });
    expect(enforceRouteCapabilities({ ...base, view: 'automation', automationSection: 'kanban' }, new Set(['automation.webhooks']))).toMatchObject({ automationSection: 'webhooks' });
    expect(enforceRouteCapabilities({ ...base, view: 'automation', automationSection: 'kanban' }, new Set())).toMatchObject({ view: 'chat' });
  });

  it('对话视图不受影响', () => {
    const chat: AppRouteState = { ...base, view: 'chat' };
    expect(enforceRouteCapabilities(chat, new Set())).toBe(chat);
  });
});
