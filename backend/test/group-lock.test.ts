/**
 * 群聊的运行锁（P3 起）。
 *
 * 执行顺序由编排器的每 Agent 队列保证；引擎里剩两件事：
 * - 每成员一把锁（兜底：绕开队列的路径、陈旧 worker 接管时同一个成员不会并发两轮）；
 * - 同群的网关成员串行（网关运行的跟踪状态 `activeRuns` / `pendingRuns` 按群键，并发会写坏对账状态）。
 * 原来的整轮群锁与「新消息准入」判据随 P3 删除：新消息永远受理并进队列，不再 409。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { GroupChatEngine } from '../src/collab/rooms/group-chat-engine';
import { RoomFence } from '../src/collab/rooms/room-fence';

/** 直接操作私有状态：这个类的构造要一整套依赖，测锁的行为不必把它们都搭起来。 */
function makeEngine(): any {
  const engine = Object.create(GroupChatEngine.prototype);
  engine.activeRuns = new Map();
  engine.pendingRuns = new Map();
  engine.gatewayTurnChains = new Map();
  Object.defineProperty(engine, 'fence', { value: new RoomFence() });
  return engine;
}

afterEach(() => vi.useRealTimers());

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

describe('同群网关成员串行、外部成员不排队', () => {
  const policy = { runIdleTimeoutSec: 600, runTotalBudgetSec: 3600 } as any;
  const input = (memberId: string, agentId: string, runtime = 'openclaw') => ({
    groupId: 'g1', member: { id: memberId, agent_id: agentId, display_name: agentId, runtime }, payload: {}, policy, onReplyCreated: () => {},
  }) as any;

  function gatewayEngine() {
    const e = memberEngine();
    e.db = { getLatestGroupMessageId: () => 1 };
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    e.runGatewayMemberWithScope = (turn: any) => new Promise((resolve) => {
      started.push(turn.input.member.id);
      releases.set(turn.input.member.id, () => resolve({ status: 'completed', messageId: 2, text: 'ok' }));
    });
    e.runExternalMember = async (turn: any) => { started.push(turn.input.member.id); return { status: 'completed', messageId: 3, text: 'ok' }; };
    return { e, started, releases };
  }

  it('第二个网关成员等第一个跑完才开跑', async () => {
    const { e, started, releases } = gatewayEngine();
    const first = e.executeTurn(input('m1', 'a'));
    const second = e.executeTurn(input('m2', 'b'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['m1']);
    releases.get('m1')!();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['m1', 'm2']);
    releases.get('m2')!();
    await second;
  });

  it('外部成员不等网关成员', async () => {
    const { e, started, releases } = gatewayEngine();
    const gateway = e.executeTurn(input('m1', 'a'));
    await e.executeTurn(input('m3', 'c', 'claude-code'));
    await new Promise((resolve) => setImmediate(resolve));
    expect([...started].sort()).toEqual(['m1', 'm3']);
    releases.get('m1')!();
    await gateway;
  });

  it('排队期间房间被清空：轮到时不开跑，回 reset', async () => {
    const { e, started, releases } = gatewayEngine();
    const first = e.executeTurn(input('m1', 'a'));
    const second = e.executeTurn(input('m2', 'b'));
    await new Promise((resolve) => setImmediate(resolve));
    e.markGroupReset('g1');
    releases.get('m1')!();
    await first;
    await expect(second).resolves.toMatchObject({ status: 'reset' });
    expect(started).toEqual(['m1']);
  });

  it('成员锁被占：回 busy 并落一条系统提示', async () => {
    const { e } = gatewayEngine();
    e.saveSystemNotice = vi.fn();
    e.acquireMemberLock('g1', 'a');
    await expect(e.executeTurn(input('m1', 'a'))).resolves.toMatchObject({ status: 'busy' });
    expect(e.saveSystemNotice).toHaveBeenCalled();
  });

  it('isMemberBusy 与 longestMemberRunMinutes 按群算', () => {
    const e = memberEngine();
    e.acquireMemberLock('g1', 'a');
    e.processingMembers.set(e.memberLockKey('g1', 'a'), Date.now() - 3 * 60 * 1000);
    expect(e.isMemberBusy('g1', 'a')).toBe(true);
    expect(e.isMemberBusy('g2', 'a')).toBe(false);
    expect(e.longestMemberRunMinutes('g1')).toBe(3);
    expect(e.longestMemberRunMinutes('g2')).toBeNull();
  });
});
