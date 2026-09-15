import { beforeEach, describe, expect, it } from 'vitest';
import { consumeComposerPrefill, writeComposerPrefill } from '../../utils/composerPrefill';
import { formatAppPath, parseAppPath } from '../routeState';
import { memberRuntimeDraftFields } from './sidebarTypes';
import { SETTINGS_NAV_ITEMS } from './sidebarNav';
import { toGroupMemberPayload } from './useGroupEditor';

describe('群成员运行时草稿', () => {
  it('从成员行还原运行时与外部配置；坏 JSON 不让编辑崩', () => {
    expect(memberRuntimeDraftFields({ runtime: 'remote-openclaw', external_config: '{"gatewayUrl":"ws://gw.lan:18789","remoteAgentId":"writer","trustedLan":true}' }))
      .toEqual({ runtime: 'remote-openclaw', externalConfig: { gatewayUrl: 'ws://gw.lan:18789', remoteAgentId: 'writer', trustedLan: true } });
    expect(memberRuntimeDraftFields({ runtime: null, external_config: '{broken' })).toEqual({ runtime: 'openclaw', externalConfig: undefined });
  });

  it('请求体：运行时总是显式带上（切回 OpenClaw 才生效）；外部配置是 JSON 文本；令牌与界面状态不进请求体', () => {
    expect(toGroupMemberPayload({ agentId: 'a', displayName: 'A', roleDescription: '' })).toEqual({ agentId: 'a', displayName: 'A', roleDescription: '', runtime: 'openclaw' });
    const payload = toGroupMemberPayload({
      agentId: 'remote-writer', displayName: 'Writer', roleDescription: 'writes',
      runtime: 'remote-openclaw', externalConfig: { gatewayUrl: 'wss://gw.example', remoteAgentId: 'main', trustedLan: false },
      remoteToken: 'secret-token', hasRemoteToken: true,
    });
    expect(payload).toEqual({
      agentId: 'remote-writer', displayName: 'Writer', roleDescription: 'writes', runtime: 'remote-openclaw',
      externalConfig: '{"gatewayUrl":"wss://gw.example","remoteAgentId":"main","trustedLan":false}',
    });
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });
});

describe('Agent 运行时页的入口', () => {
  it('/settings/runtimes 是合法页签，侧栏在团队区有入口', () => {
    expect(parseAppPath('/settings/runtimes')).toEqual({ view: 'settings', tab: 'runtimes' });
    expect(formatAppPath({ view: 'settings', settingsTab: 'runtimes', sessionId: '', groupId: null })).toBe('/settings/runtimes');
    expect(SETTINGS_NAV_ITEMS.find((item) => item.tab === 'runtimes')?.zone).toBe('team');
  });
});

describe('输入框一次性预填', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as any).sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };
  });

  it('按会话取一次就清掉', () => {
    writeComposerPrefill('main', '请帮我排查');
    expect(consumeComposerPrefill('other')).toBeNull();
    expect(consumeComposerPrefill('main')).toBe('请帮我排查');
    expect(consumeComposerPrefill('main')).toBeNull();
  });
});
