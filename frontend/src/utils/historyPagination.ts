export const CHAT_HISTORY_PAGE_ROUNDS_STORAGE_KEY = 'clawopt_chat_history_page_rounds';
export const CHAT_HISTORY_PAGE_ROUNDS_CHANGED_EVENT = 'clawopt:chat-history-page-rounds-changed';
export const DEFAULT_CHAT_HISTORY_PAGE_ROUNDS = 30;
export const MIN_CHAT_HISTORY_PAGE_ROUNDS = 5;
export const MAX_CHAT_HISTORY_PAGE_ROUNDS = 100;

export function normalizeChatHistoryPageRounds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(MAX_CHAT_HISTORY_PAGE_ROUNDS, Math.max(MIN_CHAT_HISTORY_PAGE_ROUNDS, Math.round(value)));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(MAX_CHAT_HISTORY_PAGE_ROUNDS, Math.max(MIN_CHAT_HISTORY_PAGE_ROUNDS, parsed));
    }
  }

  return DEFAULT_CHAT_HISTORY_PAGE_ROUNDS;
}

export function readChatHistoryPageRounds(): number {
  if (typeof window === 'undefined') return DEFAULT_CHAT_HISTORY_PAGE_ROUNDS;

  try {
    return normalizeChatHistoryPageRounds(localStorage.getItem(CHAT_HISTORY_PAGE_ROUNDS_STORAGE_KEY));
  } catch {
    return DEFAULT_CHAT_HISTORY_PAGE_ROUNDS;
  }
}

export function persistChatHistoryPageRounds(value: unknown): number {
  const nextValue = normalizeChatHistoryPageRounds(value);

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(CHAT_HISTORY_PAGE_ROUNDS_STORAGE_KEY, String(nextValue));
    } catch {}

    window.dispatchEvent(new CustomEvent(CHAT_HISTORY_PAGE_ROUNDS_CHANGED_EVENT, {
      detail: nextValue,
    }));
  }

  return nextValue;
}
