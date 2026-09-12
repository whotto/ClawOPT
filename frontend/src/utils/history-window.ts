/**
 * 历史窗口与游标 —— 从 UnifiedChatView.tsx 原样搬出，**一个字符都没有改**。
 *
 * 这里是分页的判据所在，而 AGENTS.md 对它有一条硬规定：
 * **历史分页必须保持游标式（`beforeId + limit`），永远不许退回 offset。**
 * `nextBeforeId` 就是那个游标——它一旦被改成「已加载条数」之类的偏移量，
 * 症状不是报错，是翻页开始重复或跳过消息，而且只在消息量大了以后才显形。
 *
 * 另一条同样安静的失败：窗口裁剪掉了更早的消息，却没有把 `hasMoreOlder` 置真。
 * 那些消息不会报错消失，它们只是**再也翻不回来**。
 *
 * 搬出来的唯一理由是测得动：原地 import 会把 react-markdown / katex / pdfjs
 * 整条依赖链拖进测试进程。
 *
 * 对应用例：src/utils/history-window.test.ts
 */
import { parsePositiveCursorValue, type ChatMessage } from './message-merge';

export const HISTORY_FETCH_BATCH_MIN_LIMIT = 40;

export type HistoryPageInfo = {
  limit: number;
  hasMoreOlder: boolean;
  oldestLoadedId: number | null;
  newestLoadedId: number | null;
  nextBeforeId: number | null;
};

export type HistoryPageSnapshot = {
  messages: ChatMessage[];
  activeLeafId: string | null;
  pageInfo: HistoryPageInfo;
};

export function normalizeHistoryPageInfo(rawPageInfo: any, fallbackLimit = HISTORY_FETCH_BATCH_MIN_LIMIT): HistoryPageInfo {
  const limit = parsePositiveCursorValue(rawPageInfo?.limit) ?? fallbackLimit;
  const oldestLoadedId = parsePositiveCursorValue(rawPageInfo?.oldestLoadedId);
  const newestLoadedId = parsePositiveCursorValue(rawPageInfo?.newestLoadedId);
  const hasMoreOlder = Boolean(rawPageInfo?.hasMoreOlder);
  const nextBeforeId = hasMoreOlder
    ? (parsePositiveCursorValue(rawPageInfo?.nextBeforeId) ?? oldestLoadedId)
    : null;

  return {
    limit,
    hasMoreOlder,
    oldestLoadedId,
    newestLoadedId,
    nextBeforeId,
  };
}

export function createEmptyHistoryPageInfo(limit = HISTORY_FETCH_BATCH_MIN_LIMIT): HistoryPageInfo {
  return {
    limit,
    hasMoreOlder: false,
    oldestLoadedId: null,
    newestLoadedId: null,
    nextBeforeId: null,
  };
}

export function buildLinearHistoryWindowSnapshot(
  messages: ChatMessage[],
  pageInfo: HistoryPageInfo,
  maxUserRounds: number,
  getPreferredLeafId: (nextMessages: ChatMessage[]) => string | null,
): HistoryPageSnapshot {
  const resolvedLeafId = getPreferredLeafId(messages);

  if (messages.length === 0) {
    return {
      messages,
      activeLeafId: resolvedLeafId,
      pageInfo: createEmptyHistoryPageInfo(pageInfo.limit),
    };
  }

  const userMessages = messages.filter((message) => message.role === 'user');
  let trimmedMessages = messages;
  if (maxUserRounds > 0 && userMessages.length > maxUserRounds) {
    const firstUserToKeep = userMessages[userMessages.length - maxUserRounds];
    const firstRetainedIndex = messages.findIndex((message) => message.id === firstUserToKeep.id);
    if (firstRetainedIndex > 0) {
      trimmedMessages = messages.slice(firstRetainedIndex);
    }
  }

  const oldestLoadedId = parsePositiveCursorValue(trimmedMessages[0]?.id);
  const newestLoadedId = parsePositiveCursorValue(trimmedMessages[trimmedMessages.length - 1]?.id);
  const hasMoreOlder = pageInfo.hasMoreOlder || trimmedMessages.length !== messages.length;

  return {
    messages: trimmedMessages,
    activeLeafId: getPreferredLeafId(trimmedMessages),
    pageInfo: {
      ...pageInfo,
      oldestLoadedId,
      newestLoadedId,
      hasMoreOlder,
      nextBeforeId: hasMoreOlder ? oldestLoadedId : null,
    },
  };
}

export function areHistoryPageInfosEqual(left: HistoryPageInfo, right: HistoryPageInfo): boolean {
  return left.limit === right.limit
    && left.hasMoreOlder === right.hasMoreOlder
    && left.oldestLoadedId === right.oldestLoadedId
    && left.newestLoadedId === right.newestLoadedId
    && left.nextBeforeId === right.nextBeforeId;
}

export function areMessageListsEquivalent(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.id !== right[index]?.id) {
      return false;
    }
  }

  return true;
}
