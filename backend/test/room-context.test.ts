/**
 * 群成员每次调用的上下文（P3，取代 v1 的 `selectGroupContextWindow` / `truncateGroupTriggerMessage`）。
 *
 * 守的是 spec 的缺口：转录按 token 截（单条超长消息不能撑爆上下文），清洗掉系统提示 / 失败提示 / 空占位 / 工具轨迹，
 * 触发消息之后、摘要锚点之前的都不进；「最新任务」保头保尾。
 */
import { describe, expect, it } from 'vitest';

import { contextBodyOf, estimateTokens, isCleanContextRow, selectTranscript } from '../src/collab/rooms/room-context';
import { handoffModeFor } from '../src/collab/rooms/room-collab';
import { truncateTriggerText, TRIGGER_MAX_CHARS } from '../src/collab/rooms/room-prompt';

const row = (id: number, content: string, over: Record<string, unknown> = {}) => ({
  id, parent_id: id - 1, sender_type: 'agent', sender_id: 'a', sender_name: 'A', content, process_content: null, message_kind: '', created_at: '', ...over,
}) as any;
const noNotice = () => false;

describe('转录清洗', () => {
  it('系统提示、空占位、失败提示、工作区 diff、序列化工具轨迹都不进', () => {
    expect(isCleanContextRow(row(1, 'hi', { sender_id: 'system' }), noNotice)).toBe(false);
    expect(isCleanContextRow(row(2, '   '), noNotice)).toBe(false);
    expect(isCleanContextRow(row(3, '❌ A 响应失败: x'), (content) => content.startsWith('❌'))).toBe(false);
    expect(isCleanContextRow(row(4, 'diff', { message_kind: 'workspace_diff' }), noNotice)).toBe(false);
    expect(isCleanContextRow(row(5, '{"type":"tool_call","name":"x"}'), noNotice)).toBe(false);
    expect(isCleanContextRow(row(6, '正常回复'), noNotice)).toBe(true);
    expect(isCleanContextRow(row(7, '人类说话', { sender_type: 'user', sender_id: null }), noNotice)).toBe(true);
  });
});

describe('按 token 截', () => {
  it('新 → 旧累加，超预算就停，省略的条数如实给出', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i + 1, `消息${i + 1} ${'字'.repeat(200)}`));
    const { lines, omitted } = selectTranscript(rows, { budgetTokens: 1000, processTags: null, isStructuredNotice: noNotice });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(50);
    expect(lines.at(-1)!.content).toContain('消息50');
    expect(omitted).toBe(50 - lines.length);
    const used = lines.reduce((sum, line) => sum + estimateTokens(line.content), 0);
    expect(used).toBeLessThanOrEqual(1000);
  });

  it('单条超长消息保头保尾截断，而不是整段塞进去（至少保留最新一条）', () => {
    const huge = `开头${'x'.repeat(100_000)}结尾`;
    const { lines } = selectTranscript([row(1, huge)], { budgetTokens: 50, perMessageChars: 2000, processTags: null, isStructuredNotice: noNotice });
    expect(lines).toHaveLength(1);
    expect(lines[0].content.length).toBeLessThan(2100);
    expect(lines[0].content.startsWith('开头')).toBe(true);
    expect(lines[0].content.endsWith('结尾')).toBe(true);
  });

  it('人类与 Agent 的署名分开（Member / Agent）', () => {
    const { lines } = selectTranscript([row(1, 'q', { sender_type: 'user', sender_id: null, sender_name: 'alice' }), row(2, 'a')], { processTags: null, isStructuredNotice: noNotice });
    expect(lines.map((line) => [line.speakerKind, line.name])).toEqual([['member', 'alice'], ['agent', 'A']]);
  });

  it('过程标签里的内容只留证据摘要', () => {
    const body = contextBodyOf({ content: '<p>正在打开文件\n闲聊一句\n已完成 /tmp/a.txt</p>结论', process_content: null }, { startTag: '<p>', endTag: '</p>' }, 2000);
    expect(body).toContain('结论');
    expect(body).toContain('[过程证据摘要]');
    expect(body).not.toContain('闲聊一句');
  });
});

describe('最新任务与交接模式', () => {
  it('超过 6000 字才截，保头保尾', () => {
    expect(truncateTriggerText('短')).toBe('短');
    const long = `头${'y'.repeat(TRIGGER_MAX_CHARS + 10)}尾`;
    const cut = truncateTriggerText(long);
    expect(cut.startsWith('头')).toBe(true);
    expect(cut.endsWith('尾')).toBe(true);
    expect(cut.length).toBeLessThan(long.length);
  });

  it('交接模式按服务端深度算：关闭 / 还有额度 / 用完 / 不限', () => {
    const policy = (handoff: Record<string, unknown>) => ({ handoff: { enabled: true, unlimited: false, maxDepth: 3, ...handoff } }) as any;
    expect(handoffModeFor(policy({ enabled: false }), 1)).toEqual({ mode: 'disabled', remainingHops: 0 });
    expect(handoffModeFor(policy({}), 1)).toEqual({ mode: 'available', remainingHops: 2 });
    expect(handoffModeFor(policy({}), 3)).toEqual({ mode: 'exhausted', remainingHops: 0 });
    expect(handoffModeFor(policy({ unlimited: true }), 99)).toEqual({ mode: 'available', remainingHops: 'unlimited' });
  });
});
