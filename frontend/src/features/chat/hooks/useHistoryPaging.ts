// 首屏加载 loadHistory（只用于切换单聊 / 群聊后的首屏初始化）、向前 / 向后翻页与滚轮、触摸手势。
import { useEffect, useCallback } from 'react';
import { createEmptyHistoryPageInfo } from '../../../utils/history-window';
import { HISTORY_LOAD_TRIGGER_PX, HISTORY_TOUCH_TRIGGER_PX } from '../lib/constants';
import { resolveProcessTagPair, isLikelyInactiveGroupMessageStale } from '../lib/processTags';
import type { ChatViewState } from './useChatViewState';
import type { ChatPresence } from './useChatPresence';
import type { MessagePatchQueue } from './useMessagePatchQueue';
import type { HistoryEdgePrompt } from './useHistoryEdgePrompt';
import type { ChatHistoryFetch } from './useChatHistoryFetch';

/** 本段读取的、由前面各段产出的值。 */
type HistoryPagingContext = Pick<
  ChatViewState & ChatPresence & MessagePatchQueue & HistoryEdgePrompt & ChatHistoryFetch,
  't' | 'mode' | 'isGroup' | 'activeKey' | 'messages' | 'setMessages' | 'setIsLoading' |
  'setSubmitError' | 'setActiveLeafId' | 'isInitialLoading' | 'setIsInitialLoading' |
  'isLoadingOlder' | 'setIsLoadingOlder' | 'historyPageRounds' | 'historyEdgePrompt' |
  'setHistoryPageNotice' | 'pageInfo' | 'setPageInfo' | 'setTypingAgents' | 'groupRunState' |
  'scrollContainerRef' | 'messagesRef' | 'activeLeafIdRef' | 'lastAppliedHistoryPageRoundsRef' |
  'historyContextRef' | 'navDotPagingLockedRef' | 'historyEdgePromptReadyRef' |
  'touchPagingStartYRef' | 'touchPagingHandledRef' | 'touchPagingArmedInCurrentGestureRef' |
  'olderLoadInFlightRef' | 'staleGroupReloadAttemptRef' | 'newerHistoryPagesRef' |
  'historyWindowScrollTargetRef' | 'historyWindowScrollLockRef' | 'historyWindowPagingGuardRef' |
  'skipNextAutoScrollRef' | 'currentGroup' | 'findSessionByAgentId' | 'getPreferredLeafId' |
  'historyFetchBatchLimit' | 'visibleMessages' | 'clearQueuedMessagePatches' |
  'clearHistoryEdgePrompt' | 'armHistoryEdgePrompt' | 'showHistoryPageNotice' |
  'clearNavDotPagingUnlockTimer' | 'scheduleNavDotPagingUnlock' | 'loadHistoryWindow'
>;

export function useHistoryPaging(c: HistoryPagingContext) {
  const {
    t, mode, isGroup, activeKey, messages, setMessages, setIsLoading, setSubmitError,
    setActiveLeafId, isInitialLoading, setIsInitialLoading, isLoadingOlder, setIsLoadingOlder,
    historyPageRounds, historyEdgePrompt, setHistoryPageNotice, pageInfo, setPageInfo,
    setTypingAgents, groupRunState, scrollContainerRef, messagesRef, activeLeafIdRef,
    lastAppliedHistoryPageRoundsRef, historyContextRef, navDotPagingLockedRef,
    historyEdgePromptReadyRef, touchPagingStartYRef, touchPagingHandledRef,
    touchPagingArmedInCurrentGestureRef, olderLoadInFlightRef, staleGroupReloadAttemptRef,
    newerHistoryPagesRef, historyWindowScrollTargetRef, historyWindowScrollLockRef,
    historyWindowPagingGuardRef, skipNextAutoScrollRef, currentGroup, findSessionByAgentId,
    getPreferredLeafId, historyFetchBatchLimit, visibleMessages, clearQueuedMessagePatches,
    clearHistoryEdgePrompt, armHistoryEdgePrompt, showHistoryPageNotice,
    clearNavDotPagingUnlockTimer, scheduleNavDotPagingUnlock, loadHistoryWindow,
  } = c;
  // Initial-page loader only: fetch the latest history window for the current chat/group context.
  // This should not be used as a generic post-send refresh, otherwise it would replace the current page window.
  const loadHistory = useCallback(async ({ showSkeleton = false }: { showSkeleton?: boolean } = {}) => {
    if (!activeKey) {
      if (showSkeleton) setIsInitialLoading(false);
      return;
    }

    const contextKey = `${mode}:${activeKey}`;
    clearQueuedMessagePatches();
    olderLoadInFlightRef.current = false;
    newerHistoryPagesRef.current = [];
    historyWindowScrollTargetRef.current = null;
    historyWindowScrollLockRef.current = false;
    historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
    skipNextAutoScrollRef.current = false;
    clearHistoryEdgePrompt();
    setHistoryPageNotice(null);
    setIsLoadingOlder(false);

    if (showSkeleton) {
      setIsInitialLoading(true);
      setMessages([]);
      setActiveLeafId(null);
      setPageInfo(createEmptyHistoryPageInfo(historyFetchBatchLimit));
    }

    try {
      const result = await loadHistoryWindow();
      if (!result || historyContextRef.current !== contextKey) return;

      setTypingAgents(new Map());
      setMessages(result.messages);
      setPageInfo(result.pageInfo);
      setActiveLeafId(result.activeLeafId);
      setSubmitError('');
    } catch (error: any) {
      // 之前是 catch {}：showSkeleton 已经把消息清空了，加载失败就变成一个
      // 「空会话」——用户以为聊天记录没了，实际只是这次没拉到。必须说清楚。
      if (historyContextRef.current === contextKey) {
        setSubmitError(error?.message || t('unifiedChat.historyLoadFailed'));
      }
    }
    finally {
      if (showSkeleton && historyContextRef.current === contextKey) {
        setIsInitialLoading(false);
      }
    }
  }, [activeKey, clearHistoryEdgePrompt, clearQueuedMessagePatches, loadHistoryWindow, mode]);

  useEffect(() => {
    const previousRounds = lastAppliedHistoryPageRoundsRef.current;
    if (previousRounds === historyPageRounds) return;
    lastAppliedHistoryPageRoundsRef.current = historyPageRounds;

    if (!activeKey) return;
    loadHistory({ showSkeleton: true });
  }, [activeKey, historyPageRounds, loadHistory]);

  useEffect(() => {
    if (!isGroup || !activeKey || isInitialLoading || groupRunState.active || newerHistoryPagesRef.current.length > 0) {
      staleGroupReloadAttemptRef.current = null;
      return;
    }

    const latestVisibleMessage = [...visibleMessages].reverse().find((message) => message.role !== 'user');
    if (!latestVisibleMessage || latestVisibleMessage.role !== 'assistant') {
      staleGroupReloadAttemptRef.current = null;
      return;
    }

    const { startTag: processStartTag, endTag: processEndTag } = resolveProcessTagPair(
      currentGroup?.process_start_tag,
      currentGroup?.process_end_tag,
      findSessionByAgentId(latestVisibleMessage.agentId)?.process_start_tag,
      findSessionByAgentId(latestVisibleMessage.agentId)?.process_end_tag,
    );
    const needsReconcile = isLikelyInactiveGroupMessageStale(latestVisibleMessage.content, processStartTag, processEndTag);

    if (!needsReconcile) {
      staleGroupReloadAttemptRef.current = null;
      return;
    }

    const attemptKey = `${mode}:${activeKey}:${latestVisibleMessage.id}:${latestVisibleMessage.content.length}:${latestVisibleMessage.content.slice(0, 120)}`;
    if (staleGroupReloadAttemptRef.current === attemptKey) {
      return;
    }

    staleGroupReloadAttemptRef.current = attemptKey;
    void loadHistory();
  }, [
    activeKey,
    currentGroup?.process_end_tag,
    currentGroup?.process_start_tag,
    findSessionByAgentId,
    groupRunState.active,
    isGroup,
    isInitialLoading,
    loadHistory,
    mode,
    visibleMessages,
  ]);

  const loadOlderHistory = useCallback(async () => {
    if (
      !activeKey
      || isInitialLoading
      || olderLoadInFlightRef.current
      || historyWindowScrollLockRef.current
      || !pageInfo.hasMoreOlder
      || pageInfo.nextBeforeId === null
    ) return;

    const contextKey = `${mode}:${activeKey}`;
    olderLoadInFlightRef.current = true;
    setIsLoadingOlder(true);
    clearHistoryEdgePrompt();

    try {
      const result = await loadHistoryWindow({ beforeId: pageInfo.nextBeforeId });
      if (!result || historyContextRef.current !== contextKey || result.messages.length === 0) return;

      newerHistoryPagesRef.current.push({
        messages: messagesRef.current,
        activeLeafId: activeLeafIdRef.current,
        pageInfo,
      });

      historyWindowScrollLockRef.current = true;
      historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: false };
      historyWindowScrollTargetRef.current = 'bottom';
      skipNextAutoScrollRef.current = true;
      setTypingAgents(new Map());
      setMessages(result.messages);
      setPageInfo(result.pageInfo);
      setActiveLeafId(result.activeLeafId);
      showHistoryPageNotice('older');
    } catch {}
    finally {
      olderLoadInFlightRef.current = false;
      if (historyContextRef.current === contextKey) {
        setIsLoadingOlder(false);
      }
    }
  }, [activeKey, clearHistoryEdgePrompt, isInitialLoading, loadHistoryWindow, mode, pageInfo, showHistoryPageNotice]);

  const loadNewerHistory = useCallback(() => {
    if (isInitialLoading || isLoadingOlder || historyWindowScrollLockRef.current) return;

    const snapshot = newerHistoryPagesRef.current.pop();
    if (!snapshot) return;

    clearHistoryEdgePrompt();
    historyWindowScrollLockRef.current = true;
    historyWindowPagingGuardRef.current = { allowOlder: false, allowNewer: true };
    historyWindowScrollTargetRef.current = 'top';
    skipNextAutoScrollRef.current = true;
    setTypingAgents(new Map());
    setMessages(snapshot.messages);
    setPageInfo(snapshot.pageInfo);
    setActiveLeafId(
      snapshot.activeLeafId && snapshot.messages.some(message => message.id === snapshot.activeLeafId)
        ? snapshot.activeLeafId
        : getPreferredLeafId(snapshot.messages)
    );
    showHistoryPageNotice('newer');
  }, [clearHistoryEdgePrompt, getPreferredLeafId, isInitialLoading, isLoadingOlder, showHistoryPageNotice]);

  const handleHistoryWindowOnScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || isInitialLoading || isLoadingOlder || historyWindowScrollLockRef.current || messagesRef.current.length === 0) return;
    if (navDotPagingLockedRef.current) {
      scheduleNavDotPagingUnlock();
      return;
    }

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const rearmThreshold = HISTORY_LOAD_TRIGGER_PX * 2;
    const canPromptOlder = historyWindowPagingGuardRef.current.allowOlder && pageInfo.hasMoreOlder && pageInfo.nextBeforeId !== null;
    const canPromptNewer = historyWindowPagingGuardRef.current.allowNewer && newerHistoryPagesRef.current.length > 0;

    if (!historyWindowPagingGuardRef.current.allowOlder && container.scrollTop > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowOlder = true;
    }
    if (!historyWindowPagingGuardRef.current.allowNewer && distanceFromBottom > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowNewer = true;
    }

    if (historyEdgePrompt === 'older' && (!canPromptOlder || container.scrollTop > rearmThreshold)) {
      clearHistoryEdgePrompt();
      return;
    }

    if (historyEdgePrompt === 'newer' && (!canPromptNewer || distanceFromBottom > rearmThreshold)) {
      clearHistoryEdgePrompt();
      return;
    }

    if (container.scrollTop <= HISTORY_LOAD_TRIGGER_PX && canPromptOlder) {
      armHistoryEdgePrompt('older');
      return;
    }

    if (distanceFromBottom <= HISTORY_LOAD_TRIGGER_PX && canPromptNewer) {
      armHistoryEdgePrompt('newer');
    }
  }, [armHistoryEdgePrompt, clearHistoryEdgePrompt, historyEdgePrompt, isInitialLoading, isLoadingOlder, pageInfo, scheduleNavDotPagingUnlock]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleHistoryWindowOnScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleHistoryWindowOnScroll);
  }, [handleHistoryWindowOnScroll]);

  const handleHistoryWindowWheel = useCallback((event: WheelEvent) => {
    const container = scrollContainerRef.current;
    if (!container || isInitialLoading || isLoadingOlder || historyWindowScrollLockRef.current || messagesRef.current.length === 0) return;

    if (navDotPagingLockedRef.current) {
      clearNavDotPagingUnlockTimer();
      navDotPagingLockedRef.current = false;
    }

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const rearmThreshold = HISTORY_LOAD_TRIGGER_PX * 2;
    const canPromptOlder = historyWindowPagingGuardRef.current.allowOlder && pageInfo.hasMoreOlder && pageInfo.nextBeforeId !== null;
    const canPromptNewer = historyWindowPagingGuardRef.current.allowNewer && newerHistoryPagesRef.current.length > 0;

    if (!historyWindowPagingGuardRef.current.allowOlder && container.scrollTop > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowOlder = true;
    }
    if (!historyWindowPagingGuardRef.current.allowNewer && distanceFromBottom > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowNewer = true;
    }

    if (event.deltaY < 0) {
      if (historyEdgePrompt === 'newer') {
        clearHistoryEdgePrompt();
      }

      if (canPromptOlder && container.scrollTop <= HISTORY_LOAD_TRIGGER_PX) {
        if (historyEdgePrompt === 'older' && historyEdgePromptReadyRef.current) {
          loadOlderHistory();
        } else {
          armHistoryEdgePrompt('older');
        }
      }
      return;
    }

    if (event.deltaY > 0) {
      if (historyEdgePrompt === 'older') {
        clearHistoryEdgePrompt();
      }

      if (canPromptNewer && distanceFromBottom <= HISTORY_LOAD_TRIGGER_PX) {
        if (historyEdgePrompt === 'newer' && historyEdgePromptReadyRef.current) {
          loadNewerHistory();
        } else {
          armHistoryEdgePrompt('newer');
        }
      }
    }
  }, [armHistoryEdgePrompt, clearHistoryEdgePrompt, clearNavDotPagingUnlockTimer, historyEdgePrompt, isInitialLoading, isLoadingOlder, loadNewerHistory, loadOlderHistory, pageInfo]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('wheel', handleHistoryWindowWheel, { passive: true });
    return () => container.removeEventListener('wheel', handleHistoryWindowWheel);
  }, [handleHistoryWindowWheel]);

  const handleHistoryWindowTouchStart = useCallback((event: TouchEvent) => {
    const firstTouch = event.touches[0];
    touchPagingStartYRef.current = firstTouch ? firstTouch.clientY : null;
    touchPagingHandledRef.current = false;
    touchPagingArmedInCurrentGestureRef.current = false;
  }, []);

  const handleHistoryWindowTouchMove = useCallback((event: TouchEvent) => {
    const container = scrollContainerRef.current;
    const firstTouch = event.touches[0];
    if (
      !container
      || !firstTouch
      || touchPagingStartYRef.current === null
      || touchPagingHandledRef.current
      || isInitialLoading
      || isLoadingOlder
      || historyWindowScrollLockRef.current
      || messagesRef.current.length === 0
    ) return;

    const dragDeltaY = firstTouch.clientY - touchPagingStartYRef.current;
    if (Math.abs(dragDeltaY) < HISTORY_TOUCH_TRIGGER_PX) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const rearmThreshold = HISTORY_LOAD_TRIGGER_PX * 2;
    const canPromptOlder = historyWindowPagingGuardRef.current.allowOlder && pageInfo.hasMoreOlder && pageInfo.nextBeforeId !== null;
    const canPromptNewer = historyWindowPagingGuardRef.current.allowNewer && newerHistoryPagesRef.current.length > 0;

    if (!historyWindowPagingGuardRef.current.allowOlder && container.scrollTop > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowOlder = true;
    }
    if (!historyWindowPagingGuardRef.current.allowNewer && distanceFromBottom > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowNewer = true;
    }

    if (dragDeltaY > 0) {
      if (historyEdgePrompt === 'newer') {
        clearHistoryEdgePrompt();
      }

      if (canPromptOlder && container.scrollTop <= HISTORY_LOAD_TRIGGER_PX) {
        if (
          historyEdgePrompt === 'older'
          && historyEdgePromptReadyRef.current
          && !touchPagingArmedInCurrentGestureRef.current
        ) {
          touchPagingHandledRef.current = true;
          loadOlderHistory();
        } else {
          touchPagingHandledRef.current = true;
          touchPagingArmedInCurrentGestureRef.current = true;
          armHistoryEdgePrompt('older');
        }
      }
      return;
    }

    if (dragDeltaY < 0) {
      if (historyEdgePrompt === 'older') {
        clearHistoryEdgePrompt();
      }

      if (canPromptNewer && distanceFromBottom <= HISTORY_LOAD_TRIGGER_PX) {
        if (
          historyEdgePrompt === 'newer'
          && historyEdgePromptReadyRef.current
          && !touchPagingArmedInCurrentGestureRef.current
        ) {
          touchPagingHandledRef.current = true;
          loadNewerHistory();
        } else {
          touchPagingHandledRef.current = true;
          touchPagingArmedInCurrentGestureRef.current = true;
          armHistoryEdgePrompt('newer');
        }
      }
    }
  }, [armHistoryEdgePrompt, clearHistoryEdgePrompt, historyEdgePrompt, isInitialLoading, isLoadingOlder, loadNewerHistory, loadOlderHistory, pageInfo]);

  useEffect(() => {
    if (messages.length > 0) return;
    clearHistoryEdgePrompt();
    setHistoryPageNotice(null);
  }, [clearHistoryEdgePrompt, messages.length]);

  const handleHistoryWindowTouchEnd = useCallback(() => {
    touchPagingStartYRef.current = null;
    touchPagingHandledRef.current = false;
    touchPagingArmedInCurrentGestureRef.current = false;
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('touchstart', handleHistoryWindowTouchStart, { passive: true });
    container.addEventListener('touchmove', handleHistoryWindowTouchMove, { passive: true });
    container.addEventListener('touchend', handleHistoryWindowTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleHistoryWindowTouchEnd, { passive: true });
    return () => {
      container.removeEventListener('touchstart', handleHistoryWindowTouchStart);
      container.removeEventListener('touchmove', handleHistoryWindowTouchMove);
      container.removeEventListener('touchend', handleHistoryWindowTouchEnd);
      container.removeEventListener('touchcancel', handleHistoryWindowTouchEnd);
    };
  }, [handleHistoryWindowTouchEnd, handleHistoryWindowTouchMove, handleHistoryWindowTouchStart]);

  useEffect(() => {
    clearQueuedMessagePatches();
    olderLoadInFlightRef.current = false;
    newerHistoryPagesRef.current = [];
    historyWindowScrollTargetRef.current = null;
    historyWindowScrollLockRef.current = false;
    historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
    clearNavDotPagingUnlockTimer();
    navDotPagingLockedRef.current = false;
    clearHistoryEdgePrompt();
    setHistoryPageNotice(null);
    skipNextAutoScrollRef.current = false;
    setIsLoading(false);

    if (!activeKey) {
      setMessages([]);
      setActiveLeafId(null);
      setPageInfo(createEmptyHistoryPageInfo(historyFetchBatchLimit));
      setIsLoadingOlder(false);
      setIsInitialLoading(false);
      return;
    }

    loadHistory({ showSkeleton: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, clearHistoryEdgePrompt, clearNavDotPagingUnlockTimer, mode]);

  return {
    loadHistory, loadOlderHistory, loadNewerHistory, handleHistoryWindowOnScroll,
    handleHistoryWindowWheel, handleHistoryWindowTouchStart, handleHistoryWindowTouchMove,
    handleHistoryWindowTouchEnd,
  };
}

export type HistoryPaging = ReturnType<typeof useHistoryPaging>;
