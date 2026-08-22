import React, { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react';
import { Menu, Plus, X, Search, ChevronUp, ChevronDown, Trash2, Users, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import ReactMarkdown from 'react-markdown';
import { normalizeLanguage } from '../i18n';
import { getFileIconInfo } from '../utils/fileUtils';
import FilePreviewModal from './FilePreviewModal';
import { MessageBubble, normalizeProcessBlocks, parseAttachmentsFromContent, ProcessStepBlock } from './chat/MessageBubble';
import { compressImage, getFileCategory, formatFileSize } from '../utils/imageCompression';
import {
  CHAT_HISTORY_PAGE_ROUNDS_CHANGED_EVENT,
  CHAT_HISTORY_PAGE_ROUNDS_STORAGE_KEY,
  normalizeChatHistoryPageRounds,
  persistChatHistoryPageRounds,
  readChatHistoryPageRounds,
} from '../utils/historyPagination';
import { ACTIVE_CONTEXT_REFRESH_EVENT, type ActiveContextRefreshDetail } from '../utils/contextRefresh';
import { getGroupIdValidationKey } from '../utils/groupId';
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeMathMarkdown } from '../utils/markdownMath';

// ============ TYPES ============

const GROUP_MAX_CHAIN_DEPTH_MESSAGE_CODE = 'group.maxChainDepthReached';
const STREAM_UPDATE_BATCH_MS = 40;
const NAV_DOTS_MAX_VISIBLE = 40;
const HISTORY_FETCH_BATCH_MIN_LIMIT = 40;
const HISTORY_WINDOW_MAX_FETCH_BATCHES = 8;
const HISTORY_LOAD_TRIGGER_PX = 72;
const HISTORY_TOUCH_TRIGGER_PX = 28;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MATCH_HIGHLIGHT_DURATION_MS = 5000;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 160;
const NAV_DOT_PAGING_UNLOCK_DEBOUNCE_MS = 180;
const GROUP_ACTIVE_RUN_RECOVERY_POLL_MS = 500;
const GROUP_SSE_RECOVERY_THROTTLE_MS = 2000;
const GROUP_POST_RUN_SETTLE_POLL_MS = 2000;
const GROUP_POST_RUN_SETTLE_TIMEOUT_MS = 120000;
const CHAT_ACTIVE_RUN_RECOVERY_POLL_MS = 1500;
const DEFAULT_PROCESS_START_TAG = '[执行工作_Start]';
const DEFAULT_PROCESS_END_TAG = '[执行工作_End]';
const MODAL_FORM_FONT_STYLE = {
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as const;
const MODAL_FIELD_LABEL_CLASS = 'block text-sm font-semibold text-gray-700 mb-1.5';
const MODAL_TEXT_INPUT_CLASS = 'w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500';
const MODAL_TEXTAREA_CLASS = 'w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all resize-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500';

type StructuredMessageParams = Record<string, string | number | boolean | null>;
type NavDotSummary = {
  primary: string;
  secondary?: string;
  tooltipText: string;
};
type NavDot = { id: string; top: number; offsetTop: number; summary: NavDotSummary };
type HistoryPagingDirection = 'older' | 'newer';
type HistoryPageInfo = {
  limit: number;
  hasMoreOlder: boolean;
  oldestLoadedId: number | null;
  newestLoadedId: number | null;
  nextBeforeId: number | null;
};
type HistoryPageSnapshot = {
  messages: ChatMessage[];
  activeLeafId: string | null;
  pageInfo: HistoryPageInfo;
};
type HistoryPageNotice = {
  id: number;
  direction: HistoryPagingDirection;
};
type SearchMatch = {
  messageId: string;
  anchorBeforeId: number | null;
};
type GroupRunState = {
  active: boolean;
  agentId: string | null;
  runId: string | null;
  startedAt: number | null;
};

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  processContent?: string;
  processStreaming?: boolean;
  timestamp: Date;
  model?: string;
  agentId?: string;
  agentName?: string;
  parentId?: string;
  messageCode?: string;
  messageParams?: StructuredMessageParams;
  rawDetail?: string;
}

interface GroupChat {
  id: string;
  name: string;
  description?: string;
  process_start_tag?: string;
  process_end_tag?: string;
  members: { id: string; group_id: string; agent_id: string; display_name: string; role_description: string; position: number }[];
}

interface GroupMember {
  agentId: string;
  displayName: string;
  roleDescription: string;
}

type GroupChatMember = GroupChat['members'][number];

function parsePositiveCursorValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function isPersistedMessageId(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}

function normalizeHistoryPageInfo(rawPageInfo: any, fallbackLimit = HISTORY_FETCH_BATCH_MIN_LIMIT): HistoryPageInfo {
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

function createEmptyHistoryPageInfo(limit = HISTORY_FETCH_BATCH_MIN_LIMIT): HistoryPageInfo {
  return {
    limit,
    hasMoreOlder: false,
    oldestLoadedId: null,
    newestLoadedId: null,
    nextBeforeId: null,
  };
}

function buildLinearHistoryWindowSnapshot(
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

function areHistoryPageInfosEqual(left: HistoryPageInfo, right: HistoryPageInfo): boolean {
  return left.limit === right.limit
    && left.hasMoreOlder === right.hasMoreOlder
    && left.oldestLoadedId === right.oldestLoadedId
    && left.newestLoadedId === right.newestLoadedId
    && left.nextBeforeId === right.nextBeforeId;
}

function areMessageListsEquivalent(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.id !== right[index]?.id) {
      return false;
    }
  }

  return true;
}

function mergeHistoryMessages(olderMessages: ChatMessage[], newerMessages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  const seen = new Set<string>();

  [...olderMessages, ...newerMessages].forEach((message) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    merged.push(message);
  });

  return merged;
}

function hasOwnMessageField<T extends object>(value: T, key: keyof any): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveProcessTagPair(
  primaryStartTag?: string | null,
  primaryEndTag?: string | null,
  secondaryStartTag?: string | null,
  secondaryEndTag?: string | null,
): { startTag: string; endTag: string } {
  const normalize = (value?: string | null) => (typeof value === 'string' ? value.trim() : '');

  const primaryStart = normalize(primaryStartTag);
  const primaryEnd = normalize(primaryEndTag);
  if (primaryStart && primaryEnd) {
    return { startTag: primaryStart, endTag: primaryEnd };
  }

  const secondaryStart = normalize(secondaryStartTag);
  const secondaryEnd = normalize(secondaryEndTag);
  if (secondaryStart && secondaryEnd) {
    return { startTag: secondaryStart, endTag: secondaryEnd };
  }

  return {
    startTag: DEFAULT_PROCESS_START_TAG,
    endTag: DEFAULT_PROCESS_END_TAG,
  };
}

function hasExplicitProcessState(incoming: Partial<ChatMessage>): boolean {
  const hasProcessContent = hasOwnMessageField(incoming, 'processContent')
    && typeof incoming.processContent === 'string'
    && incoming.processContent.trim().length > 0;
  const hasProcessStreaming = hasOwnMessageField(incoming, 'processStreaming')
    && typeof incoming.processStreaming === 'boolean';
  return hasProcessContent || hasProcessStreaming;
}

function shouldPreferIncomingMessageContent(
  existing: Pick<ChatMessage, 'content' | 'role' | 'messageCode'> | undefined,
  incoming: Partial<ChatMessage>,
): boolean {
  if (!hasOwnMessageField(incoming, 'content')) {
    return false;
  }

  const currentContent = typeof existing?.content === 'string' ? existing.content : '';
  const nextContent = typeof incoming.content === 'string' ? incoming.content : '';
  const normalizedCurrent = currentContent.trim();
  const normalizedNext = nextContent.trim();
  const nextRole = incoming.role ?? existing?.role;
  const nextMessageCode = hasOwnMessageField(incoming, 'messageCode')
    ? incoming.messageCode
    : existing?.messageCode;
  const currentIsSystemLike = existing?.role === 'system' || !!existing?.messageCode;
  const nextIsSystemLike = nextRole === 'system' || !!nextMessageCode;
  const explicitProcessState = hasExplicitProcessState(incoming);

  if (!normalizedNext) {
    if (explicitProcessState) {
      return true;
    }
    return !normalizedCurrent;
  }

  if (!normalizedCurrent) {
    return true;
  }

  if (nextContent === currentContent) {
    return true;
  }

  if (nextIsSystemLike) {
    return true;
  }

  if (currentIsSystemLike) {
    return true;
  }

  if (normalizedNext === normalizedCurrent) {
    return nextContent.length >= currentContent.length;
  }

  if (normalizedNext.startsWith(normalizedCurrent)) {
    return true;
  }

  if (normalizedCurrent.startsWith(normalizedNext)) {
    if (explicitProcessState) {
      return true;
    }
    return false;
  }

  if (explicitProcessState) {
    return true;
  }

  return normalizedNext.length > normalizedCurrent.length;
}

function shouldPreferIncomingSupplementalContent(
  currentValue: string | undefined,
  nextValue: string | undefined,
  options?: { allowShorterReplacement?: boolean },
): boolean {
  const currentContent = typeof currentValue === 'string' ? currentValue : '';
  const nextContent = typeof nextValue === 'string' ? nextValue : '';
  const normalizedCurrent = currentContent.trim();
  const normalizedNext = nextContent.trim();

  if (!normalizedNext) {
    if (options?.allowShorterReplacement) {
      return true;
    }
    return !normalizedCurrent;
  }

  if (!normalizedCurrent) {
    return true;
  }

  if (nextContent === currentContent) {
    return true;
  }

  if (normalizedNext === normalizedCurrent) {
    return nextContent.length >= currentContent.length;
  }

  if (normalizedNext.startsWith(normalizedCurrent)) {
    return true;
  }

  if (normalizedCurrent.startsWith(normalizedNext)) {
    return !!options?.allowShorterReplacement;
  }

  return normalizedNext.length > normalizedCurrent.length;
}

function shouldAllowTerminalProcessContentReplacement(incoming: Partial<ChatMessage>): boolean {
  return hasOwnMessageField(incoming, 'processContent')
    && hasOwnMessageField(incoming, 'processStreaming')
    && incoming.processStreaming === false;
}

function mergeMessagePreservingContent(existing: ChatMessage, incoming: Partial<ChatMessage>): ChatMessage {
  const next = { ...existing, ...incoming };
  if (hasOwnMessageField(incoming, 'content') && !shouldPreferIncomingMessageContent(existing, incoming)) {
    next.content = existing.content;
  }
  if (hasOwnMessageField(incoming, 'processContent') && !shouldPreferIncomingSupplementalContent(
    existing.processContent,
    incoming.processContent,
    { allowShorterReplacement: shouldAllowTerminalProcessContentReplacement(incoming) },
  )) {
    next.processContent = existing.processContent;
  }
  return next;
}

function mergeMessagePatchPreservingContent(
  existingPatch: Partial<ChatMessage>,
  incomingPatch: Partial<ChatMessage>,
): Partial<ChatMessage> {
  const next = { ...existingPatch, ...incomingPatch };
  if (hasOwnMessageField(incomingPatch, 'content') && !shouldPreferIncomingMessageContent({
    content: typeof existingPatch.content === 'string' ? existingPatch.content : '',
    role: existingPatch.role || 'assistant',
    messageCode: existingPatch.messageCode,
  }, incomingPatch)) {
    next.content = existingPatch.content;
  }
  if (hasOwnMessageField(incomingPatch, 'processContent') && !shouldPreferIncomingSupplementalContent(
    typeof existingPatch.processContent === 'string' ? existingPatch.processContent : '',
    incomingPatch.processContent,
    { allowShorterReplacement: shouldAllowTerminalProcessContentReplacement(incomingPatch) },
  )) {
    next.processContent = existingPatch.processContent;
  }
  return next;
}

function mergeMessageCollectionPreservingContent(
  baseMessages: ChatMessage[],
  incomingMessages: ChatMessage[],
): ChatMessage[] {
  const mergedMap = new Map(baseMessages.map((message) => [message.id, message]));
  incomingMessages.forEach((message) => {
    const existing = mergedMap.get(message.id);
    mergedMap.set(message.id, existing ? mergeMessagePreservingContent(existing, message) : message);
  });
  return Array.from(mergedMap.values()).sort((left, right) => {
    const leftId = parsePositiveCursorValue(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightId = parsePositiveCursorValue(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftId - rightId;
  });
}

function isContainerNearBottom(container: HTMLElement, threshold = AUTO_SCROLL_BOTTOM_THRESHOLD_PX): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

function escapeRegExpForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripProcessBlocksForStatus(content: string, processStartTag: string, processEndTag: string): string {
  const startPattern = escapeRegExpForPattern(processStartTag.trim());
  const endPattern = escapeRegExpForPattern(processEndTag.trim());
  return content
    .replace(new RegExp(`${startPattern}[\\s\\S]*?(?:${endPattern}|$)`, 'g'), '\n\n')
    .replace(new RegExp(`(?:${startPattern}|${endPattern})`, 'g'), '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isLikelyInactiveGroupMessageStale(content: string, processStartTag?: string, processEndTag?: string): boolean {
  const normalized = content.trim();
  if (!normalized) return true;

  const { startTag, endTag } = resolveProcessTagPair(processStartTag, processEndTag);
  if (!startTag || !endTag || !normalized.includes(startTag)) return false;

  if (normalized.lastIndexOf(endTag) < normalized.lastIndexOf(startTag)) {
    return true;
  }

  return stripProcessBlocksForStatus(normalized, startTag, endTag).length === 0;
}

function sampleNavDots(dots: NavDot[], maxVisible = NAV_DOTS_MAX_VISIBLE): NavDot[] {
  if (dots.length <= maxVisible) return dots;
  if (maxVisible <= 1) return dots.length > 0 ? [dots[0]] : [];

  const sampled: NavDot[] = [];
  const seen = new Set<number>();
  const lastIndex = dots.length - 1;
  const step = lastIndex / (maxVisible - 1);

  for (let i = 0; i < maxVisible; i += 1) {
    const index = i === maxVisible - 1 ? lastIndex : Math.round(i * step);
    if (seen.has(index)) continue;
    seen.add(index);
    sampled.push(dots[index]);
  }

  return sampled;
}

function resolveClosestNavDotId(dots: NavDot[], container: HTMLElement): string | null {
  if (dots.length === 0) return null;

  const scrollTop = container.scrollTop;
  let closest: string | null = null;
  let closestDist = Infinity;

  dots.forEach(dot => {
    const dist = Math.abs(dot.offsetTop - scrollTop - container.clientHeight / 3);
    if (dist < closestDist) {
      closestDist = dist;
      closest = dot.id;
    }
  });

  return closest;
}

function resolveStructuredMessageContent(message: ChatMessage, t: TFunction): string {
  if (!message.messageCode) return message.content;

  const translated = t(message.messageCode, (message.messageParams || {}) as any);
  if (typeof translated !== 'string') {
    return message.content;
  }
  return translated === message.messageCode ? message.content : translated;
}

function mapChatHistoryMessage(m: any): ChatMessage {
  return {
    id: String(m.id || Math.random()),
    role: m.role === 'system' ? 'system' : (m.role === 'assistant' ? 'assistant' as const : 'user' as const),
    content: String(m.content || ''),
    processContent: typeof m.process_content === 'string' ? m.process_content : undefined,
    processStreaming: !!m.process_streaming,
    timestamp: new Date(m.created_at || Date.now()),
    model: m.model_used || undefined,
    agentId: m.agent_id || undefined,
    agentName: m.agent_name || undefined,
    parentId: m.parent_id ? String(m.parent_id) : undefined,
    messageCode: typeof m.messageCode === 'string' ? m.messageCode : undefined,
    messageParams: m.messageParams && typeof m.messageParams === 'object' ? m.messageParams : undefined,
    rawDetail: typeof m.rawDetail === 'string' ? m.rawDetail : undefined,
  };
}

function mapStreamingErrorUpdate(evt: any, fallbackContent: string): Partial<ChatMessage> {
  return {
    role: evt.role === 'system' ? 'system' : undefined,
    content: typeof evt.text === 'string' && evt.text.trim() ? evt.text : fallbackContent,
    messageCode: typeof evt.messageCode === 'string' ? evt.messageCode : undefined,
    messageParams: evt.messageParams && typeof evt.messageParams === 'object' ? evt.messageParams : undefined,
    rawDetail: typeof evt.rawDetail === 'string' && evt.rawDetail.trim() ? evt.rawDetail : undefined,
    processContent: typeof evt.process_content === 'string' ? evt.process_content : undefined,
    processStreaming: false,
  };
}

async function mapHttpErrorResponse(response: Response, fallbackContent: string): Promise<Partial<ChatMessage>> {
  const fallbackUpdate: Partial<ChatMessage> = {
    role: 'system',
    content: fallbackContent,
  };

  try {
    const data = await response.json();
    return {
      role: data?.role === 'system' ? 'system' : 'system',
      content:
        typeof data?.message === 'string' && data.message.trim()
          ? data.message
          : (typeof data?.error === 'string' && data.error.trim() ? data.error : fallbackContent),
      messageCode: typeof data?.messageCode === 'string' ? data.messageCode : undefined,
      messageParams: data?.messageParams && typeof data.messageParams === 'object' ? data.messageParams : undefined,
      rawDetail:
        typeof data?.rawDetail === 'string' && data.rawDetail.trim()
          ? data.rawDetail
          : (typeof data?.errorDetail === 'string' && data.errorDetail.trim() ? data.errorDetail : undefined),
    };
  } catch {
    return fallbackUpdate;
  }
}

function createClientStructuredChatError(detail: string): Partial<ChatMessage> {
  const trimmedDetail = detail.trim() || 'Unknown error';
  return {
    role: 'system',
    content: `❌ Error: ${trimmedDetail}`,
    messageCode: 'chat.runError',
    rawDetail: trimmedDetail,
  };
}

function resolveSubmitError(
  data: { errorCode?: string; errorParams?: Record<string, string | number | boolean | null> | null; errorDetail?: string | null; error?: string; message?: string },
  t: TFunction,
  fallbackKey: string
): string {
  if (data.errorCode) {
    const translated = t(data.errorCode, (data.errorParams || {}) as any);
    if (translated !== data.errorCode) {
      return String(translated);
    }
  }

  if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();
  if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  if (typeof data.errorDetail === 'string' && data.errorDetail.trim()) return data.errorDetail.trim();
  return String(t(fallbackKey));
}

interface UnifiedChatViewProps {
  mode: 'chat' | 'group';
  onMenuClick: () => void;
  sessions: { id: string; name: string; agentId?: string; characterId?: string; model?: string; runtimeMode?: string; runtime_mode?: string; process_start_tag?: string; process_end_tag?: string }[];
  // Chat mode
  isConnected?: boolean;
  activeSessionId?: string;
  // Group mode
  activeGroupId?: string | null;
  onSelectGroup?: (id: string) => void;
  availableModels?: any[];
}

// ============ CONSTANTS ============

const AGENT_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-purple-500', 'bg-orange-500',
  'bg-pink-500', 'bg-teal-500', 'bg-indigo-500', 'bg-amber-500',
];

const NAV_SUMMARY_FALLBACK_REGEXES = [
  /````(?:process_step_thought|process_step_thought_streaming)[\s\S]*?````/g,
  /\[引用开始[^\]]*\]/g,
  /\[引用结束\]/g,
  /\/uploads\/[^\s)]+/g,
  /\/api\/files\/[^\s)]+/g,
  /\[执行工作_Start\][\s\S]*?(?:\[执行工作_End\]|$)/g,
];
const NAV_QUOTE_BLOCK_REGEX = /\[引用开始(?:[ \t]+author=".*?")?(?:[ \t]+time=".*?")?\][\s\S]*?(?:\[引用结束\]|$)/g;

function normalizeNavSummaryWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function normalizeNavSummaryLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripMarkdownSyntaxForNav(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

function sanitizeNavSummaryText(text: string): string {
  const cleaned = NAV_SUMMARY_FALLBACK_REGEXES.reduce((value, regex) => value.replace(regex, '\n'), text);
  return normalizeNavSummaryWhitespace(stripMarkdownSyntaxForNav(cleaned));
}

function buildNavDotSummary(primary: string, secondary?: string): NavDotSummary {
  const normalizedPrimary = normalizeNavSummaryWhitespace(primary);
  const normalizedSecondary = secondary ? normalizeNavSummaryWhitespace(secondary) : '';
  const primaryLines = normalizedPrimary ? normalizedPrimary.split('\n') : [];
  const fallbackPrimary = normalizeNavSummaryLine(primaryLines[0] || normalizedSecondary || '');
  const inferredSecondary = primaryLines.length > 1 ? primaryLines.slice(1).join(' ') : '';
  const finalSecondary = normalizeNavSummaryLine(normalizedSecondary || inferredSecondary);

  return {
    primary: fallbackPrimary,
    secondary: finalSecondary && finalSecondary !== fallbackPrimary ? finalSecondary : undefined,
    tooltipText: [fallbackPrimary, finalSecondary].filter(Boolean).join('\n'),
  };
}

function extractNavDotSummary(content: string, t: TFunction): NavDotSummary {
  const quoteLabel = `[${t('unifiedChat.quotedContent')}]`;
  const hasQuote = content.includes('[引用开始');
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

function MessageListSkeleton() {
  const items = [
    { align: 'left', lines: ['w-32', 'w-[22rem]', 'w-[16rem]'], showAvatar: true },
    { align: 'right', lines: ['w-[18rem]', 'w-[12rem]'], showAvatar: false },
    { align: 'left', lines: ['w-24', 'w-[20rem]', 'w-[14rem]'], showAvatar: true },
    { align: 'right', lines: ['w-[16rem]', 'w-[10rem]'], showAvatar: false },
  ] as const;

  return (
    <div className="space-y-6 animate-pulse" aria-hidden="true">
      <div className="flex justify-center mb-8">
        <div className="h-7 w-36 rounded-full border border-gray-200 bg-[#f5f6f7]" />
      </div>
      {items.map((item, index) => (
        <div key={index} className={`flex w-full ${item.align === 'right' ? 'justify-end' : 'justify-start'}`}>
          <div className={`flex max-w-[min(42rem,88%)] items-start gap-3 ${item.align === 'right' ? 'flex-row-reverse' : ''}`}>
            {item.showAvatar && <div className="mt-1 h-9 w-9 rounded-full border border-gray-200 bg-[#f1f3f4] flex-shrink-0" />}
            <div className={`rounded-3xl border border-gray-200 bg-[#fafafa] px-4 py-3 ${item.align === 'right' ? 'min-w-[14rem] bg-[#f8f9fb]' : 'min-w-[16rem]'}`}>
              <div className="space-y-2.5">
                {item.lines.map((widthClass, lineIndex) => (
                  <div key={lineIndex} className={`h-3 rounded-full bg-gray-200/90 ${widthClass}`} />
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryLoadMoreSkeleton() {
  return (
    <div className="flex justify-center pt-1 pb-2 animate-pulse" aria-hidden="true">
      <div className="w-full max-w-2xl rounded-2xl border border-gray-200 bg-[#fafafa] px-4 py-3">
        <div className="mx-auto mb-3 h-3 w-28 rounded-full bg-gray-200/90" />
        <div className="space-y-2">
          <div className="h-2.5 w-full rounded-full bg-gray-200/80" />
          <div className="h-2.5 w-4/5 rounded-full bg-gray-100" />
        </div>
      </div>
    </div>
  );
}

function getAgentColor(agentId: string, members: GroupChat['members']): string {
  const idx = members.findIndex(m => m.agent_id === agentId);
  return AGENT_COLORS[idx % AGENT_COLORS.length] || AGENT_COLORS[0];
}

// ============ COMPONENT ============

export default function UnifiedChatView(props: UnifiedChatViewProps) {
  const { t, i18n } = useTranslation();
  const { mode, onMenuClick, sessions } = props;
  const isChat = mode === 'chat';
  const isGroup = mode === 'group';
  const activeKey = isChat ? (props.activeSessionId || '') : (props.activeGroupId || '');
  const currentLocale = normalizeLanguage(i18n.resolvedLanguage || i18n.language);

  // ---- Shared State ----
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // 发送/上传/加载失败时说人话。此前这些路径只把输入退回输入框、
  // 或者 catch {} 了事——用户看到消息弹回来却不知道为什么，只能反复重试。
  const [submitError, setSubmitError] = useState('');
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editExistingAttachments, setEditExistingAttachments] = useState<any[]>([]);
  const [editPendingFiles, setEditPendingFiles] = useState<any[]>([]);
  const [editIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [inputPreview, setInputPreview] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{file: File, preview: string}[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [previewFile, setPreviewFile] = useState<{url: string, filename: string} | null>(null);
  const [quotedMessage, setQuotedMessage] = useState<ChatMessage | null>(null);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [messageToDelete, setMessageToDelete] = useState<string | null>(null);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState('');
  const [fileErrorModalOpen, setFileErrorModalOpen] = useState(false);
  const [fileErrorMessage, setFileErrorMessage] = useState('');
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [historyPageRounds, setHistoryPageRounds] = useState(() => readChatHistoryPageRounds());
  const [historyEdgePrompt, setHistoryEdgePrompt] = useState<HistoryPagingDirection | null>(null);
  const [historyPageNotice, setHistoryPageNotice] = useState<HistoryPageNotice | null>(null);
  const [pageInfo, setPageInfo] = useState<HistoryPageInfo>(() => (
    createEmptyHistoryPageInfo(Math.max(HISTORY_FETCH_BATCH_MIN_LIMIT, readChatHistoryPageRounds() * 2))
  ));

  // Search
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [debouncedMessageSearchQuery, setDebouncedMessageSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);
  const matchedMessageIdSet = useMemo(
    () => new Set(searchMatches.map((match) => match.messageId)),
    [searchMatches]
  );

  // Nav dots
  const [navDots, setNavDots] = useState<NavDot[]>([]);
  const [hoveredDot, setHoveredDot] = useState<string | null>(null);
  const [activeNavDot, setActiveNavDot] = useState<string | null>(null);

  // ---- Chat-mode State ----
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [showCommands, setShowCommands] = useState(false);
  const [allCommands, setAllCommands] = useState<{ id: number; command: string; description: string }[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<{ id: number; command: string; description: string }[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [aiName, setAiName] = useState('OpenClaw');
  const [characters, setCharacters] = useState<any[]>([]);

  // ---- Group-mode State ----
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [typingAgents, setTypingAgents] = useState<Map<string, string>>(new Map());
  const [groupRunState, setGroupRunState] = useState<GroupRunState>({ active: false, agentId: null, runId: null, startedAt: null });
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newGroupId, setNewGroupId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<GroupMember[]>([]);
  const [groupCreateError, setGroupCreateError] = useState<string | null>(null);
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);

  // ---- Refs ----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const attachedRunControllerRef = useRef<AbortController | null>(null);
  const justSelectedFileRef = useRef(false);
  const dragCounter = useRef(0);
  const isInitialLoad = useRef(true);
  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeLeafIdRef = useRef<string | null>(null);
  const pageInfoRef = useRef<HistoryPageInfo>(pageInfo);
  const lastAppliedHistoryPageRoundsRef = useRef(historyPageRounds);
  const historyContextRef = useRef('');
  const queuedMessagePatchesRef = useRef<Map<string, Partial<ChatMessage>>>(new Map());
  const queuedMessagePatchTimerRef = useRef<number | null>(null);
  const navScrollFrameRef = useRef<number | null>(null);
  const navDotPagingLockedRef = useRef(false);
  const navDotPagingUnlockTimerRef = useRef<number | null>(null);
  const historyEdgePromptReadyRef = useRef(false);
  const historyEdgePromptArmTimerRef = useRef<number | null>(null);
  const touchPagingStartYRef = useRef<number | null>(null);
  const touchPagingHandledRef = useRef(false);
  const touchPagingArmedInCurrentGestureRef = useRef(false);
  const historyPageNoticeTimerRef = useRef<number | null>(null);
  const activeHighlightTimerRef = useRef<number | null>(null);
  const pendingSearchFocusMessageIdRef = useRef<string | null>(null);
  const searchRequestIdRef = useRef(0);
  const searchNavigationIdRef = useRef(0);
  const olderLoadInFlightRef = useRef(false);
  const staleGroupReloadAttemptRef = useRef<string | null>(null);
  const previousGroupRunActiveRef = useRef(false);
  const groupSseRecoveryAtRef = useRef(0);
  const newerHistoryPagesRef = useRef<HistoryPageSnapshot[]>([]);
  const historyWindowScrollTargetRef = useRef<'top' | 'bottom' | null>(null);
  const historyWindowScrollLockRef = useRef(false);
  const historyWindowPagingGuardRef = useRef({ allowOlder: true, allowNewer: true });
  const skipNextAutoScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const forceAutoScrollRef = useRef(false);
  const wasChatLoadingRef = useRef(false);
  const wasGroupBusyRef = useRef(false);

  useEffect(() => {
    return () => {
      attachedRunControllerRef.current?.abort();
      attachedRunControllerRef.current = null;
      if (activeHighlightTimerRef.current !== null) {
        window.clearTimeout(activeHighlightTimerRef.current);
        activeHighlightTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    previousGroupRunActiveRef.current = false;
  }, [activeKey, mode]);

  messagesRef.current = messages;
  activeLeafIdRef.current = activeLeafId;
  pageInfoRef.current = pageInfo;
  historyContextRef.current = `${mode}:${activeKey}`;

  // ---- Derived State ----
  const currentGroup = isGroup ? (groups.find(g => g.id === activeKey) || null) : null;
  const currentSession = isChat ? (sessions.find(s => s.id === activeKey) || null) : null;
  const groupIdErrorKey = getGroupIdValidationKey(
    newGroupId,
    groups.map((group) => group.id),
    { requireValue: true }
  );
  const groupIdError = groupIdErrorKey
    ? String(t(groupIdErrorKey, { groupId: newGroupId.trim() }))
    : null;
  const visibleGroupIdError = groupIdErrorKey && groupIdErrorKey !== 'groups.idRequired'
    ? groupIdError
    : null;
  const activeSessionName = currentSession?.name || aiName || t('unifiedChat.untitledRole');
  const findSessionByAgentId = useCallback((agentId?: string) => {
    if (!agentId) return null;
    return sessions.find(s => (s.agentId || s.id) === agentId) || null;
  }, [sessions]);
  const resolveGroupMemberDisplayName = useCallback((member: Pick<GroupChatMember, 'agent_id' | 'display_name'> | GroupMember) => {
    const agentId = 'agent_id' in member ? member.agent_id : member.agentId;
    const fallbackName = 'display_name' in member ? member.display_name : member.displayName;
    return findSessionByAgentId(agentId)?.name || fallbackName || agentId;
  }, [findSessionByAgentId]);
  const hasDraftToSend = Boolean(input.trim() || pendingFiles.length > 0 || quotedMessage);

  const getPreferredLeafId = useCallback((nextMessages: ChatMessage[]) => {
    if (nextMessages.length === 0) return null;
    return nextMessages[nextMessages.length - 1]?.id ?? null;
  }, []);

  const countVisibleUserRounds = useCallback((nextMessages: ChatMessage[]) => {
    return nextMessages.filter((message) => message.role === 'user').length;
  }, []);

  const getCurrentHistoryWindowSnapshot = useCallback((
    nextMessages: ChatMessage[],
    _nextLeafId: string | null,
    currentPageInfo: HistoryPageInfo = pageInfoRef.current,
  ) => (
    buildLinearHistoryWindowSnapshot(
      nextMessages,
      currentPageInfo,
      historyPageRounds,
      getPreferredLeafId,
    )
  ), [getPreferredLeafId, historyPageRounds]);

  const historyFetchBatchLimit = useMemo(() => (
    Math.min(200, Math.max(HISTORY_FETCH_BATCH_MIN_LIMIT, historyPageRounds * 2))
  ), [historyPageRounds]);

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


  // ---- Nav Dots ----
  const userMessages = useMemo(() => {
    return visibleMessages.filter(m => m.role === 'user');
  }, [visibleMessages]);

  const navDotsEnabled = !isInitialLoading && userMessages.length > 0;

  const flushQueuedMessagePatches = useCallback(() => {
    if (queuedMessagePatchTimerRef.current !== null) {
      window.clearTimeout(queuedMessagePatchTimerRef.current);
      queuedMessagePatchTimerRef.current = null;
    }

    const queuedEntries = Array.from(queuedMessagePatchesRef.current.entries());
    if (queuedEntries.length === 0) return;

    queuedMessagePatchesRef.current.clear();
    const queuedMap = new Map(queuedEntries);

    setMessages(prev => {
      let hasChanges = false;
      const next = prev.map(message => {
        const patch = queuedMap.get(message.id);
        if (!patch) return message;
        const merged = mergeMessagePreservingContent(message, patch);
        if (merged !== message) {
          hasChanges = true;
        }
        return merged;
      });
      return hasChanges ? next : prev;
    });
  }, []);

  const scheduleQueuedMessagePatchFlush = useCallback(() => {
    if (queuedMessagePatchTimerRef.current !== null) return;
    queuedMessagePatchTimerRef.current = window.setTimeout(() => {
      queuedMessagePatchTimerRef.current = null;
      flushQueuedMessagePatches();
    }, STREAM_UPDATE_BATCH_MS);
  }, [flushQueuedMessagePatches]);

  const queueMessagePatch = useCallback((messageId: string, patch: Partial<ChatMessage>) => {
    const existing = queuedMessagePatchesRef.current.get(messageId) || {};
    queuedMessagePatchesRef.current.set(messageId, mergeMessagePatchPreservingContent(existing, patch));
    scheduleQueuedMessagePatchFlush();
  }, [scheduleQueuedMessagePatchFlush]);

  const clearQueuedMessagePatches = useCallback(() => {
    if (queuedMessagePatchTimerRef.current !== null) {
      window.clearTimeout(queuedMessagePatchTimerRef.current);
      queuedMessagePatchTimerRef.current = null;
    }
    queuedMessagePatchesRef.current.clear();
  }, []);

  const dropQueuedMessagePatch = useCallback((messageId: string) => {
    queuedMessagePatchesRef.current.delete(messageId);
  }, []);

  const clearNewerHistoryWindowTrail = useCallback(() => {
    newerHistoryPagesRef.current = [];
  }, []);

  const moveQueuedMessagePatch = useCallback((fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return;
    const fromPatch = queuedMessagePatchesRef.current.get(fromId);
    if (!fromPatch) return;
    const existingTargetPatch = queuedMessagePatchesRef.current.get(toId) || {};
    queuedMessagePatchesRef.current.set(toId, mergeMessagePatchPreservingContent(existingTargetPatch, fromPatch));
    queuedMessagePatchesRef.current.delete(fromId);
  }, []);

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

  useLayoutEffect(() => {
    const scrollTarget = historyWindowScrollTargetRef.current;
    const container = scrollContainerRef.current;
    if (!scrollTarget || !container) return;

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const bufferOffset = HISTORY_LOAD_TRIGGER_PX * 2;

    if (scrollTarget === 'bottom') {
      container.scrollTop = Math.max(0, maxScrollTop - bufferOffset);
    } else {
      container.scrollTop = Math.min(maxScrollTop, bufferOffset);
    }

    historyWindowScrollTargetRef.current = null;
    window.requestAnimationFrame(() => {
      recalcNavDots();
      handleNavScroll();
      isNearBottomRef.current = isContainerNearBottom(container);
      historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
      historyWindowScrollLockRef.current = false;
    });
  }, [handleNavScroll, messages, recalcNavDots]);

  useLayoutEffect(() => {
    if (isInitialLoading || historyWindowScrollLockRef.current) return;
    if (messages.length === 0) return;

    const snapshot = getCurrentHistoryWindowSnapshot(messages, activeLeafId);
    const sameMessages = areMessageListsEquivalent(snapshot.messages, messages);
    const sameLeaf = snapshot.activeLeafId === activeLeafId;
    const samePageInfo = areHistoryPageInfosEqual(snapshot.pageInfo, pageInfoRef.current);

    if (sameMessages && sameLeaf && samePageInfo) {
      return;
    }

    if (!sameMessages) {
      setMessages(snapshot.messages);
    }
    if (!sameLeaf) {
      setActiveLeafId(snapshot.activeLeafId);
    }
    if (!samePageInfo) {
      setPageInfo(snapshot.pageInfo);
    }
  }, [activeLeafId, getCurrentHistoryWindowSnapshot, isInitialLoading, messages]);

  const updateNearBottomState = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    isNearBottomRef.current = isContainerNearBottom(container);
  }, []);

  const scrollToLatestBottom = useCallback(() => {
    forceAutoScrollRef.current = true;
    window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      updateNearBottomState();
    });
  }, [updateNearBottomState]);

  const prepareLatestHistoryWindowForSubmit = useCallback(() => {
    const latestSnapshot = newerHistoryPagesRef.current[0];
    if (!latestSnapshot) {
      forceAutoScrollRef.current = true;
      return activeLeafIdRef.current;
    }

    clearHistoryEdgePrompt();
    olderLoadInFlightRef.current = false;
    newerHistoryPagesRef.current = [];
    historyWindowScrollTargetRef.current = null;
    historyWindowScrollLockRef.current = false;
    historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
    skipNextAutoScrollRef.current = false;
    setHistoryPageNotice(null);
    setIsLoadingOlder(false);
    forceAutoScrollRef.current = true;

    const nextLeafId = latestSnapshot.activeLeafId && latestSnapshot.messages.some(message => message.id === latestSnapshot.activeLeafId)
      ? latestSnapshot.activeLeafId
      : getPreferredLeafId(latestSnapshot.messages);

    setPageInfo(latestSnapshot.pageInfo);
    setMessages(latestSnapshot.messages);
    setActiveLeafId(nextLeafId);

    return nextLeafId;
  }, [clearHistoryEdgePrompt, getPreferredLeafId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    updateNearBottomState();
    const handle = () => updateNearBottomState();
    container.addEventListener('scroll', handle, { passive: true });
    return () => container.removeEventListener('scroll', handle);
  }, [updateNearBottomState]);

  // ---- Scroll to bottom ----
  useEffect(() => {
    isInitialLoad.current = true;
    isNearBottomRef.current = true;
    forceAutoScrollRef.current = false;
  }, [activeKey]);

  useEffect(() => {
    if (messages.length === 0) return;
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    const shouldAutoScroll = isInitialLoad.current || forceAutoScrollRef.current || isNearBottomRef.current;
    if (!shouldAutoScroll) return;
    const timer = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      if (isInitialLoad.current) isInitialLoad.current = false;
      forceAutoScrollRef.current = false;
      updateNearBottomState();
    }, 50);
    return () => clearTimeout(timer);
  }, [messages, typingAgents, activeKey, updateNearBottomState]);

  // ---- Textarea auto-resize + command filtering ----
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
    if (isChat && input.startsWith('/') && !input.includes(' ')) {
      const filter = input.split(' ')[0].toLowerCase();
      const filtered = allCommands.filter(c => c.command.toLowerCase().includes(filter));
      setFilteredCommands(filtered);
      setShowCommands(filtered.length > 0);
      setCommandIndex(0);
    } else if (isChat) {
      setShowCommands(false);
    }
  }, [input, allCommands, isChat]);

  // Click outside commands
  useEffect(() => {
    if (!showCommands) return;
    const handle = (e: MouseEvent) => { if (commandListRef.current && !commandListRef.current.contains(e.target as Node)) setShowCommands(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showCommands]);

  const syncSharedHistoryPageRounds = useCallback(async () => {
    try {
      const response = await fetch('/api/config');
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

  // =============== CHAT-MODE EFFECTS ===============
  useEffect(() => {
    if (!isChat) return;
    fetch('/api/config').then(r => r.json()).then(data => { if (data.aiName) setAiName(data.aiName); }).catch(() => {});
    fetchCommands();
    fetch('/api/characters').then(res => res.json()).then(data => { if (data.success) setCharacters(data.characters); }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChat]);

  const fetchCommands = async () => {
    try { const res = await fetch('/api/commands'); const data = await res.json(); if (data.success) setAllCommands(data.commands); } catch {}
  };

  const mapChatHistoryPageMessages = useCallback((rawMessages: any[]) => {
    const loadTimeSession = sessions.find(s => s.id === activeKey);
    const loadTimeAgentName = loadTimeSession?.name || aiName || '';
    return rawMessages.map((m: any) => {
      const historyMessage = mapChatHistoryMessage(m);
      return {
        ...historyMessage,
        agentName: historyMessage.agentName || loadTimeAgentName || undefined,
      };
    });
  }, [activeKey, aiName, sessions]);

  const fetchHistoryPage = useCallback(async (
    { beforeId = null, limit = historyFetchBatchLimit }: { beforeId?: number | null; limit?: number } = {}
  ): Promise<{ messages: ChatMessage[]; pageInfo: HistoryPageInfo } | null> => {
    if (!activeKey) return null;

    const contextKey = `${mode}:${activeKey}`;

    if (isChat && beforeId === null) {
      try {
        const configRes = await fetch('/api/config');
        const configData = await configRes.json();
        if (
          historyContextRef.current === contextKey &&
          configData?.defaultAgent &&
          configData.defaultAgent !== 'main'
        ) {
          setCurrentModel(configData.defaultAgent);
        }
      } catch {}
    }

    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (typeof beforeId === 'number') params.set('beforeId', String(beforeId));

    const endpoint = isChat ? `/api/history/${activeKey}` : `/api/groups/${activeKey}/messages`;
    const response = await fetch(`${endpoint}?${params.toString()}`);
    const data = await response.json();

    if (!data?.success || !Array.isArray(data.messages)) return null;

    return {
      messages: isChat ? mapChatHistoryPageMessages(data.messages) : data.messages.map((m: any) => mapGroupMsg(m)),
      pageInfo: normalizeHistoryPageInfo(data.pageInfo, limit),
    };
  }, [activeKey, historyFetchBatchLimit, isChat, mapChatHistoryPageMessages, mode]);

  const mergeChatMessagesIntoState = useCallback((
    incomingMessages: ChatMessage[],
    options?: { focusLatest?: boolean }
  ) => {
    if (incomingMessages.length === 0) return;

    const nextMessages = mergeMessageCollectionPreservingContent(messagesRef.current, incomingMessages);

    setMessages((prev) => {
      return mergeMessageCollectionPreservingContent(prev, incomingMessages);
    });

    if (options?.focusLatest) {
      setActiveLeafId(getPreferredLeafId(nextMessages));
    }
  }, [getPreferredLeafId]);

  const recoverLatestChatMessages = useCallback(async (focusLatest = false) => {
    if (!isChat || !activeKey) return false;

    try {
      const result = await fetchHistoryPage({
        limit: Math.max(HISTORY_FETCH_BATCH_MIN_LIMIT, Math.min(historyFetchBatchLimit, 80)),
      });
      if (!result || result.messages.length === 0) {
        return false;
      }

      mergeChatMessagesIntoState(result.messages, { focusLatest });
      return true;
    } catch {
      return false;
    }
  }, [activeKey, fetchHistoryPage, historyFetchBatchLimit, isChat, mergeChatMessagesIntoState]);

  const recoverChatActiveRun = useCallback(async (signal?: AbortSignal) => {
    if (!isChat || !activeKey) return { ok: false as const, active: false as const };

    try {
      const response = await fetch(`/api/chat/${activeKey}/active-run`, { signal });
      const data = await response.json();
      if (!data?.success) {
        return { ok: false as const, active: false as const };
      }
      return { ok: true as const, active: !!data.active };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return { ok: false as const, active: false as const };
      }
      return { ok: false as const, active: false as const };
    }
  }, [activeKey, isChat]);

  useEffect(() => {
    if (!isChat || !activeKey || !isLoading || isInitialLoading) return;

    let cancelled = false;
    const controller = new AbortController();
    let timer: number | null = null;

    const poll = async () => {
      const recovery = await recoverChatActiveRun(controller.signal);
      if (cancelled || controller.signal.aborted) return;

      if (recovery.ok && !recovery.active) {
        await recoverLatestChatMessages(true);
        if (!cancelled && !controller.signal.aborted) {
          setIsLoading(false);
        }
        return;
      }

      timer = window.setTimeout(poll, CHAT_ACTIVE_RUN_RECOVERY_POLL_MS);
    };

    timer = window.setTimeout(poll, CHAT_ACTIVE_RUN_RECOVERY_POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [activeKey, isChat, isInitialLoading, isLoading, recoverChatActiveRun, recoverLatestChatMessages]);

  const loadHistoryWindow = useCallback(async (
    { beforeId = null }: { beforeId?: number | null } = {}
  ): Promise<HistoryPageSnapshot | null> => {
    let cursorBeforeId = beforeId;
    let accumulatedMessages: ChatMessage[] = [];
    let currentPageInfo = createEmptyHistoryPageInfo(historyFetchBatchLimit);

    for (let batchIndex = 0; batchIndex < HISTORY_WINDOW_MAX_FETCH_BATCHES; batchIndex += 1) {
      const result = await fetchHistoryPage({ beforeId: cursorBeforeId, limit: historyFetchBatchLimit });
      if (!result) {
        if (accumulatedMessages.length === 0) {
          return null;
        }

        return buildLinearHistoryWindowSnapshot(
          accumulatedMessages,
          currentPageInfo,
          historyPageRounds,
          getPreferredLeafId,
        );
      }

      accumulatedMessages = mergeHistoryMessages(result.messages, accumulatedMessages);
      currentPageInfo = result.pageInfo;

      const visibleUserRounds = countVisibleUserRounds(accumulatedMessages);
      if (visibleUserRounds >= historyPageRounds || !currentPageInfo.hasMoreOlder || currentPageInfo.nextBeforeId === null) {
        return buildLinearHistoryWindowSnapshot(
          accumulatedMessages,
          currentPageInfo,
          historyPageRounds,
          getPreferredLeafId,
        );
      }

      cursorBeforeId = currentPageInfo.nextBeforeId;
    }

    return buildLinearHistoryWindowSnapshot(
      accumulatedMessages,
      currentPageInfo,
      historyPageRounds,
      getPreferredLeafId,
    );
  }, [countVisibleUserRounds, fetchHistoryPage, getPreferredLeafId, historyFetchBatchLimit, historyPageRounds]);

  const revealSearchMatchInLoadedMessages = useCallback((targetMessageId: string, nextMessages: ChatMessage[]): boolean => {
    if (!targetMessageId || !nextMessages.some((message) => message.id === targetMessageId)) {
      return false;
    }

    pendingSearchFocusMessageIdRef.current = null;
    scrollToMessage(targetMessageId);
    return true;
  }, [scrollToMessage]);

  const jumpToSearchMatch = useCallback(async (match: SearchMatch) => {
    if (!match.messageId || !activeKey) return;

    const navigationId = ++searchNavigationIdRef.current;
    if (revealSearchMatchInLoadedMessages(match.messageId, messagesRef.current)) {
      return;
    }

    const contextKey = `${mode}:${activeKey}`;

    try {
      const snapshot = await loadHistoryWindow({ beforeId: match.anchorBeforeId });
      if (
        !snapshot
        || historyContextRef.current !== contextKey
        || searchNavigationIdRef.current !== navigationId
        || !snapshot.messages.some((message) => message.id === match.messageId)
      ) {
        return;
      }

      clearHistoryEdgePrompt();
      olderLoadInFlightRef.current = false;
      newerHistoryPagesRef.current = [];
      historyWindowScrollTargetRef.current = null;
      historyWindowScrollLockRef.current = false;
      historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
      skipNextAutoScrollRef.current = true;
      setTypingAgents(new Map());
      setIsLoadingOlder(false);
      setPageInfo(snapshot.pageInfo);
      setMessages(snapshot.messages);
      pendingSearchFocusMessageIdRef.current = match.messageId;
      setActiveLeafId(snapshot.activeLeafId);
    } catch {}
  }, [activeKey, clearHistoryEdgePrompt, loadHistoryWindow, mode, revealSearchMatchInLoadedMessages]);

  useEffect(() => {
    const targetMessageId = pendingSearchFocusMessageIdRef.current;
    if (!targetMessageId) return;
    if (!visibleMessages.some((message) => message.id === targetMessageId)) return;

    const frameId = window.requestAnimationFrame(() => {
      if (!visibleMessages.some((message) => message.id === targetMessageId)) return;
      pendingSearchFocusMessageIdRef.current = null;
      scrollToMessage(targetMessageId);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [scrollToMessage, visibleMessages]);

  useEffect(() => {
    const normalizedQuery = debouncedMessageSearchQuery.trim();
    if (!activeKey || !normalizedQuery) {
      searchRequestIdRef.current += 1;
      searchNavigationIdRef.current += 1;
      pendingSearchFocusMessageIdRef.current = null;
      setSearchMatches([]);
      setCurrentMatchIndex(-1);
      return;
    }

    const requestId = ++searchRequestIdRef.current;
    const contextKey = `${mode}:${activeKey}`;
    let cancelled = false;

    const runSearch = async () => {
      try {
        const params = new URLSearchParams();
        params.set('q', normalizedQuery);
        const endpoint = isChat
          ? `/api/history/${activeKey}/search`
          : `/api/groups/${activeKey}/messages/search`;
        const response = await fetch(`${endpoint}?${params.toString()}`);
        const data = await response.json();

        if (cancelled || searchRequestIdRef.current !== requestId || historyContextRef.current !== contextKey) {
          return;
        }

        const nextMatches: SearchMatch[] = Array.isArray(data?.matches)
          ? data.matches
              .filter((match: any) => typeof match?.messageId === 'string' && match.messageId)
              .map((match: any) => ({
                messageId: match.messageId,
                anchorBeforeId: typeof match?.anchorBeforeId === 'number' ? match.anchorBeforeId : null,
              }))
          : [];

        setSearchMatches(nextMatches);
        if (nextMatches.length === 0) {
          setCurrentMatchIndex(-1);
          return;
        }

        const initialIndex = nextMatches.length - 1;
        setCurrentMatchIndex(initialIndex);
        void jumpToSearchMatch(nextMatches[initialIndex]);
      } catch {
        if (cancelled || searchRequestIdRef.current !== requestId || historyContextRef.current !== contextKey) {
          return;
        }
        setSearchMatches([]);
        setCurrentMatchIndex(-1);
      }
    };

    void runSearch();

    return () => {
      cancelled = true;
    };
  }, [activeKey, debouncedMessageSearchQuery, isChat, jumpToSearchMatch, mode]);

  const handleNextSearch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const nextIndex = currentMatchIndex < searchMatches.length - 1 ? currentMatchIndex + 1 : 0;
    setCurrentMatchIndex(nextIndex);
    void jumpToSearchMatch(searchMatches[nextIndex]);
  }, [currentMatchIndex, jumpToSearchMatch, searchMatches]);

  const handlePrevSearch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const nextIndex = currentMatchIndex > 0 ? currentMatchIndex - 1 : searchMatches.length - 1;
    setCurrentMatchIndex(nextIndex);
    void jumpToSearchMatch(searchMatches[nextIndex]);
  }, [currentMatchIndex, jumpToSearchMatch, searchMatches]);

  // Initial-page loader only: fetch the latest history window for the current chat/group context.
  // This should not be used as a generic post-send refresh, otherwise it would replace the current page window.
  const loadHistory = useCallback(async ({ showSkeleton = false }: { showSkeleton?: boolean } = {}) => {
    if (!activeKey) {
      if (showSkeleton) setIsInitialLoading(false);
      return;
    }

    const contextKey = `${mode}:${activeKey}`;
    clearQueuedMessagePatches();
    olderLoadInFlightRef.current = false;
    newerHistoryPagesRef.current = [];
    historyWindowScrollTargetRef.current = null;
    historyWindowScrollLockRef.current = false;
    historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
    skipNextAutoScrollRef.current = false;
    clearHistoryEdgePrompt();
    setHistoryPageNotice(null);
    setIsLoadingOlder(false);

    if (showSkeleton) {
      setIsInitialLoading(true);
      setMessages([]);
      setActiveLeafId(null);
      setPageInfo(createEmptyHistoryPageInfo(historyFetchBatchLimit));
    }

    try {
      const result = await loadHistoryWindow();
      if (!result || historyContextRef.current !== contextKey) return;

      setTypingAgents(new Map());
      setMessages(result.messages);
      setPageInfo(result.pageInfo);
      setActiveLeafId(result.activeLeafId);
      setSubmitError('');
    } catch (error: any) {
      // 之前是 catch {}：showSkeleton 已经把消息清空了，加载失败就变成一个
      // 「空会话」——用户以为聊天记录没了，实际只是这次没拉到。必须说清楚。
      if (historyContextRef.current === contextKey) {
        setSubmitError(error?.message || t('unifiedChat.historyLoadFailed'));
      }
    }
    finally {
      if (showSkeleton && historyContextRef.current === contextKey) {
        setIsInitialLoading(false);
      }
    }
  }, [activeKey, clearHistoryEdgePrompt, clearQueuedMessagePatches, loadHistoryWindow, mode]);

  useEffect(() => {
    const previousRounds = lastAppliedHistoryPageRoundsRef.current;
    if (previousRounds === historyPageRounds) return;
    lastAppliedHistoryPageRoundsRef.current = historyPageRounds;

    if (!activeKey) return;
    loadHistory({ showSkeleton: true });
  }, [activeKey, historyPageRounds, loadHistory]);

  useEffect(() => {
    if (!isGroup || !activeKey || isInitialLoading || groupRunState.active || newerHistoryPagesRef.current.length > 0) {
      staleGroupReloadAttemptRef.current = null;
      return;
    }

    const latestVisibleMessage = [...visibleMessages].reverse().find((message) => message.role !== 'user');
    if (!latestVisibleMessage || latestVisibleMessage.role !== 'assistant') {
      staleGroupReloadAttemptRef.current = null;
      return;
    }

    const { startTag: processStartTag, endTag: processEndTag } = resolveProcessTagPair(
      currentGroup?.process_start_tag,
      currentGroup?.process_end_tag,
      findSessionByAgentId(latestVisibleMessage.agentId)?.process_start_tag,
      findSessionByAgentId(latestVisibleMessage.agentId)?.process_end_tag,
    );
    const needsReconcile = isLikelyInactiveGroupMessageStale(latestVisibleMessage.content, processStartTag, processEndTag);

    if (!needsReconcile) {
      staleGroupReloadAttemptRef.current = null;
      return;
    }

    const attemptKey = `${mode}:${activeKey}:${latestVisibleMessage.id}:${latestVisibleMessage.content.length}:${latestVisibleMessage.content.slice(0, 120)}`;
    if (staleGroupReloadAttemptRef.current === attemptKey) {
      return;
    }

    staleGroupReloadAttemptRef.current = attemptKey;
    void loadHistory();
  }, [
    activeKey,
    currentGroup?.process_end_tag,
    currentGroup?.process_start_tag,
    findSessionByAgentId,
    groupRunState.active,
    isGroup,
    isInitialLoading,
    loadHistory,
    mode,
    visibleMessages,
  ]);

  const loadOlderHistory = useCallback(async () => {
    if (
      !activeKey
      || isInitialLoading
      || olderLoadInFlightRef.current
      || historyWindowScrollLockRef.current
      || !pageInfo.hasMoreOlder
      || pageInfo.nextBeforeId === null
    ) return;

    const contextKey = `${mode}:${activeKey}`;
    olderLoadInFlightRef.current = true;
    setIsLoadingOlder(true);
    clearHistoryEdgePrompt();

    try {
      const result = await loadHistoryWindow({ beforeId: pageInfo.nextBeforeId });
      if (!result || historyContextRef.current !== contextKey || result.messages.length === 0) return;

      newerHistoryPagesRef.current.push({
        messages: messagesRef.current,
        activeLeafId: activeLeafIdRef.current,
        pageInfo,
      });

      historyWindowScrollLockRef.current = true;
      historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: false };
      historyWindowScrollTargetRef.current = 'bottom';
      skipNextAutoScrollRef.current = true;
      setTypingAgents(new Map());
      setMessages(result.messages);
      setPageInfo(result.pageInfo);
      setActiveLeafId(result.activeLeafId);
      showHistoryPageNotice('older');
    } catch {}
    finally {
      olderLoadInFlightRef.current = false;
      if (historyContextRef.current === contextKey) {
        setIsLoadingOlder(false);
      }
    }
  }, [activeKey, clearHistoryEdgePrompt, isInitialLoading, loadHistoryWindow, mode, pageInfo, showHistoryPageNotice]);

  const loadNewerHistory = useCallback(() => {
    if (isInitialLoading || isLoadingOlder || historyWindowScrollLockRef.current) return;

    const snapshot = newerHistoryPagesRef.current.pop();
    if (!snapshot) return;

    clearHistoryEdgePrompt();
    historyWindowScrollLockRef.current = true;
    historyWindowPagingGuardRef.current = { allowOlder: false, allowNewer: true };
    historyWindowScrollTargetRef.current = 'top';
    skipNextAutoScrollRef.current = true;
    setTypingAgents(new Map());
    setMessages(snapshot.messages);
    setPageInfo(snapshot.pageInfo);
    setActiveLeafId(
      snapshot.activeLeafId && snapshot.messages.some(message => message.id === snapshot.activeLeafId)
        ? snapshot.activeLeafId
        : getPreferredLeafId(snapshot.messages)
    );
    showHistoryPageNotice('newer');
  }, [clearHistoryEdgePrompt, getPreferredLeafId, isInitialLoading, isLoadingOlder, showHistoryPageNotice]);

  const handleHistoryWindowOnScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || isInitialLoading || isLoadingOlder || historyWindowScrollLockRef.current || messagesRef.current.length === 0) return;
    if (navDotPagingLockedRef.current) {
      scheduleNavDotPagingUnlock();
      return;
    }

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const rearmThreshold = HISTORY_LOAD_TRIGGER_PX * 2;
    const canPromptOlder = historyWindowPagingGuardRef.current.allowOlder && pageInfo.hasMoreOlder && pageInfo.nextBeforeId !== null;
    const canPromptNewer = historyWindowPagingGuardRef.current.allowNewer && newerHistoryPagesRef.current.length > 0;

    if (!historyWindowPagingGuardRef.current.allowOlder && container.scrollTop > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowOlder = true;
    }
    if (!historyWindowPagingGuardRef.current.allowNewer && distanceFromBottom > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowNewer = true;
    }

    if (historyEdgePrompt === 'older' && (!canPromptOlder || container.scrollTop > rearmThreshold)) {
      clearHistoryEdgePrompt();
      return;
    }

    if (historyEdgePrompt === 'newer' && (!canPromptNewer || distanceFromBottom > rearmThreshold)) {
      clearHistoryEdgePrompt();
      return;
    }

    if (container.scrollTop <= HISTORY_LOAD_TRIGGER_PX && canPromptOlder) {
      armHistoryEdgePrompt('older');
      return;
    }

    if (distanceFromBottom <= HISTORY_LOAD_TRIGGER_PX && canPromptNewer) {
      armHistoryEdgePrompt('newer');
    }
  }, [armHistoryEdgePrompt, clearHistoryEdgePrompt, historyEdgePrompt, isInitialLoading, isLoadingOlder, pageInfo, scheduleNavDotPagingUnlock]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleHistoryWindowOnScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleHistoryWindowOnScroll);
  }, [handleHistoryWindowOnScroll]);

  const handleHistoryWindowWheel = useCallback((event: WheelEvent) => {
    const container = scrollContainerRef.current;
    if (!container || isInitialLoading || isLoadingOlder || historyWindowScrollLockRef.current || messagesRef.current.length === 0) return;

    if (navDotPagingLockedRef.current) {
      clearNavDotPagingUnlockTimer();
      navDotPagingLockedRef.current = false;
    }

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const rearmThreshold = HISTORY_LOAD_TRIGGER_PX * 2;
    const canPromptOlder = historyWindowPagingGuardRef.current.allowOlder && pageInfo.hasMoreOlder && pageInfo.nextBeforeId !== null;
    const canPromptNewer = historyWindowPagingGuardRef.current.allowNewer && newerHistoryPagesRef.current.length > 0;

    if (!historyWindowPagingGuardRef.current.allowOlder && container.scrollTop > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowOlder = true;
    }
    if (!historyWindowPagingGuardRef.current.allowNewer && distanceFromBottom > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowNewer = true;
    }

    if (event.deltaY < 0) {
      if (historyEdgePrompt === 'newer') {
        clearHistoryEdgePrompt();
      }

      if (canPromptOlder && container.scrollTop <= HISTORY_LOAD_TRIGGER_PX) {
        if (historyEdgePrompt === 'older' && historyEdgePromptReadyRef.current) {
          loadOlderHistory();
        } else {
          armHistoryEdgePrompt('older');
        }
      }
      return;
    }

    if (event.deltaY > 0) {
      if (historyEdgePrompt === 'older') {
        clearHistoryEdgePrompt();
      }

      if (canPromptNewer && distanceFromBottom <= HISTORY_LOAD_TRIGGER_PX) {
        if (historyEdgePrompt === 'newer' && historyEdgePromptReadyRef.current) {
          loadNewerHistory();
        } else {
          armHistoryEdgePrompt('newer');
        }
      }
    }
  }, [armHistoryEdgePrompt, clearHistoryEdgePrompt, clearNavDotPagingUnlockTimer, historyEdgePrompt, isInitialLoading, isLoadingOlder, loadNewerHistory, loadOlderHistory, pageInfo]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('wheel', handleHistoryWindowWheel, { passive: true });
    return () => container.removeEventListener('wheel', handleHistoryWindowWheel);
  }, [handleHistoryWindowWheel]);

  const handleHistoryWindowTouchStart = useCallback((event: TouchEvent) => {
    const firstTouch = event.touches[0];
    touchPagingStartYRef.current = firstTouch ? firstTouch.clientY : null;
    touchPagingHandledRef.current = false;
    touchPagingArmedInCurrentGestureRef.current = false;
  }, []);

  const handleHistoryWindowTouchMove = useCallback((event: TouchEvent) => {
    const container = scrollContainerRef.current;
    const firstTouch = event.touches[0];
    if (
      !container
      || !firstTouch
      || touchPagingStartYRef.current === null
      || touchPagingHandledRef.current
      || isInitialLoading
      || isLoadingOlder
      || historyWindowScrollLockRef.current
      || messagesRef.current.length === 0
    ) return;

    const dragDeltaY = firstTouch.clientY - touchPagingStartYRef.current;
    if (Math.abs(dragDeltaY) < HISTORY_TOUCH_TRIGGER_PX) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const rearmThreshold = HISTORY_LOAD_TRIGGER_PX * 2;
    const canPromptOlder = historyWindowPagingGuardRef.current.allowOlder && pageInfo.hasMoreOlder && pageInfo.nextBeforeId !== null;
    const canPromptNewer = historyWindowPagingGuardRef.current.allowNewer && newerHistoryPagesRef.current.length > 0;

    if (!historyWindowPagingGuardRef.current.allowOlder && container.scrollTop > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowOlder = true;
    }
    if (!historyWindowPagingGuardRef.current.allowNewer && distanceFromBottom > rearmThreshold) {
      historyWindowPagingGuardRef.current.allowNewer = true;
    }

    if (dragDeltaY > 0) {
      if (historyEdgePrompt === 'newer') {
        clearHistoryEdgePrompt();
      }

      if (canPromptOlder && container.scrollTop <= HISTORY_LOAD_TRIGGER_PX) {
        if (
          historyEdgePrompt === 'older'
          && historyEdgePromptReadyRef.current
          && !touchPagingArmedInCurrentGestureRef.current
        ) {
          touchPagingHandledRef.current = true;
          loadOlderHistory();
        } else {
          touchPagingHandledRef.current = true;
          touchPagingArmedInCurrentGestureRef.current = true;
          armHistoryEdgePrompt('older');
        }
      }
      return;
    }

    if (dragDeltaY < 0) {
      if (historyEdgePrompt === 'older') {
        clearHistoryEdgePrompt();
      }

      if (canPromptNewer && distanceFromBottom <= HISTORY_LOAD_TRIGGER_PX) {
        if (
          historyEdgePrompt === 'newer'
          && historyEdgePromptReadyRef.current
          && !touchPagingArmedInCurrentGestureRef.current
        ) {
          touchPagingHandledRef.current = true;
          loadNewerHistory();
        } else {
          touchPagingHandledRef.current = true;
          touchPagingArmedInCurrentGestureRef.current = true;
          armHistoryEdgePrompt('newer');
        }
      }
    }
  }, [armHistoryEdgePrompt, clearHistoryEdgePrompt, historyEdgePrompt, isInitialLoading, isLoadingOlder, loadNewerHistory, loadOlderHistory, pageInfo]);

  useEffect(() => {
    if (messages.length > 0) return;
    clearHistoryEdgePrompt();
    setHistoryPageNotice(null);
  }, [clearHistoryEdgePrompt, messages.length]);

  const handleHistoryWindowTouchEnd = useCallback(() => {
    touchPagingStartYRef.current = null;
    touchPagingHandledRef.current = false;
    touchPagingArmedInCurrentGestureRef.current = false;
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('touchstart', handleHistoryWindowTouchStart, { passive: true });
    container.addEventListener('touchmove', handleHistoryWindowTouchMove, { passive: true });
    container.addEventListener('touchend', handleHistoryWindowTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleHistoryWindowTouchEnd, { passive: true });
    return () => {
      container.removeEventListener('touchstart', handleHistoryWindowTouchStart);
      container.removeEventListener('touchmove', handleHistoryWindowTouchMove);
      container.removeEventListener('touchend', handleHistoryWindowTouchEnd);
      container.removeEventListener('touchcancel', handleHistoryWindowTouchEnd);
    };
  }, [handleHistoryWindowTouchEnd, handleHistoryWindowTouchMove, handleHistoryWindowTouchStart]);

  useEffect(() => {
    clearQueuedMessagePatches();
    olderLoadInFlightRef.current = false;
    newerHistoryPagesRef.current = [];
    historyWindowScrollTargetRef.current = null;
    historyWindowScrollLockRef.current = false;
    historyWindowPagingGuardRef.current = { allowOlder: true, allowNewer: true };
    clearNavDotPagingUnlockTimer();
    navDotPagingLockedRef.current = false;
    clearHistoryEdgePrompt();
    setHistoryPageNotice(null);
    skipNextAutoScrollRef.current = false;
    setIsLoading(false);

    if (!activeKey) {
      setMessages([]);
      setActiveLeafId(null);
      setPageInfo(createEmptyHistoryPageInfo(historyFetchBatchLimit));
      setIsLoadingOlder(false);
      setIsInitialLoading(false);
      return;
    }

    loadHistory({ showSkeleton: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, clearHistoryEdgePrompt, clearNavDotPagingUnlockTimer, mode]);

  useEffect(() => {
    if (!isChat || !activeKey || isInitialLoading) return;

    attachedRunControllerRef.current?.abort();
    const controller = new AbortController();
    attachedRunControllerRef.current = controller;

    let attachedMessageId: string | null = null;

    const resolveAttachedMessageId = (rawMessageId: unknown): string | null => {
      if (rawMessageId !== null && rawMessageId !== undefined) {
        return String(rawMessageId);
      }

      const activeLeafId = activeLeafIdRef.current;
      if (activeLeafId) {
        const activeLeafMessage = messagesRef.current.find((message) => message.id === activeLeafId);
        if (activeLeafMessage && activeLeafMessage.role !== 'user') {
          return activeLeafId;
        }
      }

      const latestAssistantMessage = [...messagesRef.current]
        .reverse()
        .find((message) => message.role !== 'user');

      return latestAssistantMessage?.id || null;
    };

    const queueAttachedPatch = (patch: Partial<ChatMessage>, flush = false) => {
      if (!attachedMessageId) return;
      queueMessagePatch(attachedMessageId, patch);
      if (flush) flushQueuedMessagePatches();
    };

    const updateAttachedMessage = (updater: (message: ChatMessage) => ChatMessage) => {
      if (!attachedMessageId) return;
      setMessages((prev) => prev.map((message) => (
        message.id === attachedMessageId ? updater(message) : message
      )));
    };

    const attachActiveRun = async () => {
      try {
        const response = await fetch(`/api/chat/attach/${activeKey}`, { signal: controller.signal });
        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
          const latestAssistantMessage = [...messagesRef.current]
            .reverse()
            .find((message) => message.role !== 'user');
          if (latestAssistantMessage && !String(latestAssistantMessage.content || '').trim()) {
            await recoverLatestChatMessages(true);
          }
          setIsLoading(false);
          return;
        }

        if (!response.ok || !response.body) {
          return;
        }

        setIsLoading(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let receivedFinal = false;
        let receivedError = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'attached') {
                attachedMessageId = resolveAttachedMessageId(evt.messageId);
                if (attachedMessageId) {
                  queueAttachedPatch({
                    agentId: typeof evt.agentId === 'string' ? evt.agentId : undefined,
                    agentName: typeof evt.agentName === 'string' ? evt.agentName : undefined,
                    model: typeof evt.modelUsed === 'string' ? evt.modelUsed : undefined,
                  }, true);
                }
              } else if (evt.type === 'delta' || evt.type === 'final') {
                if (evt.type === 'final') {
                  receivedFinal = true;
                }
                const patch: Partial<ChatMessage> = {
                  content: typeof evt.text === 'string' ? evt.text : '',
                };
                if (typeof evt.process_content === 'string') {
                  patch.processContent = evt.process_content;
                }
                if (typeof evt.process_streaming === 'boolean') {
                  patch.processStreaming = evt.process_streaming;
                } else if (evt.type === 'final') {
                  patch.processStreaming = false;
                }
                if (typeof evt.modelUsed === 'string') {
                  patch.model = evt.modelUsed;
                } else if (typeof evt.model_used === 'string') {
                  patch.model = evt.model_used;
                }
                queueAttachedPatch(patch, evt.type === 'final');
              } else if (evt.type === 'error') {
                receivedError = true;
                if (!attachedMessageId) continue;
                dropQueuedMessagePatch(attachedMessageId);
                const errorUpdate = mapStreamingErrorUpdate(evt, `❌ ${t('common.error')}: ${t('common.unknownError')}`);
                updateAttachedMessage((message) => ({ ...message, ...errorUpdate }));
              }
            } catch {}
          }
        }

        flushQueuedMessagePatches();
        if (!controller.signal.aborted && !receivedFinal && !receivedError) {
          const recovered = await recoverLatestChatMessages(true);
          if (!recovered) setSubmitError(t('unifiedChat.replyMayBeIncomplete'));
        }
      } catch (error: any) {
        if (error?.name !== 'AbortError' && attachedMessageId) {
          dropQueuedMessagePatch(attachedMessageId);
          const detail = typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : t('common.unknownError');
          const structuredError = createClientStructuredChatError(detail);
          updateAttachedMessage((message) => ({ ...message, ...structuredError }));
        }
      } finally {
        flushQueuedMessagePatches();
        if (attachedRunControllerRef.current === controller) {
          attachedRunControllerRef.current = null;
        }
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void attachActiveRun();

    return () => {
      controller.abort();
      if (attachedRunControllerRef.current === controller) {
        attachedRunControllerRef.current = null;
      }
    };
  }, [activeKey, dropQueuedMessagePatch, flushQueuedMessagePatches, isChat, isInitialLoading, queueMessagePatch, recoverLatestChatMessages, t]);

  // =============== GROUP-MODE EFFECTS ===============
  const loadGroups = useCallback(async () => {
    if (!isGroup) return;
    try { const res = await fetch('/api/groups'); const data = await res.json(); if (data.success) setGroups(data.groups); } catch {}
  }, [isGroup]);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  useEffect(() => {
    const handleActiveContextRefresh = (event: Event) => {
      const detail = (event as CustomEvent<ActiveContextRefreshDetail>).detail;
      if (!detail || !activeKey || detail.mode !== mode || detail.id !== activeKey) return;

      clearNewerHistoryWindowTrail();
      if (detail.mode === 'group') {
        void loadGroups();
      }
      void loadHistory({ showSkeleton: true });
    };

    window.addEventListener(ACTIVE_CONTEXT_REFRESH_EVENT, handleActiveContextRefresh as EventListener);
    return () => {
      window.removeEventListener(ACTIVE_CONTEXT_REFRESH_EVENT, handleActiveContextRefresh as EventListener);
    };
  }, [activeKey, clearNewerHistoryWindowTrail, loadGroups, loadHistory, mode]);

  function mapGroupMsg(m: any): ChatMessage {
    return {
      id: String(m.id), role: m.sender_type === 'user' ? 'user' : (m.sender_id === 'system' ? 'system' : 'assistant'),
      content: m.content || '', timestamp: new Date(m.created_at || ''),
      processContent: typeof m.process_content === 'string' ? m.process_content : undefined,
      processStreaming: !!m.process_streaming,
      model: m.model_used, agentId: m.sender_id, agentName: m.sender_name,
      parentId: m.parent_id ? String(m.parent_id) : undefined,
      messageCode: typeof m.messageCode === 'string' ? m.messageCode : undefined,
      messageParams: m.messageParams && typeof m.messageParams === 'object' ? m.messageParams : undefined,
      rawDetail: typeof m.rawDetail === 'string' ? m.rawDetail : undefined,
    };
  }

  const resolveNextLiveGroupLeafId = useCallback((
    _previousLeafId: string | null,
    nextMessages: ChatMessage[],
    _incomingMessageId: string,
    _incomingParentId?: string,
  ) => {
    return getPreferredLeafId(nextMessages);
  }, [getPreferredLeafId]);

  const mergeGroupMessagesIntoState = useCallback((
    incomingMessages: ChatMessage[],
    options?: { focusLatest?: boolean }
  ) => {
    if (incomingMessages.length === 0) return;

    const nextMessages = mergeMessageCollectionPreservingContent(messagesRef.current, incomingMessages);

    setMessages((prev) => {
      return mergeMessageCollectionPreservingContent(prev, incomingMessages);
    });

    if (!options?.focusLatest) return;

    const latestMessage = incomingMessages[incomingMessages.length - 1];
    setActiveLeafId((prevLeaf) => (
      resolveNextLiveGroupLeafId(prevLeaf, nextMessages, latestMessage.id, latestMessage.parentId)
    ));
  }, [resolveNextLiveGroupLeafId]);

  const upsertGroupStreamMessage = useCallback((payload: any) => {
    if (!payload || payload.id === undefined || payload.id === null) return;
    const existingMessage = messagesRef.current.find((message) => message.id === String(payload.id));
    const inferredSenderType = typeof payload.sender_type === 'string'
      ? payload.sender_type
      : (existingMessage?.role === 'user' ? 'user' : 'agent');
    const inferredSenderId = typeof payload.sender_id === 'string'
      ? payload.sender_id
      : (existingMessage?.role === 'system' ? 'system' : existingMessage?.agentId);
    const inferredSenderName = typeof payload.sender_name === 'string'
      ? payload.sender_name
      : existingMessage?.agentName;

    const mapped = mapGroupMsg({
      id: payload.id,
      parent_id: payload.parent_id ?? null,
      sender_type: inferredSenderType,
      sender_id: inferredSenderId,
      sender_name: inferredSenderName,
      content: typeof payload.content === 'string' ? payload.content : '',
      process_content: typeof payload.process_content === 'string' ? payload.process_content : undefined,
      process_streaming: !!payload.process_streaming,
      created_at: payload.created_at || new Date().toISOString(),
      model_used: payload.model_used,
      messageCode: payload.messageCode,
      messageParams: payload.messageParams,
      rawDetail: payload.rawDetail,
    });

    const nextMessages = mergeMessageCollectionPreservingContent(messagesRef.current, [mapped]);

    setMessages(prev => {
      return mergeMessageCollectionPreservingContent(prev, [mapped]);
    });

    setActiveLeafId(prevLeaf => resolveNextLiveGroupLeafId(prevLeaf, nextMessages, mapped.id, mapped.parentId));
  }, [resolveNextLiveGroupLeafId]);

  const recoverGroupActiveRun = useCallback(async (signal?: AbortSignal) => {
    if (!isGroup || !activeKey) return { ok: false as const, active: false as const, runState: null as GroupRunState | null };

    try {
      const response = await fetch(`/api/groups/${activeKey}/active-run`, { signal });
      const data = await response.json();
      if (!data?.success) {
        return { ok: false as const, active: false as const, runState: null as GroupRunState | null };
      }

      const runState: GroupRunState | null = data.runState && typeof data.runState === 'object'
        ? {
            active: !!data.runState.active,
            agentId: typeof data.runState.agentId === 'string' ? data.runState.agentId : null,
            runId: typeof data.runState.runId === 'string' ? data.runState.runId : null,
            startedAt: typeof data.runState.startedAt === 'number' ? data.runState.startedAt : null,
          }
        : null;

      if (data.message) {
        upsertGroupStreamMessage(data.message);
      }

      if (!data.active) {
        return { ok: true as const, active: false as const, runState };
      }

      return { ok: true as const, active: true as const, runState };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return { ok: false as const, active: false as const, runState: null as GroupRunState | null };
      }
      return { ok: false as const, active: false as const, runState: null as GroupRunState | null };
    }
  }, [activeKey, isGroup, upsertGroupStreamMessage]);

  useEffect(() => {
    if (!isGroup || !activeKey || isInitialLoading) {
      return;
    }

    const controller = new AbortController();

    void (async () => {
      const recovery = await recoverGroupActiveRun(controller.signal);
      if (controller.signal.aborted || !recovery.ok || !recovery.runState) return;

      setGroupRunState(recovery.runState);
      if (!recovery.runState.active) {
        setTypingAgents(new Map());
      }
    })();

    return () => {
      controller.abort();
    };
  }, [activeKey, isGroup, isInitialLoading, recoverGroupActiveRun]);

  const recoverLatestGroupMessages = useCallback(async (focusLatest = false) => {
    if (!isGroup || !activeKey) return false;

    try {
      const result = await fetchHistoryPage({
        limit: Math.max(HISTORY_FETCH_BATCH_MIN_LIMIT, Math.min(historyFetchBatchLimit, 80)),
      });
      if (!result || result.messages.length === 0) {
        return false;
      }

      mergeGroupMessagesIntoState(result.messages, { focusLatest });
      return true;
    } catch {
      return false;
    }
  }, [activeKey, fetchHistoryPage, historyFetchBatchLimit, isGroup, mergeGroupMessagesIntoState]);

  // SSE for group
  useEffect(() => {
    if (!isGroup || !activeKey) return;
    eventSourceRef.current?.close();
    setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
    const es = new EventSource(`/api/groups/${activeKey}/events`);
    eventSourceRef.current = es;
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'message') {
          const mapped = mapGroupMsg(parsed.data);
          dropQueuedMessagePatch(mapped.id);
          const isBrowsingOlderWindow = newerHistoryPagesRef.current.length > 0;
          const nextMessages = mergeMessageCollectionPreservingContent(messagesRef.current, [mapped]);
          setMessages(prev => {
            if (prev.some(m => m.id === mapped.id)) {
              return mergeMessageCollectionPreservingContent(prev, [mapped]);
            }
            if (isBrowsingOlderWindow) return prev;
            return mergeMessageCollectionPreservingContent(prev, [mapped]);
          });
          setActiveLeafId(prevLeaf => {
            if (isBrowsingOlderWindow) return prevLeaf;
            return resolveNextLiveGroupLeafId(prevLeaf, nextMessages, mapped.id, mapped.parentId);
          });
        } else if (parsed.type === 'typing') {
          if (newerHistoryPagesRef.current.length > 0) return;
          setTypingAgents(prev => { const n = new Map(prev); n.set(parsed.data.agentId, parsed.data.displayName); return n; });
        } else if (parsed.type === 'typing_done') {
          if (newerHistoryPagesRef.current.length > 0) return;
          setTypingAgents(prev => { const n = new Map(prev); n.delete(parsed.data.agentId); return n; });
        } else if (parsed.type === 'run_state') {
          const nextState: GroupRunState = {
            active: !!parsed.data?.active,
            agentId: typeof parsed.data?.agentId === 'string' ? parsed.data.agentId : null,
            runId: typeof parsed.data?.runId === 'string' ? parsed.data.runId : null,
            startedAt: typeof parsed.data?.startedAt === 'number' ? parsed.data.startedAt : null,
          };
          setGroupRunState(nextState);
          if (!nextState.active) {
            setTypingAgents(new Map());
          }
        } else if (parsed.type === 'delete') {
          const deletedIds = Array.isArray(parsed.deletedIds)
            ? parsed.deletedIds.map((id: number | string) => String(id))
            : (parsed.id !== undefined ? [String(parsed.id)] : []);
          const deletedIdSet = new Set(deletedIds);
          const fallbackParentId = typeof parsed.fallbackParentId === 'number' || typeof parsed.fallbackParentId === 'string'
            ? String(parsed.fallbackParentId)
            : (parsed.parent_id ? String(parsed.parent_id) : null);
          deletedIds.forEach((id: string) => dropQueuedMessagePatch(id));
          setMessages(prev => {
            const nextMessages = prev.filter((message) => !deletedIdSet.has(message.id));
            setActiveLeafId((prevLeaf) => {
              if (!prevLeaf || !deletedIdSet.has(prevLeaf)) {
                return prevLeaf;
              }
              if (fallbackParentId && nextMessages.some((message) => message.id === fallbackParentId)) {
                return fallbackParentId;
              }
              return getPreferredLeafId(nextMessages);
            });
            return nextMessages;
          });
        } else if (parsed.type === 'delta') {
          if (!messagesRef.current.some(message => message.id === String(parsed.id))) {
            upsertGroupStreamMessage(parsed);
          } else {
            const patch: Partial<ChatMessage> = {
              content: typeof parsed.content === 'string' ? parsed.content : '',
            };
            if (typeof parsed.process_content === 'string') patch.processContent = parsed.process_content;
            if (typeof parsed.process_streaming === 'boolean') patch.processStreaming = parsed.process_streaming;
            if (typeof parsed.messageCode === 'string') patch.messageCode = parsed.messageCode;
            if (parsed.messageParams && typeof parsed.messageParams === 'object') patch.messageParams = parsed.messageParams;
            if (typeof parsed.rawDetail === 'string') patch.rawDetail = parsed.rawDetail;
            if (parsed.sender_id === 'system') patch.role = 'system';
            if (typeof parsed.sender_id === 'string') patch.agentId = parsed.sender_id;
            if (typeof parsed.sender_name === 'string') patch.agentName = parsed.sender_name;
            queueMessagePatch(String(parsed.id), patch);
            flushQueuedMessagePatches();
          }
        } else if (parsed.type === 'edit') {
          dropQueuedMessagePatch(String(parsed.id));
          upsertGroupStreamMessage(parsed);
        }
      } catch {}
    };
    es.onerror = () => {
      if (newerHistoryPagesRef.current.length > 0) return;

      const now = Date.now();
      if (now - groupSseRecoveryAtRef.current < GROUP_SSE_RECOVERY_THROTTLE_MS) {
        return;
      }
      groupSseRecoveryAtRef.current = now;

      void (async () => {
        const recovery = await recoverGroupActiveRun();
        if (!recovery.ok) return;
        if (recovery.runState) {
          setGroupRunState(recovery.runState);
        }
        if (!recovery.active) {
          setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
          setTypingAgents(new Map());
          await recoverLatestGroupMessages(true);
        }
      })();
    };
    return () => {
      es.close();
      clearQueuedMessagePatches();
    };
  }, [activeKey, clearQueuedMessagePatches, dropQueuedMessagePatch, isGroup, queueMessagePatch, recoverGroupActiveRun, recoverLatestGroupMessages, resolveNextLiveGroupLeafId, upsertGroupStreamMessage]);

  useEffect(() => {
    if (!isGroup || !activeKey || !groupRunState.active || isInitialLoading || newerHistoryPagesRef.current.length > 0) {
      return;
    }

    const controller = new AbortController();
    let timerId: number | null = null;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      const recovery = await recoverGroupActiveRun(controller.signal);
      if (cancelled) return;
      if (recovery.runState) {
        setGroupRunState(recovery.runState);
      }
      if (recovery.ok && !recovery.active) {
        setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
        setTypingAgents(new Map());
        await recoverLatestGroupMessages(true);
        return;
      }
      timerId = window.setTimeout(() => {
        void poll();
      }, GROUP_ACTIVE_RUN_RECOVERY_POLL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      controller.abort();
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [activeKey, groupRunState.active, isGroup, isInitialLoading, recoverGroupActiveRun, recoverLatestGroupMessages]);

  useEffect(() => {
    if (!isGroup || !activeKey) {
      previousGroupRunActiveRef.current = false;
      return;
    }

    const wasActive = previousGroupRunActiveRef.current;
    previousGroupRunActiveRef.current = groupRunState.active;

    if (groupRunState.active || !wasActive || isInitialLoading || newerHistoryPagesRef.current.length > 0) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let timerId: number | null = null;
    const deadline = Date.now() + GROUP_POST_RUN_SETTLE_TIMEOUT_MS;

    const poll = async (focusLatest: boolean) => {
      if (cancelled || newerHistoryPagesRef.current.length > 0) return;

      const recovery = await recoverGroupActiveRun(controller.signal);
      if (recovery.runState) {
        setGroupRunState(recovery.runState);
      }
      if (cancelled || newerHistoryPagesRef.current.length > 0) return;

      await recoverLatestGroupMessages(focusLatest);
      if (cancelled || newerHistoryPagesRef.current.length > 0) return;

      if (Date.now() >= deadline) return;

      timerId = window.setTimeout(() => {
        void poll(false);
      }, GROUP_POST_RUN_SETTLE_POLL_MS);
    };

    void poll(true);

    return () => {
      cancelled = true;
      controller.abort();
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [activeKey, groupRunState.active, isGroup, isInitialLoading, recoverGroupActiveRun, recoverLatestGroupMessages]);

  // =============== HANDLERS ===============

  const handleCopy = (text: string, id: string) => {
    const doCopy = (t: string) => {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(t).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); })
          .catch(() => fallbackCopy(t));
      } else fallbackCopy(t);
    };
    const fallbackCopy = (t: string) => {
      const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); } catch {}
      document.body.removeChild(ta);
    };
    doCopy(text);
  };

  const resetEditComposer = useCallback(() => {
    setEditingMessageId(null);
    setEditContent('');
    setEditExistingAttachments([]);
    setEditPendingFiles([]);
  }, []);

  const handleQuote = (msg: ChatMessage) => { setQuotedMessage(msg); textareaRef.current?.focus(); };

  const handleDeleteMessage = (msgId: string) => {
    setDeleteErrorMessage('');
    setMessageToDelete(msgId);
    setIsDeleteModalOpen(true);
  };

  const confirmDeleteMessage = async () => {
    if (!messageToDelete) return;
    let didDelete = false;
    try {
      clearNewerHistoryWindowTrail();
      if (isChat) {
        const res = await fetch(`/api/messages/${messageToDelete}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data?.error === 'string' ? data.error : '');
        }
        const deletedIds = Array.isArray(data?.deletedIds)
          ? new Set<string>(data.deletedIds.map((id: number | string) => String(id)))
          : new Set<string>([messageToDelete]);
        setMessages(prev => prev.filter(m => !deletedIds.has(m.id)));
        didDelete = true;
      } else if (isGroup && currentGroup) {
        const res = await fetch(`/api/groups/${currentGroup.id}/messages/${messageToDelete}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data?.error === 'string' ? data.error : '');
        }
        const deletedIds = Array.isArray(data?.deletedIds)
          ? new Set<string>(data.deletedIds.map((id: number | string) => String(id)))
          : new Set<string>([messageToDelete]);
        const fallbackParentId = typeof data?.fallbackParentId === 'number' || typeof data?.fallbackParentId === 'string'
          ? String(data.fallbackParentId)
          : null;
        setMessages(prev => {
          const nextMessages = prev.filter((message) => !deletedIds.has(message.id));
          setActiveLeafId((prevLeaf) => {
            if (!prevLeaf || !deletedIds.has(prevLeaf)) {
              return prevLeaf;
            }
            if (fallbackParentId && nextMessages.some((message) => message.id === fallbackParentId)) {
              return fallbackParentId;
            }
            return getPreferredLeafId(nextMessages);
          });
          return nextMessages;
        });
        didDelete = true;
      }
    } catch (error: any) {
      const detail = typeof error?.message === 'string' ? error.message.trim() : '';
      setDeleteErrorMessage(detail ? `${t('unifiedChat.deleteMessageFailed')}\n${detail}` : t('unifiedChat.deleteMessageFailed'));
    } finally {
      if (didDelete) {
        setDeleteErrorMessage('');
        setIsDeleteModalOpen(false);
        setMessageToDelete(null);
      }
    }
  };

  const handleSaveEdit = async () => {
    if (!editingMessageId) return;
    const targetMessageId = editingMessageId;
    const currentEditContent = editContent.trim();
    const currentExistingAttachments = [...editExistingAttachments];
    const currentPendingFiles = [...editPendingFiles];
    clearNewerHistoryWindowTrail();

    const serializeAttachmentMarkdown = (attachment: { name?: string; url: string; isImage?: boolean }) => {
      const attachmentName = attachment.name?.trim() || t('common.file');
      return `${attachment.isImage ? '!' : ''}[${attachmentName}](${attachment.url})`;
    };

    const existingAttachmentContent = currentExistingAttachments
      .map((attachment) => serializeAttachmentMarkdown(attachment))
      .join('\n');
    const uploadedAttachmentContent = currentPendingFiles.length > 0
      ? await uploadFiles(currentPendingFiles)
      : '';
    const nextContent = [existingAttachmentContent, uploadedAttachmentContent, currentEditContent]
      .filter(Boolean)
      .join('\n\n');

    if (!nextContent) return;

    // Optimistic UI Update
    setMessages(prev => prev.map(m => m.id === targetMessageId ? { ...m, content: nextContent } : m));

    const currentMessages = messagesRef.current;
    const editedMsg = currentMessages.find(m => m.id === targetMessageId);

    resetEditComposer();
    focusMainInput();

    if (isChat) {
      try {
        await fetch(`/api/messages/${targetMessageId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: nextContent })
        });
        
        // Auto-regenerate if it's a user message
        if (editedMsg && editedMsg.role === 'user') {
          const latestReply = [...currentMessages].reverse().find(message =>
            (message.role === 'assistant' || message.role === 'system')
            && message.parentId === targetMessageId
          );
          const regenerateTarget = latestReply ?? ({ id: `dummy-${Date.now()}`, role: 'assistant', parentId: targetMessageId } as ChatMessage);
          await handleRegenerate(
            regenerateTarget,
            nextContent,
            {
              explicitParentId: targetMessageId,
              targetMessageId: latestReply && isPersistedMessageId(latestReply.id)
                ? latestReply.id
                : targetMessageId,
            },
          );
        }
      } catch {}
    } else if (isGroup && currentGroup) {
      try {
        const response = await fetch(`/api/groups/${currentGroup.id}/messages/${targetMessageId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: nextContent })
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(typeof data?.error === 'string' ? data.error : '');
        }
      } catch {
        await recoverLatestGroupMessages(true);
      }
    }
  };

  const handleRegenerate = async (
    msg: ChatMessage,
    customParentContent?: string,
    options?: {
      explicitParentId?: string;
      targetMessageId?: string;
    },
  ) => {
    if (isChat) {
      const tempId = `temp-${Date.now()}`;
      let resolvedId = tempId;
      const assistantTargetIds = new Set<string>([tempId]);
      const queueAssistantPatch = (patch: Partial<ChatMessage>, flush = false) => {
        assistantTargetIds.forEach((messageId) => queueMessagePatch(messageId, patch));
        if (flush) flushQueuedMessagePatches();
      };
      const dropAssistantPatches = () => {
        assistantTargetIds.forEach((messageId) => dropQueuedMessagePatch(messageId));
      };
      const updateAssistantMessages = (updater: (message: ChatMessage) => ChatMessage) => {
        setMessages(prev => prev.map(message => assistantTargetIds.has(message.id) ? updater(message) : message));
      };
      const currentMessages = messagesRef.current;
      let parentId = options?.explicitParentId || msg.parentId;
      const requestTargetMessageId = options?.targetMessageId || msg.id;
      if (!parentId) { const idx = currentMessages.findIndex(m => m.id === msg.id); if (idx > 0) parentId = currentMessages[idx - 1]?.id; }
      if (isLoading || !activeKey || !parentId) return;
      clearNewerHistoryWindowTrail();
      setIsLoading(true);
      try {
        const parentUserMsg = currentMessages.find(m => m.id === parentId);
        const contentStr = customParentContent || parentUserMsg?.content || 'Continue';
        const currentSession = sessions.find(s => s.id === activeKey);
        const shouldShowProcessPlaceholder = !!(currentSession?.process_start_tag && currentSession?.process_end_tag);
        forceAutoScrollRef.current = true;
        setMessages(prev => [
          ...prev.filter(message => message.id !== msg.id),
          { id: tempId, role: 'assistant', content: '', processStreaming: shouldShowProcessPlaceholder, timestamp: new Date(), model: currentSession?.model || msg.model, agentName: currentSession?.name || msg.agentName, parentId },
        ]);
        setActiveLeafId(tempId);
        const response = await fetch('/api/chat/regenerate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: contentStr,
            sessionId: activeKey,
            parentId,
            ...(isPersistedMessageId(requestTargetMessageId) ? { targetMessageId: requestTargetMessageId } : {}),
          }),
        });
        if (!response.ok || !response.body) {
          dropAssistantPatches();
          const fallbackContent = `❌ ${t('common.error')}: ${t('unifiedChat.requestFailed')}`;
          const errorUpdate = await mapHttpErrorResponse(response, fallbackContent);
          updateAssistantMessages(message => ({ ...message, ...errorUpdate }));
          return;
        }
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        let receivedFinal = false;
        let receivedError = false;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'ids' && evt.assistantMsgId) {
                const previousResolvedId = resolvedId;
                moveQueuedMessagePatch(resolvedId, String(evt.assistantMsgId));
                setMessages(prev => prev.map(m => m.id === resolvedId ? { ...m, id: String(evt.assistantMsgId) } : m));
                setActiveLeafId(prev => prev === resolvedId ? String(evt.assistantMsgId) : prev);
                resolvedId = String(evt.assistantMsgId);
                assistantTargetIds.add(previousResolvedId);
                assistantTargetIds.add(resolvedId);
              } else if (evt.type === 'delta' || evt.type === 'final') {
                if (evt.type === 'final') {
                  receivedFinal = true;
                }
                const patch: Partial<ChatMessage> = {
                  content: typeof evt.text === 'string' ? evt.text : '',
                };
                if (typeof evt.process_content === 'string') {
                  patch.processContent = evt.process_content;
                }
                if (typeof evt.process_streaming === 'boolean') {
                  patch.processStreaming = evt.process_streaming;
                } else if (evt.type === 'final') {
                  patch.processStreaming = false;
                }
                if (typeof evt.modelUsed === 'string') {
                  patch.model = evt.modelUsed;
                } else if (typeof evt.model_used === 'string') {
                  patch.model = evt.model_used;
                }
                queueAssistantPatch(patch, evt.type === 'final');
              } else if (evt.type === 'error') {
                receivedError = true;
                dropAssistantPatches();
                const errorUpdate = mapStreamingErrorUpdate(evt, `❌ ${t('common.error')}: ${evt.error || t('common.unknownError')}`);
                updateAssistantMessages(message => ({
                  ...message,
                  ...errorUpdate,
                }));
              }
            } catch {}
          }
        }
        flushQueuedMessagePatches();
        if (!receivedError && receivedFinal) {
          queueAssistantPatch({ processStreaming: false }, true);
        }
        if (!receivedFinal && !receivedError) {
          const recovered = await recoverLatestChatMessages(true);
          if (!recovered) setSubmitError(t('unifiedChat.replyMayBeIncomplete'));
        }
      } catch (error: any) {
        if (error?.name !== 'AbortError') {
          dropAssistantPatches();
          const detail = typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : t('unifiedChat.requestFailed');
          const structuredError = createClientStructuredChatError(detail);
          updateAssistantMessages(message => ({ ...message, ...structuredError }));
        }
      } finally { flushQueuedMessagePatches(); setIsLoading(false); }
    } else if (isGroup && currentGroup) {
      if (isLoading) return;
      clearNewerHistoryWindowTrail();
      setIsLoading(true);
      try {
        await fetch(`/api/groups/${currentGroup.id}/messages/regenerate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgId: Number(msg.id) })
        });
        // Wait a moment for the SSE stream to deliver the new message, then reload
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch {} finally { setIsLoading(false); }
    }
  };

  // ---- File handling ----
  const handleFileChange = async (files: File[]) => {
    if (!files.length) return;

    const IMAGE_TARGET_SIZE = 4_500_000; // 4.5MB target for images

    const processedFiles: {file: File, preview: string}[] = [];
    const errors: string[] = [];

    for (const file of files) {
      const category = getFileCategory(file);

      if (category === 'image') {
        try {
          const compressed = await compressImage(file, IMAGE_TARGET_SIZE);
          if (compressed.size > IMAGE_TARGET_SIZE) {
            errors.push(t('unifiedChat.imageTooLargeAfterCompression', {
              name: file.name,
              originalSize: formatFileSize(file.size),
              limit: formatFileSize(IMAGE_TARGET_SIZE),
            }));
          } else {
            const preview = URL.createObjectURL(compressed);
            processedFiles.push({ file: compressed, preview });
          }
        } catch (err) {
          errors.push(t('unifiedChat.imageCompressionFailed', {
            name: file.name,
            message: err instanceof Error ? err.message : t('common.unknownError'),
          }));
        }
      } else {
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
        processedFiles.push({ file, preview });
      }
    }

    // Show errors if any
    if (errors.length > 0) {
      setFileErrorMessage(errors.join('\n'));
      setFileErrorModalOpen(true);
    }

    // Add successfully processed files
    if (processedFiles.length > 0) {
      justSelectedFileRef.current = true;
      setTimeout(() => { justSelectedFileRef.current = false; }, 500);
      setPendingFiles(prev => [...prev, ...processedFiles]);
    }
  };
  const removePendingFile = (index: number) => {
    setPendingFiles(prev => { const t = prev[index]; if (t.preview) URL.revokeObjectURL(t.preview); return prev.filter((_, i) => i !== index); });
  };
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (editingMessageId) {
      if (isDragging) {
        setIsDragging(false);
      }
      dragCounter.current = 0;
      return;
    }
    if (e.type === 'dragenter') { dragCounter.current++; setIsDragging(true); }
    else if (e.type === 'dragleave') { dragCounter.current--; if (dragCounter.current <= 0) setIsDragging(false); }
    else if (e.type === 'dragover') { if (!isDragging) setIsDragging(true); }
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false); dragCounter.current = 0;
    if (editingMessageId) return;
    if (e.dataTransfer.files?.length > 0) handleFileChange(Array.from(e.dataTransfer.files));
  };
  const handlePaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData?.files.length > 0) { e.preventDefault(); handleFileChange(Array.from(e.clipboardData.files)); }
  };

  // ---- Upload files helper ----
  const uploadFiles = async (filesToUpload: {file: File, preview: string}[]): Promise<string> => {
    if (filesToUpload.length === 0) return '';
    const fd = new FormData();
    if (isChat) {
      fd.append('contextType', 'session');
      fd.append('sessionId', activeKey);
    } else {
      fd.append('contextType', 'group');
      fd.append('groupId', activeKey);
    }
    filesToUpload.forEach(f => fd.append('files', f.file));
    const upRes = await fetch('/api/files/upload', { method: 'POST', body: fd });
    const upData = await upRes.json().catch(() => null);
    if (upData?.success && upData.files) {
      return upData.files.map((f: any) => {
        const isImage = f.mimeType?.startsWith('image/');
        const name = f.name || f.originalname || t('common.file');
        return isImage ? `![${name}](${f.url})` : `[${name}](${f.url})`;
      }).join('\n');
    }
    // 上传失败必须抛，不能返回空串。返回空串的后果是：附件被静默丢掉，
    // 消息照发——用户以为文件发出去了，模型那头什么也没收到。
    throw new Error(resolveSubmitError(upData || {}, t, 'unifiedChat.uploadFailed'));
  };

  // ---- Send message ----
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!input.trim() && pendingFiles.length === 0 && !quotedMessage) || isLoading || isGroupBusy) return;
    setSubmitError('');
    const currentInput = input.trim(); const currentFiles = [...pendingFiles]; const currentQuote = quotedMessage;
    const submitLeafId = prepareLatestHistoryWindowForSubmit();
    setInput(''); setPendingFiles([]); setQuotedMessage(null); setIsLoading(true);
    scrollToLatestBottom();

    if (isChat) {
      const controller = new AbortController(); abortControllerRef.current = controller;
      const userMessageId = `temp-user-${Date.now()}`;
      const assistantId = `temp-asst-${Date.now() + 1}`;
      let resolvedAssistantId = assistantId;
      let resolvedUserMsgId = userMessageId;
      const assistantTargetIds = new Set<string>([assistantId]);
      const queueAssistantPatch = (patch: Partial<ChatMessage>, flush = false) => {
        assistantTargetIds.forEach((messageId) => queueMessagePatch(messageId, patch));
        if (flush) flushQueuedMessagePatches();
      };
      const dropAssistantPatches = () => {
        assistantTargetIds.forEach((messageId) => dropQueuedMessagePatch(messageId));
      };
      const updateAssistantMessages = (updater: (message: ChatMessage) => ChatMessage) => {
        setMessages(prev => {
          const hasTarget = prev.some(message => assistantTargetIds.has(message.id));
          if (!hasTarget) return prev;
          return prev.map(message => assistantTargetIds.has(message.id) ? updater(message) : message);
        });
      };
      try {
        const uploadedContent = await uploadFiles(currentFiles);
        let textContent = currentInput;
        if (currentQuote) {
          const author = currentQuote.role === 'user' ? t('common.you') : (currentQuote.agentName || t('common.ai'));
          const time = formatQuoteTime(currentQuote.timestamp);
          textContent = `[引用开始 author="${author}" time="${time}"]\n${currentQuote.content}\n[引用结束]\n\n${currentInput}`.trim();
        }
        const fullMessage = [uploadedContent, textContent].filter(Boolean).join('\n\n');
        if (!fullMessage) { setIsLoading(false); return; }
        const parentForUser = submitLeafId || undefined;
        const currentSession = sessions.find(s => s.id === activeKey);
        const snapshotModel = currentSession?.model || currentModel || undefined;
        const snapshotAgentName = currentSession?.name || activeSessionName || undefined;
        const shouldShowProcessPlaceholder = !!(currentSession?.process_start_tag && currentSession?.process_end_tag);
        forceAutoScrollRef.current = true;
        setMessages(prev => [...prev,
          { id: userMessageId, role: 'user', content: fullMessage, timestamp: new Date(), parentId: parentForUser },
          { id: assistantId, role: 'assistant', content: '', processStreaming: shouldShowProcessPlaceholder, timestamp: new Date(), model: snapshotModel, agentName: snapshotAgentName, parentId: userMessageId },
        ]);
        setActiveLeafId(assistantId);
        const response = await fetch('/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: activeKey, message: fullMessage }), signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          dropAssistantPatches();
          const fallbackContent = `❌ ${t('common.error')}: ${t('unifiedChat.requestFailed')}`;
          const errorUpdate = await mapHttpErrorResponse(response, fallbackContent);
          updateAssistantMessages(message => ({ ...message, ...errorUpdate }));
          return;
        }
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        let receivedFinal = false;
        let receivedError = false;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'ids') {
                // Replace temp IDs with real DB IDs
                const previousAssistantId = resolvedAssistantId;
                const realUserId = String(evt.userMsgId);
                const realAssistantId = String(evt.assistantMsgId);
                moveQueuedMessagePatch(resolvedUserMsgId, realUserId);
                moveQueuedMessagePatch(resolvedAssistantId, realAssistantId);
                setMessages(prev => prev.map(m => {
                  if (m.id === resolvedUserMsgId) return { ...m, id: realUserId };
                  if (m.id === resolvedAssistantId) return { ...m, id: realAssistantId, parentId: realUserId };
                  return m;
                }));
                setActiveLeafId(prev => prev === resolvedAssistantId ? realAssistantId : prev);
                resolvedUserMsgId = realUserId;
                resolvedAssistantId = realAssistantId;
                assistantTargetIds.add(previousAssistantId);
                assistantTargetIds.add(realAssistantId);
              } else if (evt.type === 'delta' || evt.type === 'final') {
                if (evt.type === 'final') {
                  receivedFinal = true;
                }
                const patch: Partial<ChatMessage> = {
                  content: typeof evt.text === 'string' ? evt.text : '',
                };
                if (typeof evt.process_content === 'string') {
                  patch.processContent = evt.process_content;
                }
                if (typeof evt.process_streaming === 'boolean') {
                  patch.processStreaming = evt.process_streaming;
                } else if (evt.type === 'final') {
                  patch.processStreaming = false;
                }
                if (typeof evt.modelUsed === 'string') {
                  patch.model = evt.modelUsed;
                } else if (typeof evt.model_used === 'string') {
                  patch.model = evt.model_used;
                }
                queueAssistantPatch(patch, evt.type === 'final');
              } else if (evt.type === 'error') {
                receivedError = true;
                dropAssistantPatches();
                const errorUpdate = mapStreamingErrorUpdate(evt, `❌ ${t('common.error')}: ${evt.error || t('common.unknownError')}`);
                updateAssistantMessages(message => ({
                  ...message,
                  ...errorUpdate,
                }));
              }
            } catch {}
          }
        }
        flushQueuedMessagePatches();
        if (!receivedError) {
          queueAssistantPatch({ processStreaming: false }, true);
        }
        if (!receivedFinal && !receivedError && !abortControllerRef.current?.signal.aborted) {
          // 没有终态事件 = 这轮回复没有正常收尾。先回历史对账，
          // 对账也拿不到完整版就必须说出来——静默展示半截内容是最伤信任的做法。
          const recovered = await recoverLatestChatMessages(true);
          if (!recovered) {
            setSubmitError(t('unifiedChat.replyMayBeIncomplete'));
          }
        }
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          dropAssistantPatches();
          const detail = typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : t('common.unknownError');
          const structuredError = createClientStructuredChatError(detail);
          setMessages(prev => {
            const hasTarget = prev.some(m => assistantTargetIds.has(m.id));
            if (hasTarget) {
              return prev.map(m => assistantTargetIds.has(m.id) ? { ...m, ...structuredError } : m);
            }
            return [...prev, { id: (Date.now() + 1).toString(), role: 'system', content: String(structuredError.content || ''), messageCode: structuredError.messageCode, rawDetail: structuredError.rawDetail, timestamp: new Date() }];
          });
        }
      } finally { flushQueuedMessagePatches(); abortControllerRef.current = null; setIsLoading(false); }
    } else if (isGroup) {
      try {
        const uploadedContent = await uploadFiles(currentFiles);
        let finalContent = currentInput;
        if (currentQuote) {
          const author = currentQuote.role === 'user' ? t('common.you') : (currentQuote.agentName || t('common.ai'));
          const time = formatQuoteTime(currentQuote.timestamp);
          finalContent = `[引用开始 author="${author}" time="${time}"]\n${currentQuote.content}\n[引用结束]\n\n${finalContent}`;
        }
        const fullMessage = [uploadedContent, finalContent].filter(Boolean).join('\n\n');
        if (!fullMessage) return;
        const response = await fetch(`/api/groups/${activeKey}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: fullMessage,
          }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          setInput(currentInput);
          setPendingFiles(currentFiles);
          setQuotedMessage(currentQuote);
          setSubmitError(resolveSubmitError(payload || {}, t, 'unifiedChat.sendFailed'));
          if (payload?.runState) {
            setGroupRunState({
              active: !!payload.runState.active,
              agentId: typeof payload.runState.agentId === 'string' ? payload.runState.agentId : null,
              runId: typeof payload.runState.runId === 'string' ? payload.runState.runId : null,
              startedAt: typeof payload.runState.startedAt === 'number' ? payload.runState.startedAt : null,
            });
          }
          return;
        }
      } catch (error: any) {
        setInput(currentInput);
        setPendingFiles(currentFiles);
        setQuotedMessage(currentQuote);
        setSubmitError(error?.message || t('unifiedChat.sendFailed'));
      } finally { setIsLoading(false); }
    }
  };

  const handleStop = async () => {
    if (isChat && activeKey) {
      try {
        const response = await fetch('/api/chat/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: activeKey }),
        });
        if (response.ok) {
          await recoverLatestChatMessages(true);
        }
      } catch {}
      setIsLoading(false);
      return;
    }

    if (isGroup && activeKey) {
      try {
        const response = await fetch(`/api/groups/${activeKey}/stop`, { method: 'POST' });
        if (response.ok) {
          setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
          setTypingAgents(new Map());
          await recoverLatestGroupMessages(true);
          const recovery = await recoverGroupActiveRun();
          if (recovery.runState) {
            setGroupRunState(recovery.runState);
          } else {
            setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
          }
          if (!recovery.active) {
            setTypingAgents(new Map());
          }
        }
      } catch {}
      return;
    }
  };

  // ---- Group mention input ----
  const handleGroupInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value; setInput(val);
    const cursorPos = e.target.selectionStart || 0;
    const atMatch = val.slice(0, cursorPos).match(/@([^\s@]*)$/);
    if (atMatch && currentGroup) { setMentionFilter(atMatch[1]); setShowMentionPopup(true); setMentionIndex(0); }
    else setShowMentionPopup(false);
  };
  const getFilteredMembers = () => currentGroup ? currentGroup.members.filter(m => resolveGroupMemberDisplayName(m).toLowerCase().includes(mentionFilter.toLowerCase())) : [];
  const insertMention = (name: string) => {
    const pos = textareaRef.current?.selectionStart || 0;
    const before = input.slice(0, pos); const after = input.slice(pos);
    setInput(before.slice(0, before.lastIndexOf('@')) + `@${name} ` + after);
    setShowMentionPopup(false); textareaRef.current?.focus();
  };

  // ---- Keyboard ----
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isGroup && showMentionPopup) {
      const filtered = getFilteredMembers();
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (filtered[mentionIndex]) insertMention(resolveGroupMemberDisplayName(filtered[mentionIndex])); }
      else if (e.key === 'Escape') setShowMentionPopup(false);
      return;
    }
    if (isChat && showCommands && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCommandIndex(prev => (prev + 1) % filteredCommands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCommandIndex(prev => (prev - 1 + filteredCommands.length) % filteredCommands.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); setInput(filteredCommands[commandIndex].command + ' '); setShowCommands(false); return; }
      if (e.key === 'Escape') { setShowCommands(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (justSelectedFileRef.current) { justSelectedFileRef.current = false; e.preventDefault(); return; }
      e.preventDefault(); handleSubmit();
    }
  };

  // ---- Group CRUD ----
  const handleCreateGroup = async () => {
    if (!newGroupId.trim() || !newGroupName.trim() || selectedMembers.length === 0) return;
    if (groupIdError) {
      setGroupCreateError(groupIdError);
      return;
    }
    try {
      const res = await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: newGroupId.trim(), name: newGroupName.trim(), description: newGroupDesc.trim(), members: selectedMembers }) });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setShowCreateDialog(false);
        setNewGroupId('');
        setNewGroupName('');
        setNewGroupDesc('');
        setSelectedMembers([]);
        setGroupCreateError(null);
        await loadGroups();
        props.onSelectGroup?.(data.id);
      } else {
        setGroupCreateError(resolveSubmitError(data, t, 'common.unknownError'));
      }
    } catch {
      setGroupCreateError(t('common.unknownError'));
    }
  };
  const handleDeleteGroup = async (id: string) => {
    try { await fetch(`/api/groups/${id}`, { method: 'DELETE' }); await loadGroups(); if (activeKey === id) props.onSelectGroup?.(''); } catch {}
  };
  const toggleMember = (agentId: string, name: string) => {
    setSelectedMembers(prev => prev.find(m => m.agentId === agentId) ? prev.filter(m => m.agentId !== agentId) : [...prev, { agentId, displayName: name, roleDescription: '' }]);
  };
  const updateMemberRole = (agentId: string, role: string) => {
    setSelectedMembers(prev => prev.map(m => m.agentId === agentId ? { ...m, roleDescription: role } : m));
  };

  // ==================== RENDER ====================
  // ====== GROUP LIST VIEW (no active group) ======
  if (isGroup && !activeKey) {
    return (
      <div className="flex flex-col h-full bg-gradient-to-b from-gray-50 to-blue-50/30">
        <header className="h-14 px-4 sm:px-6 border-b border-gray-300 flex items-center justify-between flex-shrink-0 bg-white z-10 w-full">
          <div className="flex items-center gap-3">
            <button onClick={onMenuClick} className="md:hidden p-2 hover:bg-gray-100 rounded-xl"><Menu className="w-5 h-5" /></button>
            <Users className="w-5 h-5 text-blue-500" />
            <h1 className="text-lg font-bold text-gray-900">{t('unifiedChat.groupTitle')}</h1>
          </div>
          <button
            onClick={() => {
              setNewGroupId('');
              setNewGroupName('');
              setNewGroupDesc('');
              setSelectedMembers([]);
              setGroupCreateError(null);
              setShowCreateDialog(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" /> {t('unifiedChat.newGroup')}
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-6">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-400">
              <Users className="w-16 h-16 mb-4 opacity-30" />
              <p className="text-lg font-bold mb-2">{t('unifiedChat.noGroupsTitle')}</p>
              <p className="text-sm">{t('unifiedChat.noGroupsDescription')}</p>
            </div>
          ) : (
            <div className="max-w-2xl mx-auto space-y-4">
              {groups.map(group => (
                <div key={group.id} className="bg-white rounded-2xl border border-gray-200 p-5 hover:border-blue-300 transition-all cursor-pointer group" onClick={() => props.onSelectGroup?.(group.id)}>
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="text-base font-bold text-gray-900">{group.name}</h3>
                      {group.description && <p className="text-sm text-gray-500 mt-0.5">{group.description}</p>}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteGroup(group.id); }} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg opacity-0 group-hover:opacity-100 transition-all">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Users className="w-4 h-4 text-gray-400" />
                    {group.members.map(m => (<span key={m.id} className="text-xs font-bold text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full">{resolveGroupMemberDisplayName(m)}</span>))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Create Dialog */}
        {showCreateDialog && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowCreateDialog(false)} />
            <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 max-h-[calc(100vh-2rem)] flex flex-col" style={MODAL_FORM_FONT_STYLE}>
              <div className="flex items-center justify-between p-6 border-b border-gray-100 bg-gray-50/50">
                <h3 className="text-xl font-bold text-gray-900">{t('unifiedChat.createGroupTitle')}</h3>
                <button onClick={() => setShowCreateDialog(false)} className="p-2 hover:bg-gray-100 rounded-lg"><X className="w-5 h-5" /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-5">
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className={MODAL_FIELD_LABEL_CLASS}>{t('chat.groupId')} <span className="text-red-500">*</span></label>
                    <input
                      value={newGroupId}
                      onChange={e => {
                        setNewGroupId(e.target.value);
                        setGroupCreateError(null);
                      }}
                      placeholder={t('chat.groupIdPlaceholder')}
                      autoFocus
                      className={`${MODAL_TEXT_INPUT_CLASS} ${
                        visibleGroupIdError
                          ? 'bg-red-50/50 border-red-300 focus:bg-white focus:ring-2 focus:ring-red-500/15 focus:border-red-400'
                          : ''
                      }`}
                    />
                    {visibleGroupIdError ? (
                      <p className="mt-1.5 text-xs text-red-500">{visibleGroupIdError}</p>
                    ) : null}
                  </div>
                  <div className="flex-1">
                    <label className={MODAL_FIELD_LABEL_CLASS}>{t('chat.groupName')} <span className="text-red-500">*</span></label>
                    <input
                      value={newGroupName}
                      onChange={e => {
                        setNewGroupName(e.target.value);
                        setGroupCreateError(null);
                      }}
                      placeholder={t('chat.groupNamePlaceholder')}
                      className={MODAL_TEXT_INPUT_CLASS}
                    />
                  </div>
                </div>
                <div>
                  <label className={MODAL_FIELD_LABEL_CLASS}>{t('unifiedChat.groupDescriptionLabel')}</label>
                  <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)} placeholder={t('unifiedChat.groupDescriptionPlaceholder')} className={MODAL_TEXT_INPUT_CLASS} />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">👥 {t('unifiedChat.selectMembersLabel', { count: selectedMembers.length })}</label>
                  <div className="grid grid-cols-2 gap-2">
                    {sessions.map(s => {
                      const memberAgentId = s.agentId || s.id;
                      const isSelected = selectedMembers.some(m => m.agentId === memberAgentId);
                      return (
                        <button key={s.id} onClick={() => toggleMember(memberAgentId, s.name)} className={`text-left p-3 rounded-xl border-2 transition-all ${isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300 bg-white'}`}>
                          <div className="flex items-center gap-2">
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center ${isSelected ? 'bg-blue-500' : 'bg-gray-200'}`}>
                              {isSelected && <Check className="w-3 h-3 text-white" />}
                            </div>
                            <span className="font-bold text-sm text-gray-900">{s.name}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {selectedMembers.length > 0 && (
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">📝 {t('unifiedChat.defineResponsibilitiesLabel')}</label>
                    <p className="text-xs text-gray-400 mb-3">{t('unifiedChat.defineResponsibilitiesDescription')}</p>
                    <div className="space-y-3">
                      {selectedMembers.map(m => (
                        <div key={m.agentId} className="bg-gray-50 rounded-xl p-3">
                          <div className="text-sm font-bold text-gray-800 mb-1.5">{m.displayName}</div>
                          <textarea value={m.roleDescription} onChange={e => updateMemberRole(m.agentId, e.target.value)}
                            placeholder={t('unifiedChat.memberRolePlaceholder', { name: m.displayName })}
                            rows={3} className={`${MODAL_TEXTAREA_CLASS} min-h-[72px] rounded-lg resize-y bg-white px-3 py-2`} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {groupCreateError && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                    {groupCreateError}
                  </div>
                )}
              </div>
              <div className="p-6 border-t border-gray-100 bg-gray-50/50">
                <button onClick={handleCreateGroup} disabled={!newGroupId.trim() || !newGroupName.trim() || selectedMembers.length === 0 || !!groupIdError}
                  className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{t('unifiedChat.createGroupButton')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ====== ACTIVE CHAT VIEW (both modes) ======
  const headerTitle = isChat ? aiName : currentGroup?.name;
  const showMessageListSkeleton = isInitialLoading;
  const showOlderHistorySkeleton = !showMessageListSkeleton && isLoadingOlder;
  const canShowHistoryPagingUi = !showMessageListSkeleton && messages.length > 0;
  const promptHistoryPageRounds = historyPageRounds;
  const historyPromptShellClass = 'pointer-events-none absolute inset-x-0 z-20 px-4 sm:px-8';
  const historyPromptRowClass = 'mx-auto flex w-full max-w-5xl justify-center';
  const historyPromptBubbleClass = 'inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-full py-2 sm:py-2.5 pl-2.5 pr-5 sm:pl-3 sm:pr-6 text-sm sm:text-base font-medium text-gray-700';
  const historyEdgePromptText = historyEdgePrompt === 'older'
    ? t('unifiedChat.historyPagePromptOlder', { count: promptHistoryPageRounds })
    : historyEdgePrompt === 'newer'
      ? t('unifiedChat.historyPagePromptNewer', { count: promptHistoryPageRounds })
      : '';
  const historyPageNoticeText = historyPageNotice?.direction === 'older'
    ? t('unifiedChat.historyPageNoticeOlder', { count: promptHistoryPageRounds })
    : historyPageNotice?.direction === 'newer'
      ? t('unifiedChat.historyPageNoticeNewer', { count: promptHistoryPageRounds })
      : '';
  const headerStatus = (() => {
    if (isChat) {
      if (!props.isConnected) return { text: t('common.disconnected'), color: 'text-red-500', dotColor: 'bg-red-500', pulse: false };
      if (isLoading) return { text: t('common.processing'), color: 'text-green-600', dotColor: 'bg-green-500', pulse: true };
      return { text: t('common.connected'), color: 'text-green-600', dotColor: 'bg-green-500', pulse: false };
    }
    if (isGroupBusy) return { text: t('common.processing'), color: 'text-green-600', dotColor: 'bg-green-500', pulse: true };
    return { text: t('unifiedChat.collaboratingCount', { count: currentGroup?.members.length ?? 0 }), color: 'text-green-600', dotColor: 'bg-green-500', pulse: false };
  })();

  return (
    <div className="flex flex-col h-full bg-white relative" onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleDrop}>
      {/* Drag overlay */}
      {isDragging && !editingMessageId && (
        <div className="absolute inset-0 z-[100] bg-blue-600/10 backdrop-blur-sm border-4 border-dashed border-blue-500 flex items-center justify-center p-12 transition-all pointer-events-none">
          <div className="bg-white p-10 rounded-[40px] flex flex-col items-center gap-6 animate-in zoom-in-95 duration-200">
            <div className="w-20 h-20 bg-blue-50 rounded-3xl flex items-center justify-center border border-blue-100"><Plus className="w-10 h-10 text-blue-600" /></div>
            <div className="text-center">
              <p className="text-2xl font-black text-gray-900 tracking-tight">{t('unifiedChat.dragUploadTitle')}</p>
              <p className="text-sm text-gray-500 mt-1 font-medium italic">{t('unifiedChat.dragUploadDescription')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="h-14 px-4 sm:px-6 border-b border-gray-300 flex items-center justify-between flex-shrink-0 bg-white z-10 w-full relative">
        {!showMobileSearch && (
          <div className="flex items-center space-x-2 sm:space-x-3 flex-shrink-0">
            <button className="md:hidden text-gray-500 hover:text-gray-900 focus:outline-none pr-1" onClick={onMenuClick}><Menu className="w-6 h-6" /></button>
            <div className="flex items-center space-x-2 sm:space-x-3">
              <h1 className="text-[17px] sm:text-lg font-bold text-gray-900 leading-tight truncate">{headerTitle}</h1>
              <div className={`flex items-center gap-1 sm:gap-1.5 text-xs sm:text-sm group/badge cursor-default relative ${headerStatus.color}`}>
                <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${headerStatus.dotColor} ${headerStatus.pulse ? 'animate-pulse' : ''}`}></span>
                <span className={`font-medium ${headerStatus.pulse ? 'animate-pulse' : ''}`}>{headerStatus.text}</span>
                
                {/* TOOLTIP FOR GROUP CHAT */}
                {isGroup && currentGroup && (
                  <div className="absolute top-full left-0 mt-3 bg-white w-64 rounded-2xl border border-gray-200 z-50 opacity-0 invisible group-hover/badge:opacity-100 group-hover/badge:visible transition-all animate-in fade-in slide-in-from-top-2 p-2">

                    <div className="flex flex-col gap-0.5">
                      {currentGroup.members.map(m => {
                        const memberDisplayName = resolveGroupMemberDisplayName(m);
                        const isWorking = activeProcessingAgents.includes(m.agent_id);
                        return (
                          <div key={m.agent_id} className="flex flex-row items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-gray-50/80 transition-colors">
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 border border-gray-200 ${getAgentColor(m.agent_id, currentGroup.members)}`}>
                              {memberDisplayName[0]}
                            </div>
                            <div className="flex flex-col min-w-0 flex-1">
                              <span className="text-sm font-normal text-gray-800 line-clamp-1 truncate leading-tight">{memberDisplayName}</span>
                            </div>
                            <div className={`text-xs font-normal tracking-wide w-fit px-2 py-0.5 rounded-md flex gap-1.5 items-center flex-shrink-0 border ${isWorking ? 'text-green-600 bg-green-50 border-green-100' : 'text-gray-400 bg-gray-50 border-gray-100/50'}`}>
                              {isWorking && <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse"></span>}
                              {isWorking ? t('common.processing') : t('common.idle')}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {!showMobileSearch && (
          <button className="md:hidden p-2 text-gray-500 hover:text-gray-900 ml-auto" onClick={() => setShowMobileSearch(true)}><Search className="w-5 h-5" /></button>
        )}
        {/* Search bar */}
        <div className={`flex-1 max-w-sm ml-auto items-center justify-end md:pl-6 ${showMobileSearch ? 'flex w-full' : 'hidden md:flex'}`}>
          <div className="relative w-full group flex items-center gap-1 sm:gap-2">
            {showMobileSearch && (
              <button onClick={() => { setShowMobileSearch(false); setMessageSearchQuery(''); }} className="md:hidden p-2 text-gray-500 hover:text-gray-700"><X className="w-5 h-5" /></button>
            )}
            <div className="relative w-full">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><Search className="h-4 w-4 text-gray-400 group-focus-within:text-blue-500 transition-colors" /></div>
              <input type="text" placeholder={isChat ? t('unifiedChat.searchCurrentConversation') : t('unifiedChat.searchGroupConversation')} value={messageSearchQuery} onChange={(e) => setMessageSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) handlePrevSearch(); else handleNextSearch(); } }}
                className="block w-full pl-9 pr-24 py-2 rounded-xl border border-gray-200 bg-gray-50 hover:border-gray-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm font-medium placeholder-gray-400" />
              {messageSearchQuery && (
                <div className="absolute inset-y-0 right-0 flex items-center pr-1.5 space-x-1">
                  <span className="text-[11px] font-bold text-gray-400 px-1 border-r border-gray-200 mr-0.5">{searchMatches.length > 0 ? `${currentMatchIndex + 1}/${searchMatches.length}` : '0/0'}</span>
                  <button onClick={handlePrevSearch} disabled={searchMatches.length === 0} className="p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 rounded-md disabled:opacity-30" title={t('unifiedChat.previousResult')}><ChevronUp className="w-4 h-4" /></button>
                  <button onClick={handleNextSearch} disabled={searchMatches.length === 0} className="p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 rounded-md disabled:opacity-30" title={t('unifiedChat.nextResult')}><ChevronDown className="w-4 h-4" /></button>
                  <button onClick={() => setMessageSearchQuery('')} className="p-1 mr-1 text-gray-400 hover:bg-red-50 hover:text-red-500 rounded-md ml-0.5"><X className="w-4 h-4" /></button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Message List Area */}
      <div className="flex-1 flex relative min-h-0">
        {/* Nav dots */}
        {!showMessageListSkeleton && navDots.length > 0 && (
          <div className="hidden md:block absolute inset-y-0 left-0 w-0 z-[60] pointer-events-none">
            <div className="relative h-full">
              {navDots.map((dot) => (
                <div key={dot.id} className="absolute left-0 -translate-x-1/2 z-10" style={{ top: `${Math.max(2, Math.min(98, dot.top))}%` }} onMouseEnter={() => setHoveredDot(dot.id)} onMouseLeave={() => setHoveredDot(null)}>
                  <button
                    onClick={() => scrollToUserMsg(dot.id)}
                    className={`pointer-events-auto rounded-full transition-all duration-200 hover:scale-150 relative ${activeNavDot === dot.id ? 'w-3 h-3 bg-blue-500' : 'w-2.5 h-2.5 bg-gray-400 hover:bg-blue-400'}`}
                  />
                  {hoveredDot === dot.id && (
                    <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 w-max max-w-[280px] px-3 py-2 bg-gray-800 text-white text-[12px] rounded-lg leading-relaxed pointer-events-none animate-in fade-in duration-150 z-50">
                      <div className="min-w-[120px] max-w-[280px] space-y-0.5">
                        <div className="truncate text-white">{dot.summary.primary}</div>
                        {dot.summary.secondary && (
                          <div className="truncate text-gray-200">{dot.summary.secondary}</div>
                        )}
                      </div>
                      <div className="absolute top-1/2 -translate-y-1/2 left-[-4px] w-0 h-0 border-t-4 border-b-4 border-r-4 border-t-transparent border-b-transparent border-r-gray-800" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {canShowHistoryPagingUi && historyPageNoticeText && (
          <div className={`${historyPromptShellClass} top-5`}>
            <div className={historyPromptRowClass}>
              <div className={`${historyPromptBubbleClass} border border-gray-200 bg-white`}>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                <span className="min-w-0 truncate whitespace-nowrap">{historyPageNoticeText}</span>
              </div>
            </div>
          </div>
        )}

        {canShowHistoryPagingUi && historyEdgePrompt === 'older' && (
          <div className={`${historyPromptShellClass} top-5`}>
            <div className={historyPromptRowClass}>
              <div className={`${historyPromptBubbleClass} border border-orange-300 bg-[#fff8ee]`}>
                <ChevronUp className="w-4 h-4 text-orange-500 shrink-0" />
                <span className="min-w-0 truncate whitespace-nowrap">{historyEdgePromptText}</span>
              </div>
            </div>
          </div>
        )}

        {canShowHistoryPagingUi && historyEdgePrompt === 'newer' && (
          <div className={`${historyPromptShellClass} bottom-5`}>
            <div className={historyPromptRowClass}>
              <div className={`${historyPromptBubbleClass} border border-orange-300 bg-[#fff8ee]`}>
                <ChevronDown className="w-4 h-4 text-orange-500 shrink-0" />
                <span className="min-w-0 truncate whitespace-nowrap">{historyEdgePromptText}</span>
              </div>
            </div>
          </div>
        )}

        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:px-8 sm:py-4 space-y-6 bg-white pb-0 relative">
          {showMessageListSkeleton ? (
            <MessageListSkeleton />
          ) : (
            <>
              {showOlderHistorySkeleton && <HistoryLoadMoreSkeleton />}

              {/* Date badge / empty state */}
              {isChat && (
                <div className="flex justify-center mb-8">
                  <span className="px-4 py-1.5 bg-[#eff1f4] text-gray-500 text-[11px] rounded-full">
                    {messages.length > 0 ? formatMessageDate(messages[0].timestamp) : t('unifiedChat.startConversation')}
                  </span>
                </div>
              )}
              {isGroup && messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-64 text-gray-400">
                  <Users className="w-12 h-12 mb-3 opacity-30" />
                  <p className="text-sm font-medium">{t('unifiedChat.firstGroupMessageTitle')}</p>
                  <p className="text-xs mt-1">{t('unifiedChat.firstGroupMessageDescription')}</p>
                </div>
              )}

              {/* Messages */}
              {visibleMessages.map((msg, index) => {
                const lastUserMsgId = [...visibleMessages].reverse().find(m => m.role === 'user')?.id ?? null;
                const isHighlighted = activeHighlightId === msg.id;
                const prevMsg = index > 0 ? visibleMessages[index - 1] : null;
                const showDateDivider = prevMsg ? msg.timestamp.toDateString() !== prevMsg.timestamp.toDateString() : false;

                // Model display
                let modelDisplayName: string | undefined;
                let agentName: string | undefined;
                let avatarUrl: string | undefined;
                let avatarChar: string | undefined;
                let avatarColorClass: string | undefined;

                if (isChat) {
                  const session = sessions.find(s => s.id === activeKey);
                  const character = characters.find(c => c.id === session?.characterId);
                  const modelId = msg.model || session?.model || character?.model || currentModel;
                  const modelInfo = props.availableModels?.find(m => m.id === modelId);
                  modelDisplayName = modelInfo?.alias || modelId || 'OpenClaw';
                  agentName = msg.agentName || activeSessionName;
                  avatarUrl = '/ai-robot.jpg';
                } else {
                  const isUser = msg.role === 'user';
                  const isSystem = msg.role === 'system';
                  const agentSession = (!isUser && !isSystem) ? findSessionByAgentId(msg.agentId) : null;

                  const modelId = msg.model || agentSession?.model;

                  if (modelId) {
                    const modelInfo = props.availableModels?.find(m => m.id === modelId);
                    modelDisplayName = modelInfo?.alias || modelId;
                  } else {
                    modelDisplayName = undefined;
                  }

                  agentName = msg.agentName;
                  if (!isUser && !isSystem) {
                    avatarChar = (msg.agentName || '?')[0];
                    avatarColorClass = currentGroup ? getAgentColor(msg.agentId || '', currentGroup.members) : undefined;
                  }
                }

                const resolvedContent = msg.role === 'system'
                  ? resolveStructuredMessageContent(msg, t)
                  : msg.content;

                if (msg.role === 'system' && msg.messageCode === GROUP_MAX_CHAIN_DEPTH_MESSAGE_CODE) {
                  return (
                    <div key={msg.id} className="flex justify-center my-6 relative w-full items-center">
                      <div className="absolute inset-0 flex items-center px-4 md:px-8" aria-hidden="true">
                        <div className="w-full border-t border-gray-200"></div>
                      </div>
                      <div className="flex justify-center relative">
                        <span className="px-4 py-1.5 bg-[#eff1f4] text-gray-500 text-[11px] rounded-full z-10">
                          {resolvedContent}
                        </span>
                      </div>
                    </div>
                  );
                }

                const resolvedProcessTags = isGroup
                  ? resolveProcessTagPair(
                      currentGroup?.process_start_tag,
                      currentGroup?.process_end_tag,
                      findSessionByAgentId(msg.agentId)?.process_start_tag,
                      findSessionByAgentId(msg.agentId)?.process_end_tag,
                    )
                  : resolveProcessTagPair(
                      currentSession?.process_start_tag,
                      currentSession?.process_end_tag,
                    );

                return (
                  <MessageBubble
                    key={msg.id} id={msg.id} role={msg.role} content={resolvedContent} timestamp={msg.timestamp}
                    processContent={msg.processContent}
                    processStreaming={msg.processStreaming}
                    rawDetail={msg.rawDetail}
                    isHighlighted={isHighlighted} showDateDivider={showDateDivider}
                    searchQuery={matchedMessageIdSet.has(msg.id) ? debouncedMessageSearchQuery : ''}
                    agentName={agentName} modelDisplayName={modelDisplayName}
                    avatarUrl={avatarUrl} avatarChar={avatarChar} avatarColorClass={avatarColorClass}
                    onPreview={(url, filename) => setPreviewFile({url, filename})}
                    isEditing={msg.id === editingMessageId} editContent={editContent}
                    editIsDragging={editIsDragging} editExistingAttachments={editExistingAttachments as any} editPendingFiles={editPendingFiles as any}
                    onSetEditIsDragging={undefined} onSetEditContent={setEditContent}
                    onSetEditExistingAttachments={setEditExistingAttachments} onSetEditPendingFiles={setEditPendingFiles}
                    onDropNewFiles={undefined}
                    onEditClick={(attachments, text) => { setEditingMessageId(msg.id); setEditContent(text); setEditExistingAttachments(attachments); setEditPendingFiles([]); }}
                    onCancelEdit={resetEditComposer}
                    onSaveEdit={handleSaveEdit}
                    onRegenerate={() => handleRegenerate(msg)}
                    onQuote={() => handleQuote(msg)}
                    onCopy={(content, id) => handleCopy(content, id as string)}
                    onDelete={() => handleDeleteMessage(msg.id)}
                    isCopied={copiedId === msg.id}
                    activeCopiedId={copiedId}
                    isLoading={isLoading}
                    processStartTag={resolvedProcessTags.startTag}
                    processEndTag={resolvedProcessTags.endTag}
                    isLatest={msg.role === 'user' ? msg.id === lastUserMsgId : index === visibleMessages.length - 1}
                    preserveProcessExpansionWhenNotLatest={isGroup && msg.role === 'assistant'}
                  />
                );
              })}
            </>
          )}



          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="px-4 sm:px-6 pb-6 sm:pb-4 pt-2 flex-shrink-0 bg-white">
        <div className="max-w-5xl mx-auto flex flex-col gap-3">
          {/* 失败提示：发送、上传、历史加载共用这一处，可手动关闭 */}
          {submitError && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              <span className="flex-1 min-w-0 break-words">{submitError}</span>
              <button
                type="button"
                onClick={() => setSubmitError('')}
                className="shrink-0 text-red-400 hover:text-red-600"
                aria-label={t('common.close')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Pending file previews */}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-3 pb-2 animate-in slide-in-from-bottom-2 duration-300">
              {pendingFiles.map((pf, idx) => (
                <div key={idx} className={`relative group ${pf.preview ? 'w-24 h-24' : 'w-max min-w-[120px] max-w-[200px] h-14 pl-2 pr-3 flex items-center gap-2'} rounded-xl overflow-hidden bg-white border border-gray-300 flex-shrink-0 transition-all hover:scale-[1.02] active:scale-95 hover:bg-blue-50/50 hover:border-blue-200`}>
                  {pf.preview ? (
                    <img src={pf.preview} className="w-full h-full object-cover" alt="preview" />
                  ) : (
                    (() => { const { Icon, typeText, bgColor } = getFileIconInfo(pf.file.name); return (
                      <>
                        <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0 text-white`}><Icon className="w-5 h-5 text-white" /></div>
                        <div className="flex flex-col min-w-0 pr-4">
                          <span className="text-[12px] font-semibold text-gray-700 truncate w-full">{pf.file.name}</span>
                          <span className="text-[10px] text-gray-400 capitalize">{typeText}</span>
                        </div>
                      </>
                    ); })()
                  )}
                  <button onClick={() => removePendingFile(idx)} className="absolute top-1.5 right-1.5 bg-black/60 hover:bg-red-500 text-white rounded-full p-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all border border-transparent hover:border-white/20">
                    <Plus className="w-3.5 h-3.5 rotate-45" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative">
            {/* Group mention popup */}
            {isGroup && showMentionPopup && (
              <div className="absolute bottom-full left-0 mb-2 w-64 bg-white rounded-xl border border-gray-200 py-1 z-50 overflow-hidden">
                <div className="px-3 py-1.5 text-xs font-bold text-gray-400 border-b border-gray-100">{t('unifiedChat.mentionMembersTitle')}</div>
                {getFilteredMembers().map((m, idx) => (
                  <button key={m.agent_id} onClick={() => insertMention(resolveGroupMemberDisplayName(m))} onMouseEnter={() => setMentionIndex(idx)}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${idx === mentionIndex ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'}`}>
                    <div className={`w-6 h-6 rounded-full ${getAgentColor(m.agent_id, currentGroup?.members || [])} flex items-center justify-center text-white text-xs font-bold`}>{resolveGroupMemberDisplayName(m)[0]}</div>
                    <span className="font-bold">{resolveGroupMemberDisplayName(m)}</span>
                  </button>
                ))}
                {getFilteredMembers().length === 0 && <div className="px-3 py-2 text-sm text-gray-400">{t('unifiedChat.noMatchingMembers')}</div>}
              </div>
            )}

            <form onSubmit={handleSubmit} className="relative flex flex-col border border-gray-200 rounded-2xl bg-white overflow-visible hover:border-gray-300 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 transition-all">
              {/* Quote preview */}
              {quotedMessage && (
                <div className="mx-4 mt-3 mb-1 px-3 py-2 bg-gray-100 rounded-lg relative group flex items-start justify-between animate-in fade-in slide-in-from-bottom-2">
                  <div className="flex-1 min-w-0 pr-4">
                    <span className="text-[11px] font-bold text-gray-500 mb-0.5 block tracking-wider">{t('unifiedChat.quotedContent')}</span>
                    <div className="max-h-28 overflow-hidden prose prose-sm max-w-none prose-slate text-[13px] text-gray-700 break-words">
                      {(() => {
                        const processStart = (isGroup ? currentGroup?.process_start_tag : currentSession?.process_start_tag) || '[执行工作_Start]';
                        const processEnd = (isGroup ? currentGroup?.process_end_tag : currentSession?.process_end_tag) || '[执行工作_End]';
                        const processed = normalizeProcessBlocks(quotedMessage.content, processStart, processEnd);
                        const previewComponents: any = {
                          pre({ children }: any) { return <>{children}</>; },
                          code({ node, inline, className, children, ...props }: any) {
                            const match = /language-([^\s]+)/.exec(className || '');
                            const codeText = children ? String(children).replace(/\n$/, '') : '';
                            if (!inline && match && (match[1] === 'process_step_thought' || match[1] === 'process_step_thought_streaming')) {
                              return (
                                <ProcessStepBlock
                                  content={codeText.trim()}
                                  initiallyExpanded={false}
                                  isExtractingProcess={match[1] === 'process_step_thought_streaming'}
                                  isDense
                                />
                              );
                            }
                            return <code className={className} {...props}>{children}</code>;
                          }
                        };
                        return (
                          <ReactMarkdown
                            remarkPlugins={markdownRemarkPlugins}
                            rehypePlugins={markdownRehypePlugins}
                            components={previewComponents}
                          >
                            {normalizeMathMarkdown(processed)}
                          </ReactMarkdown>
                        );
                      })()}
                    </div>
                  </div>
                  <button type="button" onClick={() => setQuotedMessage(null)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded-full hover:bg-gray-200 transition-all flex-shrink-0"><X className="w-4 h-4" /></button>
                </div>
              )}

              {/* Chat command suggestions */}
              {isChat && showCommands && filteredCommands.length > 0 && (
                <div ref={commandListRef} className="absolute bottom-full left-0 mb-4 w-72 bg-white rounded-2xl border border-gray-300 z-[100] py-2 overflow-hidden animate-in fade-in slide-in-from-bottom-2">
                  <div className="px-4 py-2.5 text-sm font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100 mb-1 flex justify-between items-center">
                    <span>{t('unifiedChat.quickCommands')}</span><span>{t('unifiedChat.resultsCount', { count: filteredCommands.length })}</span>
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    {filteredCommands.map((cmd, idx) => (
                      <button key={cmd.id} type="button"
                        onClick={() => { setInput(cmd.command + ' '); setShowCommands(false); textareaRef.current?.focus(); }}
                        onMouseEnter={() => setCommandIndex(idx)}
                        className={`w-full text-left px-4 py-3 flex flex-col gap-0.5 transition-colors ${idx === commandIndex ? 'bg-blue-100' : 'hover:bg-gray-50'}`}>
                        <span className={`text-sm font-extrabold ${idx === commandIndex ? 'text-blue-600' : 'text-gray-900'}`}>{cmd.command}</span>
                        <div className="text-[13px] text-gray-500 truncate">{cmd.description}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="relative">
                <textarea ref={textareaRef} rows={1} value={input} onKeyDown={handleKeyDown} onPaste={handlePaste}
                  onChange={isGroup ? handleGroupInputChange : (e) => setInput(e.target.value)}
                  placeholder={t('unifiedChat.inputPlaceholder')} disabled={isLoading}
                  className={`w-full min-h-[44px] max-h-[200px] py-3 pl-5 pr-8 bg-transparent focus:outline-none text-[16px] font-medium placeholder:text-gray-400 resize-none overflow-y-auto leading-relaxed border-none scrollbar-hide ${inputPreview ? 'invisible' : ''}`} />
                {inputPreview && (
                  <div
                    className="absolute inset-0 py-3 pl-5 pr-8 overflow-y-auto leading-relaxed text-[16px] font-medium prose prose-sm max-w-none prose-slate cursor-text"
                    onClick={() => { setInputPreview(false); setTimeout(() => textareaRef.current?.focus(), 0); }}
                  >
                    {input.trim() ? (() => {
                      const processStart = (isGroup ? currentGroup?.process_start_tag : currentSession?.process_start_tag) || '[执行工作_Start]';
                      const processEnd = (isGroup ? currentGroup?.process_end_tag : currentSession?.process_end_tag) || '[执行工作_End]';
                      const processed = normalizeProcessBlocks(input, processStart, processEnd);
                      const previewComponents: any = {
                        pre({ children }: any) { return <>{children}</>; },
                        code({ node, inline, className, children, ...props }: any) {
                          const match = /language-(\w+)/.exec(className || '');
                          const codeText = children ? String(children).replace(/\n$/, '') : '';
                          if (!inline && match && (match[1] === 'process_step_thought' || match[1] === 'process_step_thought_streaming')) {
                            return <ProcessStepBlock content={codeText.trim()} initiallyExpanded={true} isExtractingProcess={match[1] === 'process_step_thought_streaming'} />;
                          }
                          return <code className={className} {...props}>{children}</code>;
                        }
                      };
                      return (
                        <ReactMarkdown
                          remarkPlugins={markdownRemarkPlugins}
                          rehypePlugins={markdownRehypePlugins}
                          components={previewComponents}
                        >
                          {normalizeMathMarkdown(processed)}
                        </ReactMarkdown>
                      );
                    })() : (
                      <span className="text-gray-400">{t('unifiedChat.inputPlaceholder')}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Bottom toolbar */}
              <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100">
                <div className="flex items-center gap-1">
                  <input type="file" ref={fileInputRef} multiple className="hidden" onChange={(e) => handleFileChange(Array.from(e.target.files || []))} />
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all">
                    <Plus className="w-5 h-5" />
                  </button>
                  {isChat && (
                    <button type="button" onClick={() => { if (showCommands) setShowCommands(false); else { setFilteredCommands(allCommands); setCommandIndex(0); setShowCommands(true); } }}
                      className="h-9 px-2 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all font-bold text-base">/</button>
                  )}
                  {isGroup && (
                    <button type="button" onClick={() => {
                      const ta = textareaRef.current; if (ta) {
                        const pos = ta.selectionStart; setInput(input.substring(0, pos) + '@' + input.substring(pos));
                        setShowMentionPopup(true); setMentionFilter('');
                        setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = pos + 1; }, 0);
                      }
                    }} className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all font-bold text-lg">@</button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setInputPreview(p => !p); if (inputPreview) setTimeout(() => textareaRef.current?.focus(), 0); }}
                    className={`h-9 px-2.5 flex items-center justify-center rounded-lg text-xs font-medium transition-all ${inputPreview ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                    title={inputPreview ? t('unifiedChat.switchToEdit') : t('unifiedChat.previewRender')}
                  >
                    {inputPreview ? t('common.edit') : t('unifiedChat.preview')}
                  </button>
                </div>
                {(isChat && isLoading) || (isGroup && isGroupBusy) ? (
                  <button type="button" onClick={handleStop} className="px-4 h-9 flex items-center gap-1.5 justify-center rounded-lg transition-all font-bold text-sm bg-red-100 text-red-600 hover:bg-red-200 active:scale-95">
                    <span className="w-3 h-3 rounded-sm bg-red-600 inline-block flex-shrink-0" />{t('common.stop')}
                  </button>
                ) : (
                  <button type="submit" disabled={!hasDraftToSend || isLoading || isGroupBusy}
                    className={`px-4 h-9 flex items-center justify-center rounded-lg transition-all font-bold text-sm ${hasDraftToSend && !isLoading && !isGroupBusy ? 'bg-blue-600 text-white hover:bg-blue-700 active:scale-95' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>
                    {isLoading ? t('common.sending') : t('common.send')}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* File Preview Modal */}
      {previewFile && <FilePreviewModal url={previewFile.url} filename={previewFile.filename} onClose={() => setPreviewFile(null)} />}

      {/* Delete Confirmation Modal */}
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" onClick={() => { setDeleteErrorMessage(''); setIsDeleteModalOpen(false); }}></div>
          <div className="bg-white rounded-[32px] border border-gray-200 w-full max-w-[340px] max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-8 text-center">
              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-3xl bg-red-50 mb-6 border border-red-100"><Trash2 className="h-8 w-8 text-red-500" /></div>
              <h3 className="text-xl font-black text-gray-900 mb-2 tracking-tight">{t('unifiedChat.deleteMessageTitle')}</h3>
              <p className="text-sm text-gray-500 leading-relaxed px-2">{t('unifiedChat.deleteMessageDescription')}</p>
              {deleteErrorMessage ? (
                <p className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left text-sm whitespace-pre-line text-red-600">
                  {deleteErrorMessage}
                </p>
              ) : null}
            </div>
            <div className="p-5 bg-gray-50/80 flex gap-3 border-t border-gray-100">
              <button type="button" onClick={() => { setDeleteErrorMessage(''); setIsDeleteModalOpen(false); }} className="flex-1 px-4 py-3 text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 active:scale-95 rounded-2xl font-bold text-sm transition-all">{t('common.cancel')}</button>
              <button type="button" onClick={confirmDeleteMessage} className="flex-1 px-4 py-3 text-white bg-red-600 hover:bg-red-700 active:scale-95 rounded-2xl font-bold text-sm transition-all">{t('common.confirmDelete')}</button>
            </div>
          </div>
        </div>
      )}

      {/* File Error Modal */}
      {fileErrorModalOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" onClick={() => setFileErrorModalOpen(false)}></div>
          <div className="bg-white rounded-[32px] border border-gray-200 w-full max-w-[420px] max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-8 text-center">
              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-3xl bg-red-50 mb-6 border border-red-100"><X className="h-8 w-8 text-red-500" /></div>
              <h3 className="text-xl font-black text-gray-900 mb-2 tracking-tight">{t('unifiedChat.fileProcessingFailed')}</h3>
              <p className="text-sm text-gray-500 leading-relaxed px-2 whitespace-pre-line">{fileErrorMessage}</p>
            </div>
            <div className="p-5 bg-gray-50/80 border-t border-gray-100">
              <button type="button" onClick={() => setFileErrorModalOpen(false)} className="w-full px-4 py-3 text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-2xl font-bold text-sm transition-all">{t('common.gotIt')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
