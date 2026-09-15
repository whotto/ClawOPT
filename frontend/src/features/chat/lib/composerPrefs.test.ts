import { describe, expect, it } from 'vitest';
import {
  clampComposerHeight, COMPOSER_DRAFTS_KEY, isSilentFailure, readDraft, shouldSendOnEnter, writeDraft,
} from './composerPrefs';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

describe('草稿', () => {
  it('按会话存取；清空即删；坏数据按空', () => {
    const storage = memoryStorage();
    writeDraft(storage, 'chat:a', 'hello');
    writeDraft(storage, 'chat:b', 'world');
    expect(readDraft(storage, 'chat:a')).toBe('hello');
    writeDraft(storage, 'chat:a', '   ');
    expect(readDraft(storage, 'chat:a')).toBe('');
    writeDraft(storage, 'chat:b', '');
    expect(storage.map.has(COMPOSER_DRAFTS_KEY)).toBe(false);
    storage.setItem(COMPOSER_DRAFTS_KEY, '{bad');
    expect(readDraft(storage, 'chat:a')).toBe('');
  });

  it('最多留最近 50 个', () => {
    const storage = memoryStorage();
    for (let i = 0; i < 60; i += 1) writeDraft(storage, `k${i}`, 'x', i);
    expect(Object.keys(JSON.parse(storage.map.get(COMPOSER_DRAFTS_KEY)!))).toHaveLength(50);
    expect(readDraft(storage, 'k0')).toBe('');
    expect(readDraft(storage, 'k59')).toBe('x');
  });
});

describe('输入框', () => {
  it('输入法组合中的回车不发送；Shift+Enter 换行', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
  });

  it('拖拽高度夹在范围里', () => {
    expect(clampComposerHeight(10)).toBe(88);
    expect(clampComposerHeight(9999)).toBe(600);
    expect(clampComposerHeight('abc')).toBe(200);
  });

  it('静默失败：没有正文、过程与结构化结果，且不是被停下 / 被插入打断', () => {
    expect(isSilentFailure({ role: 'assistant', content: '' }, { stopped: false })).toBe(true);
    expect(isSilentFailure({ role: 'assistant', content: '', processContent: '调用工具…' }, { stopped: false })).toBe(false);
    expect(isSilentFailure({ role: 'assistant', content: '' }, { stopped: true })).toBe(false);
    expect(isSilentFailure({ role: 'assistant', content: '', interrupted: true }, { stopped: false })).toBe(false);
    expect(isSilentFailure({ role: 'system', content: '', messageCode: 'runtimeCommand.compactDone' }, { stopped: false })).toBe(false);
  });
});
