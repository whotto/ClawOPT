// 翻页边缘提示（先提示、再次滚动才翻页）、翻页通知、导航点跳转期间的翻页锁、定位到消息。
import { useEffect, useCallback } from 'react';
import {
  SEARCH_MATCH_HIGHLIGHT_DURATION_MS, NAV_DOT_PAGING_UNLOCK_DEBOUNCE_MS,
} from '../lib/constants';
import type { HistoryPagingDirection } from '../lib/types';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type HistoryEdgePromptContext = Pick<
  ChatViewState,
  'setActiveHighlightId' | 'setHistoryEdgePrompt' | 'historyPageNotice' | 'setHistoryPageNotice' |
  'scrollContainerRef' | 'navDotPagingLockedRef' | 'navDotPagingUnlockTimerRef' |
  'historyEdgePromptReadyRef' | 'historyEdgePromptArmTimerRef' | 'historyPageNoticeTimerRef' |
  'activeHighlightTimerRef'
>;

export function useHistoryEdgePrompt(c: HistoryEdgePromptContext) {
  const {
    setActiveHighlightId, setHistoryEdgePrompt, historyPageNotice, setHistoryPageNotice,
    scrollContainerRef, navDotPagingLockedRef, navDotPagingUnlockTimerRef,
    historyEdgePromptReadyRef, historyEdgePromptArmTimerRef, historyPageNoticeTimerRef,
    activeHighlightTimerRef,
  } = c;
  const clearHistoryEdgePromptArmTimer = useCallback(() => {
    if (historyEdgePromptArmTimerRef.current !== null) {
      window.clearTimeout(historyEdgePromptArmTimerRef.current);
      historyEdgePromptArmTimerRef.current = null;
    }
  }, []);

  const setHistoryEdgePromptDirection = useCallback((direction: HistoryPagingDirection | null) => {
    setHistoryEdgePrompt(prev => (prev === direction ? prev : direction));
  }, []);

  const clearHistoryEdgePrompt = useCallback(() => {
    clearHistoryEdgePromptArmTimer();
    historyEdgePromptReadyRef.current = false;
    setHistoryEdgePromptDirection(null);
  }, [clearHistoryEdgePromptArmTimer, setHistoryEdgePromptDirection]);

  const armHistoryEdgePrompt = useCallback((direction: HistoryPagingDirection) => {
    historyEdgePromptReadyRef.current = false;
    setHistoryEdgePromptDirection(direction);
    clearHistoryEdgePromptArmTimer();
    historyEdgePromptArmTimerRef.current = window.setTimeout(() => {
      historyEdgePromptArmTimerRef.current = null;
      setHistoryEdgePrompt(current => {
        if (current === direction) {
          historyEdgePromptReadyRef.current = true;
        }
        return current;
      });
    }, 320);
  }, [clearHistoryEdgePromptArmTimer, setHistoryEdgePromptDirection]);

  const showHistoryPageNotice = useCallback((direction: HistoryPagingDirection) => {
    if (historyPageNoticeTimerRef.current !== null) {
      window.clearTimeout(historyPageNoticeTimerRef.current);
      historyPageNoticeTimerRef.current = null;
    }
    setHistoryPageNotice({ id: Date.now(), direction });
  }, []);

  useEffect(() => {
    if (!historyPageNotice) return;

    historyPageNoticeTimerRef.current = window.setTimeout(() => {
      setHistoryPageNotice(current => (current?.id === historyPageNotice.id ? null : current));
      historyPageNoticeTimerRef.current = null;
    }, 1400);

    return () => {
      if (historyPageNoticeTimerRef.current !== null) {
        window.clearTimeout(historyPageNoticeTimerRef.current);
        historyPageNoticeTimerRef.current = null;
      }
    };
  }, [historyPageNotice]);

  const clearNavDotPagingUnlockTimer = useCallback(() => {
    if (navDotPagingUnlockTimerRef.current !== null) {
      window.clearTimeout(navDotPagingUnlockTimerRef.current);
      navDotPagingUnlockTimerRef.current = null;
    }
  }, []);

  const scheduleNavDotPagingUnlock = useCallback(() => {
    clearNavDotPagingUnlockTimer();
    navDotPagingUnlockTimerRef.current = window.setTimeout(() => {
      navDotPagingUnlockTimerRef.current = null;
      navDotPagingLockedRef.current = false;
    }, NAV_DOT_PAGING_UNLOCK_DEBOUNCE_MS);
  }, [clearNavDotPagingUnlockTimer]);

  const scrollToUserMsg = (msgId: string) => {
    const el = scrollContainerRef.current?.querySelector(`[data-user-msg-id="${msgId}"]`) as HTMLElement | null;
    if (!el) return;
    clearNavDotPagingUnlockTimer();
    navDotPagingLockedRef.current = true;
    clearHistoryEdgePrompt();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    scheduleNavDotPagingUnlock();
  };

  const scrollToMessage = useCallback((msgId: string) => {
    const el = scrollContainerRef.current?.querySelector(`[data-msg-id="${msgId}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setActiveHighlightId(msgId);
      if (activeHighlightTimerRef.current !== null) {
        window.clearTimeout(activeHighlightTimerRef.current);
      }
      activeHighlightTimerRef.current = window.setTimeout(() => {
        setActiveHighlightId(null);
        activeHighlightTimerRef.current = null;
      }, SEARCH_MATCH_HIGHLIGHT_DURATION_MS);
    }
  }, []);

  return {
    clearHistoryEdgePromptArmTimer, setHistoryEdgePromptDirection, clearHistoryEdgePrompt,
    armHistoryEdgePrompt, showHistoryPageNotice, clearNavDotPagingUnlockTimer,
    scheduleNavDotPagingUnlock, scrollToUserMsg, scrollToMessage,
  };
}

export type HistoryEdgePrompt = ReturnType<typeof useHistoryEdgePrompt>;
