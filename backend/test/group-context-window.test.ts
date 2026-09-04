/**
 * 团队提示词的历史窗口与「最新任务」上限。
 *
 * 原先：固定取最近 15 条（每条 900 字摘要），触发消息既在历史里又原样作为
 * 「最新任务」重复一遍，且「最新任务」不设上限——上一位成员 2 万字的回复整段转交。
 */
import { describe, it, expect } from 'vitest';
import { selectGroupContextWindow, truncateGroupTriggerMessage } from '../src/group-chat-engine';

const row = (id: number, content: string, sender: 'user' | 'agent' = 'agent', name = 'A') => ({
  id, group_id: 'g', parent_id: id - 1, sender_type: sender, sender_id: sender === 'user' ? null : name,
  sender_name: sender === 'user' ? null : name, content, process_content: null, mentions: null,
  model_used: null, created_at: '', process_streaming: 0,
}) as any;

describe('selectGroupContextWindow', () => {
  it('最多 15 条，按新到旧挑', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, `m${i + 1}`));
    const picked = selectGroupContextWindow(rows);
    expect(picked).toHaveLength(15);
    expect(picked[0].id).toBe(26);
    expect(picked[14].id).toBe(40);
  });

  it('字符预算用完就停，但至少保一条', () => {
    // 每条按摘要上限（900 字）计价，不按原文长度：历史里放的就是摘要。
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, 'x'.repeat(5000)));
    const picked = selectGroupContextWindow(rows, { budgetChars: 1000 });
    expect(picked).toHaveLength(1);
    expect(picked[0].id).toBe(10);
  });

  it('触发消息已作为「最新任务」单独给出时，不再进历史', () => {
    const rows = [row(1, 'hi', 'user'), row(2, 'A 的长回复 @B'), row(3, '用户追问', 'user')];
    const picked = selectGroupContextWindow(rows, { triggerParentId: 3, triggerMsg: '用户追问' });
    expect(picked.map(r => r.id)).toEqual([1, 2]);
    const hop = selectGroupContextWindow(rows.slice(0, 2), { triggerParentId: 2, triggerMsg: 'A 的长回复 @B', triggerSenderName: 'A' });
    expect(hop.map(r => r.id)).toEqual([1]);
  });

  it('parentId 被重定位到别的消息时不误删', () => {
    const rows = [row(1, 'hi', 'user'), row(2, 'B 说的', 'agent', 'B')];
    const picked = selectGroupContextWindow(rows, { triggerParentId: 2, triggerMsg: '完全不同的内容', triggerSenderName: 'A' });
    expect(picked.map(r => r.id)).toEqual([1, 2]);
  });
});

describe('truncateGroupTriggerMessage', () => {
  it('短消息原样返回', () => {
    expect(truncateGroupTriggerMessage('short')).toBe('short');
  });
  it('超长消息保头保尾并注明省略', () => {
    const long = 'H'.repeat(4000) + 'M'.repeat(10000) + 'T'.repeat(1600);
    const out = truncateGroupTriggerMessage(long);
    expect(out.startsWith('H'.repeat(4000))).toBe(true);
    expect(out.endsWith('T'.repeat(1600))).toBe(true);
    expect(out).toContain('中间省略 10000 字');
    expect(out.length).toBeLessThan(long.length);
  });
});
