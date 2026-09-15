// 单聊运行控制（P1b）：服务端状态快照、会话实时通道、队列面板的取消与立即插入、别处开始的一轮接进时间线。
//
// - 进入会话 / 标签页回到前台 / 实时通道重连：拉 `GET /api/chat/:id/state`，按会话代次与事件游标合并（chatRunState.ts）；
// - 实时通道只收控制事件；正文由发起那一轮的 POST 流、或这里触发的接回流（useChatAttachRun）读；
// - `chat.user_message` 回声：另一个标签页发的、或自己排队后出队的一轮 → 补用户气泡与助手占位，再接回流；
// - 被「立即插入」让出的那一轮不当错误显示，只在气泡上标「已被插入的消息打断」。
import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelQueuedChatMessage, getChatRunState, insertQueuedChatMessage } from '../../../api/chat';
import { openChatLiveEvents } from '../../../api/stream';
import { mergeMessageCollectionPreservingContent } from '../../../utils/message-merge';
import {
  applyChatLiveEvent,
  applyChatRunSnapshot,
  createChatRunState,
  isQueueInsertionInterruption,
  type ChatLiveEvent,
  type ChatRunState,
} from '../run/chatRunState';
import { parseChatTurnEcho, planPeerTurnMessages } from '../run/peerTurns';
import { resolveSubmitError } from '../lib/messageMapping';
import type { ChatViewState } from './useChatViewState';

type ChatRunControlContext = Pick<
  ChatViewState,
  't' | 'isChat' | 'activeKey' | 'setMessages' | 'messagesRef' | 'setSubmitError' |
  'attachedRunControllerRef' | 'abortControllerRef' | 'isInitialLoading'
>;

export function useChatRunControl(c: ChatRunControlContext) {
  const { t, isChat, activeKey, setMessages, messagesRef, setSubmitError, attachedRunControllerRef, abortControllerRef, isInitialLoading } = c;
  const generationRef = useRef(0);
  const [runState, setRunState] = useState<ChatRunState>(() => createChatRunState(activeKey, 0));
  const runStateRef = useRef(runState);
  runStateRef.current = runState;
  /** 本标签页立即发送（自己读 POST 流）的那几轮的引用 id：它们的回声与 run.started 不触发接回。 */
  const locallyStreamedRefsRef = useRef<Set<string>>(new Set());
  const [attachRequest, setAttachRequest] = useState(0);
  const [insertPendingQueueId, setInsertPendingQueueId] = useState<string | null>(null);

  const requestAttach = useCallback(() => {
    // 本地流正在读（发起方自己）或接回流已经挂着：不重复接回。
    if (abortControllerRef.current || attachedRunControllerRef.current) return;
    setAttachRequest((value) => value + 1);
  }, []);

  const refreshRunState = useCallback(async () => {
    if (!isChat || !activeKey) return;
    const generation = generationRef.current;
    try {
      const response = await getChatRunState(activeKey);
      if (!response.ok) return;
      const snapshot = await response.json();
      setRunState((previous) => applyChatRunSnapshot(previous, generation, snapshot));
      if (snapshot?.activeRun && generation === generationRef.current) requestAttach();
    } catch {
      // 拿不到快照不致命：实时通道与接回流仍在。
    }
  }, [activeKey, isChat, requestAttach]);

  const markInterrupted = useCallback((messageId: unknown) => {
    if (typeof messageId !== 'number') return;
    const id = String(messageId);
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, interrupted: true } : message)));
  }, []);

  const handleLiveEvent = useCallback((generation: number, event: ChatLiveEvent) => {
    if (generation !== generationRef.current) return;
    setRunState((previous) => applyChatLiveEvent(previous, generation, event));
    const payload = event.payload ?? {};
    if (event.event === 'chat.user_message') {
      const echo = parseChatTurnEcho(payload);
      if (!echo) return;
      const additions = planPeerTurnMessages(messagesRef.current, echo, locallyStreamedRefsRef.current);
      if (additions) setMessages((prev) => mergeMessageCollectionPreservingContent(prev, additions));
      return;
    }
    if (event.event === 'run.started') {
      const ref = typeof payload.ref === 'string' ? payload.ref : null;
      if (ref && locallyStreamedRefsRef.current.has(ref)) return;
      requestAttach();
      return;
    }
    if ((event.event === 'run.aborted' || event.event === 'run.completed') && isQueueInsertionInterruption(payload)) {
      markInterrupted(payload.message_id);
    }
  }, [markInterrupted, requestAttach]);

  // 会话切换：开新代次、清状态、拉快照、开实时通道。
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setRunState(createChatRunState(activeKey, generation));
    setInsertPendingQueueId(null);
    locallyStreamedRefsRef.current = new Set();
    if (!isChat || !activeKey || isInitialLoading || typeof EventSource === 'undefined') return;

    let source: EventSource | null = openChatLiveEvents(activeKey);
    let sawError = false;
    source.onmessage = (message) => {
      let frame: any;
      try {
        frame = JSON.parse(message.data);
      } catch {
        return;
      }
      if (frame?.type === 'state') {
        setRunState((previous) => applyChatRunSnapshot(previous, generation, frame.state));
        if (frame.state?.activeRun) requestAttach();
        return;
      }
      if (frame?.type === 'event') handleLiveEvent(generation, { id: frame.id, event: frame.event, payload: frame.payload, runId: frame.runId });
    };
    source.onerror = () => { sawError = true; };
    source.onopen = () => {
      // 断线重连成功：服务端会先推一份 state；这里再兜一次历史对账，补上断线期间结束的那一轮。
      if (sawError) {
        sawError = false;
        void refreshRunState();
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshRunState();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      source?.close();
      source = null;
    };
  }, [activeKey, handleLiveEvent, isChat, isInitialLoading, refreshRunState, requestAttach]);

  const cancelQueued = useCallback(async (queueId: string) => {
    if (!activeKey) return;
    try {
      const response = await cancelQueuedChatMessage(activeKey, queueId);
      if (!response.ok && response.status !== 404) {
        setSubmitError(resolveSubmitError(await response.json().catch(() => ({})), t, 'chatQueue.cancelFailed'));
      }
    } catch (error: any) {
      setSubmitError(error?.message || String(t('chatQueue.cancelFailed')));
    } finally {
      void refreshRunState();
    }
  }, [activeKey, refreshRunState, t]);

  const insertQueued = useCallback(async (queueId: string) => {
    if (!activeKey || insertPendingQueueId) return;
    setInsertPendingQueueId(queueId);
    try {
      const response = await insertQueuedChatMessage(activeKey, queueId);
      if (!response.ok && response.status !== 404) {
        setSubmitError(resolveSubmitError(await response.json().catch(() => ({})), t, 'chatQueue.insertFailed'));
      }
    } catch (error: any) {
      setSubmitError(error?.message || String(t('chatQueue.insertFailed')));
    } finally {
      setInsertPendingQueueId(null);
      void refreshRunState();
    }
  }, [activeKey, insertPendingQueueId, refreshRunState, t]);

  return {
    runState, refreshRunState, locallyStreamedRefsRef, attachRequest, requestAttach,
    cancelQueued, insertQueued, insertPendingQueueId,
  };
}

export type ChatRunControl = ReturnType<typeof useChatRunControl>;
