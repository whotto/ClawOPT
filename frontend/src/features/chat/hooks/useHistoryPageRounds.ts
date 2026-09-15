// 每页轮数与服务端配置、其他标签页保持同步。
import { useEffect, useCallback } from 'react';
import {
  CHAT_HISTORY_PAGE_ROUNDS_CHANGED_EVENT, CHAT_HISTORY_PAGE_ROUNDS_STORAGE_KEY,
  normalizeChatHistoryPageRounds, persistChatHistoryPageRounds, readChatHistoryPageRounds,
} from '../../../utils/historyPagination';
import { getConfig } from '../../../api/config';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type HistoryPageRoundsContext = Pick<ChatViewState, 'setHistoryPageRounds'>;

export function useHistoryPageRounds(c: HistoryPageRoundsContext) {
  const { setHistoryPageRounds } = c;
  const syncSharedHistoryPageRounds = useCallback(async () => {
    try {
      const response = await getConfig();
      const data = await response.json();
      if (data?.historyPageRounds === undefined) return;

      const nextHistoryPageRounds = normalizeChatHistoryPageRounds(data.historyPageRounds);
      setHistoryPageRounds(prev => (prev === nextHistoryPageRounds ? prev : nextHistoryPageRounds));
      persistChatHistoryPageRounds(nextHistoryPageRounds);
    } catch {}
  }, []);

  useEffect(() => {
    void syncSharedHistoryPageRounds();
  }, [syncSharedHistoryPageRounds]);

  useEffect(() => {
    const handleFocus = () => {
      void syncSharedHistoryPageRounds();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncSharedHistoryPageRounds();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [syncSharedHistoryPageRounds]);

  useEffect(() => {
    const syncHistoryPageRounds = () => {
      setHistoryPageRounds((prev) => {
        const next = readChatHistoryPageRounds();
        return prev === next ? prev : next;
      });
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== CHAT_HISTORY_PAGE_ROUNDS_STORAGE_KEY) return;
      syncHistoryPageRounds();
    };

    const handleRoundsChanged = () => {
      syncHistoryPageRounds();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(CHAT_HISTORY_PAGE_ROUNDS_CHANGED_EVENT, handleRoundsChanged);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(CHAT_HISTORY_PAGE_ROUNDS_CHANGED_EVENT, handleRoundsChanged);
    };
  }, []);

  return { syncSharedHistoryPageRounds };
}
