// 历史窗口换页后的滚动定位、窗口裁剪、贴底判定与自动滚到底。
import { useEffect, useCallback, useLayoutEffect } from 'react';
import { areHistoryPageInfosEqual, areMessageListsEquivalent } from '../../../utils/history-window';
import { HISTORY_LOAD_TRIGGER_PX } from '../lib/constants';
import { isContainerNearBottom } from '../lib/scrollGeometry';
import type { ChatViewState } from './useChatViewState';
import type { NavDots } from './useNavDots';
import type { HistoryEdgePrompt } from './useHistoryEdgePrompt';

/** 本段读取的、由前面各段产出的值。 */
type HistoryScrollContext = Pick<
  ChatViewState & NavDots & HistoryEdgePrompt,
  'activeKey' | 'messages' | 'setMessages' | 'activeLeafId' | 'setActiveLeafId' |
  'isInitialLoading' | 'setIsLoadingOlder' | 'setHistoryPageNotice' | 'setPageInfo' |
  'typingAgents' | 'messagesEndRef' | 'scrollContainerRef' | 'isInitialLoad' | 'activeLeafIdRef' |
  'pageInfoRef' | 'olderLoadInFlightRef' | 'newerHistoryPagesRef' | 'historyWindowScrollTargetRef' |
  'historyWindowScrollLockRef' | 'historyWindowPagingGuardRef' | 'skipNextAutoScrollRef' |
  'isNearBottomRef' | 'forceAutoScrollRef' | 'getPreferredLeafId' |
  'getCurrentHistoryWindowSnapshot' | 'recalcNavDots' | 'handleNavScroll' |
  'clearHistoryEdgePrompt'
>;

export function useHistoryScroll(c: HistoryScrollContext) {
  const {
    activeKey, messages, setMessages, activeLeafId, setActiveLeafId, isInitialLoading,
    setIsLoadingOlder, setHistoryPageNotice, setPageInfo, typingAgents, messagesEndRef,
    scrollContainerRef, isInitialLoad, activeLeafIdRef, pageInfoRef, olderLoadInFlightRef,
    newerHistoryPagesRef, historyWindowScrollTargetRef, historyWindowScrollLockRef,
    historyWindowPagingGuardRef, skipNextAutoScrollRef, isNearBottomRef, forceAutoScrollRef,
    getPreferredLeafId, getCurrentHistoryWindowSnapshot, recalcNavDots, handleNavScroll,
    clearHistoryEdgePrompt,
  } = c;
  useLayoutEffect(() => {
    const scrollTarget = historyWindowScrollTargetRef.current;
    const container = scrollContainerRef.current;
    if (!scrollTarget || !container) return;

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const bufferOffset = HISTORY_LOAD_TRIGGER_PX * 2;

    if (scrollTarget === 'bottom') {
      container.scrollTop = Math.max(0, maxScrollTop - bufferOffset);
    } else {
      container.scrollTop = Math.min(maxScrollTop, bufferOffset);
    }

    historyWindowScrollTargetRef.current = null;
    window.requestAnimationFrame(() => {
      recalcNavDots();
      handleNavScroll();
      isNearBottomRef.current = isContainerNearBottom(container);
      historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
      historyWindowScrollLockRef.current = false;
    });
  }, [handleNavScroll, messages, recalcNavDots]);

  useLayoutEffect(() => {
    if (isInitialLoading || historyWindowScrollLockRef.current) return;
    if (messages.length === 0) return;

    const snapshot = getCurrentHistoryWindowSnapshot(messages, activeLeafId);
    const sameMessages = areMessageListsEquivalent(snapshot.messages, messages);
    const sameLeaf = snapshot.activeLeafId === activeLeafId;
    const samePageInfo = areHistoryPageInfosEqual(snapshot.pageInfo, pageInfoRef.current);

    if (sameMessages && sameLeaf && samePageInfo) {
      return;
    }

    if (!sameMessages) {
      setMessages(snapshot.messages);
    }
    if (!sameLeaf) {
      setActiveLeafId(snapshot.activeLeafId);
    }
    if (!samePageInfo) {
      setPageInfo(snapshot.pageInfo);
    }
  }, [activeLeafId, getCurrentHistoryWindowSnapshot, isInitialLoading, messages]);

  const updateNearBottomState = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    isNearBottomRef.current = isContainerNearBottom(container);
  }, []);

  const scrollToLatestBottom = useCallback(() => {
    forceAutoScrollRef.current = true;
    window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      updateNearBottomState();
    });
  }, [updateNearBottomState]);

  const prepareLatestHistoryWindowForSubmit = useCallback(() => {
    const latestSnapshot = newerHistoryPagesRef.current[0];
    if (!latestSnapshot) {
      forceAutoScrollRef.current = true;
      return activeLeafIdRef.current;
    }

    clearHistoryEdgePrompt();
    olderLoadInFlightRef.current = false;
    newerHistoryPagesRef.current = [];
    historyWindowScrollTargetRef.current = null;
    historyWindowScrollLockRef.current = false;
    historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
    skipNextAutoScrollRef.current = false;
    setHistoryPageNotice(null);
    setIsLoadingOlder(false);
    forceAutoScrollRef.current = true;

    const nextLeafId = latestSnapshot.activeLeafId && latestSnapshot.messages.some(message => message.id === latestSnapshot.activeLeafId)
      ? latestSnapshot.activeLeafId
      : getPreferredLeafId(latestSnapshot.messages);

    setPageInfo(latestSnapshot.pageInfo);
    setMessages(latestSnapshot.messages);
    setActiveLeafId(nextLeafId);

    return nextLeafId;
  }, [clearHistoryEdgePrompt, getPreferredLeafId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    updateNearBottomState();
    const handle = () => updateNearBottomState();
    container.addEventListener('scroll', handle, { passive: true });
    return () => container.removeEventListener('scroll', handle);
  }, [updateNearBottomState]);

  // ---- Scroll to bottom ----
  useEffect(() => {
    isInitialLoad.current = true;
    isNearBottomRef.current = true;
    forceAutoScrollRef.current = false;
  }, [activeKey]);

  useEffect(() => {
    if (messages.length === 0) return;
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    const shouldAutoScroll = isInitialLoad.current || forceAutoScrollRef.current || isNearBottomRef.current;
    if (!shouldAutoScroll) return;
    const timer = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      if (isInitialLoad.current) isInitialLoad.current = false;
      forceAutoScrollRef.current = false;
      updateNearBottomState();
    }, 50);
    return () => clearTimeout(timer);
  }, [messages, typingAgents, activeKey, updateNearBottomState]);

  return { updateNearBottomState, scrollToLatestBottom, prepareLatestHistoryWindowForSubmit };
}

export type HistoryScroll = ReturnType<typeof useHistoryScroll>;
