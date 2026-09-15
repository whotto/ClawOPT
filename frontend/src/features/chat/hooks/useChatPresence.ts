// 当前叶子消息、群聊忙碌态、回复结束后把焦点还给输入框、日期格式化。
import { useEffect, useCallback, useMemo } from 'react';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type ChatPresenceContext = Pick<
  ChatViewState,
  'isChat' | 'isGroup' | 'activeKey' | 'currentLocale' | 'messages' | 'isLoading' |
  'setActiveLeafId' | 'editingMessageId' | 'inputPreview' | 'setInputPreview' | 'typingAgents' |
  'groupRunState' | 'textareaRef' | 'wasChatLoadingRef' | 'wasGroupBusyRef' | 'getPreferredLeafId'
>;

export function useChatPresence(c: ChatPresenceContext) {
  const {
    isChat, isGroup, activeKey, currentLocale, messages, isLoading, setActiveLeafId,
    editingMessageId, inputPreview, setInputPreview, typingAgents, groupRunState, textareaRef,
    wasChatLoadingRef, wasGroupBusyRef, getPreferredLeafId,
  } = c;
  // ---- Tree / Branch Logic ----
  useEffect(() => {
    if (messages.length > 0) {
      setActiveLeafId(getPreferredLeafId(messages));
    }
  }, [messages, getPreferredLeafId]);

  const visibleMessages = useMemo(() => messages, [messages]);

  const activeProcessingAgents = useMemo(() => {
    if (!isGroup) return [];
    const active = new Set<string>();
    typingAgents.forEach((_name, agentId) => active.add(agentId));
    if (groupRunState.active && groupRunState.agentId) {
      active.add(groupRunState.agentId);
    }
    return Array.from(active);
  }, [groupRunState.active, groupRunState.agentId, isGroup, typingAgents]);
  const isGroupBusy = isGroup && (groupRunState.active || activeProcessingAgents.length > 0);

  const focusMainInput = useCallback(() => {
    window.setTimeout(() => {
      if (!activeKey || editingMessageId || isLoading) return;
      if (inputPreview) {
        setInputPreview(false);
        window.setTimeout(() => {
          if (!activeKey || editingMessageId || isLoading) return;
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.focus();
          const caret = textarea.value.length;
          textarea.setSelectionRange(caret, caret);
        }, 0);
        return;
      }
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const caret = textarea.value.length;
      textarea.setSelectionRange(caret, caret);
    }, 0);
  }, [activeKey, editingMessageId, inputPreview, isLoading]);

  useEffect(() => {
    if (!isChat) {
      wasChatLoadingRef.current = false;
      return;
    }

    const wasLoading = wasChatLoadingRef.current;
    if (wasLoading && !isLoading) {
      focusMainInput();
    }
    wasChatLoadingRef.current = isLoading;
  }, [focusMainInput, isChat, isLoading]);

  useEffect(() => {
    if (!isGroup) {
      wasGroupBusyRef.current = false;
      return;
    }

    const wasBusy = wasGroupBusyRef.current;
    if (wasBusy && !isGroupBusy) {
      focusMainInput();
    }
    wasGroupBusyRef.current = isGroupBusy;
  }, [focusMainInput, isGroup, isGroupBusy]);

  const formatMessageDate = useCallback((date: Date | string | number) => (
    new Date(date).toLocaleDateString(currentLocale, { year: 'numeric', month: 'long', day: 'numeric' })
  ), [currentLocale]);

  const formatQuoteTime = useCallback((date: Date | string | number) => (
    new Date(date).toLocaleString(currentLocale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  ), [currentLocale]);

  return {
    visibleMessages, activeProcessingAgents, isGroupBusy, focusMainInput, formatMessageDate,
    formatQuoteTime,
  };
}

export type ChatPresence = ReturnType<typeof useChatPresence>;
