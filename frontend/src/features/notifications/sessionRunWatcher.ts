// 看着「我看得见的单聊会话」的运行生命周期，给完成提醒与未读点用。
//
// 主通道：`/ws` 的 `agent:<id>` 主题——协调器把 run.started 与终态发到每次运行的全部主题，
// 这个主题只收生命周期事件、不收逐字增量，订阅几十个也很轻；授权与 HTTP 同一判据（bootstrap/realtime.ts）。
// 兜底：任何一个主题被拒、5 秒内没全部确认、或会话多到超过每连接主题上限，整体退回轮询 `GET /api/sessions/activity`。
// 快照（含重连快照）里的重放一律不当事件：只有订阅之后实时到达的事件才交给回调。
import { getRealtimeClient, type RealtimeClient, type RealtimeEventMessage } from '../../api/ws';
import type { SessionActivityRow } from './notificationLogic';

export const RUN_WATCH_READY_TIMEOUT_MS = 5000;
export const RUN_WATCH_POLL_MS = 10000;
/** 服务端每连接最多 200 个主题；留出聊天页、审批、工作流自己的订阅。 */
export const RUN_WATCH_MAX_TOPICS = 150;

export type WatchedSession = { sessionId: string; agentId: string };

export type SessionRunHandlers = {
  onStarted: (sessionId: string, runId: string) => void;
  onTerminal: (sessionId: string, event: string, payload: any, runId: string) => void;
  onActivity: (rows: SessionActivityRow[]) => void;
  onTransport?: (transport: 'ws' | 'poll') => void;
};

export type SessionRunWatchDeps = {
  realtime?: Pick<RealtimeClient, 'subscribe'>;
  fetchActivity?: () => Promise<SessionActivityRow[] | null>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  readyTimeoutMs?: number;
  pollMs?: number;
  maxTopics?: number;
};

const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.aborted']);

export function watchSessionRuns(sessions: WatchedSession[], handlers: SessionRunHandlers, deps: SessionRunWatchDeps): () => void {
  const realtime = deps.realtime ?? getRealtimeClient();
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
  const fetchActivity = deps.fetchActivity ?? (async () => null);
  let closed = false;
  let polling = false;
  let pollTimer: unknown = null;

  // 同一个 Agent 对应多个会话时按第一个算（ClawOPT 的单聊会话与 Agent 一一对应，外部运行时单聊的 Agent id 即会话自己的）。
  const sessionByAgent = new Map<string, string>();
  for (const session of sessions) {
    if (!sessionByAgent.has(session.agentId)) sessionByAgent.set(session.agentId, session.sessionId);
  }

  const subscriptions: Array<{ unsubscribe: () => void }> = [];

  const poll = async () => {
    if (closed) return;
    try {
      const rows = await fetchActivity();
      if (!closed && rows) handlers.onActivity(rows);
    } catch {
      // 下一轮再拉
    }
    if (!closed) pollTimer = setTimer(() => { void poll(); }, deps.pollMs ?? RUN_WATCH_POLL_MS);
  };

  const fallBackToPolling = () => {
    if (closed || polling) return;
    polling = true;
    for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
    handlers.onTransport?.('poll');
    void poll();
  };

  if (sessionByAgent.size > (deps.maxTopics ?? RUN_WATCH_MAX_TOPICS)) {
    fallBackToPolling();
    return () => {
      closed = true;
      if (pollTimer) clearTimer(pollTimer);
    };
  }

  const readies: Array<Promise<{ ok: boolean }>> = [];
  for (const [agentId, sessionId] of sessionByAgent) {
    const onEvent = (message: RealtimeEventMessage) => {
      if (closed || polling) return;
      const runId = typeof message.runId === 'string' && message.runId ? message.runId : String(message.payload?.run_id ?? '');
      if (!runId) return;
      if (message.event === 'run.started') handlers.onStarted(sessionId, runId);
      else if (TERMINAL_EVENTS.has(message.event)) handlers.onTerminal(sessionId, message.event, message.payload, runId);
    };
    const subscription = realtime.subscribe(`agent:${agentId}`, { onEvent });
    subscriptions.push(subscription);
    readies.push(subscription.ready);
  }

  const readyTimer = readies.length > 0 ? setTimer(fallBackToPolling, deps.readyTimeoutMs ?? RUN_WATCH_READY_TIMEOUT_MS) : null;
  if (readies.length > 0) {
    void Promise.all(readies).then((results) => {
      if (readyTimer) clearTimer(readyTimer);
      if (closed || polling) return;
      if (results.every((result) => result.ok)) handlers.onTransport?.('ws');
      else fallBackToPolling();
    });
  }

  return () => {
    closed = true;
    if (readyTimer) clearTimer(readyTimer);
    if (pollTimer) clearTimer(pollTimer);
    for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
  };
}
