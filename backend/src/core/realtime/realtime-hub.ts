/**
 * 实时事件中枢：运行协调器、群聊引擎往里发，SSE 与 WebSocket 两条通道从这里取。
 *
 * ## 为什么不直接复用 core/events 的业务事件总线
 *
 * 业务总线的消费者是固定的几个下游（Webhook、通知），订阅关系启动时就定了；
 * 实时通道的订阅者是**浏览器连接**，随连随断，按主题（session:<id> / room:<id> / agent:<id>）过滤，
 * 而且每个事件要带全局递增的 id，客户端才能判断重放里哪些已经见过。
 *
 * ## 规则
 *
 * - 每个事件都带 `id`（进程内单调递增）与 `topic`；
 * - 监听者按名字登记，**故障隔离**：一个监听者抛错不影响后面的监听者，也不冒泡到发布方；
 * - 中枢不存历史。重放缓冲属于运行状态，由协调器按会话维护（runtime/coordinator/replay-buffer.ts）。
 */

export interface RealtimeEvent<TPayload = unknown> {
  id: number;
  topic: string;
  type: string;
  payload: TPayload;
  at: number;
  runId?: string;
  runMarker?: string;
  /** 发起这次运行的 WebSocket 连接 id。主题没有订阅者时用它兜底直发。 */
  origin?: string;
}

export type RealtimePublishInput<TPayload = unknown> = Omit<RealtimeEvent<TPayload>, 'id' | 'at'>;

export type RealtimeListener = (event: RealtimeEvent) => void;

export const REALTIME_TOPIC_PATTERN = /^(session|room|agent):[^\s]{1,256}$/;

export function isRealtimeTopic(topic: unknown): topic is string {
  return typeof topic === 'string' && REALTIME_TOPIC_PATTERN.test(topic);
}

export function parseRealtimeTopic(topic: string): { kind: 'session' | 'room' | 'agent'; id: string } | null {
  if (!isRealtimeTopic(topic)) return null;
  const separator = topic.indexOf(':');
  return { kind: topic.slice(0, separator) as 'session' | 'room' | 'agent', id: topic.slice(separator + 1) };
}

export class RealtimeHub {
  private nextId = 1;
  private readonly listeners = new Map<string, RealtimeListener>();
  private readonly onListenerError: (name: string, event: RealtimeEvent, error: unknown) => void;

  constructor(options: { onListenerError?: (name: string, event: RealtimeEvent, error: unknown) => void } = {}) {
    this.onListenerError = options.onListenerError ?? ((name, event, error) => {
      const kind = (error as Error)?.name || typeof error;
      console.error(`[Realtime] listener "${name}" failed on ${event.type} (${event.topic}): ${kind}`);
    });
  }

  publish<TPayload>(input: RealtimePublishInput<TPayload>): RealtimeEvent<TPayload> {
    const event: RealtimeEvent<TPayload> = { ...input, id: this.nextId++, at: Date.now() };
    for (const [name, listener] of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.onListenerError(name, event, error);
        } catch {
          // 上报器自己坏了也不能影响下一个监听者。
        }
      }
    }
    return event;
  }

  listen(name: string, listener: RealtimeListener): () => void {
    if (this.listeners.has(name)) throw new Error(`realtime listener "${name}" is already registered`);
    this.listeners.set(name, listener);
    return () => {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    };
  }

  listenerNames(): string[] {
    return [...this.listeners.keys()];
  }

  /** 最近分配出去的事件 id（没有事件时为 0）。 */
  lastEventId(): number {
    return this.nextId - 1;
  }
}
