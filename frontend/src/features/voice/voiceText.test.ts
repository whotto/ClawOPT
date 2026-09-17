import { describe, expect, it } from 'vitest';
import { appendTranscript, pickRepliesToRead, recorderReducer, toSpeakableText, type RecorderState } from './voiceText';

describe('toSpeakableText', () => {
  it('去掉代码块、图片、过程块与 HTML；链接留文字；标记去掉', () => {
    const md = [
      '# 标题',
      '这是 **重点** 与 `inline` 和 [链接](https://example.com)。',
      '```ts',
      'const secret = 1;',
      '```',
      '![图](a.png)',
      '[执行工作_Start]内部步骤[执行工作_End]',
      '- 列表项',
      '> 引用 <b>粗</b>',
    ].join('\n');
    const spoken = toSpeakableText(md);
    expect(spoken).toBe('标题 这是 重点 与 inline 和 链接。 列表项 引用 粗');
    expect(spoken).not.toContain('const');
    expect(spoken).not.toContain('内部步骤');
  });

  it('没闭合的代码块（流式截断）也不念；超长在句末截断', () => {
    expect(toSpeakableText('前面\n```\ncode without end')).toBe('前面');
    const long = `${'这是一句话。'.repeat(400)}`;
    const spoken = toSpeakableText(long, 100);
    expect(spoken.length).toBeLessThanOrEqual(100);
    expect(spoken.endsWith('。')).toBe(true);
  });
});

describe('pickRepliesToRead', () => {
  const since = 1_000;
  it('跑着的时候不挑也不标记；结束后只读新出现的助手回复一次', () => {
    const seen = new Set<string>();
    const messages = [{ id: 'u1', role: 'user', content: 'hi', timestamp: 2000 }, { id: 'a1', role: 'assistant', content: 'hello', timestamp: 2001 }];
    expect(pickRepliesToRead({ messages, seen, busy: true, since })).toEqual([]);
    expect(seen.size).toBe(0);
    expect(pickRepliesToRead({ messages, seen, busy: false, since }).map((m) => m.id)).toEqual(['a1']);
    expect(pickRepliesToRead({ messages, seen, busy: false, since })).toEqual([]);
  });

  it('打开对话前的历史、往上翻页加载的旧消息、流式中的、空的都不读', () => {
    const seen = new Set<string>();
    const old = { id: 'old', role: 'assistant', content: 'history', timestamp: 500 };
    const streaming = { id: 's', role: 'assistant', content: 'partial', processStreaming: true, timestamp: 3000 };
    expect(pickRepliesToRead({ messages: [old, streaming, { id: 'e', role: 'assistant', content: '  ', timestamp: 3001 }], seen, busy: false, since })).toEqual([]);
    // 往上翻页：旧消息插在已见过的消息前面（时间也可能晚于打开时刻，比如多端同时在聊），不能被当成新回复。
    const paged = Array.from({ length: 2 }, (_, i) => ({ id: `p${i}`, role: 'assistant', content: 'older page', timestamp: 5000 }));
    expect(pickRepliesToRead({ messages: [...paged, old, streaming], seen, busy: false, since })).toEqual([]);
    const latest = { id: 'new', role: 'assistant', content: 'fresh', timestamp: 6000 };
    expect(pickRepliesToRead({ messages: [...paged, old, streaming, latest], seen, busy: false, since }).map((m) => m.id)).toEqual(['new']);
  });

  it('流式中的回复不被标记成见过：结束后照样念一次', () => {
    const seen = new Set<string>();
    const user = { id: 'u', role: 'user', content: 'q', timestamp: 2000 };
    const reply = { id: 'r', role: 'assistant', content: 'partial', processStreaming: true, timestamp: 2001 };
    expect(pickRepliesToRead({ messages: [user, reply], seen, busy: false, since })).toEqual([]);
    expect(pickRepliesToRead({ messages: [user, { ...reply, content: 'done', processStreaming: false }], seen, busy: false, since }).map((m) => m.id)).toEqual(['r']);
  });
});

describe('appendTranscript', () => {
  it('追加不覆盖，补分隔空格；空识别结果不动输入', () => {
    expect(appendTranscript('', ' 你好 ')).toBe('你好');
    expect(appendTranscript('已有', '追加')).toBe('已有 追加');
    expect(appendTranscript('已有 ', '追加')).toBe('已有 追加');
    expect(appendTranscript('已有', '  ')).toBe('已有');
  });
});

describe('recorderReducer（半双工按住说话）', () => {
  const run = (events: Parameters<typeof recorderReducer>[1][]) => events.reduce<RecorderState>(recorderReducer, { phase: 'idle' });
  it('按下 → 授权 → 松手 → 转写 → 回到空闲', () => {
    expect(run([{ type: 'press' }, { type: 'granted', at: 1 }, { type: 'release' }]).phase).toBe('transcribing');
    expect(run([{ type: 'press' }, { type: 'granted', at: 1 }, { type: 'release' }, { type: 'transcribed' }]).phase).toBe('idle');
  });
  it('授权前松手直接取消；转写中再按无效；失败后可以重来', () => {
    expect(run([{ type: 'press' }, { type: 'release' }, { type: 'granted', at: 2 }]).phase).toBe('idle');
    expect(run([{ type: 'press' }, { type: 'granted', at: 1 }, { type: 'release' }, { type: 'press' }]).phase).toBe('transcribing');
    expect(run([{ type: 'press' }, { type: 'fail', code: 'voice.micDenied' }, { type: 'press' }]).phase).toBe('requesting');
  });
});
