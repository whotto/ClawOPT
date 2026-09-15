/**
 * 每 Agent 执行队列（spec 02 F8）。
 *
 * ## 两层
 *
 * - **内存 FIFO**：键 = (群, 成员)。一个键同一时刻只有一个 worker 在排空 → 同一个 Agent 严格按顺序处理点到它的消息；
 *   不同键并行 → 同一个群里不同 Agent 并发。协调器仍按 (群, 成员) 会话键单运行、引擎仍有每成员一把锁（兜底）。
 * - **持久化行**（`room_queue`）：只给人类消息建，**只为界面可见位置与撤回**。执行顺序以内存为准；
 *   服务重启时残留的 queued / running 行一律改成 failed（不续跑——上一个进程里的上下文已经没了）。
 *
 * ## 撤回
 *
 * 只有发这条消息的人能撤；而且这条消息指向的**所有**目标都还在 queued 才行（有一个已经开跑就不行）。
 * 一个立即事务里：行改 cancelled、删掉这条人类消息（子消息改挂父消息）、推进 `summary_generation` 并删摘要行。
 * 账号用户按身份撤；访客按能力令牌撤（浏览器里存 64 位随机十六进制，服务端只存 SHA-256，常数时间比较）。
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';

import { applyRoomSchema } from './room-schema';

export type QueueRowStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export type QueueRequester =
  | { kind: 'user'; userId: number | null }
  | { kind: 'guest'; guestId: string };

export type QueueSnapshotItem = {
  id: string;
  messageId: number;
  memberId: string;
  targetName: string;
  textSummary: string;
  sequence: number;
  /** 这个 Agent 队列里的位置（1 起）。 */
  position: number;
  createdAt: number;
  requesterKind: QueueRequester['kind'];
  requesterUserId: number | null;
  requesterGuestId: string | null;
};

export const QUEUE_TEXT_SUMMARY_MAX = 160;
export const QUEUE_RESTART_ERROR = 'groups.queueInterruptedByRestart';
export const QUEUE_CLEARED_ERROR = 'groups.queueCleared';
export const QUEUE_MEMBER_REMOVED_ERROR = 'groups.queueMemberRemoved';
export const QUEUE_MEMBER_INTERRUPTED_ERROR = 'groups.queueMemberInterrupted';

export function hashQueueCapability(capability: string): string {
  return crypto.createHash('sha256').update(capability, 'utf8').digest('hex');
}

export function isQueueCapabilityShape(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function summarizeQueueText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > QUEUE_TEXT_SUMMARY_MAX ? `${collapsed.slice(0, QUEUE_TEXT_SUMMARY_MAX - 1)}…` : collapsed;
}

type Row = {
  id: string;
  group_id: string;
  message_id: number;
  target_member_id: string;
  target_name: string;
  requester_kind: string;
  requester_user_id: number | null;
  requester_guest_id: string | null;
  cancel_capability_hash: string | null;
  text_summary: string;
  sequence: number;
  status: QueueRowStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
};

export type RetractOutcome =
  | { ok: true; rowIds: string[]; parentId: number | null }
  | { ok: false; reason: 'notFound' | 'forbidden' | 'notCancellable'; statuses?: QueueRowStatus[] };

export function createRoomQueueStore(conn: Database.Database, now: () => number = Date.now) {
  applyRoomSchema(conn);

  const insert = conn.prepare(`INSERT OR IGNORE INTO room_queue (id, group_id, message_id, target_member_id, target_name, requester_kind,
    requester_user_id, requester_guest_id, cancel_capability_hash, text_summary, sequence, status, created_at)
    VALUES (@id, @groupId, @messageId, @memberId, @targetName, @requesterKind, @requesterUserId, @requesterGuestId, @capabilityHash,
      @textSummary, @sequence, 'queued', @createdAt)`);

  /** 幂等入队：(消息, 目标) 唯一。返回每个目标的行 id（已存在的返回原来那行）。 */
  function enqueueRows(input: {
    groupId: string;
    messageId: number;
    targets: Array<{ memberId: string; name: string }>;
    requester: QueueRequester;
    capability?: string | null;
    text: string;
  }): Map<string, string> {
    const run = conn.transaction(() => {
      const out = new Map<string, string>();
      const base = (conn.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM room_queue WHERE group_id = ?').get(input.groupId) as { seq: number }).seq;
      let sequence = base;
      for (const target of input.targets) {
        sequence += 1;
        const id = crypto.randomUUID();
        insert.run({
          id,
          groupId: input.groupId,
          messageId: input.messageId,
          memberId: target.memberId,
          targetName: target.name,
          requesterKind: input.requester.kind,
          requesterUserId: input.requester.kind === 'user' ? input.requester.userId : null,
          requesterGuestId: input.requester.kind === 'guest' ? input.requester.guestId : null,
          capabilityHash: input.capability && isQueueCapabilityShape(input.capability) ? hashQueueCapability(input.capability) : null,
          textSummary: summarizeQueueText(input.text),
          sequence,
          createdAt: now(),
        });
        const row = conn.prepare('SELECT id FROM room_queue WHERE message_id = ? AND target_member_id = ?').get(input.messageId, target.memberId) as { id: string };
        out.set(target.memberId, row.id);
      }
      return out;
    });
    return run.immediate();
  }

  /** queued → running 的 CAS；失败（已撤回 / 已作废）返回 false，worker 跳过这一项。 */
  function markRunning(rowId: string): boolean {
    return conn.prepare("UPDATE room_queue SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(now(), rowId).changes === 1;
  }

  function markFinished(rowId: string, status: 'completed' | 'failed' | 'cancelled', error?: string | null): void {
    conn.prepare("UPDATE room_queue SET status = ?, finished_at = ?, last_error = ? WHERE id = ? AND status IN ('queued', 'running')")
      .run(status, now(), error ?? null, rowId);
  }

  function failOpenRows(filter: { groupId?: string; memberId?: string }, error: string): string[] {
    const clauses = ["status IN ('queued', 'running')"];
    const params: unknown[] = [];
    if (filter.groupId) { clauses.push('group_id = ?'); params.push(filter.groupId); }
    if (filter.memberId) { clauses.push('target_member_id = ?'); params.push(filter.memberId); }
    const ids = (conn.prepare(`SELECT id FROM room_queue WHERE ${clauses.join(' AND ')}`).all(...params) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length > 0) {
      conn.prepare(`UPDATE room_queue SET status = 'failed', finished_at = ?, last_error = ? WHERE ${clauses.join(' AND ')}`).run(now(), error, ...params);
    }
    return ids;
  }

  /** 启动时：上一个进程残留的排队 / 运行中行一律作废。 */
  function recoverOnBoot(): number {
    return failOpenRows({}, QUEUE_RESTART_ERROR).length;
  }

  function snapshot(groupId: string): QueueSnapshotItem[] {
    const rows = conn.prepare("SELECT * FROM room_queue WHERE group_id = ? AND status = 'queued' ORDER BY sequence ASC").all(groupId) as Row[];
    const positions = new Map<string, number>();
    return rows.map((row) => {
      const position = (positions.get(row.target_member_id) ?? 0) + 1;
      positions.set(row.target_member_id, position);
      return {
        id: row.id,
        messageId: row.message_id,
        memberId: row.target_member_id,
        targetName: row.target_name,
        textSummary: row.text_summary,
        sequence: row.sequence,
        position,
        createdAt: row.created_at,
        requesterKind: row.requester_kind as QueueRequester['kind'],
        requesterUserId: row.requester_user_id,
        requesterGuestId: row.requester_guest_id,
      };
    });
  }

  function rowsForMessage(messageId: number): Row[] {
    return conn.prepare('SELECT * FROM room_queue WHERE message_id = ?').all(messageId) as Row[];
  }

  /** 编辑重跑前：这条消息的旧行（已终态的）让出唯一键。仍在排队 / 运行中的行不删。 */
  function deleteRowsForMessage(messageId: number): number {
    return conn.prepare("DELETE FROM room_queue WHERE message_id = ? AND status NOT IN ('queued', 'running')").run(messageId).changes;
  }

  function deleteForGroup(groupId: string): void {
    conn.prepare('DELETE FROM room_queue WHERE group_id = ?').run(groupId);
  }

  /**
   * 撤回。`deleteMessage` 在同一个事务里删消息（改挂子消息）并让摘要失效。
   * 判据：消息存在于这个群且是人类消息、请求人就是发送人（身份或能力令牌）、所有目标行都还是 queued。
   */
  function retract(input: {
    groupId: string;
    messageId: number;
    requester: QueueRequester;
    capability?: string | null;
    isHumanMessageOfRequester: (messageId: number) => boolean;
    deleteMessage: (messageId: number) => { deleted: boolean; parentId: number | null };
    invalidateSummary: () => void;
  }): RetractOutcome {
    const run = conn.transaction((): RetractOutcome => {
      const rows = rowsForMessage(input.messageId).filter((row) => row.group_id === input.groupId);
      if (rows.length === 0) return { ok: false, reason: 'notFound' };
      const capabilityHash = input.capability && isQueueCapabilityShape(input.capability) ? hashQueueCapability(input.capability) : null;
      const authorized = rows.every((row) => {
        if (input.requester.kind === 'user') {
          return row.requester_kind === 'user' && row.requester_user_id === input.requester.userId;
        }
        if (row.requester_kind !== 'guest' || row.requester_guest_id !== input.requester.guestId) return false;
        if (!row.cancel_capability_hash || !capabilityHash) return false;
        const a = Buffer.from(row.cancel_capability_hash, 'hex');
        const b = Buffer.from(capabilityHash, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      });
      if (!authorized || !input.isHumanMessageOfRequester(input.messageId)) return { ok: false, reason: 'forbidden' };
      if (!rows.every((row) => row.status === 'queued')) return { ok: false, reason: 'notCancellable', statuses: rows.map((row) => row.status) };
      conn.prepare("UPDATE room_queue SET status = 'cancelled', finished_at = ? WHERE message_id = ? AND status = 'queued'").run(now(), input.messageId);
      const removed = input.deleteMessage(input.messageId);
      input.invalidateSummary();
      return { ok: true, rowIds: rows.map((row) => row.id), parentId: removed.parentId };
    });
    return run.immediate();
  }

  return { enqueueRows, markRunning, markFinished, failOpenRows, recoverOnBoot, snapshot, rowsForMessage, deleteRowsForMessage, deleteForGroup, retract };
}

export type RoomQueueStore = ReturnType<typeof createRoomQueueStore>;

/** 内存 FIFO 的一项。 */
export type QueueWorkItem<T> = {
  groupId: string;
  memberId: string;
  rowId: string | null;
  payload: T;
};

/**
 * 内存执行队列：每 (群, 成员) 一个 FIFO + 至多一个 worker。
 * `execute` 的异常不会让 worker 停下（下一项照跑）；`pause` 的群不开新项（已开跑的不打断）。
 */
export class RoomExecutionQueue<T> {
  private readonly queues = new Map<string, Array<QueueWorkItem<T> & { done: (dropped: boolean) => void }>>();
  private readonly running = new Set<string>();
  private readonly paused = new Set<string>();

  constructor(private readonly execute: (item: QueueWorkItem<T>) => Promise<void>, private readonly log: (message: string) => void = () => {}) {}

  static key(groupId: string, memberId: string): string {
    return `${groupId.length}:${groupId}:${memberId}`;
  }

  /** 入队并确保 worker 在跑。返回的 promise 在这一项执行完（或被丢弃）后 resolve，参数 = 是否被丢弃。 */
  enqueue(item: QueueWorkItem<T>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const key = RoomExecutionQueue.key(item.groupId, item.memberId);
      const queue = this.queues.get(key) ?? [];
      queue.push({ ...item, done: resolve });
      this.queues.set(key, queue);
      this.pump(key, item.groupId);
    });
  }

  private pump(key: string, groupId: string): void {
    if (this.running.has(key) || this.paused.has(groupId)) return;
    const queue = this.queues.get(key);
    const next = queue?.shift();
    if (!next) {
      this.queues.delete(key);
      return;
    }
    this.running.add(key);
    void (async () => {
      try {
        await this.execute(next);
      } catch (error) {
        this.log(`[RoomQueue] item failed: ${(error as Error)?.message}`);
      } finally {
        this.running.delete(key);
        next.done(false);
        this.pump(key, groupId);
      }
    })();
  }

  /** 丢掉排队中的项（不打断正在跑的）。返回被丢掉的项。 */
  drop(groupId: string, memberId?: string): Array<QueueWorkItem<T>> {
    const dropped: Array<QueueWorkItem<T>> = [];
    for (const [key, queue] of [...this.queues.entries()]) {
      const remaining = queue.filter((item) => {
        const hit = item.groupId === groupId && (memberId === undefined || item.memberId === memberId);
        if (hit) {
          dropped.push(item);
          item.done(true);
        }
        return !hit;
      });
      if (remaining.length > 0) this.queues.set(key, remaining);
      else if (!this.running.has(key)) this.queues.delete(key);
      else this.queues.set(key, remaining);
    }
    return dropped;
  }

  /** 按排队行 id 摘掉一项（撤回）。 */
  removeRow(rowId: string): boolean {
    for (const [key, queue] of this.queues.entries()) {
      const index = queue.findIndex((item) => item.rowId === rowId);
      if (index >= 0) {
        const [item] = queue.splice(index, 1);
        item.done(true);
        if (queue.length === 0 && !this.running.has(key)) this.queues.delete(key);
        return true;
      }
    }
    return false;
  }

  pause(groupId: string): void {
    this.paused.add(groupId);
  }

  resume(groupId: string): void {
    this.paused.delete(groupId);
    for (const [key, queue] of this.queues.entries()) {
      if (queue[0]?.groupId === groupId) this.pump(key, groupId);
    }
  }

  /** (群, 成员) 排队 + 在跑的数量（「这个 Agent 忙不忙」的即时信号）。 */
  pendingCount(groupId: string, memberId: string): number {
    const key = RoomExecutionQueue.key(groupId, memberId);
    return (this.queues.get(key)?.length ?? 0) + (this.running.has(key) ? 1 : 0);
  }

  /** 这个群里排队或在跑的成员（「Agent 忙」的即时信号：排队中也算忙）。 */
  busyMembers(groupId: string): string[] {
    const out = new Set<string>();
    const consider = (key: string) => {
      // 键是 `${groupId.length}:${groupId}:${memberId}`，按长度前缀切回去（群 id 里带冒号也不会切错）。
      const colon = key.indexOf(':');
      const len = Number(key.slice(0, colon));
      if (key.slice(colon + 1, colon + 1 + len) === groupId) out.add(key.slice(colon + 2 + len));
    };
    for (const [key, queue] of this.queues.entries()) if (queue.length > 0) consider(key);
    for (const key of this.running) consider(key);
    return [...out];
  }
}
