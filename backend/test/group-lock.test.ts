/**
 * 群聊运行锁的陈旧判定。
 *
 * 背景：锁本身在 finally 里释放，不会因抛错泄漏；真正会卡死的是派发链路
 * 一直 await 不返回（文档工具首次 bootstrap 最长 20 分钟）。此时 finally 没执行，
 * 群就永久 409，用户只能 /stop。这里守的是「卡太久要能被接管」这条性质。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { GroupChatEngine } from '../src/group-chat-engine';

/** 直接操作私有状态：这个类的构造要一整套依赖，测锁的行为不必把它们都搭起来。 */
function makeEngine(): any {
  const engine = Object.create(GroupChatEngine.prototype);
  engine.processingGroups = new Set<string>();
  engine.processingSince = new Map<string, number>();
  engine.activeRuns = new Map();
  engine.pendingRuns = new Map();
  return engine;
}

afterEach(() => vi.useRealTimers());

describe('陈旧锁判定', () => {
  it('刚开始跑的不算陈旧——正常并发仍要挡住', () => {
    const engine = makeEngine();
    engine.processingGroups.add('g1');
    engine.processingSince.set('g1', Date.now());
    expect(engine.isGroupLockStale('g1')).toBe(false);
  });

  it('没有持锁记录时不算陈旧', () => {
    expect(makeEngine().isGroupLockStale('g1')).toBe(false);
  });

  it('超过 15 分钟判为陈旧，允许新一轮接管', () => {
    const engine = makeEngine();
    engine.processingGroups.add('g1');
    engine.processingSince.set('g1', Date.now() - 16 * 60 * 1000);
    expect(engine.isGroupLockStale('g1')).toBe(true);
  });

  it('14 分钟还不算——阈值不能松到把正常长任务也踢掉', () => {
    const engine = makeEngine();
    engine.processingSince.set('g1', Date.now() - 14 * 60 * 1000);
    expect(engine.isGroupLockStale('g1')).toBe(false);
  });

  it('报告的持锁分钟数用于给用户一个能判断的数字', () => {
    const engine = makeEngine();
    engine.processingSince.set('g1', Date.now() - 3 * 60 * 1000 - 5000);
    expect(engine.groupLockAgeMinutes('g1')).toBe(3);
    expect(engine.groupLockAgeMinutes('未知群')).toBeNull();
  });

  it('不同群互不影响', () => {
    const engine = makeEngine();
    engine.processingSince.set('stuck', Date.now() - 20 * 60 * 1000);
    engine.processingSince.set('fresh', Date.now());
    expect(engine.isGroupLockStale('stuck')).toBe(true);
    expect(engine.isGroupLockStale('fresh')).toBe(false);
  });
});

/**
 * 每成员一把锁 —— v1.8.0。
 *
 * ## 为什么 per-group 是死路
 *
 * 原来整轮派发都握着群锁：一个 Claude Code 跑 10 分钟，整个群 10 分钟不能说话。
 * 外部 Agent 的典型时长是分钟级（深度重构、长调研），而「多 Agent 协作」这个
 * 命题的前提就是别人还能说话。所以 per-member 是**结论**，不是选项。
 *
 * ## 群锁为什么能放掉
 *
 * `sendUserMessage` 里「算 parent → 落库 → 广播」那一段全是同步调用，
 * Node 单线程下本来就原子，不需要锁来保护。群锁真正挡住的是整轮派发——
 * 而那正是不该挡的东西。
 *
 * 重新生成仍然走群锁：v1.5.2 明确要求过（`AGENTS.md`「重新生成走群锁」），
 * 它要重写已有消息的分支，和新消息不是一回事。
 */
function memberEngine(): any {
  const engine = makeEngine();
  engine.processingMembers = new Map<string, number>();
  return engine;
}

describe('成员锁', () => {
  it('同一群里的同一个成员不能同时跑两轮', () => {
    const e = memberEngine();
    expect(e.acquireMemberLock('g1', 'a1')).toBe(true);
    expect(e.acquireMemberLock('g1', 'a1')).toBe(false);
  });

  it('**同一群里的不同成员互不阻塞**——这条就是整个改动的目的', () => {
    const e = memberEngine();
    expect(e.acquireMemberLock('g1', 'a1')).toBe(true);
    expect(e.acquireMemberLock('g1', 'a2'), '一个成员在跑，别人就说不了话').toBe(true);
  });

  it('同一个成员在不同群里互不阻塞', () => {
    const e = memberEngine();
    expect(e.acquireMemberLock('g1', 'a1')).toBe(true);
    expect(e.acquireMemberLock('g2', 'a1')).toBe(true);
  });

  it('释放之后可以再拿', () => {
    const e = memberEngine();
    e.acquireMemberLock('g1', 'a1');
    e.releaseMemberLock('g1', 'a1');
    expect(e.acquireMemberLock('g1', 'a1')).toBe(true);
  });

  it('超过 15 分钟判为陈旧，允许接管——外部进程跑飞时不能让成员永远锁死', () => {
    const e = memberEngine();
    e.processingMembers.set(e.memberLockKey('g1', 'a1'), Date.now() - 16 * 60 * 1000);
    expect(e.acquireMemberLock('g1', 'a1')).toBe(true);
  });

  it('14 分钟还不算陈旧——阈值不能松到把正常长任务踢掉', () => {
    const e = memberEngine();
    e.processingMembers.set(e.memberLockKey('g1', 'a1'), Date.now() - 14 * 60 * 1000);
    expect(e.acquireMemberLock('g1', 'a1')).toBe(false);
  });

  it('hasBusyMember 按群统计，不串群', () => {
    const e = memberEngine();
    e.acquireMemberLock('g1', 'a1');
    expect(e.hasBusyMember('g1')).toBe(true);
    expect(e.hasBusyMember('g2')).toBe(false);
  });

  it('成员 id 里带分隔符也不会串到别的键上', () => {
    // 键是 `${groupId}::${agentId}` 拼出来的，两个成员恰好拼出同一个键就会互相顶掉。
    const e = memberEngine();
    expect(e.acquireMemberLock('g1::a', 'b')).toBe(true);
    expect(e.acquireMemberLock('g1', 'a::b'), '两个不同成员被拼成了同一把锁').toBe(true);
  });
});

describe('持锁快照（诊断用）', () => {
  it('**键能原样切回 (groupId, agentId)**，含分隔符与中文都不出错', () => {
    // 键是 `${groupId.length}:${groupId}:${agentId}`。切回去时靠长度前缀定位，
    // 不能用 split(':')——那会在 groupId 自己含冒号时切错。
    const e = memberEngine();
    const pairs: Array<[string, string]> = [
      ['g1', 'a1'],
      ['g1::a', 'b'],        // 与下一行在朴素拼接下会撞成同一把锁
      ['g1', 'a::b'],
      ['含中文的群', '成员'],
    ];
    for (const [g, a] of pairs) e.acquireMemberLock(g, a);

    const snap = e.heldMemberLockSnapshot();
    expect(snap).toHaveLength(pairs.length);
    expect(snap.map((s: any) => [s.groupId, s.agentId])).toEqual(pairs);
  });

  it('给出持锁时长，诊断靠它判断是不是泄漏', () => {
    const e = memberEngine();
    e.processingMembers.set(e.memberLockKey('g1', 'a1'), Date.now() - 20 * 60 * 1000);
    const [entry] = e.heldMemberLockSnapshot();
    expect(entry.heldMs).toBeGreaterThan(19 * 60 * 1000);
  });

  it('没有持锁时返回空数组', () => {
    expect(memberEngine().heldMemberLockSnapshot()).toEqual([]);
  });
});

