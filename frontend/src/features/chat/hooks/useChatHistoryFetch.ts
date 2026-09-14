// 历史分页请求（beforeId + limit）、单聊对账与运行中 run 的轮询兜底、按轮数拼历史窗口。
import { useEffect, useCallback } from 'react';
import { getConfig } from '../../../api/config';
import { getChatActiveRun, getChatHistory } from '../../../api/chat';
import { getGroupMessages } from '../../../api/groups';
import {
  type ChatMessage, mergeMessageCollectionPreservingContent,
} from '../../../utils/message-merge';
import {
  HISTORY_FETCH_BATCH_MIN_LIMIT, type HistoryPageInfo, type HistoryPageSnapshot,
  normalizeHistoryPageInfo, createEmptyHistoryPageInfo, buildLinearHistoryWindowSnapshot,
} from '../../../utils/history-window';
import {
  HISTORY_WINDOW_MAX_FETCH_BATCHES, CHAT_ACTIVE_RUN_RECOVERY_POLL_MS,
} from '../lib/constants';
import { mergeHistoryMessages, mapChatHistoryMessage, mapGroupMsg } from '../lib/messageMapping';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type ChatHistoryFetchContext = Pick<
  ChatViewState,
  'mode' | 'sessions' | 'isChat' | 'activeKey' | 'setMessages' | 'isLoading' | 'setIsLoading' |
  'setActiveLeafId' | 'isInitialLoading' | 'historyPageRounds' | 'setCurrentModel' | 'aiName' |
  'messagesRef' | 'historyContextRef' | 'getPreferredLeafId' | 'countVisibleUserRounds' |
  'historyFetchBatchLimit'
>;

export function useChatHistoryFetch(c: ChatHistoryFetchContext) {
  const {
    mode, sessions, isChat, activeKey, setMessages, isLoading, setIsLoading, setActiveLeafId,
    isInitialLoading, historyPageRounds, setCurrentModel, aiName, messagesRef, historyContextRef,
    getPreferredLeafId, countVisibleUserRounds, historyFetchBatchLimit,
  } = c;
  const mapChatHistoryPageMessages = useCallback((rawMessages: any[]) => {
    const loadTimeSession = sessions.find(s => s.id === activeKey);
    const loadTimeAgentName = loadTimeSession?.name || aiName || '';
    return rawMessages.map((m: any) => {
      const historyMessage = mapChatHistoryMessage(m);
      return {
        ...historyMessage,
        agentName: historyMessage.agentName || loadTimeAgentName || undefined,
      };
    });
  }, [activeKey, aiName, sessions]);

  const fetchHistoryPage = useCallback(async (
    { beforeId = null, limit = historyFetchBatchLimit }: { beforeId?: number | null; limit?: number } = {}
  ): Promise<{ messages: ChatMessage[]; pageInfo: HistoryPageInfo } | null> => {
    if (!activeKey) return null;

    const contextKey = `${mode}:${activeKey}`;

    if (isChat && beforeId === null) {
      try {
        const configRes = await getConfig();
        const configData = await configRes.json();
        if (
          historyContextRef.current === contextKey &&
          configData?.defaultAgent &&
          configData.defaultAgent !== 'main'
        ) {
          setCurrentModel(configData.defaultAgent);
        }
      } catch {}
    }

    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (typeof beforeId === 'number') params.set('beforeId', String(beforeId));

    const response = await (isChat ? getChatHistory(activeKey, params) : getGroupMessages(activeKey, params));
    const data = await response.json();

    if (!data?.success || !Array.isArray(data.messages)) return null;

    return {
      messages: isChat ? mapChatHistoryPageMessages(data.messages) : data.messages.map((m: any) => mapGroupMsg(m)),
      pageInfo: normalizeHistoryPageInfo(data.pageInfo, limit),
    };
  }, [activeKey, historyFetchBatchLimit, isChat, mapChatHistoryPageMessages, mode]);

  const mergeChatMessagesIntoState = useCallback((
    incomingMessages: ChatMessage[],
    options?: { focusLatest?: boolean }
  ) => {
    if (incomingMessages.length === 0) return;

    const nextMessages = mergeMessageCollectionPreservingContent(messagesRef.current, incomingMessages);

    setMessages((prev) => {
      return mergeMessageCollectionPreservingContent(prev, incomingMessages);
    });

    if (options?.focusLatest) {
      setActiveLeafId(getPreferredLeafId(nextMessages));
    }
  }, [getPreferredLeafId]);

  const recoverLatestChatMessages = useCallback(async (focusLatest = false) => {
    if (!isChat || !activeKey) return false;

    try {
      const result = await fetchHistoryPage({
        limit: Math.max(HISTORY_FETCH_BATCH_MIN_LIMIT, Math.min(historyFetchBatchLimit, 80)),
      });
      if (!result || result.messages.length === 0) {
        return false;
      }

      mergeChatMessagesIntoState(result.messages, { focusLatest });
      return true;
    } catch {
      return false;
    }
  }, [activeKey, fetchHistoryPage, historyFetchBatchLimit, isChat, mergeChatMessagesIntoState]);

  const recoverChatActiveRun = useCallback(async (signal?: AbortSignal) => {
    if (!isChat || !activeKey) return { ok: false as const, active: false as const };

    try {
      const response = await getChatActiveRun(activeKey, signal);
      const data = await response.json();
      if (!data?.success) {
        return { ok: false as const, active: false as const };
      }
      return { ok: true as const, active: !!data.active };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return { ok: false as const, active: false as const };
      }
      return { ok: false as const, active: false as const };
    }
  }, [activeKey, isChat]);

  useEffect(() => {
    if (!isChat || !activeKey || !isLoading || isInitialLoading) return;

    let cancelled = false;
    const controller = new AbortController();
    let timer: number | null = null;

    const poll = async () => {
      const recovery = await recoverChatActiveRun(controller.signal);
      if (cancelled || controller.signal.aborted) return;

      if (recovery.ok && !recovery.active) {
        await recoverLatestChatMessages(true);
        if (!cancelled && !controller.signal.aborted) {
          setIsLoading(false);
        }
        return;
      }

      timer = window.setTimeout(poll, CHAT_ACTIVE_RUN_RECOVERY_POLL_MS);
    };

    timer = window.setTimeout(poll, CHAT_ACTIVE_RUN_RECOVERY_POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [activeKey, isChat, isInitialLoading, isLoading, recoverChatActiveRun, recoverLatestChatMessages]);

  const loadHistoryWindow = useCallback(async (
    { beforeId = null }: { beforeId?: number | null } = {}
  ): Promise<HistoryPageSnapshot | null> => {
    let cursorBeforeId = beforeId;
    let accumulatedMessages: ChatMessage[] = [];
    let currentPageInfo = createEmptyHistoryPageInfo(historyFetchBatchLimit);

    for (let batchIndex = 0; batchIndex < HISTORY_WINDOW_MAX_FETCH_BATCHES; batchIndex += 1) {
      const result = await fetchHistoryPage({ beforeId: cursorBeforeId, limit: historyFetchBatchLimit });
      if (!result) {
        if (accumulatedMessages.length === 0) {
          return null;
        }

        return buildLinearHistoryWindowSnapshot(
          accumulatedMessages,
          currentPageInfo,
          historyPageRounds,
          getPreferredLeafId,
        );
      }

      accumulatedMessages = mergeHistoryMessages(result.messages, accumulatedMessages);
      currentPageInfo = result.pageInfo;

      const visibleUserRounds = countVisibleUserRounds(accumulatedMessages);
      if (visibleUserRounds >= historyPageRounds || !currentPageInfo.hasMoreOlder || currentPageInfo.nextBeforeId === null) {
        return buildLinearHistoryWindowSnapshot(
          accumulatedMessages,
          currentPageInfo,
          historyPageRounds,
          getPreferredLeafId,
        );
      }

      cursorBeforeId = currentPageInfo.nextBeforeId;
    }

    return buildLinearHistoryWindowSnapshot(
      accumulatedMessages,
      currentPageInfo,
      historyPageRounds,
      getPreferredLeafId,
    );
  }, [countVisibleUserRounds, fetchHistoryPage, getPreferredLeafId, historyFetchBatchLimit, historyPageRounds]);

  return {
    mapChatHistoryPageMessages, fetchHistoryPage, mergeChatMessagesIntoState,
    recoverLatestChatMessages, recoverChatActiveRun, loadHistoryWindow,
  };
}

export type ChatHistoryFetch = ReturnType<typeof useChatHistoryFetch>;
