/**
 * 结构化 @ 与每 Agent 队列（P3 任务 1、2）。
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  deriveAgentMentions,
  findTextMentions,
  maskNonRoutingSegments,
  MentionValidationError,
  parseStructuredMentionsInput,
  resolveMentions,
  stripMentionsForRecipient,
} from '../src/collab/rooms/mentions';
import { createRoomQueueStore, hashQueueCapability, RoomExecutionQueue } from '../src/collab/rooms/room-queue';

const agents = [
  { participantId: 'gm1', displayName: 'Claude', kind: 'agent' as const },
  { participantId: 'gm2', displayName: 'Claude Code', kind: 'agent' as const },
  { participantId: 'gm3', displayName: '产品', kind: 'agent' as const },
];

describe('文本 @ 解析', () => {
  it('名字按最长优先占位：@Claude Code 只算 Claude Code', () => {
    const hits = findTextMentions('请 @Claude Code 看看', agents.map((a) => a.displayName));
    expect(hits.map((h) => h.name)).toEqual(['Claude Code']);
  });

  it('前面是字母数字下划线不算（邮箱）；紧挨中文可以；后面必须是边界', () => {
    expect(findTextMentions('mail a@Claude', ['Claude'])).toEqual([]);
    expect(findTextMentions('问@产品，好吗', ['产品']).map((h) => h.name)).toEqual(['产品']);
    expect(findTextMentions('@产品经理', ['产品'])).toEqual([]);
  });

  it('引用块与代码块里的 @ 不叫起（按原长度抹掉，偏移不变）', () => {
    const text = '<quoted_message sender="x">@产品 旧话</quoted_message>\n```\n@Claude\n```\n真 @Claude';
    expect(maskNonRoutingSegments(text)).toHaveLength(text.length);
    expect(findTextMentions(text, ['产品', 'Claude']).map((h) => h.name)).toEqual(['Claude']);
  });
});

describe('结构化 @ 校验', () => {
  it('人类不带 mentions：旧协议按文本路由；显式 [] = 谁也不叫', () => {
    expect(resolveMentions('@产品 看', undefined, agents, { kind: 'human' }).targets.map((t) => t.participantId)).toEqual(['gm3']);
    expect(resolveMentions('@产品 看', [], agents, { kind: 'human' }).targets).toEqual([]);
  });

  it('参与者 id 必须对得上看得见的 @当前名字', () => {
    expect(resolveMentions('@产品 看', [{ type: 'agent', participantId: 'gm3', displayName: '产品' }], agents, { kind: 'human' }).targets).toHaveLength(1);
    expect(() => resolveMentions('看一下', [{ type: 'agent', participantId: 'gm3', displayName: '产品' }], agents, { kind: 'human' })).toThrow(MentionValidationError);
    expect(() => resolveMentions('@产品 看', [{ type: 'agent', participantId: 'gm3', displayName: '旧名字' }], agents, { kind: 'human' })).toThrow(/does not match/);
    expect(() => resolveMentions('@产品 看', [{ type: 'agent', participantId: 'nope', displayName: '产品' }], agents, { kind: 'human' })).toThrow(/not in this room/);
    expect(() => resolveMentions('@产品 看', [{ type: 'agent', participantId: 'gm3', displayName: '产品' }, { type: 'agent', participantId: 'gm3', displayName: '产品' }], agents, { kind: 'human' })).toThrow(/duplicate/);
  });

  it('@all 必须独占且看得见', () => {
    expect(resolveMentions('@all 开会', [{ type: 'all', displayName: 'all' }], agents, { kind: 'human' }).all).toBe(true);
    expect(() => resolveMentions('开会', [{ type: 'all', displayName: 'all' }], agents, { kind: 'human' })).toThrow(/not visible/);
    expect(() => resolveMentions('@all @产品', [{ type: 'all', displayName: 'all' }, { type: 'agent', participantId: 'gm3', displayName: '产品' }], agents, { kind: 'human' })).toThrow(/only mention/);
  });

  it('Agent 发送：结构化集合必须恰好等于正文里看得见的；不带元数据却 @ 了人 → 拒收；不能 @ 自己', () => {
    const sender = { kind: 'agent' as const, participantId: 'gm1' };
    expect(() => resolveMentions('@产品 @Claude Code', [{ type: 'agent', participantId: 'gm3', displayName: '产品' }], agents, sender)).toThrow(/exactly/);
    expect(() => resolveMentions('@产品', undefined, agents, sender)).toThrow(/require structured/);
    expect(() => resolveMentions('@Claude', [{ type: 'agent', participantId: 'gm1', displayName: 'Claude' }], agents, sender)).toThrow(/itself/);
    expect(resolveMentions('@产品 帮忙', [{ type: 'agent', participantId: 'gm3', displayName: '产品' }], agents, sender).targets).toHaveLength(1);
  });

  it('本机 Agent 的回复由服务端构造出与正文恰好一致的集合（排除自己）', () => {
    const derived = deriveAgentMentions('@Claude Code 接着做 @Claude 我自己', agents, 'gm1');
    expect(derived).toEqual([{ type: 'agent', participantId: 'gm2', displayName: 'Claude Code' }]);
    expect(resolveMentions('@Claude Code 接着做 @Claude 我自己', derived, agents, { kind: 'agent', participantId: 'gm1' }).targets).toHaveLength(1);
  });

  it('请求体形状不对整条拒收', () => {
    expect(() => parseStructuredMentionsInput('x')).toThrow(MentionValidationError);
    expect(() => parseStructuredMentionsInput([{ type: 'bot' }])).toThrow(MentionValidationError);
    expect(() => parseStructuredMentionsInput(Array.from({ length: 65 }, () => ({ type: 'all', displayName: 'all' })))).toThrow(/too many/);
  });

  it('交给接收方时只去掉 @all 与接收方自己的 @', () => {
    expect(stripMentionsForRecipient('@产品 @Claude 一起看', '产品')).toBe('@Claude 一起看');
    expect(stripMentionsForRecipient('@all 开会', '产品')).toBe('开会');
  });
});

function queueDb() {
  const conn = new Database(':memory:');
  conn.exec(`CREATE TABLE group_chats (id TEXT PRIMARY KEY, name TEXT, max_chain_depth INTEGER DEFAULT 6, updated_at TEXT);
    CREATE TABLE group_members (id TEXT PRIMARY KEY, group_id TEXT, agent_id TEXT, display_name TEXT, role_description TEXT, position INTEGER, runtime TEXT, external_config TEXT);
    CREATE TABLE group_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, group_id TEXT, sender_type TEXT, sender_id TEXT, sender_name TEXT, content TEXT, process_content TEXT, mentions TEXT, model_used TEXT, created_at TEXT);`);
  return conn;
}

describe('持久化队列行', () => {
  it('可见位置按 Agent 分别计数；(消息, 目标) 幂等；CAS queued→running', () => {
    const store = createRoomQueueStore(queueDb());
    store.enqueueRows({ groupId: 'g', messageId: 1, targets: [{ memberId: 'a', name: 'A' }, { memberId: 'b', name: 'B' }], requester: { kind: 'user', userId: 1 }, text: 'x' });
    const again = store.enqueueRows({ groupId: 'g', messageId: 1, targets: [{ memberId: 'a', name: 'A' }], requester: { kind: 'user', userId: 1 }, text: 'x' });
    store.enqueueRows({ groupId: 'g', messageId: 2, targets: [{ memberId: 'a', name: 'A' }], requester: { kind: 'user', userId: 1 }, text: 'y' });
    expect(store.snapshot('g').map((i) => [i.memberId, i.position])).toEqual([['a', 1], ['b', 1], ['a', 2]]);
    const rowId = again.get('a')!;
    expect(store.markRunning(rowId)).toBe(true);
    expect(store.markRunning(rowId)).toBe(false);
    expect(store.snapshot('g').map((i) => i.messageId)).toEqual([1, 2]);
  });

  it('撤回：只有发送人、所有目标都还在排队才行；访客按能力令牌', () => {
    const conn = queueDb();
    const store = createRoomQueueStore(conn);
    const cap = 'a'.repeat(64);
    const deleted: number[] = [];
    let invalidated = 0;
    const base = { groupId: 'g', isHumanMessageOfRequester: () => true, deleteMessage: (id: number) => { deleted.push(id); return { deleted: true, parentId: null }; }, invalidateSummary: () => { invalidated += 1; } };
    const rows = store.enqueueRows({ groupId: 'g', messageId: 5, targets: [{ memberId: 'a', name: 'A' }, { memberId: 'b', name: 'B' }], requester: { kind: 'guest', guestId: 'g1' }, capability: cap, text: 'x' });
    expect(store.retract({ ...base, messageId: 5, requester: { kind: 'guest', guestId: 'g1' }, capability: 'b'.repeat(64) })).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(store.retract({ ...base, messageId: 5, requester: { kind: 'user', userId: 1 } })).toMatchObject({ ok: false, reason: 'forbidden' });
    store.markRunning(rows.get('b')!);
    expect(store.retract({ ...base, messageId: 5, requester: { kind: 'guest', guestId: 'g1' }, capability: cap })).toMatchObject({ ok: false, reason: 'notCancellable' });
    expect(deleted).toEqual([]);

    store.enqueueRows({ groupId: 'g', messageId: 6, targets: [{ memberId: 'a', name: 'A' }], requester: { kind: 'guest', guestId: 'g1' }, capability: cap, text: 'y' });
    expect(store.retract({ ...base, messageId: 6, requester: { kind: 'guest', guestId: 'g1' }, capability: cap })).toMatchObject({ ok: true });
    expect(deleted).toEqual([6]);
    expect(invalidated).toBe(1);
    expect(hashQueueCapability(cap)).toHaveLength(64);
    expect(conn.prepare('SELECT cancel_capability_hash FROM room_queue WHERE message_id = 6').get()).toEqual({ cancel_capability_hash: hashQueueCapability(cap) });
  });

  it('重启时残留的排队 / 运行中行一律作废', () => {
    const store = createRoomQueueStore(queueDb());
    store.enqueueRows({ groupId: 'g', messageId: 1, targets: [{ memberId: 'a', name: 'A' }], requester: { kind: 'user', userId: null }, text: 'x' });
    expect(store.recoverOnBoot()).toBe(1);
    expect(store.snapshot('g')).toEqual([]);
  });
});

describe('内存执行队列', () => {
  it('同一个 Agent 严格按序；不同 Agent 并行', async () => {
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const queue = new RoomExecutionQueue<string>(async (item) => {
      log.push(`start ${item.payload}`);
      await new Promise<void>((resolve) => gates.set(item.payload, resolve));
      log.push(`end ${item.payload}`);
    });
    const a1 = queue.enqueue({ groupId: 'g', memberId: 'a', rowId: null, payload: 'a1' });
    const a2 = queue.enqueue({ groupId: 'g', memberId: 'a', rowId: null, payload: 'a2' });
    queue.enqueue({ groupId: 'g', memberId: 'b', rowId: null, payload: 'b1' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toEqual(['start a1', 'start b1']);
    expect(queue.busyMembers('g').sort()).toEqual(['a', 'b']);
    gates.get('a1')!();
    await a1;
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toContain('start a2');
    gates.get('a2')!();
    gates.get('b1')!();
    await a2;
  });

  it('按行摘掉（撤回）与按成员丢弃，被丢的等待方拿到 dropped=true', async () => {
    const queue = new RoomExecutionQueue<string>(() => new Promise(() => {}));
    void queue.enqueue({ groupId: 'g', memberId: 'a', rowId: 'r0', payload: 'running' });
    const waiting = queue.enqueue({ groupId: 'g', memberId: 'a', rowId: 'r1', payload: 'queued' });
    const other = queue.enqueue({ groupId: 'g', memberId: 'a', rowId: 'r2', payload: 'queued2' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(queue.removeRow('r1')).toBe(true);
    await expect(waiting).resolves.toBe(true);
    expect(queue.drop('g', 'a').map((item) => item.rowId)).toEqual(['r2']);
    await expect(other).resolves.toBe(true);
    expect(queue.pendingCount('g', 'a')).toBe(1);
  });
});
