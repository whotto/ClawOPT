import { describe, expect, it } from 'vitest';
import { buildLocalAgentPromptChars, formatCompactCount, resolveGroupMemberDisplayName, resolveSidebarSubmitError } from './sidebarFormat';
import type { AgentFormData } from './sidebarTypes';

const t = (key: string) => (key === 'known.code' ? '已翻译' : key);

describe('resolveSidebarSubmitError', () => {
  it('prefers a translated errorCode, then error, message, errorDetail, then fallback', () => {
    expect(resolveSidebarSubmitError({ errorCode: 'known.code', error: 'e' }, t, 'fb')).toBe('已翻译');
    expect(resolveSidebarSubmitError({ errorCode: 'unknown.code', error: ' e ' }, t, 'fb')).toBe('e');
    expect(resolveSidebarSubmitError({ message: 'm', errorDetail: 'd' }, t, 'fb')).toBe('m');
    expect(resolveSidebarSubmitError({ errorDetail: 'd' }, t, 'fb')).toBe('d');
    expect(resolveSidebarSubmitError({}, t, 'fb')).toBe('fb');
  });
});

describe('resolveGroupMemberDisplayName', () => {
  const sessions = [{ id: 's1', name: '会话名', agentId: 'agent-1' }];
  it('uses the linked session name first', () => {
    expect(resolveGroupMemberDisplayName({ agent_id: 'agent-1', display_name: '成员名' }, sessions)).toBe('会话名');
  });
  it('falls back to the member display name, then the agent id', () => {
    expect(resolveGroupMemberDisplayName({ agentId: 'x', displayName: '成员名' }, sessions)).toBe('成员名');
    expect(resolveGroupMemberDisplayName({ agent_id: 'x' }, sessions)).toBe('x');
  });
});

describe('formatCompactCount', () => {
  it('uses 万 for zh and k for other languages above the threshold', () => {
    expect(formatCompactCount(25000, 'zh-CN')).toBe('2.5万');
    expect(formatCompactCount(2500, 'en')).toBe('2.5k');
    expect(formatCompactCount(999, 'en')).toBe((999).toLocaleString());
  });
});

describe('buildLocalAgentPromptChars', () => {
  const empty: AgentFormData = {
    id: 'demo', name: '', model: '', process_start_tag: '', process_end_tag: '',
    runtimeMode: 'configured', systemPromptMode: 'agent', toolMode: 'full', runtimeMetrics: null,
    soulContent: '', userContent: '', agentsContent: '', toolsContent: '', heartbeatContent: '', identityContent: '',
    fallbackMode: 'disabled', fallbacks: [],
  };

  it('is zero when every section is blank', () => {
    expect(buildLocalAgentPromptChars({ ...empty, soulContent: '   ' })).toBe(0);
  });

  it('counts the assembled prompt with header and trimmed sections', () => {
    const expected = [
      '# Agent demo',
      'Follow this agent-specific prompt. The sections below come from this agent workspace.',
      '## SOUL.md\n\nsoul',
    ].join('\n\n').length;
    expect(buildLocalAgentPromptChars({ ...empty, soulContent: ' soul ' })).toBe(expected);
  });
});
