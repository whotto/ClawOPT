/**
 * 群聊实时合并（P3 任务 12）：批处理、终帧前冲刷、非空优先、不复活、空泡清理。
 * 这些故障都不会报错——只会让用户看着内容闪回、删掉的消息又冒出来、或者留一串空气泡。
 */
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './message-merge';
import {
  applyFinalFrame, applyPatchBatch, isEmptyAssistantBubble, LiveDeltaBatcher, MessageTombstones,
  removeEmptyAssistantBubbles, ROOM_LIVE_DELTA_BATCH_MS,
} from './room-live-merge';

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: '1', role: 'assistant', content: '', timestamp: new Date('2026-09-01T00:00:00Z'), ...over,
});

function manualScheduler() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  return {
    queue,
    schedule: (fn: () => void, ms: number) => { queue.push({ fn, ms }); return queue.length as unknown as ReturnType<typeof setTimeout>; },
    cancel: () => {},
    run: () => { const items = queue.splice(0); items.forEach((item) => item.fn()); },
  };
}

describe('LiveDeltaBatcher · 50ms 批处理', () => {
  it('窗口里的多个增量合成一个补丁、只调度一次、正文只增不减', () => {
    const flushed: Array<Map<string, Partial<ChatMessage>>> = [];
    const clock = manualScheduler();
    const batcher = new LiveDeltaBatcher((batch) => flushed.push(batch), new MessageTombstones(), ROOM_LIVE_DELTA_BATCH_MS, clock.schedule, clock.cancel);
    batcher.push('7', { content: '第一' });
    batcher.push('7', { content: '第一段' });
    batcher.push('7', { content: '第一' }); // 迟到的短帧不回退
    batcher.push('8', { content: 'x' });
    expect(clock.queue).toHaveLength(1);
    expect(clock.queue[0].ms).toBe(50);
    expect(flushed).toHaveLength(0);
    clock.run();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].get('7')).toEqual({ content: '第一段' });
    expect(flushed[0].get('8')).toEqual({ content: 'x' });
    expect(batcher.size).toBe(0);
  });

  it('墓碑里的 id 不排队（删掉的消息不被增量复活）', () => {
    const tombstones = new MessageTombstones();
    tombstones.add(['9']);
    const clock = manualScheduler();
    const batcher = new LiveDeltaBatcher(() => {}, tombstones, 50, clock.schedule, clock.cancel);
    expect(batcher.push('9', { content: '迟到' })).toBe(false);
    expect(batcher.size).toBe(0);
    expect(clock.queue).toHaveLength(0);
  });
});

describe('applyFinalFrame · 终帧前先冲刷', () => {
  it('排队的增量先合进去，再合终帧：终帧比增量短（未带终态信号）时保留更长的正文', () => {
    const list = [msg({ id: '1', content: '开头' })];
    const next = applyFinalFrame(list, msg({ id: '1', content: '开头' }), { content: '开头，然后是后面一大段' });
    expect(next[0].content).toBe('开头，然后是后面一大段');
  });

  it('非空优先：终帧正文为空不抹掉已显示的正文', () => {
    const list = [msg({ id: '1', content: '已经显示的回答' })];
    expect(applyFinalFrame(list, msg({ id: '1', content: '' }), undefined)[0].content).toBe('已经显示的回答');
  });

  it('结构化提示终帧照常覆盖（状态通告不参与长短比较）', () => {
    const list = [msg({ id: '1', content: '很长的一段正文……' })];
    const next = applyFinalFrame(list, msg({ id: '1', role: 'system', content: '已停止', messageCode: 'groups.agentOffline' }), undefined);
    expect(next[0]).toMatchObject({ role: 'system', messageCode: 'groups.agentOffline' });
  });

  it('不复活：墓碑里的终帧不插回来；不在列表里的新终帧追加', () => {
    const tombstones = new MessageTombstones();
    tombstones.add(['2']);
    const list = [msg({ id: '1', content: 'a' })];
    expect(applyFinalFrame(list, msg({ id: '2', content: '被撤回的' }), undefined, tombstones)).toBe(list);
    expect(applyFinalFrame(list, msg({ id: '3', content: '新消息' }), undefined, tombstones).map((m) => m.id)).toEqual(['1', '3']);
  });
});

describe('空泡清理与批量补丁', () => {
  it('没有正文 / 过程 / 结构化提示、不在流式中的助手气泡算空泡；用户消息与仍在跑的不算', () => {
    expect(isEmptyAssistantBubble(msg({ content: '  ' }))).toBe(true);
    expect(isEmptyAssistantBubble(msg({ processContent: '调用工具' }))).toBe(false);
    expect(isEmptyAssistantBubble(msg({ processStreaming: true }))).toBe(false);
    expect(isEmptyAssistantBubble(msg({ role: 'user' }))).toBe(false);
    const list = [msg({ id: '1', content: 'ok' }), msg({ id: '2' }), msg({ id: '3' })];
    expect(removeEmptyAssistantBubbles(list, new Set(['3'])).map((m) => m.id)).toEqual(['1', '3']);
    const clean = [msg({ id: '1', content: 'ok' })];
    expect(removeEmptyAssistantBubbles(clean)).toBe(clean);
  });

  it('applyPatchBatch 只合已有的消息、跳过墓碑、没变化返回原数组', () => {
    const tombstones = new MessageTombstones();
    tombstones.add(['2']);
    const list = [msg({ id: '1', content: 'a' }), msg({ id: '2', content: 'b' })];
    const next = applyPatchBatch(list, new Map([['1', { content: 'ab' }], ['2', { content: 'bc' }], ['3', { content: 'zzz' }]]), tombstones);
    expect(next.map((m) => m.content)).toEqual(['ab', 'b']);
    expect(applyPatchBatch(list, new Map())).toBe(list);
  });

  it('墓碑有上限，按先进先出淘汰', () => {
    const tombstones = new MessageTombstones();
    tombstones.add(Array.from({ length: 2005 }, (_, i) => String(i)));
    expect(tombstones.has('0')).toBe(false);
    expect(tombstones.has('2004')).toBe(true);
  });
});
