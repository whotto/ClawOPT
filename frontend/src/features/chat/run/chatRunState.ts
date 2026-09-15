// 单聊运行控制的客户端状态（纯函数，带单测）：服务端状态快照 + 会话实时通道事件 → 队列面板 / 插入状态 / 活跃运行。
//
// 三条守卫，缺一条都会出现「晚到的旧结果覆盖新状态」：
// 1. **会话代次**（generation）：切换会话、断线重连、标签页回到前台都会开新代次；旧代次的快照与事件一律丢弃；
// 2. **事件游标**（cursor）：快照带实时中枢的事件 id，id 不大于快照游标的事件已经反映在快照里，重复应用会把
//    已出队的项重新加回队列；
// 3. **插入令牌**：插入状态以服务端 generation 为准，清除事件只清掉同一个令牌（或无令牌的全清）。

export type QueueItem = {
  queueId: string;
  position: number;
  display: string | null;
  enqueuedAt: number;
  ref: string | null;
};

export type QueueInsertionPhase = 'requesting' | 'waiting_for_tool_batch' | 'stopping_current_turn' | 'starting_queued_message';

export type QueueInsertion = {
  generation: string;
  queueId: string;
  phase: QueueInsertionPhase;
  guarantee: 'strict' | 'immediate';
};

export type ActiveChatRun = {
  runId: string;
  startedAt: number;
  messageId: number | null;
  userMessageId: number | null;
  aborting: boolean;
  ref: string | null;
};

export type ChatRunState = {
  sessionId: string;
  generation: number;
  cursor: number;
  loaded: boolean;
  activeRun: ActiveChatRun | null;
  queue: QueueItem[];
  insertion: QueueInsertion | null;
};

export type ChatLiveEvent = {
  id: number;
  event: string;
  payload: any;
  runId?: string | null;
};

export function createChatRunState(sessionId: string, generation: number): ChatRunState {
  return { sessionId, generation, cursor: 0, loaded: false, activeRun: null, queue: [], insertion: null };
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeQueue(raw: unknown): QueueItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item.queueId === 'string')
    .map((item, index) => ({
      queueId: String(item.queueId),
      position: toNumber(item.position) ?? index + 1,
      display: typeof item.display === 'string' ? item.display : null,
      enqueuedAt: toNumber(item.enqueuedAt) ?? 0,
      ref: typeof item.ref === 'string' ? item.ref : null,
    }));
}

function normalizeInsertion(raw: any): QueueInsertion | null {
  if (!raw || typeof raw !== 'object') return null;
  const generation = raw.generation;
  const queueId = raw.queueId ?? raw.queue_id;
  if (typeof generation !== 'string' || typeof queueId !== 'string') return null;
  return {
    generation,
    queueId,
    phase: (raw.phase ?? 'requesting') as QueueInsertionPhase,
    guarantee: raw.guarantee === 'strict' ? 'strict' : 'immediate',
  };
}

/** 服务端 `GET /api/chat/:id/state`（或 SSE 通道首帧 state）。代次不符的丢弃。 */
export function applyChatRunSnapshot(state: ChatRunState, generation: number, snapshot: any): ChatRunState {
  if (generation !== state.generation || !snapshot || snapshot.sessionId !== state.sessionId) return state;
  const run = snapshot.activeRun;
  return {
    ...state,
    loaded: true,
    cursor: Math.max(state.cursor, toNumber(snapshot.cursor) ?? 0),
    activeRun: run && typeof run.runId === 'string'
      ? {
        runId: run.runId,
        startedAt: toNumber(run.startedAt) ?? Date.now(),
        messageId: toNumber(run.messageId),
        userMessageId: toNumber(run.userMessageId),
        aborting: !!run.aborting,
        ref: null,
      }
      : null,
    queue: normalizeQueue(snapshot.queue),
    insertion: normalizeInsertion(snapshot.insertion),
  };
}

/** 会话实时通道上的一个控制事件。不在快照之后的事件（id ≤ cursor）丢弃。 */
export function applyChatLiveEvent(state: ChatRunState, generation: number, event: ChatLiveEvent): ChatRunState {
  if (generation !== state.generation) return state;
  if (typeof event.id === 'number' && event.id > 0 && event.id <= state.cursor) return state;
  const cursor = typeof event.id === 'number' && event.id > state.cursor ? event.id : state.cursor;
  const payload = event.payload ?? {};
  switch (event.event) {
    case 'run.started':
      return {
        ...state,
        cursor,
        activeRun: {
          runId: String(payload.run_id ?? event.runId ?? ''),
          startedAt: Date.now(),
          messageId: toNumber(payload.meta?.messageId),
          userMessageId: toNumber(payload.meta?.userMessageId),
          aborting: false,
          ref: typeof payload.ref === 'string' ? payload.ref : null,
        },
      };
    case 'run.queued':
      return { ...state, cursor, queue: normalizeQueue(payload.queued) };
    case 'abort.started':
      return state.activeRun && state.activeRun.runId === (payload.run_id ?? event.runId)
        ? { ...state, cursor, activeRun: { ...state.activeRun, aborting: true } }
        : { ...state, cursor };
    case 'run.completed':
    case 'run.failed':
    case 'run.aborted': {
      const runId = payload.run_id ?? event.runId;
      if (state.activeRun && state.activeRun.runId !== runId) return { ...state, cursor };
      return { ...state, cursor, activeRun: null };
    }
    case 'queue.insertion.updated': {
      if (payload.cleared) return { ...state, cursor, insertion: null };
      const insertion = normalizeInsertion(payload);
      return insertion ? { ...state, cursor, insertion } : { ...state, cursor };
    }
    default:
      return { ...state, cursor };
  }
}

/** 终态事件是不是「被立即插入让出」（不是失败、也不是用户点的停止）。 */
export function isQueueInsertionInterruption(payload: any): boolean {
  return payload?.stop_reason === 'queue_insertion';
}

/** 插入箭头能不能点：没有进行中的插入，且当前确实有运行在跑。 */
export function canInsertQueuedItem(state: Pick<ChatRunState, 'insertion' | 'activeRun'>): boolean {
  return !state.insertion && !!state.activeRun;
}

/** 前端这一轮的引用 id（后端只收 6–80 位的 `[A-Za-z0-9_-]`）。 */
export function createClientTurnId(random: () => number = Math.random, now: () => number = Date.now): string {
  return `t${now().toString(36)}${Math.floor(random() * 1e12).toString(36)}`;
}
