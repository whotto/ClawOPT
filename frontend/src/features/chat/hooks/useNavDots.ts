// 左侧用户消息导航点：位置采样、当前点跟随滚动、卸载清理。
import { useEffect, useCallback, useMemo } from 'react';
import { parseAttachmentsFromContent } from '../message';
import type { NavDot, NavDotSummary } from '../lib/types';
import { sampleNavDots, resolveClosestNavDotId } from '../lib/scrollGeometry';
import {
  buildNavDotSummary, sanitizeNavSummaryText, NAV_QUOTE_BLOCK_REGEX,
} from '../lib/navSummary';
import type { TFunction } from 'i18next';
import type { ChatViewState } from './useChatViewState';
import type { ChatPresence } from './useChatPresence';
import type { MessagePatchQueue } from './useMessagePatchQueue';

/** 本段读取的、由前面各段产出的值。 */
type NavDotsContext = Pick<
  ChatViewState & ChatPresence & MessagePatchQueue,
  't' | 'isInitialLoading' | 'navDots' | 'setNavDots' | 'setActiveNavDot' | 'scrollContainerRef' |
  'navScrollFrameRef' | 'navDotPagingUnlockTimerRef' | 'historyEdgePromptArmTimerRef' |
  'historyPageNoticeTimerRef' | 'visibleMessages' | 'clearQueuedMessagePatches'
>;

function extractNavDotSummary(content: string, t: TFunction): NavDotSummary {
  const quoteLabel = `[${t('unifiedChat.quotedContent')}]`;
  const hasQuote = content.includes('[引用开始') || content.trimStart().startsWith('<quoted_message');
  const withoutQuotes = content.replace(NAV_QUOTE_BLOCK_REGEX, '\n');

  const { attachments, text: textWithoutAttachments } = parseAttachmentsFromContent(withoutQuotes);
  const cleanedInput = sanitizeNavSummaryText(textWithoutAttachments);

  if (hasQuote) {
    return buildNavDotSummary(quoteLabel, cleanedInput);
  }

  if (attachments.length > 0) {
    const primary = attachments[0]?.name?.trim() || t('common.file');
    return buildNavDotSummary(primary, cleanedInput);
  }

  const fallbackText = cleanedInput || sanitizeNavSummaryText(content);
  return buildNavDotSummary(fallbackText);
}

export function useNavDots(c: NavDotsContext) {
  const {
    t, isInitialLoading, navDots, setNavDots, setActiveNavDot, scrollContainerRef,
    navScrollFrameRef, navDotPagingUnlockTimerRef, historyEdgePromptArmTimerRef,
    historyPageNoticeTimerRef, visibleMessages, clearQueuedMessagePatches,
  } = c;
  // ---- Nav Dots ----
  const userMessages = useMemo(() => {
    return visibleMessages.filter(m => m.role === 'user');
  }, [visibleMessages]);

  const navDotsEnabled = !isInitialLoading && userMessages.length > 0;

  const recalcNavDots = useCallback(() => {
    if (!navDotsEnabled) {
      setNavDots([]);
      setActiveNavDot(null);
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) return;
    const totalScrollHeight = container.scrollHeight;
    if (totalScrollHeight <= 0) return;
    const userMessageOffsets = new Map<string, number>();
    container.querySelectorAll<HTMLElement>('[data-user-msg-id]').forEach(el => {
      const messageId = el.dataset.userMsgId;
      if (messageId) userMessageOffsets.set(messageId, el.offsetTop);
    });
    const allDots: NavDot[] = [];
    userMessages.forEach(msg => {
      const offsetTop = userMessageOffsets.get(msg.id);
      if (typeof offsetTop !== 'number') return;
      const proportional = (offsetTop / totalScrollHeight) * 100;
      allDots.push({ id: msg.id, top: proportional, offsetTop, summary: extractNavDotSummary(msg.content, t) });
    });
    const displayedDots = sampleNavDots(allDots);
    setNavDots(displayedDots);
    setActiveNavDot(resolveClosestNavDotId(displayedDots, container));
  }, [navDotsEnabled, t, userMessages]);

  const handleNavScroll = useCallback(() => {
    if (!navDotsEnabled || navDots.length === 0) return;
    if (navScrollFrameRef.current !== null) return;
    navScrollFrameRef.current = window.requestAnimationFrame(() => {
      navScrollFrameRef.current = null;
      const container = scrollContainerRef.current;
      if (!container) return;
      const closest = resolveClosestNavDotId(navDots, container);
      setActiveNavDot(prev => (prev === closest ? prev : closest));
    });
  }, [navDots, navDotsEnabled]);

  useEffect(() => { recalcNavDots(); }, [recalcNavDots]);
  useEffect(() => { const t = setTimeout(recalcNavDots, 500); return () => clearTimeout(t); }, [recalcNavDots]);
  useEffect(() => {
    if (!navDotsEnabled) {
      if (navScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(navScrollFrameRef.current);
        navScrollFrameRef.current = null;
      }
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleNavScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleNavScroll);
      if (navScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(navScrollFrameRef.current);
        navScrollFrameRef.current = null;
      }
    };
  }, [handleNavScroll, navDotsEnabled]);

  useEffect(() => () => {
    clearQueuedMessagePatches();
    if (navScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(navScrollFrameRef.current);
      navScrollFrameRef.current = null;
    }
    if (navDotPagingUnlockTimerRef.current !== null) {
      window.clearTimeout(navDotPagingUnlockTimerRef.current);
      navDotPagingUnlockTimerRef.current = null;
    }
    if (historyEdgePromptArmTimerRef.current !== null) {
      window.clearTimeout(historyEdgePromptArmTimerRef.current);
      historyEdgePromptArmTimerRef.current = null;
    }
    if (historyPageNoticeTimerRef.current !== null) {
      window.clearTimeout(historyPageNoticeTimerRef.current);
      historyPageNoticeTimerRef.current = null;
    }
  }, [clearQueuedMessagePatches]);

  return { userMessages, navDotsEnabled, recalcNavDots, handleNavScroll };
}

export type NavDots = ReturnType<typeof useNavDots>;
