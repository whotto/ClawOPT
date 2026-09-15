// 工作流状态流：主通道是 `/ws` 的 `workflow:<id>` 主题，WebSocket 订阅不到（被拒、5 秒内没确认）就退回 SSE。
//
// 两条通道给出同一组回调：
// - onStatus(status)：运行时状态（很小，整份替换）；
// - onEvidence(runId, evidence)：证据行（增量或快照里的全部），调用方按行 id 合并——WS 的主题级增量可能与快照重叠，合并无害。
// 断线重连后 WS 客户端会带 resume 重新订阅，快照再走一遍 onStatus / onEvidence，补齐断线期间的变化。
import { openWorkflowEvents } from '../../../api/automation';
import { getRealtimeClient, type RealtimeClient } from '../../../api/ws';
import type { RunEvidence, RuntimeStatus } from './types';

export const WORKFLOW_WS_READY_TIMEOUT_MS = 5000;

export type WorkflowStreamHandlers = {
  onStatus: (status: RuntimeStatus) => void;
  onEvidence: (runId: string, evidence: RunEvidence) => void;
  /** 实际在用的通道（诊断与测试用）。 */
  onTransport?: (transport: 'ws' | 'sse') => void;
};

type EventSourceLike = Pick<EventSource, 'addEventListener' | 'close'>;

export type WorkflowStreamDeps = {
  realtime?: Pick<RealtimeClient, 'subscribe'>;
  openSse?: (workflowId: string, since?: { runId: string; seq: number }) => EventSourceLike;
  since?: () => { runId: string; seq: number } | undefined;
  readyTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export function subscribeWorkflowStream(workflowId: string, handlers: WorkflowStreamHandlers, deps: WorkflowStreamDeps = {}): () => void {
  const realtime = deps.realtime ?? getRealtimeClient();
  const openSse = deps.openSse ?? openWorkflowEvents;
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
  let closed = false;
  let sse: EventSourceLike | null = null;

  const applySnapshot = (snapshot: any) => {
    const workflow = snapshot?.workflow;
    if (!workflow) return;
    if (workflow.status) handlers.onStatus(workflow.status as RuntimeStatus);
    if (workflow.runId && workflow.evidence) handlers.onEvidence(workflow.runId, workflow.evidence as RunEvidence);
  };

  const subscription = realtime.subscribe(`workflow:${workflowId}`, {
    onEvent: (message) => {
      if (closed || sse) return;
      if (message.event === 'workflow.status' && message.payload?.status) handlers.onStatus(message.payload.status as RuntimeStatus);
      else if (message.event === 'workflow.evidence' && message.payload?.runId) handlers.onEvidence(message.payload.runId, message.payload.evidence as RunEvidence);
    },
    onSnapshot: (snapshot) => {
      if (!closed && !sse) applySnapshot(snapshot);
    },
  });

  const fallBackToSse = () => {
    if (closed || sse) return;
    subscription.unsubscribe();
    const source = openSse(workflowId, deps.since?.());
    sse = source;
    source.addEventListener('status', (event) => handlers.onStatus(JSON.parse((event as MessageEvent).data).status));
    source.addEventListener('evidence', (event) => {
      const message = JSON.parse((event as MessageEvent).data);
      handlers.onEvidence(message.runId, message.evidence);
    });
    handlers.onTransport?.('sse');
  };

  const timer = setTimer(fallBackToSse, deps.readyTimeoutMs ?? WORKFLOW_WS_READY_TIMEOUT_MS);
  void subscription.ready.then((result) => {
    clearTimer(timer);
    if (closed || sse) return;
    if (result.ok) handlers.onTransport?.('ws');
    else fallBackToSse();
  });

  return () => {
    closed = true;
    clearTimer(timer);
    subscription.unsubscribe();
    sse?.close();
  };
}

/**
 * 待办中心的变更提醒：订阅 `approvals:workflows`（不带内容），每次提醒与每次（重新）订阅成功都调 `onChange` 重新拉列表。
 * 订阅不到就退回轮询。返回取消函数。
 */
export function watchPendingApprovals(onChange: () => void, deps: {
  realtime?: Pick<RealtimeClient, 'subscribe'>;
  pollMs?: number;
  readyTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onTransport?: (transport: 'ws' | 'poll') => void;
} = {}): () => void {
  const realtime = deps.realtime ?? getRealtimeClient();
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
  const pollMs = deps.pollMs ?? 5000;
  let closed = false;
  let polling = false;
  let pollTimer: unknown = null;

  const subscription = realtime.subscribe('approvals:workflows', {
    onEvent: () => { if (!closed && !polling) onChange(); },
    onSnapshot: () => { if (!closed && !polling) onChange(); },
  });

  const poll = () => {
    if (closed) return;
    onChange();
    pollTimer = setTimer(poll, pollMs);
  };
  const fallBackToPolling = () => {
    if (closed || polling) return;
    polling = true;
    subscription.unsubscribe();
    deps.onTransport?.('poll');
    poll();
  };

  const readyTimer = setTimer(fallBackToPolling, deps.readyTimeoutMs ?? WORKFLOW_WS_READY_TIMEOUT_MS);
  void subscription.ready.then((result) => {
    clearTimer(readyTimer);
    if (closed || polling) return;
    if (result.ok) deps.onTransport?.('ws');
    else fallBackToPolling();
  });

  return () => {
    closed = true;
    clearTimer(readyTimer);
    if (pollTimer) clearTimer(pollTimer);
    subscription.unsubscribe();
  };
}
