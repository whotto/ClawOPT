/**
 * 进程内业务事件总线。
 *
 * 出站 Webhook、工作流触发、通知这类「某件事发生了，好几个下游各自关心」的场景，
 * 不该让发布方逐个去调下游——下游一多，发布方就被最慢、最容易崩的那个拖垮。
 *
 * ## 三条规则
 *
 * 1. **消费者有名字，且名字唯一**。出问题时日志能指到具体是谁；重复订阅直接抛，
 *    不留两个同名消费者各收一份的隐患。
 * 2. **每个消费者故障隔离**。同步抛错、异步 reject 都在它自己那一格里被接住并上报，
 *    不影响排在它后面的消费者，也不会冒泡到发布方。
 * 3. **投递前重新鉴权**。`authorize` 在每一次投递时调用，而不是订阅时判一次——
 *    订阅之后权限可能被收回（用户被移出群、令牌被吊销）。
 *
 * `publish()` 同步返回**接收数**：类型匹配且通过鉴权、事件已交到手里的消费者个数。
 * 交到手里之后处理成败不改变这个数，失败走 `onConsumerError`。
 */
export type BusEvent<T = unknown> = {
  type: string;
  payload: T;
  publishedAt: number;
};

export type ConsumerHandler = (event: BusEvent) => void | Promise<void>;

export type ConsumerOptions = {
  /** 关心的事件类型；省略或 `'*'` 表示全部。 */
  types?: string[] | '*';
  /** 每次投递前调用；返回 false 则这次不投递、不计数。 */
  authorize?: (event: BusEvent) => boolean;
};

export type ConsumerFailure = {
  consumer: string;
  eventType: string;
  stage: 'authorize' | 'handle';
  error: unknown;
};

export class EventBusError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'EventBusError';
    this.errorCode = errorCode;
  }
}

type Consumer = {
  name: string;
  handler: ConsumerHandler;
  types: Set<string> | '*';
  authorize?: (event: BusEvent) => boolean;
};

/** 默认上报只打消费者名、事件类型与错误码/错误类型，不打原始错误文本（可能带着负载内容）。 */
function defaultOnConsumerError(failure: ConsumerFailure): void {
  const code = (failure.error as { errorCode?: unknown })?.errorCode;
  const kind = typeof code === 'string' ? code : (failure.error as Error)?.name || typeof failure.error;
  console.error(`[EventBus] consumer "${failure.consumer}" failed at ${failure.stage} for "${failure.eventType}": ${kind}`);
}

export class EventBus {
  private readonly consumersByName = new Map<string, Consumer>();
  private readonly onConsumerError: (failure: ConsumerFailure) => void;

  constructor(options: { onConsumerError?: (failure: ConsumerFailure) => void } = {}) {
    this.onConsumerError = options.onConsumerError ?? defaultOnConsumerError;
  }

  subscribe(name: string, handler: ConsumerHandler, options: ConsumerOptions = {}): () => void {
    if (!name.trim()) throw new EventBusError('events.consumerNameRequired', 'Consumer name is required');
    if (this.consumersByName.has(name)) {
      throw new EventBusError('events.duplicateConsumer', `Consumer "${name}" is already subscribed`);
    }
    const consumer: Consumer = {
      name,
      handler,
      types: !options.types || options.types === '*' ? '*' : new Set(options.types),
      authorize: options.authorize,
    };
    this.consumersByName.set(name, consumer);
    return () => {
      if (this.consumersByName.get(name) === consumer) this.consumersByName.delete(name);
    };
  }

  publish<T>(type: string, payload: T): number {
    const event: BusEvent<T> = { type, payload, publishedAt: Date.now() };
    let accepted = 0;
    // 快照：投递途中有消费者退订或新订阅，不影响这一次的名单。
    for (const consumer of [...this.consumersByName.values()]) {
      if (consumer.types !== '*' && !consumer.types.has(type)) continue;
      if (consumer.authorize) {
        let allowed = false;
        try {
          allowed = consumer.authorize(event) === true;
        } catch (error) {
          this.report(consumer, event, 'authorize', error);
          continue;
        }
        if (!allowed) continue;
      }
      accepted += 1;
      try {
        const result = consumer.handler(event);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((error) => this.report(consumer, event, 'handle', error));
        }
      } catch (error) {
        this.report(consumer, event, 'handle', error);
      }
    }
    return accepted;
  }

  consumers(): string[] {
    return [...this.consumersByName.keys()];
  }

  private report(consumer: Consumer, event: BusEvent, stage: ConsumerFailure['stage'], error: unknown): void {
    try {
      this.onConsumerError({ consumer: consumer.name, eventType: event.type, stage, error });
    } catch {
      // 上报器自己坏了也不能把故障传给下一个消费者。
    }
  }
}
