// 群聊：群列表、SSE 事件流、运行态恢复轮询、运行结束后的收敛轮询。
import { useEffect, useCallback } from 'react';
import {
  ACTIVE_CONTEXT_REFRESH_EVENT, type ActiveContextRefreshDetail,
} from '../../../utils/contextRefresh';
import { getGroupActiveRun, listGroups } from '../../../api/groups';
import { openGroupEvents } from '../../../api/stream';
import {
  type ChatMessage, mergeMessageCollectionPreservingContent,
} from '../../../utils/message-merge';
import { HISTORY_FETCH_BATCH_MIN_LIMIT } from '../../../utils/history-window';
import {
  applyPatchBatch, LiveDeltaBatcher, MessageTombstones, removeEmptyAssistantBubbles,
} from '../../../utils/room-live-merge';
import { dispatchRoomFrame, isRoomCollabFrame } from '../../rooms/roomFrames';
import {
  GROUP_ACTIVE_RUN_RECOVERY_POLL_MS, GROUP_SSE_RECOVERY_THROTTLE_MS, GROUP_POST_RUN_SETTLE_POLL_MS,
  GROUP_POST_RUN_SETTLE_TIMEOUT_MS,
} from '../lib/constants';
import type { GroupRunState } from '../lib/types';
import { mapGroupMsg } from '../lib/messageMapping';
import type { ChatViewState } from './useChatViewState';
import type { MessagePatchQueue } from './useMessagePatchQueue';
import type { ChatHistoryFetch } from './useChatHistoryFetch';
import type { HistoryPaging } from './useHistoryPaging';

/** 本段读取的、由前面各段产出的值。 */
type GroupEventsContext = Pick<
  ChatViewState & MessagePatchQueue & ChatHistoryFetch & HistoryPaging,
  'mode' | 'isGroup' | 'activeKey' | 'setMessages' | 'setActiveLeafId' | 'isInitialLoading' |
  'setGroups' | 'setTypingAgents' | 'groupRunState' | 'setGroupRunState' | 'eventSourceRef' |
  'messagesRef' | 'previousGroupRunActiveRef' | 'groupSseRecoveryAtRef' | 'newerHistoryPagesRef' |
  'getPreferredLeafId' | 'historyFetchBatchLimit' | 'flushQueuedMessagePatches' |
  'queueMessagePatch' | 'clearQueuedMessagePatches' | 'dropQueuedMessagePatch' |
  'clearNewerHistoryWindowTrail' | 'fetchHistoryPage' | 'loadHistory'
>;

export function useGroupEvents(c: GroupEventsContext) {
  const {
    mode, isGroup, activeKey, setMessages, setActiveLeafId, isInitialLoading, setGroups,
    setTypingAgents, groupRunState, setGroupRunState, eventSourceRef, messagesRef,
    previousGroupRunActiveRef, groupSseRecoveryAtRef, newerHistoryPagesRef, getPreferredLeafId,
    historyFetchBatchLimit, queueMessagePatch,
    clearQueuedMessagePatches, dropQueuedMessagePatch, clearNewerHistoryWindowTrail,
    fetchHistoryPage, loadHistory,
  } = c;
  // =============== GROUP-MODE EFFECTS ===============
  const loadGroups = useCallback(async () => {
    if (!isGroup) return;
    try { const res = await listGroups(); const data = await res.json(); if (data.success) setGroups(data.groups); } catch {}
  }, [isGroup]);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  useEffect(() => {
    const handleActiveContextRefresh = (event: Event) => {
      const detail = (event as CustomEvent<ActiveContextRefreshDetail>).detail;
      if (!detail || !activeKey || detail.mode !== mode || detail.id !== activeKey) return;

      clearNewerHistoryWindowTrail();
      if (detail.mode === 'group') {
        void loadGroups();
      }
      void loadHistory({ showSkeleton: true });
    };

    window.addEventListener(ACTIVE_CONTEXT_REFRESH_EVENT, handleActiveContextRefresh as EventListener);
    return () => {
      window.removeEventListener(ACTIVE_CONTEXT_REFRESH_EVENT, handleActiveContextRefresh as EventListener);
    };
  }, [activeKey, clearNewerHistoryWindowTrail, loadGroups, loadHistory, mode]);

  const resolveNextLiveGroupLeafId = useCallback((
    _previousLeafId: string | null,
    nextMessages: ChatMessage[],
    _incomingMessageId: string,
    _incomingParentId?: string,
  ) => {
    return getPreferredLeafId(nextMessages);
  }, [getPreferredLeafId]);

  const mergeGroupMessagesIntoState = useCallback((
    incomingMessages: ChatMessage[],
    options?: { focusLatest?: boolean }
  ) => {
    if (incomingMessages.length === 0) return;

    const nextMessages = mergeMessageCollectionPreservingContent(messagesRef.current, incomingMessages);

    setMessages((prev) => {
      return mergeMessageCollectionPreservingContent(prev, incomingMessages);
    });

    if (!options?.focusLatest) return;

    const latestMessage = incomingMessages[incomingMessages.length - 1];
    setActiveLeafId((prevLeaf) => (
      resolveNextLiveGroupLeafId(prevLeaf, nextMessages, latestMessage.id, latestMessage.parentId)
    ));
  }, [resolveNextLiveGroupLeafId]);

  const upsertGroupStreamMessage = useCallback((payload: any) => {
    if (!payload || payload.id === undefined || payload.id === null) return;
    const existingMessage = messagesRef.current.find((message) => message.id === String(payload.id));
    const inferredSenderType = typeof payload.sender_type === 'string'
      ? payload.sender_type
      : (existingMessage?.role === 'user' ? 'user' : 'agent');
    const inferredSenderId = typeof payload.sender_id === 'string'
      ? payload.sender_id
      : (existingMessage?.role === 'system' ? 'system' : existingMessage?.agentId);
    const inferredSenderName = typeof payload.sender_name === 'string'
      ? payload.sender_name
      : existingMessage?.agentName;

    const mapped = mapGroupMsg({
      id: payload.id,
      parent_id: payload.parent_id ?? null,
      sender_type: inferredSenderType,
      sender_id: inferredSenderId,
      sender_name: inferredSenderName,
      content: typeof payload.content === 'string' ? payload.content : '',
      process_content: typeof payload.process_content === 'string' ? payload.process_content : undefined,
      process_streaming: !!payload.process_streaming,
      created_at: payload.created_at || new Date().toISOString(),
      model_used: payload.model_used,
      messageCode: payload.messageCode,
      messageParams: payload.messageParams,
      rawDetail: payload.rawDetail,
    });

    const nextMessages = mergeMessageCollectionPreservingContent(messagesRef.current, [mapped]);

    setMessages(prev => {
      return mergeMessageCollectionPreservingContent(prev, [mapped]);
    });

    setActiveLeafId(prevLeaf => resolveNextLiveGroupLeafId(prevLeaf, nextMessages, mapped.id, mapped.parentId));
  }, [resolveNextLiveGroupLeafId]);

  const recoverGroupActiveRun = useCallback(async (signal?: AbortSignal) => {
    if (!isGroup || !activeKey) return { ok: false as const, active: false as const, runState: null as GroupRunState | null };

    try {
      const response = await getGroupActiveRun(activeKey, signal);
      const data = await response.json();
      if (!data?.success) {
        return { ok: false as const, active: false as const, runState: null as GroupRunState | null };
      }

      const runState: GroupRunState | null = data.runState && typeof data.runState === 'object'
        ? {
            active: !!data.runState.active,
            agentId: typeof data.runState.agentId === 'string' ? data.runState.agentId : null,
            runId: typeof data.runState.runId === 'string' ? data.runState.runId : null,
            startedAt: typeof data.runState.startedAt === 'number' ? data.runState.startedAt : null,
          }
        : null;

      if (data.message) {
        upsertGroupStreamMessage(data.message);
      }

      if (!data.active) {
        return { ok: true as const, active: false as const, runState };
      }

      return { ok: true as const, active: true as const, runState };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return { ok: false as const, active: false as const, runState: null as GroupRunState | null };
      }
      return { ok: false as const, active: false as const, runState: null as GroupRunState | null };
    }
  }, [activeKey, isGroup, upsertGroupStreamMessage]);

  useEffect(() => {
    if (!isGroup || !activeKey || isInitialLoading) {
      return;
    }

    const controller = new AbortController();

    void (async () => {
      const recovery = await recoverGroupActiveRun(controller.signal);
      if (controller.signal.aborted || !recovery.ok || !recovery.runState) return;

      setGroupRunState(recovery.runState);
      if (!recovery.runState.active) {
        setTypingAgents(new Map());
      }
    })();

    return () => {
      controller.abort();
    };
  }, [activeKey, isGroup, isInitialLoading, recoverGroupActiveRun]);

  const recoverLatestGroupMessages = useCallback(async (focusLatest = false) => {
    if (!isGroup || !activeKey) return false;

    try {
      const result = await fetchHistoryPage({
        limit: Math.max(HISTORY_FETCH_BATCH_MIN_LIMIT, Math.min(historyFetchBatchLimit, 80)),
      });
      if (!result || result.messages.length === 0) {
        return false;
      }

      mergeGroupMessagesIntoState(result.messages, { focusLatest });
      return true;
    } catch {
      return false;
    }
  }, [activeKey, fetchHistoryPage, historyFetchBatchLimit, isGroup, mergeGroupMessagesIntoState]);

  // SSE for group
  useEffect(() => {
    if (!isGroup || !activeKey) return;
    eventSourceRef.current?.close();
    setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
    const es = openGroupEvents(activeKey);
    eventSourceRef.current = es;
    // P3 实时合并规则（utils/room-live-merge.ts）：增量 50ms 批处理、终帧前先冲刷、删除 / 撤回记墓碑不复活、运行结束清空泡。
    const tombstones = new MessageTombstones();
    const batcher = new LiveDeltaBatcher((batch) => setMessages((prev) => applyPatchBatch(prev, batch, tombstones)), tombstones);
    const flushPendingInto = (id: string) => {
      const pending = batcher.take(id);
      if (pending) setMessages((prev) => applyPatchBatch(prev, new Map([[id, pending]]), tombstones));
    };
    const forgetMessages = (ids: string[]) => {
      tombstones.add(ids);
      batcher.drop(ids);
      ids.forEach((id) => dropQueuedMessagePatch(id));
    };
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (isRoomCollabFrame(parsed)) {
          if (parsed.type === 'message_retracted' && parsed.data && parsed.data.messageId !== undefined) {
            const retractedId = String(parsed.data.messageId);
            forgetMessages([retractedId]);
            setMessages((prev) => prev.filter((message) => message.id !== retractedId));
          }
          dispatchRoomFrame(activeKey, parsed);
          return;
        }
        if (parsed.type === 'message') {
          const mapped = mapGroupMsg(parsed.data);
          if (tombstones.has(mapped.id)) return;
          flushPendingInto(mapped.id);
          dropQueuedMessagePatch(mapped.id);
          const isBrowsingOlderWindow = newerHistoryPagesRef.current.length > 0;
          const nextMessages = mergeMessageCollectionPreservingContent(messagesRef.current, [mapped]);
          setMessages(prev => {
            if (prev.some(m => m.id === mapped.id)) {
              return mergeMessageCollectionPreservingContent(prev, [mapped]);
            }
            if (isBrowsingOlderWindow) return prev;
            return mergeMessageCollectionPreservingContent(prev, [mapped]);
          });
          setActiveLeafId(prevLeaf => {
            if (isBrowsingOlderWindow) return prevLeaf;
            return resolveNextLiveGroupLeafId(prevLeaf, nextMessages, mapped.id, mapped.parentId);
          });
        } else if (parsed.type === 'typing') {
          if (newerHistoryPagesRef.current.length > 0) return;
          setTypingAgents(prev => { const n = new Map(prev); n.set(parsed.data.agentId, parsed.data.displayName); return n; });
        } else if (parsed.type === 'typing_done') {
          if (newerHistoryPagesRef.current.length > 0) return;
          setTypingAgents(prev => { const n = new Map(prev); n.delete(parsed.data.agentId); return n; });
        } else if (parsed.type === 'run_state') {
          const nextState: GroupRunState = {
            active: !!parsed.data?.active,
            agentId: typeof parsed.data?.agentId === 'string' ? parsed.data.agentId : null,
            runId: typeof parsed.data?.runId === 'string' ? parsed.data.runId : null,
            startedAt: typeof parsed.data?.startedAt === 'number' ? parsed.data.startedAt : null,
          };
          setGroupRunState(nextState);
          if (!nextState.active) {
            setTypingAgents(new Map());
            batcher.flush();
            setMessages((prev) => removeEmptyAssistantBubbles(prev));
          }
        } else if (parsed.type === 'delete') {
          const deletedIds = Array.isArray(parsed.deletedIds)
            ? parsed.deletedIds.map((id: number | string) => String(id))
            : (parsed.id !== undefined ? [String(parsed.id)] : []);
          const deletedIdSet = new Set(deletedIds);
          const fallbackParentId = typeof parsed.fallbackParentId === 'number' || typeof parsed.fallbackParentId === 'string'
            ? String(parsed.fallbackParentId)
            : (parsed.parent_id ? String(parsed.parent_id) : null);
          forgetMessages(deletedIds);
          setMessages(prev => {
            const nextMessages = prev.filter((message) => !deletedIdSet.has(message.id));
            setActiveLeafId((prevLeaf) => {
              if (!prevLeaf || !deletedIdSet.has(prevLeaf)) {
                return prevLeaf;
              }
              if (fallbackParentId && nextMessages.some((message) => message.id === fallbackParentId)) {
                return fallbackParentId;
              }
              return getPreferredLeafId(nextMessages);
            });
            return nextMessages;
          });
        } else if (parsed.type === 'delta') {
          if (tombstones.has(String(parsed.id))) return;
          if (!messagesRef.current.some(message => message.id === String(parsed.id))) {
            upsertGroupStreamMessage(parsed);
          } else {
            const patch: Partial<ChatMessage> = {
              content: typeof parsed.content === 'string' ? parsed.content : '',
            };
            if (typeof parsed.process_content === 'string') patch.processContent = parsed.process_content;
            if (typeof parsed.process_streaming === 'boolean') patch.processStreaming = parsed.process_streaming;
            if (typeof parsed.messageCode === 'string') patch.messageCode = parsed.messageCode;
            if (parsed.messageParams && typeof parsed.messageParams === 'object') patch.messageParams = parsed.messageParams;
            if (typeof parsed.rawDetail === 'string') patch.rawDetail = parsed.rawDetail;
            if (parsed.sender_id === 'system') patch.role = 'system';
            if (typeof parsed.sender_id === 'string') patch.agentId = parsed.sender_id;
            if (typeof parsed.sender_name === 'string') patch.agentName = parsed.sender_name;
            batcher.push(String(parsed.id), patch);
          }
        } else if (parsed.type === 'edit') {
          if (tombstones.has(String(parsed.id))) return;
          flushPendingInto(String(parsed.id));
          dropQueuedMessagePatch(String(parsed.id));
          upsertGroupStreamMessage(parsed);
        }
      } catch {}
    };
    es.onerror = () => {
      if (newerHistoryPagesRef.current.length > 0) return;

      const now = Date.now();
      if (now - groupSseRecoveryAtRef.current < GROUP_SSE_RECOVERY_THROTTLE_MS) {
        return;
      }
      groupSseRecoveryAtRef.current = now;

      void (async () => {
        const recovery = await recoverGroupActiveRun();
        if (!recovery.ok) return;
        if (recovery.runState) {
          setGroupRunState(recovery.runState);
        }
        if (!recovery.active) {
          setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
          setTypingAgents(new Map());
          await recoverLatestGroupMessages(true);
        }
      })();
    };
    return () => {
      es.close();
      batcher.dispose();
      clearQueuedMessagePatches();
    };
  }, [activeKey, clearQueuedMessagePatches, dropQueuedMessagePatch, isGroup, queueMessagePatch, recoverGroupActiveRun, recoverLatestGroupMessages, resolveNextLiveGroupLeafId, upsertGroupStreamMessage]);

  useEffect(() => {
    if (!isGroup || !activeKey || !groupRunState.active || isInitialLoading || newerHistoryPagesRef.current.length > 0) {
      return;
    }

    const controller = new AbortController();
    let timerId: number | null = null;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      const recovery = await recoverGroupActiveRun(controller.signal);
      if (cancelled) return;
      if (recovery.runState) {
        setGroupRunState(recovery.runState);
      }
      if (recovery.ok && !recovery.active) {
        setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
        setTypingAgents(new Map());
        await recoverLatestGroupMessages(true);
        return;
      }
      timerId = window.setTimeout(() => {
        void poll();
      }, GROUP_ACTIVE_RUN_RECOVERY_POLL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      controller.abort();
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [activeKey, groupRunState.active, isGroup, isInitialLoading, recoverGroupActiveRun, recoverLatestGroupMessages]);

  useEffect(() => {
    if (!isGroup || !activeKey) {
      previousGroupRunActiveRef.current = false;
      return;
    }

    const wasActive = previousGroupRunActiveRef.current;
    previousGroupRunActiveRef.current = groupRunState.active;

    if (groupRunState.active || !wasActive || isInitialLoading || newerHistoryPagesRef.current.length > 0) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let timerId: number | null = null;
    const deadline = Date.now() + GROUP_POST_RUN_SETTLE_TIMEOUT_MS;

    const poll = async (focusLatest: boolean) => {
      if (cancelled || newerHistoryPagesRef.current.length > 0) return;

      const recovery = await recoverGroupActiveRun(controller.signal);
      if (recovery.runState) {
        setGroupRunState(recovery.runState);
      }
      if (cancelled || newerHistoryPagesRef.current.length > 0) return;

      await recoverLatestGroupMessages(focusLatest);
      if (cancelled || newerHistoryPagesRef.current.length > 0) return;

      if (Date.now() >= deadline) return;

      timerId = window.setTimeout(() => {
        void poll(false);
      }, GROUP_POST_RUN_SETTLE_POLL_MS);
    };

    void poll(true);

    return () => {
      cancelled = true;
      controller.abort();
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [activeKey, groupRunState.active, isGroup, isInitialLoading, recoverGroupActiveRun, recoverLatestGroupMessages]);

  return {
    loadGroups, resolveNextLiveGroupLeafId, mergeGroupMessagesIntoState, upsertGroupStreamMessage,
    recoverGroupActiveRun, recoverLatestGroupMessages,
  };
}

export type GroupEvents = ReturnType<typeof useGroupEvents>;
