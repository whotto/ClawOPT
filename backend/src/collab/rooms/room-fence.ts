/**
 * 会话隔离与运行超时（spec 02 F16，外加 spec 缺口：本机运行没有总时限）。
 *
 * ## 隔离
 *
 * - 房间代数（generation）：清空、删除、换工作区、停止整个房间时推进。推进**之前**开跑的运行拿着旧代数，
 *   它之后的一切写入（消息行、帧、会话句柄）都被拒——即使中断已经返回，迟到的事件也写不进被清空的房间。
 * - 成员中断版本：中断单个成员时推进，只隔离那个成员当时在跑的那一轮。
 * - 令牌在运行开始时取（`token`），每次写入前比对（`isCurrent`）。
 *
 * 引擎原有的 reset epoch 就是房间代数（`markGroupReset`），这里把「成员中断版本」补上，并把判据收成一个函数。
 *
 * ## 超时
 *
 * 两道：**空闲**（没有任何事件的时长，事件到来就续期）与**总预算**（从开跑算，不续期）。
 * 参考实现远程 150 秒硬切且不随流式输出续期（长运行必超时），本机运行则完全没有上限。
 * 两个值都在房间设置里可调（`run_idle_timeout_sec` / `run_total_budget_sec`）。
 */

export type FenceToken = { generation: number; version: number };

export class RoomFence {
  private readonly generations = new Map<string, number>();
  private readonly versions = new Map<string, number>();

  private key(groupId: string, memberId: string): string {
    return `${groupId.length}:${groupId}:${memberId}`;
  }

  generation(groupId: string): number {
    return this.generations.get(groupId) ?? 0;
  }

  fenceRoom(groupId: string): number {
    const next = this.generation(groupId) + 1;
    this.generations.set(groupId, next);
    return next;
  }

  interruptMember(groupId: string, memberId: string): number {
    const key = this.key(groupId, memberId);
    const next = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, next);
    return next;
  }

  token(groupId: string, memberId: string): FenceToken {
    return { generation: this.generation(groupId), version: this.versions.get(this.key(groupId, memberId)) ?? 0 };
  }

  isCurrent(groupId: string, memberId: string, token: FenceToken): boolean {
    const current = this.token(groupId, memberId);
    return current.generation === token.generation && current.version === token.version;
  }

  forget(groupId: string): void {
    this.generations.delete(groupId);
    const prefix = `${groupId.length}:${groupId}:`;
    for (const key of [...this.versions.keys()]) if (key.startsWith(prefix)) this.versions.delete(key);
  }
}

export type WatchdogReason = 'idle_timeout' | 'hard_timeout';

/**
 * 运行看门狗：`touch()` 续期空闲计时；到点调 `onExpire(reason)` 一次。`stop()` 之后不再触发。
 */
export class RunWatchdog {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private fired: WatchdogReason | null = null;
  private stopped = false;

  constructor(
    private readonly idleMs: number,
    private readonly totalMs: number,
    private readonly onExpire: (reason: WatchdogReason) => void,
  ) {
    this.totalTimer = setTimeout(() => this.expire('hard_timeout'), totalMs);
    this.totalTimer.unref?.();
    this.touch();
  }

  touch(): void {
    if (this.stopped || this.fired) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.expire('idle_timeout'), this.idleMs);
    this.idleTimer.unref?.();
  }

  private expire(reason: WatchdogReason): void {
    if (this.stopped || this.fired) return;
    this.fired = reason;
    this.clear();
    this.onExpire(reason);
  }

  private clear(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.totalTimer) clearTimeout(this.totalTimer);
    this.idleTimer = null;
    this.totalTimer = null;
  }

  get reason(): WatchdogReason | null {
    return this.fired;
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }
}
