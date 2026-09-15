// 会话内搜索：请求、结果跳转（必要时按锚点加载对应历史窗口）。
import { useEffect, useCallback } from 'react';
import { searchChatHistory } from '../../../api/chat';
import { searchGroupMessages } from '../../../api/groups';
import type { ChatMessage } from '../../../utils/message-merge';
import type { SearchMatch } from '../lib/types';
import type { ChatViewState } from './useChatViewState';
import type { ChatPresence } from './useChatPresence';
import type { HistoryEdgePrompt } from './useHistoryEdgePrompt';
import type { ChatHistoryFetch } from './useChatHistoryFetch';

/** 本段读取的、由前面各段产出的值。 */
type MessageSearchContext = Pick<
  ChatViewState & ChatPresence & HistoryEdgePrompt & ChatHistoryFetch,
  'mode' | 'isChat' | 'activeKey' | 'setMessages' | 'setActiveLeafId' | 'setIsLoadingOlder' |
  'setPageInfo' | 'debouncedMessageSearchQuery' | 'searchMatches' | 'setSearchMatches' |
  'currentMatchIndex' | 'setCurrentMatchIndex' | 'setTypingAgents' | 'messagesRef' |
  'historyContextRef' | 'pendingSearchFocusMessageIdRef' | 'searchRequestIdRef' |
  'searchNavigationIdRef' | 'olderLoadInFlightRef' | 'newerHistoryPagesRef' |
  'historyWindowScrollTargetRef' | 'historyWindowScrollLockRef' | 'historyWindowPagingGuardRef' |
  'skipNextAutoScrollRef' | 'visibleMessages' | 'clearHistoryEdgePrompt' | 'scrollToMessage' |
  'loadHistoryWindow'
>;

export function useMessageSearch(c: MessageSearchContext) {
  const {
    mode, isChat, activeKey, setMessages, setActiveLeafId, setIsLoadingOlder, setPageInfo,
    debouncedMessageSearchQuery, searchMatches, setSearchMatches, currentMatchIndex,
    setCurrentMatchIndex, setTypingAgents, messagesRef, historyContextRef,
    pendingSearchFocusMessageIdRef, searchRequestIdRef, searchNavigationIdRef,
    olderLoadInFlightRef, newerHistoryPagesRef, historyWindowScrollTargetRef,
    historyWindowScrollLockRef, historyWindowPagingGuardRef, skipNextAutoScrollRef,
    visibleMessages, clearHistoryEdgePrompt, scrollToMessage, loadHistoryWindow,
  } = c;
  const revealSearchMatchInLoadedMessages = useCallback((targetMessageId: string, nextMessages: ChatMessage[]): boolean => {
    if (!targetMessageId || !nextMessages.some((message) => message.id === targetMessageId)) {
      return false;
    }

    pendingSearchFocusMessageIdRef.current = null;
    scrollToMessage(targetMessageId);
    return true;
  }, [scrollToMessage]);

  const jumpToSearchMatch = useCallback(async (match: SearchMatch) => {
    if (!match.messageId || !activeKey) return;

    const navigationId = ++searchNavigationIdRef.current;
    if (revealSearchMatchInLoadedMessages(match.messageId, messagesRef.current)) {
      return;
    }

    const contextKey = `${mode}:${activeKey}`;

    try {
      const snapshot = await loadHistoryWindow({ beforeId: match.anchorBeforeId });
      if (
        !snapshot
        || historyContextRef.current !== contextKey
        || searchNavigationIdRef.current !== navigationId
        || !snapshot.messages.some((message) => message.id === match.messageId)
      ) {
        return;
      }

      clearHistoryEdgePrompt();
      olderLoadInFlightRef.current = false;
      newerHistoryPagesRef.current = [];
      historyWindowScrollTargetRef.current = null;
      historyWindowScrollLockRef.current = false;
      historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
      skipNextAutoScrollRef.current = true;
      setTypingAgents(new Map());
      setIsLoadingOlder(false);
      setPageInfo(snapshot.pageInfo);
      setMessages(snapshot.messages);
      pendingSearchFocusMessageIdRef.current = match.messageId;
      setActiveLeafId(snapshot.activeLeafId);
    } catch {}
  }, [activeKey, clearHistoryEdgePrompt, loadHistoryWindow, mode, revealSearchMatchInLoadedMessages]);

  useEffect(() => {
    const targetMessageId = pendingSearchFocusMessageIdRef.current;
    if (!targetMessageId) return;
    if (!visibleMessages.some((message) => message.id === targetMessageId)) return;

    const frameId = window.requestAnimationFrame(() => {
      if (!visibleMessages.some((message) => message.id === targetMessageId)) return;
      pendingSearchFocusMessageIdRef.current = null;
      scrollToMessage(targetMessageId);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [scrollToMessage, visibleMessages]);

  useEffect(() => {
    const normalizedQuery = debouncedMessageSearchQuery.trim();
    if (!activeKey || !normalizedQuery) {
      searchRequestIdRef.current += 1;
      searchNavigationIdRef.current += 1;
      pendingSearchFocusMessageIdRef.current = null;
      setSearchMatches([]);
      setCurrentMatchIndex(-1);
      return;
    }

    const requestId = ++searchRequestIdRef.current;
    const contextKey = `${mode}:${activeKey}`;
    let cancelled = false;

    const runSearch = async () => {
      try {
        const params = new URLSearchParams();
        params.set('q', normalizedQuery);
        const response = await (isChat ? searchChatHistory(activeKey, params) : searchGroupMessages(activeKey, params));
        const data = await response.json();

        if (cancelled || searchRequestIdRef.current !== requestId || historyContextRef.current !== contextKey) {
          return;
        }

        const nextMatches: SearchMatch[] = Array.isArray(data?.matches)
          ? data.matches
              .filter((match: any) => typeof match?.messageId === 'string' && match.messageId)
              .map((match: any) => ({
                messageId: match.messageId,
                anchorBeforeId: typeof match?.anchorBeforeId === 'number' ? match.anchorBeforeId : null,
              }))
          : [];

        setSearchMatches(nextMatches);
        if (nextMatches.length === 0) {
          setCurrentMatchIndex(-1);
          return;
        }

        const initialIndex = nextMatches.length - 1;
        setCurrentMatchIndex(initialIndex);
        void jumpToSearchMatch(nextMatches[initialIndex]);
      } catch {
        if (cancelled || searchRequestIdRef.current !== requestId || historyContextRef.current !== contextKey) {
          return;
        }
        setSearchMatches([]);
        setCurrentMatchIndex(-1);
      }
    };

    void runSearch();

    return () => {
      cancelled = true;
    };
  }, [activeKey, debouncedMessageSearchQuery, isChat, jumpToSearchMatch, mode]);

  const handleNextSearch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const nextIndex = currentMatchIndex < searchMatches.length - 1 ? currentMatchIndex + 1 : 0;
    setCurrentMatchIndex(nextIndex);
    void jumpToSearchMatch(searchMatches[nextIndex]);
  }, [currentMatchIndex, jumpToSearchMatch, searchMatches]);

  const handlePrevSearch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const nextIndex = currentMatchIndex > 0 ? currentMatchIndex - 1 : searchMatches.length - 1;
    setCurrentMatchIndex(nextIndex);
    void jumpToSearchMatch(searchMatches[nextIndex]);
  }, [currentMatchIndex, jumpToSearchMatch, searchMatches]);

  return {
    revealSearchMatchInLoadedMessages, jumpToSearchMatch, handleNextSearch, handlePrevSearch,
  };
}

export type MessageSearch = ReturnType<typeof useMessageSearch>;
