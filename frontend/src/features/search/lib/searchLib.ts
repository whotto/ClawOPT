/**
 * 全局搜索的纯逻辑：请求序号守卫、片段高亮切段、跨组件事件与「跳到某条消息」的一次性请求。
 */

/** 请求序号守卫：慢的旧请求回来时不得覆盖新请求的结果。 */
export function createRequestSequence() {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (token: number) => token === current,
    /** 作废所有在途请求（关闭面板时）。 */
    invalidate: () => { current += 1; },
  };
}

export type HighlightSegment = { text: string; match: boolean };

/** 按查询词把片段切成高亮 / 普通段（大小写不敏感，最长词优先，不跨段重叠）。 */
export function highlightSegments(text: string, terms: string[]): HighlightSegment[] {
  const needles = [...new Set(terms.map((term) => term.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.toLowerCase());
  if (!text) return [];
  if (needles.length === 0) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const needle = needles.find((candidate) => lower.startsWith(candidate, index));
    if (!needle) {
      index += 1;
      continue;
    }
    if (index > plainStart) segments.push({ text: text.slice(plainStart, index), match: false });
    segments.push({ text: text.slice(index, index + needle.length), match: true });
    index += needle.length;
    plainStart = index;
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart), match: false });
  return segments;
}

/** 与后端 `parseChatSearchTerms` 同一套切词（高亮在服务端回 terms 之前也要能用）。 */
export function splitSearchTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.split(/\s+/)) {
    if (!raw || /^[\p{P}\p{S}]+$/u.test(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(raw);
    if (terms.length >= 20) break;
  }
  return terms;
}

/** 列表里上下移动选中项（循环）。 */
export function moveSelection(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export const OPEN_SESSION_SEARCH_EVENT = 'clawopt:open-session-search';
export const NEW_CHAT_SHORTCUT_EVENT = 'clawopt:new-chat';
export const CHAT_FOCUS_REQUEST_EVENT = 'clawopt:chat-focus-request';

export type ChatFocusRequest = { sessionId: string; messageId: string; anchorBeforeId: number | null };

let pendingFocus: ChatFocusRequest | null = null;

/** 搜索结果要求聊天页跳到某条消息。请求先存下（聊天页可能还没挂载），再发事件通知已挂载的聊天页。 */
export function requestChatFocus(request: ChatFocusRequest): void {
  pendingFocus = request;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<ChatFocusRequest>(CHAT_FOCUS_REQUEST_EVENT, { detail: request }));
}

/** 看一眼给这个会话的待处理跳转（不取走）。 */
export function peekChatFocusRequest(sessionId: string): ChatFocusRequest | null {
  return pendingFocus && pendingFocus.sessionId === sessionId ? pendingFocus : null;
}

/** 跳转已完成（或放弃）：只清掉仍是同一个请求的那一份，不误清后来的新请求。 */
export function settleChatFocusRequest(request: ChatFocusRequest): void {
  if (pendingFocus === request) pendingFocus = null;
}
