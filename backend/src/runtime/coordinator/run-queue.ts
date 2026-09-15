/**
 * 每会话的服务端运行队列。
 *
 * **快照语义**：入队那一刻就把请求整个复制下来（模型、指令、工作区……）。
 * 排队期间用户改了会话模型，排着的那一条仍按它入队时的配置跑——
 * 否则「我发的时候选的是 A，跑出来是 B」，而且没有任何提示。
 *
 * 复制只深拷贝纯数据；函数（投影器工厂等）按引用保留，它们本来就不是配置。
 */

export interface QueuedRunView {
  queueId: string;
  position: number;
  display: string | null;
  enqueuedAt: number;
}

export interface QueuedRun<TPayload> {
  queueId: string;
  payload: TPayload;
  display: string | null;
  enqueuedAt: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 深拷贝纯数据（对象、数组、Date），其余（函数、类实例）按引用保留。 */
export function snapshotRequest<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => snapshotRequest(item)) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = snapshotRequest(item);
    return copy as T;
  }
  return value;
}

export class SessionRunQueue<TPayload> {
  private items: Array<QueuedRun<TPayload>> = [];

  enqueue(item: Omit<QueuedRun<TPayload>, 'enqueuedAt'> & { enqueuedAt?: number }): number {
    if (this.items.some((existing) => existing.queueId === item.queueId)) {
      throw new Error(`queue item "${item.queueId}" is already queued`);
    }
    this.items.push({ ...item, enqueuedAt: item.enqueuedAt ?? Date.now() });
    return this.items.length;
  }

  /** 取消一条排队项，返回被取出的那一条（找不到为 undefined）。 */
  cancel(queueId: string): QueuedRun<TPayload> | undefined {
    const index = this.items.findIndex((item) => item.queueId === queueId);
    if (index < 0) return undefined;
    return this.items.splice(index, 1)[0];
  }

  /** 把某一条挪到队首（「立即插入」的第一步）。 */
  moveToFront(queueId: string): boolean {
    const index = this.items.findIndex((item) => item.queueId === queueId);
    if (index < 0) return false;
    const [item] = this.items.splice(index, 1);
    this.items.unshift(item);
    return true;
  }

  shift(): QueuedRun<TPayload> | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  view(): QueuedRunView[] {
    return this.items.map((item, index) => ({
      queueId: item.queueId,
      position: index + 1,
      display: item.display,
      enqueuedAt: item.enqueuedAt,
    }));
  }
}
