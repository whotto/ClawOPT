import { describe, expect, it } from 'vitest';
import {
  applyChatLiveEvent,
  applyChatRunSnapshot,
  canInsertQueuedItem,
  createChatRunState,
  createClientTurnId,
  isQueueInsertionInterruption,
} from './chatRunState';

const snapshot = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  cursor: 10,
  activeRun: { runId: 'r1', startedAt: 1000, messageId: 5, userMessageId: 4, aborting: false },
  queue: [{ queueId: 'q1', position: 1, display: 'later', enqueuedAt: 1, ref: 'turn-1' }],
  insertion: null,
  ...over,
});

describe('chatRunState', () => {
  it('快照：代次不符或会话不符丢弃；否则整份替换', () => {
    const state = createChatRunState('s1', 2);
    expect(applyChatRunSnapshot(state, 1, snapshot())).toBe(state);
    expect(applyChatRunSnapshot(state, 2, snapshot({ sessionId: 's2' }))).toBe(state);
    const next = applyChatRunSnapshot(state, 2, snapshot());
    expect(next).toMatchObject({ loaded: true, cursor: 10, activeRun: { runId: 'r1', startedAt: 1000, messageId: 5 }, queue: [{ queueId: 'q1', ref: 'turn-1' }] });
  });

  it('事件游标：不大于快照游标的事件已反映在快照里，不重复应用（否则已出队项会回到队列）', () => {
    const loaded = applyChatRunSnapshot(createChatRunState('s1', 1), 1, snapshot({ queue: [] }));
    const stale = applyChatLiveEvent(loaded, 1, { id: 9, event: 'run.queued', payload: { queued: [{ queueId: 'q1', position: 1 }] } });
    expect(stale.queue).toEqual([]);
    const fresh = applyChatLiveEvent(loaded, 1, { id: 11, event: 'run.queued', payload: { queued: [{ queueId: 'q2', position: 1 }] } });
    expect(fresh.queue.map((q) => q.queueId)).toEqual(['q2']);
    expect(fresh.cursor).toBe(11);
  });

  it('旧代次的事件丢弃（切换会话后晚到的事件）', () => {
    const state = createChatRunState('s1', 3);
    expect(applyChatLiveEvent(state, 2, { id: 50, event: 'run.started', payload: { run_id: 'x' } })).toBe(state);
  });

  it('运行开始 / 终态：只清同一个运行；插入状态以服务端为准，清除事件清掉它', () => {
    let state = applyChatRunSnapshot(createChatRunState('s1', 1), 1, snapshot({ cursor: 0, activeRun: null }));
    state = applyChatLiveEvent(state, 1, { id: 1, event: 'run.started', payload: { run_id: 'r2', ref: 'turn-9', meta: { messageId: 8, userMessageId: 7 } } });
    expect(state.activeRun).toMatchObject({ runId: 'r2', ref: 'turn-9', messageId: 8 });
    expect(canInsertQueuedItem(state)).toBe(true);
    state = applyChatLiveEvent(state, 1, { id: 2, event: 'queue.insertion.updated', payload: { generation: 'g', queue_id: 'q1', phase: 'stopping_current_turn', guarantee: 'immediate' } });
    expect(state.insertion).toMatchObject({ queueId: 'q1', phase: 'stopping_current_turn' });
    expect(canInsertQueuedItem(state)).toBe(false);
    state = applyChatLiveEvent(state, 1, { id: 3, event: 'run.aborted', payload: { run_id: 'other' } });
    expect(state.activeRun?.runId).toBe('r2');
    state = applyChatLiveEvent(state, 1, { id: 4, event: 'run.aborted', payload: { run_id: 'r2', stop_reason: 'queue_insertion' } });
    expect(state.activeRun).toBeNull();
    state = applyChatLiveEvent(state, 1, { id: 5, event: 'queue.insertion.updated', payload: { cleared: true, reason: 'started' } });
    expect(state.insertion).toBeNull();
  });

  it('被立即插入让出不是失败；clientTurnId 满足后端格式', () => {
    expect(isQueueInsertionInterruption({ stop_reason: 'queue_insertion' })).toBe(true);
    expect(isQueueInsertionInterruption({ stop_reason: 'user_stop' })).toBe(false);
    expect(createClientTurnId()).toMatch(/^[A-Za-z0-9_-]{6,80}$/);
  });
});
