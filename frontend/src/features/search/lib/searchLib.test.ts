import { describe, expect, it } from 'vitest';
import { createRequestSequence, highlightSegments, moveSelection, peekChatFocusRequest, requestChatFocus, settleChatFocusRequest, splitSearchTerms } from './searchLib';
import { isEditableTarget, matchGlobalShortcut, shortcutLabel } from './shortcuts';

const key = (over: Partial<Parameters<typeof matchGlobalShortcut>[0]>) => ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe('全局快捷键', () => {
  it('macOS 认 Cmd，其余平台认 Ctrl；macOS 上 Ctrl+K 不抢（文本框删到行尾）', () => {
    expect(matchGlobalShortcut(key({ metaKey: true }), { isMac: true, targetEditable: false, searchOpen: false })).toBe('openSearch');
    expect(matchGlobalShortcut(key({ ctrlKey: true }), { isMac: true, targetEditable: false, searchOpen: false })).toBeNull();
    expect(matchGlobalShortcut(key({ ctrlKey: true }), { isMac: false, targetEditable: true, searchOpen: false })).toBe('openSearch');
    expect(matchGlobalShortcut(key({ key: ',', ctrlKey: true }), { isMac: false, targetEditable: false, searchOpen: false })).toBe('openSettings');
  });

  it('Ctrl/Cmd+N 在输入框里不抢；输入法组合中一律不响应；Esc 只在面板打开时关闭', () => {
    expect(matchGlobalShortcut(key({ key: 'n', ctrlKey: true }), { isMac: false, targetEditable: true, searchOpen: false })).toBeNull();
    expect(matchGlobalShortcut(key({ key: 'n', ctrlKey: true }), { isMac: false, targetEditable: false, searchOpen: false })).toBe('newChat');
    expect(matchGlobalShortcut(key({ ctrlKey: true, isComposing: true }), { isMac: false, targetEditable: false, searchOpen: false })).toBeNull();
    expect(matchGlobalShortcut(key({ ctrlKey: true, keyCode: 229 }), { isMac: false, targetEditable: false, searchOpen: false })).toBeNull();
    expect(matchGlobalShortcut(key({ key: 'Escape' }), { isMac: false, targetEditable: false, searchOpen: false })).toBeNull();
    expect(matchGlobalShortcut(key({ key: 'Escape' }), { isMac: false, targetEditable: true, searchOpen: true })).toBe('closeSearch');
  });

  it('可编辑元素判定与提示文字', () => {
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as any)).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as any)).toBe(true);
    expect(isEditableTarget({ tagName: 'BUTTON' } as any)).toBe(false);
    expect(shortcutLabel('k', true)).toBe('⌘K');
    expect(shortcutLabel('k', false)).toBe('Ctrl+K');
  });
});

describe('搜索面板纯逻辑', () => {
  it('请求序号：旧请求回来时不再是当前的；关闭面板作废在途请求', () => {
    const sequence = createRequestSequence();
    const first = sequence.next();
    const second = sequence.next();
    expect(sequence.isCurrent(first)).toBe(false);
    expect(sequence.isCurrent(second)).toBe(true);
    sequence.invalidate();
    expect(sequence.isCurrent(second)).toBe(false);
  });

  it('高亮切段：大小写不敏感、长词优先；切词去重、丢纯标点、最多 20 个', () => {
    expect(highlightSegments('Deploy the deployment', ['deploy', 'deployment'])).toEqual([
      { text: 'Deploy', match: true }, { text: ' the ', match: false }, { text: 'deployment', match: true },
    ]);
    expect(splitSearchTerms('a A ... b')).toEqual(['a', 'b']);
    expect(splitSearchTerms(Array.from({ length: 30 }, (_, i) => `t${i}`).join(' '))).toHaveLength(20);
    expect(moveSelection(-1, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
  });

  it('跳转请求：只清同一个请求，不误清后来的新请求', () => {
    const first = { sessionId: 's1', messageId: '1', anchorBeforeId: null };
    requestChatFocus(first);
    const second = { sessionId: 's1', messageId: '2', anchorBeforeId: null };
    requestChatFocus(second);
    settleChatFocusRequest(first);
    expect(peekChatFocusRequest('s1')).toBe(second);
    expect(peekChatFocusRequest('s2')).toBeNull();
    settleChatFocusRequest(second);
    expect(peekChatFocusRequest('s1')).toBeNull();
  });
});
