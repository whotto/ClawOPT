// 搜索输入防抖。
import { useEffect } from 'react';
import { SEARCH_DEBOUNCE_MS } from '../lib/constants';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type SearchQueryDebounceContext = Pick<ChatViewState, 'messageSearchQuery' | 'setDebouncedMessageSearchQuery'>;

export function useSearchQueryDebounce(c: SearchQueryDebounceContext) {
  const { messageSearchQuery, setDebouncedMessageSearchQuery } = c;
  // ---- Search ----
  useEffect(() => {
    if (!messageSearchQuery.trim()) {
      setDebouncedMessageSearchQuery('');
      return;
    }

    const timer = window.setTimeout(() => {
      setDebouncedMessageSearchQuery(messageSearchQuery);
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [messageSearchQuery]);
}
