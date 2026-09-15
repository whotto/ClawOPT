/**
 * 重放缓冲：运行中断线的客户端重新订阅时，把「接回所需的状态事件」补给它。
 *
 * - `append`：工具开始/结束这类有序事件，逐条保留；
 * - `replace`：同一个键只留最新一条（审批请求、累计文本快照、中止状态）——
 *   快照类事件保留历史只会让重连的客户端把文本从头「打」一遍；
 * - `skip`：纯增量、接回时由快照覆盖的事件，不进缓冲。
 *
 * 有上限：超过上限丢最旧的。一个跑了一小时、调了几千次工具的运行不能把内存吃穿。
 */
import type { RealtimeEvent } from '../../core/realtime';

export type ReplayPolicy =
  | { mode: 'append' }
  | { mode: 'replace'; key: string }
  | { mode: 'skip' };

export const DEFAULT_REPLAY_LIMIT = 200;

type Entry = { key: string | null; event: RealtimeEvent };

export class ReplayBuffer {
  private entries: Entry[] = [];
  private droppedCount = 0;

  constructor(private readonly limit = DEFAULT_REPLAY_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('replay buffer limit must be a positive integer');
  }

  push(event: RealtimeEvent, policy: ReplayPolicy): void {
    if (policy.mode === 'skip') return;
    if (policy.mode === 'replace') {
      this.entries = this.entries.filter((entry) => entry.key !== policy.key);
      this.entries.push({ key: policy.key, event });
    } else {
      this.entries.push({ key: null, event });
    }
    while (this.entries.length > this.limit) {
      this.entries.shift();
      this.droppedCount += 1;
    }
  }

  /** 按键移除（例如澄清已答复：重连时不该再弹一次）。 */
  remove(key: string): void {
    this.entries = this.entries.filter((entry) => entry.key !== key);
  }

  snapshot(): RealtimeEvent[] {
    return this.entries.map((entry) => entry.event);
  }

  clear(): void {
    this.entries = [];
    this.droppedCount = 0;
  }

  get size(): number {
    return this.entries.length;
  }

  /** 因超上限被丢掉的条数。重连方据此知道重放不完整、需要回历史对账。 */
  get dropped(): number {
    return this.droppedCount;
  }
}
