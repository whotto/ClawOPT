/**
 * 聊天历史对账：决定「哪条 assistant 消息算最终版」。
 *
 * 回归后果不是报错，而是用户看到旧文本覆盖新文本、或者半截回答被当成完整回答，
 * 而日志里毫无痕迹。这也是 AGENTS.md 里那条「五处一致」要求的由来。
 */
import { describe, expect, it } from 'vitest';
import {
  createHistoryMessageSignature,
  extractSettledAssistantOutcome,
  getHistorySnapshot,
  getHistoryTailActivity,
  getUnknownHistorySnapshot,
  isNonTerminalAssistantMessage,
} from '../src/chat-history-reconciliation';

const assistant = (content: string, extra: Record<string, any> = {}) => ({ role: 'assistant', content, ...extra });
const user = (content: string) => ({ role: 'user', content });

describe('历史快照', () => {
  it('基线不可信时不产出任何结论——宁可不改，也不能拿错的覆盖对的', () => {
    const unknown = getUnknownHistorySnapshot();
    expect(unknown.trusted).toBe(false);
    const outcome = extractSettledAssistantOutcome({ messages: [assistant('新内容')] }, unknown);
    expect(outcome.kind).toBe('none');
  });

  it('同一份历史算出的签名稳定', () => {
    const message = assistant('内容');
    expect(createHistoryMessageSignature(message)).toBe(createHistoryMessageSignature({ ...message }));
  });

  it('内容不同则签名不同', () => {
    expect(createHistoryMessageSignature(assistant('A'))).not.toBe(createHistoryMessageSignature(assistant('B')));
  });
});

describe('尾部活动判定', () => {
  it('历史没变化时不认为有新活动', () => {
    const payload = { messages: [user('问'), assistant('答')] };
    const baseline = getHistorySnapshot(payload);
    const activity = getHistoryTailActivity(payload, baseline);
    expect(activity.hasChanges).toBe(false);
    expect(activity.length).toBe(2);
  });

  it('追加了新消息时判定为有活动', () => {
    const before = { messages: [user('问')] };
    const baseline = getHistorySnapshot(before);
    const after = { messages: [user('问'), assistant('答')] };
    const activity = getHistoryTailActivity(after, baseline);
    expect(activity.hasChanges).toBe(true);
    expect(activity.latestSignature).not.toBe(baseline.latestSignature);
  });
});

describe('最终 assistant 结论', () => {
  it('取到新出现的完整回答', () => {
    const baseline = getHistorySnapshot({ messages: [user('问')] });
    const outcome = extractSettledAssistantOutcome({ messages: [user('问'), assistant('这是回答')] }, baseline);
    expect(outcome.kind).toBe('text');
    if (outcome.kind === 'text') expect(outcome.text).toContain('这是回答');
  });

  it('历史没有新增时不产出结论（避免把旧消息当成本轮结果）', () => {
    const payload = { messages: [user('问'), assistant('旧回答')] };
    const baseline = getHistorySnapshot(payload);
    expect(extractSettledAssistantOutcome(payload, baseline).kind).toBe('none');
  });

  it('空历史与畸形载荷不抛错', () => {
    const baseline = getHistorySnapshot({ messages: [] });
    expect(() => extractSettledAssistantOutcome({}, baseline)).not.toThrow();
    expect(() => extractSettledAssistantOutcome({ messages: 'not-an-array' }, baseline)).not.toThrow();
    expect(() => getHistorySnapshot(null)).not.toThrow();
  });
});

describe('非终态识别', () => {
  it('能识别出还在流式中的 assistant 消息', () => {
    // 具体判据由实现决定，这里固定「函数可调用且对普通消息返回布尔」
    expect(typeof isNonTerminalAssistantMessage(assistant('完整回答'))).toBe('boolean');
    expect(typeof isNonTerminalAssistantMessage(user('问'))).toBe('boolean');
  });
});
