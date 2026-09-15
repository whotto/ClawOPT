import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { getAgentColor } from './agentColors';
import {
  createClientStructuredChatError,
  isPersistedMessageId,
  mapChatHistoryMessage,
  mapGroupMsg,
  mapHttpErrorResponse,
  mergeHistoryMessages,
  resolveGroupSendNotice,
  resolveSubmitError,
} from './messageMapping';
import { buildNavDotSummary, sanitizeNavSummaryText } from './navSummary';
import { isLikelyInactiveGroupMessageStale, resolveProcessTagPair } from './processTags';
import { isContainerNearBottom, resolveClosestNavDotId, sampleNavDots } from './scrollGeometry';
import type { NavDot } from './types';
import type { ChatMessage } from '../../../utils/message-merge';

const START = '[执行工作_Start]';
const END = '[执行工作_End]';

describe('processTags', () => {
  it('prefers a complete primary pair, then secondary, then defaults', () => {
    expect(resolveProcessTagPair(' <a> ', '<b>')).toEqual({ startTag: '<a>', endTag: '<b>' });
    expect(resolveProcessTagPair('<a>', '', '<c>', '<d>')).toEqual({ startTag: '<c>', endTag: '<d>' });
    expect(resolveProcessTagPair()).toEqual({ startTag: START, endTag: END });
  });

  it('flags group messages that look unfinished', () => {
    expect(isLikelyInactiveGroupMessageStale('   ')).toBe(true);
    expect(isLikelyInactiveGroupMessageStale('plain answer')).toBe(false);
    expect(isLikelyInactiveGroupMessageStale(`${START} still thinking`)).toBe(true);
    expect(isLikelyInactiveGroupMessageStale(`${START} steps ${END}`)).toBe(true);
    expect(isLikelyInactiveGroupMessageStale(`${START} steps ${END} final answer`)).toBe(false);
  });
});

describe('messageMapping', () => {
  it('recognizes persisted (numeric) message ids only', () => {
    expect(isPersistedMessageId('123')).toBe(true);
    expect(isPersistedMessageId(' 42 ')).toBe(true);
    expect(isPersistedMessageId('temp-asst-1')).toBe(false);
    expect(isPersistedMessageId(null)).toBe(false);
  });

  it('merges history pages older-first and drops duplicate ids', () => {
    const msg = (id: string): ChatMessage => ({ id, role: 'user', content: id, timestamp: new Date(0) });
    expect(mergeHistoryMessages([msg('1'), msg('2')], [msg('2'), msg('3')]).map((m) => m.id)).toEqual(['1', '2', '3']);
  });

  it('maps group rows to roles by sender', () => {
    expect(mapGroupMsg({ id: 1, sender_type: 'user', content: 'hi' }).role).toBe('user');
    expect(mapGroupMsg({ id: 2, sender_type: 'agent', sender_id: 'system' }).role).toBe('system');
    const assistant = mapGroupMsg({ id: 3, sender_type: 'agent', sender_id: 'a1', sender_name: 'A', parent_id: 2, process_streaming: 1 });
    expect(assistant).toMatchObject({ id: '3', role: 'assistant', agentId: 'a1', agentName: 'A', parentId: '2', processStreaming: true, content: '' });
  });

  it('maps single-chat history rows', () => {
    const mapped = mapChatHistoryMessage({ id: 7, role: 'assistant', content: 'x', model_used: 'm', process_content: 'p' });
    expect(mapped).toMatchObject({ id: '7', role: 'assistant', content: 'x', model: 'm', processContent: 'p', processStreaming: false });
    expect(mapChatHistoryMessage({ id: 8, role: 'system' }).role).toBe('system');
    expect(mapChatHistoryMessage({ id: 9, role: 'other' }).role).toBe('user');
  });

  it('turns HTTP error bodies into system messages and falls back on bad JSON', async () => {
    const withBody = await mapHttpErrorResponse(new Response(JSON.stringify({ error: 'boom', errorDetail: 'trace' })), 'fallback');
    expect(withBody).toMatchObject({ role: 'system', content: 'boom', rawDetail: 'trace' });
    const badJson = await mapHttpErrorResponse(new Response('not json'), 'fallback');
    expect(badJson).toEqual({ role: 'system', content: 'fallback' });
  });

  it('resolves submit errors: translated code, then error/message/detail, then fallback key', () => {
    const t = ((key: string) => (key === 'known.code' ? '已翻译' : key)) as unknown as TFunction;
    expect(resolveSubmitError({ errorCode: 'known.code', error: 'raw' }, t, 'fb')).toBe('已翻译');
    expect(resolveSubmitError({ errorCode: 'unknown.code', error: ' raw ' }, t, 'fb')).toBe('raw');
    expect(resolveSubmitError({ errorDetail: 'detail' }, t, 'fb')).toBe('detail');
    expect(resolveSubmitError({}, t, 'fb')).toBe('fb');
  });

  it('builds client-side structured errors with a default detail', () => {
    expect(createClientStructuredChatError('  ')).toEqual({
      role: 'system', content: '❌ Error: Unknown error', messageCode: 'chat.runError', rawDetail: 'Unknown error',
    });
  });
});

describe('navSummary', () => {
  it('splits primary / secondary lines', () => {
    expect(buildNavDotSummary('first  line\nsecond\nthird')).toEqual({
      primary: 'first line', secondary: 'second third', tooltipText: 'first line\nsecond third',
    });
    expect(buildNavDotSummary('same', 'same')).toEqual({ primary: 'same', secondary: undefined, tooltipText: 'same\nsame' });
  });

  it('strips upload links, markdown link syntax and process blocks', () => {
    expect(sanitizeNavSummaryText('see [doc](/uploads/a.pdf) ok')).toBe('see doc ok');
    expect(sanitizeNavSummaryText(`${START}hidden${END}\nvisible`)).toBe('visible');
  });
});

describe('scrollGeometry and agent colors', () => {
  const dot = (id: string, offsetTop: number): NavDot => ({ id, top: 0, offsetTop, summary: { primary: id, tooltipText: id } });

  it('samples nav dots evenly and keeps both ends', () => {
    const dots = ['a', 'b', 'c', 'd', 'e'].map((id, i) => dot(id, i * 100));
    expect(sampleNavDots(dots, 3).map((d) => d.id)).toEqual(['a', 'c', 'e']);
    expect(sampleNavDots(dots, 10)).toBe(dots);
    expect(sampleNavDots(dots, 1).map((d) => d.id)).toEqual(['a']);
  });

  it('picks the dot closest to one third of the viewport', () => {
    const container = { scrollTop: 100, clientHeight: 300 } as HTMLElement;
    expect(resolveClosestNavDotId([dot('a', 0), dot('b', 210), dot('c', 600)], container)).toBe('b');
    expect(resolveClosestNavDotId([], container)).toBeNull();
  });

  it('treats the container as near bottom within the threshold', () => {
    expect(isContainerNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 } as HTMLElement)).toBe(true);
    expect(isContainerNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 200 } as HTMLElement)).toBe(false);
  });

  it('colors agents by member position', () => {
    const members = [{ agent_id: 'x' }, { agent_id: 'y' }] as Parameters<typeof getAgentColor>[1];
    expect(getAgentColor('y', members)).toBe('bg-emerald-500');
    expect(getAgentColor('missing', members)).toBe('bg-blue-500');
  });
});

describe('resolveGroupSendNotice', () => {
  const t = ((key: string, params?: Record<string, unknown>) => `${key}|${params?.agents ?? ''}`) as unknown as TFunction;

  it('群里 @ 了没有叫起的成员：按界面语言拼名字', () => {
    const payload = { success: true, notice: { messageCode: 'groups.mentionNotPermitted', messageParams: { agents: '产品, 测试' }, agentNames: ['产品', '测试'] } };
    expect(resolveGroupSendNotice(payload, t, 'zh-CN')).toBe('groups.mentionNotPermitted|产品、测试');
    expect(resolveGroupSendNotice(payload, t, 'en')).toBe('groups.mentionNotPermitted|产品, 测试');
  });

  it('没有提示或载荷不对：空串', () => {
    expect(resolveGroupSendNotice({ success: true }, t, 'en')).toBe('');
    expect(resolveGroupSendNotice(null, t, 'en')).toBe('');
    expect(resolveGroupSendNotice({ notice: { agentNames: ['x'] } }, t, 'en')).toBe('');
  });
});
