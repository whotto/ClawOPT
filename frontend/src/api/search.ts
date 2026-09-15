import { apiFetch } from './client';

export type ChatSearchResult = {
  sessionId: string;
  sessionName: string;
  matchedField?: 'title' | 'message';
  matchedMessageId?: number | null;
  anchorBeforeId?: number | null;
  snippet?: string;
  role?: string | null;
  timestamp: string | null;
};

export type ChatSearchResponse = {
  success: boolean;
  mode: 'recent' | 'search';
  terms: string[];
  results: ChatSearchResult[];
};

/** Ctrl/Cmd+K 全局搜索；`q` 为空时回最近会话。服务端按用户过滤。 */
export function searchChats(query: string, options: { limit?: number; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ q: query });
  if (options.limit) params.set('limit', String(options.limit));
  return apiFetch(`/search/chat?${params.toString()}`, { signal: options.signal });
}
