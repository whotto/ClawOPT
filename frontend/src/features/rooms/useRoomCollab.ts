/**
 * 群协作层的状态：策略、执行队列、停止的交接链、摘要、待决审批 / 澄清。
 * 首次进群拉一遍；之后按协作帧（roomFrames.ts）增量刷新——`queue` 帧自带快照，其余帧只说「变了」再经 HTTP 取（按身份过滤）。
 * 断线重连后群事件流会重发 `connected`，这里在窗口重新可见时也补拉一次（spec 02 F6「重连后回放待决审批」）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type HandoffChain, type QueueSnapshot, roomApi, type RoomInteraction, type RoomPolicyResponse, type SummaryState,
} from './api';
import { subscribeRoomFrames } from './roomFrames';

export type RoomCollabState = {
  policy: RoomPolicyResponse | null;
  queue: QueueSnapshot;
  chains: HandoffChain[];
  canManageChains: boolean;
  summary: SummaryState | null;
  interactions: RoomInteraction[];
};

const EMPTY: RoomCollabState = { policy: null, queue: { items: [], busyMembers: [] }, chains: [], canManageChains: false, summary: null, interactions: [] };

export function useRoomCollab(groupId: string | null) {
  const [state, setState] = useState<RoomCollabState>(EMPTY);
  const [workspaceDiffTick, setWorkspaceDiffTick] = useState(0);
  const current = useRef(groupId);
  current.current = groupId;

  const guard = useCallback(<T,>(id: string, apply: (value: T) => void) => (value: T) => {
    if (current.current === id) apply(value);
  }, []);

  const loadPolicy = useCallback(async (id: string) => {
    try { guard(id, (policy: RoomPolicyResponse) => setState((prev) => ({ ...prev, policy })))(await roomApi.policy(id)); } catch { /* 无权 / 已删：保持空 */ }
  }, [guard]);
  const loadQueue = useCallback(async (id: string) => {
    try { guard(id, (queue: QueueSnapshot) => setState((prev) => ({ ...prev, queue })))(await roomApi.queue(id)); } catch { /* ignore */ }
  }, [guard]);
  const loadChains = useCallback(async (id: string) => {
    try {
      const result = await roomApi.handoffs(id);
      guard(id, () => setState((prev) => ({ ...prev, chains: result.chains, canManageChains: result.canManage })))(null);
    } catch { /* ignore */ }
  }, [guard]);
  const loadSummary = useCallback(async (id: string) => {
    try { guard(id, (result: { state: SummaryState }) => setState((prev) => ({ ...prev, summary: result.state })))(await roomApi.summary(id)); } catch { /* ignore */ }
  }, [guard]);
  const loadInteractions = useCallback(async (id: string) => {
    try { guard(id, (result: { interactions: RoomInteraction[] }) => setState((prev) => ({ ...prev, interactions: result.interactions })))(await roomApi.interactions(id)); } catch { /* ignore */ }
  }, [guard]);

  const reloadAll = useCallback((id: string) => {
    void loadPolicy(id);
    void loadQueue(id);
    void loadChains(id);
    void loadSummary(id);
    void loadInteractions(id);
  }, [loadChains, loadInteractions, loadPolicy, loadQueue, loadSummary]);

  useEffect(() => {
    setState(EMPTY);
    if (!groupId) return;
    reloadAll(groupId);
    const unsubscribe = subscribeRoomFrames(groupId, (frame) => {
      switch (frame.type) {
        case 'queue':
          if (frame.data && Array.isArray(frame.data.items)) setState((prev) => ({ ...prev, queue: { items: frame.data.items, busyMembers: frame.data.busyMembers ?? [] } }));
          else void loadQueue(groupId);
          break;
        case 'handoff':
          void loadChains(groupId);
          break;
        case 'summary':
          if (frame.data && typeof frame.data.status === 'string') setState((prev) => ({ ...prev, summary: frame.data }));
          else void loadSummary(groupId);
          break;
        case 'interactions':
          void loadInteractions(groupId);
          break;
        case 'room_updated':
          void loadPolicy(groupId);
          if (frame.data?.cleared) reloadAll(groupId);
          break;
        case 'message_retracted':
          void loadQueue(groupId);
          break;
        case 'workspace_diff':
          setWorkspaceDiffTick((tick) => tick + 1);
          break;
        default:
          break;
      }
    });
    const onVisible = () => { if (document.visibilityState === 'visible') reloadAll(groupId); };
    document.addEventListener('visibilitychange', onVisible);
    // 审批倒计时与离线重连兜底：每 20 秒补拉待决交互（便宜，且按身份过滤）。
    const timer = window.setInterval(() => { void loadInteractions(groupId); }, 20_000);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [groupId, loadChains, loadInteractions, loadPolicy, loadQueue, loadSummary, reloadAll]);

  return {
    ...state,
    workspaceDiffTick,
    reloadPolicy: () => groupId && loadPolicy(groupId),
    reloadChains: () => groupId && loadChains(groupId),
    reloadSummary: () => groupId && loadSummary(groupId),
    reloadInteractions: () => groupId && loadInteractions(groupId),
    reloadQueue: () => groupId && loadQueue(groupId),
    setInteractions: (interactions: RoomInteraction[]) => setState((prev) => ({ ...prev, interactions })),
  };
}

export type RoomCollabController = ReturnType<typeof useRoomCollab>;
