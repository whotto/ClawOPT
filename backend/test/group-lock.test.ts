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
