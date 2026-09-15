import { describe, expect, it } from 'vitest';
import { swapMessageIds } from './messageIds';

describe('swapMessageIds', () => {
  it('临时 id 换成库里的 id，助手行顺带改 parentId；其余消息与顺序不动', () => {
    const messages = [
      { id: '5', role: 'user' },
      { id: 'temp-user-1', role: 'user', parentId: '6' },
      { id: 'temp-asst-2', role: 'assistant', parentId: 'temp-user-1' },
    ];
    expect(swapMessageIds(messages, [{ from: 'temp-user-1', to: '7' }, { from: 'temp-asst-2', to: '8', parentId: '7' }])).toEqual([
      { id: '5', role: 'user' },
      { id: '7', role: 'user', parentId: '6' },
      { id: '8', role: 'assistant', parentId: '7' },
    ]);
  });

  it('没有匹配、from = to 时返回原数组（不触发重渲染）', () => {
    const messages = [{ id: '1' }];
    expect(swapMessageIds(messages, [{ from: 'x', to: '2' }])).toBe(messages);
    expect(swapMessageIds(messages, [{ from: '1', to: '1' }])).toBe(messages);
  });
});
