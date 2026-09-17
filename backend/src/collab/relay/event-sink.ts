/**
 * target 侧的事件 sink：把本机运行的规范事件按 relay 协议送回 host（spec 02 F19「Event sink — backpressure design」）。
 *
 * - 每跳一个序号计数器（从 1 起）；每个事件发出前递归脱敏（令牌、凭据）；
 * - **同一时刻只有一帧在途**：收到 host 的 res 才发下一帧；ack 30 秒没回 → 致命（本机运行中止、连接判为不可信）；
 * - 积压上限 2048 个事件 / 4 MB，超了 → 致命；
 * - 批量只在 host 声明了 `agent.events.v1` 时开：只有高频事件（文本 / 推理增量）最多延后 40 ms 攒批，其余立刻发；一帧 ≤64 个事件 / 16 KB；
 * - `drain()` 等积压全部确认（`run.completed` 之前必须调，保证 host 先落完所有事件再收终态）。
 */
import type { RelayChannel } from './channel';
import {
  RELAY_ACK_TIMEOUT_MS,
  RELAY_BATCH_DELAY_MS,
  RELAY_BATCH_MAX_BYTES,
  RELAY_HIGH_FREQUENCY_EVENTS,
  RELAY_MAX_EVENTS_PER_FRAME,
  RELAY_SINK_MAX_PENDING_BYTES,
  RELAY_SINK_MAX_PENDING_EVENTS,
  redactSecrets,
  type RelayEventType,
} from './protocol';

type Queued = { seq: number; type: RelayEventType; data: Record<string, unknown>; bytes: number };

export class RelayEventSink {
  private seq = 0;
  private readonly queue: Queued[] = [];
  private pendingBytes = 0;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fatal: Error | null = null;
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(
    private readonly channel: Pick<RelayChannel, 'request'>,
    private readonly runId: string,
    private readonly options: { batching: boolean; secrets: () => readonly string[]; onFatal: (error: Error) => void; ackTimeoutMs?: number },
  ) {}

  get failed(): Error | null {
    return this.fatal;
  }

  push(type: RelayEventType, data: Record<string, unknown>): void {
    if (this.fatal) return;
    const clean = redactSecrets(data, this.options.secrets());
    const bytes = Buffer.byteLength(JSON.stringify(clean));
    if (this.queue.length + 1 > RELAY_SINK_MAX_PENDING_EVENTS || this.pendingBytes + bytes > RELAY_SINK_MAX_PENDING_BYTES) {
      this.fail(new Error('relay event sink overflow'));
      return;
    }
    this.seq += 1;
    this.queue.push({ seq: this.seq, type, data: clean, bytes });
    this.pendingBytes += bytes;
    this.schedule(RELAY_HIGH_FREQUENCY_EVENTS.has(type));
  }

  private schedule(highFrequency: boolean): void {
    if (this.inFlight) return;
    if (this.options.batching && highFrequency && this.queue.every((item) => RELAY_HIGH_FREQUENCY_EVENTS.has(item.type))) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, RELAY_BATCH_DELAY_MS);
        this.timer.unref?.();
      }
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  private takeFrame(): Queued[] {
    if (!this.options.batching) return this.queue.splice(0, 1);
    const frame: Queued[] = [];
    let bytes = 0;
    while (this.queue.length > 0 && frame.length < RELAY_MAX_EVENTS_PER_FRAME) {
      const next = this.queue[0];
      if (frame.length > 0 && bytes + next.bytes > RELAY_BATCH_MAX_BYTES) break;
      frame.push(this.queue.shift()!);
      bytes += next.bytes;
    }
    return frame;
  }

  private flush(): void {
    if (this.inFlight || this.fatal || this.queue.length === 0) {
      if (!this.inFlight && this.queue.length === 0) this.settleWaiters();
      return;
    }
    const frame = this.takeFrame();
    this.inFlight = true;
    this.channel.request('agent.events', { runId: this.runId, events: frame.map(({ seq, type, data }) => ({ seq, type, data })) }, this.options.ackTimeoutMs ?? RELAY_ACK_TIMEOUT_MS)
      .then(() => {
        this.pendingBytes -= frame.reduce((sum, item) => sum + item.bytes, 0);
        this.inFlight = false;
        if (this.queue.length === 0) this.settleWaiters();
        else this.schedule(false);
      })
      .catch((error: Error) => {
        this.inFlight = false;
        this.fail(error);
      });
  }

  private settleWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private fail(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;
    if (this.timer) clearTimeout(this.timer);
    this.queue.splice(0);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.options.onFatal(error);
  }

  /** 等积压全部被 host 确认。 */
  drain(): Promise<void> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (!this.inFlight && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.flush();
    });
  }
}
