import { describe, expect, it } from 'vitest';
import { parseChatTurnEcho, planPeerTurnMessages } from './peerTurns';

const echo = (over: Record<string, unknown> = {}) => parseChatTurnEcho({
  client_turn_id: 'turn-a1b2c3',
  user_message_id: 11,
  assistant_message_id: 12,
  parent_id: 10,
  content: 'hello from tab B',
  agent_name: 'Main',
  queued: false,
  created_at: '2026-09-15T00:00:00.000Z',
  ...over,
})!;

describe('peerTurns', () => {
  it('另一个标签页发的一轮：补用户气泡与助手占位（父子关系、Agent 名）', () => {
    const planned = planPeerTurnMessages([{ id: '10' }], echo(), new Set());
    expect(planned?.map((m) => [m.id, m.role, m.content, m.parentId])).toEqual([
      ['11', 'user', 'hello from tab B', '10'],
      ['12', 'assistant', '', '11'],
    ]);
    expect(planned?.[1].agentName).toBe('Main');
  });

  it('本标签页立即发送的一轮不重复补（乐观气泡已在）；排队出队的照样补', () => {
    expect(planPeerTurnMessages([], echo(), new Set(['turn-a1b2c3']))).toBeNull();
    expect(planPeerTurnMessages([], echo({ client_turn_id: 'turn-queued-9', queued: true }), new Set(['turn-a1b2c3']))).toHaveLength(2);
  });

  it('两条都在时间线里（历史对账先到）：不补；只缺助手行：只补助手行', () => {
    expect(planPeerTurnMessages([{ id: '11' }, { id: '12' }], echo(), new Set())).toBeNull();
    expect(planPeerTurnMessages([{ id: '11' }], echo(), new Set())?.map((m) => m.id)).toEqual(['12']);
  });

  it('没有助手行 id 的负载不是合法回声', () => {
    expect(parseChatTurnEcho({ user_message_id: 1 })).toBeNull();
  });
});
