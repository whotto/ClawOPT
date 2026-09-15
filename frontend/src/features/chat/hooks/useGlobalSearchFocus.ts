// 全局搜索（Ctrl/Cmd+K）打开消息命中后，在聊天页里翻到那条消息并高亮。复用会话内搜索的跳转（jumpToSearchMatch）。
import { useEffect, useRef, useState } from 'react';
import {
  CHAT_FOCUS_REQUEST_EVENT,
  peekChatFocusRequest,
  settleChatFocusRequest,
  type ChatFocusRequest,
} from '../../search/lib/searchLib';
import type { ChatViewState } from './useChatViewState';
import type { HistoryEdgePrompt } from './useHistoryEdgePrompt';
import type { MessageSearch } from './useMessageSearch';

/** 最多翻几次：首屏加载可能在我们翻到目标之后才落地、把窗口换回最新一页，这时再翻一次。 */
const MAX_FOCUS_ATTEMPTS = 3;

type GlobalSearchFocusContext = Pick<
  ChatViewState & HistoryEdgePrompt & MessageSearch,
  'isChat' | 'activeKey' | 'messages' | 'isInitialLoading' | 'scrollToMessage' | 'jumpToSearchMatch'
>;

export function useGlobalSearchFocus(c: GlobalSearchFocusContext) {
  const { isChat, activeKey, messages, isInitialLoading, scrollToMessage, jumpToSearchMatch } = c;
  const [request, setRequest] = useState<ChatFocusRequest | null>(() => (isChat && activeKey ? peekChatFocusRequest(activeKey) : null));
  const attemptsRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<ChatFocusRequest>).detail;
      if (!detail) return;
      attemptsRef.current = 0;
      setRequest(detail);
    };
    window.addEventListener(CHAT_FOCUS_REQUEST_EVENT, handle);
    return () => window.removeEventListener(CHAT_FOCUS_REQUEST_EVENT, handle);
  }, []);

  useEffect(() => {
    if (!request || !isChat || activeKey !== request.sessionId || isInitialLoading) return;
    if (messages.some((message) => message.id === request.messageId)) {
      const frame = window.requestAnimationFrame(() => {
        scrollToMessage(request.messageId);
        settleChatFocusRequest(request);
        setRequest((current) => (current === request ? null : current));
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (inFlightRef.current) return;
    if (attemptsRef.current >= MAX_FOCUS_ATTEMPTS) {
      settleChatFocusRequest(request);
      setRequest((current) => (current === request ? null : current));
      return;
    }
    attemptsRef.current += 1;
    inFlightRef.current = true;
    void jumpToSearchMatch({ messageId: request.messageId, anchorBeforeId: request.anchorBeforeId })
      .finally(() => { inFlightRef.current = false; });
  }, [activeKey, isChat, isInitialLoading, jumpToSearchMatch, messages, request, scrollToMessage]);
}
