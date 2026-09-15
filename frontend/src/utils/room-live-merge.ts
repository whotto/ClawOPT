/**
 * 群聊实时合并规则（P3 任务 12，spec 02 §4「客户端合并」）——在 message-merge.ts 的「正文只增不减」之上补四条：
 *
 * 1. **增量批处理**：同一条消息的 delta 在 50 ms 窗口里合成一个补丁再落 state（`LiveDeltaBatcher`）；
 * 2. **终帧前先冲刷**：终帧（`message` / `edit`）到来时，先把这条消息还没落地的增量合进去，再合终帧——
 *    不是直接丢掉排队的增量（丢掉会让终帧与增量之间的最后一段内容闪回）；
 * 3. **非空优先**：终帧正文为空、而屏幕上已经有正文时保留屏幕上的（结构化提示与带终态信号的收尾除外，见 message-merge）；
 * 4. **不复活**：已删除 / 已撤回的消息 id 记墓碑，迟到的 delta / 终帧不再把它插回来；
 * 5. **空泡清理**：运行结束后仍然没有正文、没有过程、没有结构化提示、也不在流式中的助手气泡移除。
 *
 * 对应用例：src/utils/room-live-merge.test.ts
 */
import { type ChatMessage, mergeMessagePatchPreservingContent, mergeMessagePreservingContent } from './message-merge';

export const ROOM_LIVE_DELTA_BATCH_MS = 50;
const TOMBSTONE_LIMIT = 2000;

/** 墓碑：删除 / 撤回过的消息 id。只增不减（上限内按先进先出淘汰最老的）。 */
export class MessageTombstones {
  private readonly ids = new Set<string>();

  add(ids: Iterable<string>): void {
    for (const id of ids) {
      this.ids.delete(id);
      this.ids.add(id);
    }
    while (this.ids.size > TOMBSTONE_LIMIT) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  clear(): void {
    this.ids.clear();
  }
}

/** 终帧合并：先合排队的增量，再合终帧（两步都走「只增不减」）。消息不在列表里时按终帧追加。 */
export function applyFinalFrame(
  messages: ChatMessage[],
  final: ChatMessage,
  pendingPatch: Partial<ChatMessage> | undefined,
  tombstones?: MessageTombstones,
): ChatMessage[] {
  if (tombstones?.has(final.id)) return messages;
  const index = messages.findIndex((message) => message.id === final.id);
  if (index < 0) return [...messages, final];
  const flushed = pendingPatch ? mergeMessagePreservingContent(messages[index], pendingPatch) : messages[index];
  const merged = mergeMessagePreservingContent(flushed, final);
  const next = messages.slice();
  next[index] = merged;
  return next;
}

/** 这条消息是不是「空泡」：助手角色、没有正文 / 过程 / 结构化提示，且不在流式中。 */
export function isEmptyAssistantBubble(message: ChatMessage): boolean {
  return message.role === 'assistant'
    && !message.content.trim()
    && !(message.processContent ?? '').trim()
    && !message.messageCode
    && !message.processStreaming;
}

/** 运行结束后清掉空泡（`keepIds` 里的仍在跑，保留）。没变化时返回原数组。 */
export function removeEmptyAssistantBubbles(messages: ChatMessage[], keepIds: ReadonlySet<string> = new Set()): ChatMessage[] {
  const next = messages.filter((message) => keepIds.has(message.id) || !isEmptyAssistantBubble(message));
  return next.length === messages.length ? messages : next;
}

/**
 * 增量批处理器（与 React 无关，便于测）：`push` 攒补丁并按窗口调度 `flush`；`take(id)` 取走某条消息排队的补丁（终帧前冲刷用）。
 * 墓碑里的 id 直接丢弃，不排队。
 */
export class LiveDeltaBatcher {
  private readonly pending = new Map<string, Partial<ChatMessage>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onFlush: (patches: Map<string, Partial<ChatMessage>>) => void,
    private readonly tombstones: MessageTombstones = new MessageTombstones(),
    private readonly delayMs = ROOM_LIVE_DELTA_BATCH_MS,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms),
    private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void = (timer) => clearTimeout(timer),
  ) {}

  push(id: string, patch: Partial<ChatMessage>): boolean {
    if (this.tombstones.has(id)) return false;
    this.pending.set(id, mergeMessagePatchPreservingContent(this.pending.get(id) ?? {}, patch));
    if (this.timer === null) this.timer = this.schedule(() => this.flush(), this.delayMs);
    return true;
  }

  take(id: string): Partial<ChatMessage> | undefined {
    const patch = this.pending.get(id);
    this.pending.delete(id);
    return patch;
  }

  drop(ids: Iterable<string>): void {
    for (const id of ids) this.pending.delete(id);
  }

  flush(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const batch = new Map(this.pending);
    this.pending.clear();
    this.onFlush(batch);
  }

  dispose(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

/** 把一批补丁合进消息列表（只合已有的消息；墓碑里的不动）。没变化时返回原数组。 */
export function applyPatchBatch(messages: ChatMessage[], patches: Map<string, Partial<ChatMessage>>, tombstones?: MessageTombstones): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    const patch = patches.get(message.id);
    if (!patch || tombstones?.has(message.id)) return message;
    const merged = mergeMessagePreservingContent(message, patch);
    if (merged !== message) changed = true;
    return merged;
  });
  return changed ? next : messages;
}
