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

/**
 * 主题种类：`session:<会话键>` / `room:<群>` / `agent:<Agent>`（P1a），`workflow:<工作流>`（工作流状态流），
 * `approvals:workflows`（工作流待审批集合变了的提醒，不带内容，客户端据此重新拉自己看得见的列表）。
 */
export const REALTIME_TOPIC_KINDS = ['session', 'room', 'agent', 'workflow', 'approvals'] as const;
export type RealtimeTopicKind = typeof REALTIME_TOPIC_KINDS[number];
export const REALTIME_TOPIC_PATTERN = /^(session|room|agent|workflow|approvals):[^\s]{1,256}$/;

export function isRealtimeTopic(topic: unknown): topic is string {
  return typeof topic === 'string' && REALTIME_TOPIC_PATTERN.test(topic);
}

export function parseRealtimeTopic(topic: string): { kind: RealtimeTopicKind; id: string } | null {
  if (!isRealtimeTopic(topic)) return null;
  const separator = topic.indexOf(':');
  return { kind: topic.slice(0, separator) as RealtimeTopicKind, id: topic.slice(separator + 1) };
}

export class RealtimeHub {
  private nextId = 1;
  private readonly listeners = new Map<string, RealtimeListener>();
  /** 每个主题的订阅计数（WebSocket 连接订阅时登记）。发布方据此跳过「没人要」的重负载计算。 */
  private readonly subscriptions = new Map<string, number>();
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

  /**
   * 登记一个主题订阅，返回退订函数（只生效一次）。计数归零即删键，不随主题数增长。
   * 只是计数：事件照常经 `publish` 发给监听者，谁收由监听者自己按主题过滤。
   */
  retainTopic(topic: string): () => void {
    this.subscriptions.set(topic, (this.subscriptions.get(topic) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.subscriptions.get(topic) ?? 1) - 1;
      if (next > 0) this.subscriptions.set(topic, next);
      else this.subscriptions.delete(topic);
    };
  }

  /** 主题当前有没有订阅者。没有时发布方可以只做廉价的状态记账、跳过负载计算。 */
  hasSubscribers(topic: string): boolean {
    return (this.subscriptions.get(topic) ?? 0) > 0;
  }

  listenerNames(): string[] {
    return [...this.listeners.keys()];
  }

  /** 最近分配出去的事件 id（没有事件时为 0）。 */
  lastEventId(): number {
    return this.nextId - 1;
  }
}
