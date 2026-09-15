import type { MessagePageInfo, MessageSearchMatch } from '../../core/db';
import type { StructuredMessageParams } from '../../core/http';
import {
  CHAT_GATEWAY_DISCONNECTED_CODE,
  CHAT_GATEWAY_DISCONNECTED_DETAIL,
  CHAT_RUN_ERROR_CODE,
  CHAT_RUN_ERROR_PREFIX,
  DEFAULT_HISTORY_PAGE_LIMIT,
  MAX_HISTORY_PAGE_LIMIT,
} from './chat-constants';
import { parseCommandResultContent } from './chat-command-result';
import { CONTEXT_WINDOW_TOO_SMALL_CODE, isContextWindowTooSmallError } from './context-usage';
import { rewriteOpenClawMediaPaths } from './process-text';
import type { SessionRuntime } from './session-runtime';

export function createStructuredChatError(rawDetail?: string | null, forcedCode?: string) {
  const detail = typeof rawDetail === 'string' && rawDetail.trim() ? rawDetail.trim() : 'Unknown error';
  const messageCode = (isContextWindowTooSmallError(detail) ? CONTEXT_WINDOW_TOO_SMALL_CODE : null)
    || forcedCode
    || (detail === CHAT_GATEWAY_DISCONNECTED_DETAIL
      ? CHAT_GATEWAY_DISCONNECTED_CODE
      : CHAT_RUN_ERROR_CODE);

  return {
    content: `${CHAT_RUN_ERROR_PREFIX}${detail}`,
    messageCode,
    messageParams: undefined as StructuredMessageParams | undefined,
    rawDetail: detail,
    role: 'system' as const,
    agent_id: 'system',
    agent_name: 'System',
  };
}

export function resolveStructuredChatErrorInput(error: any): { rawDetail: string | null; messageCode?: string } {
  const rawDetail = typeof error?.rawDetail === 'string' && error.rawDetail.trim()
    ? error.rawDetail.trim()
    : (typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : null);

  const messageCode = typeof error?.messageCode === 'string' && error.messageCode.trim()
    ? error.messageCode.trim()
    : undefined;

  return {
    rawDetail,
    messageCode,
  };
}

export function buildStructuredChatHttpError(rawDetail?: string | null, forcedCode?: string) {
  const structured = createStructuredChatError(rawDetail, forcedCode);
  return {
    success: false as const,
    message: structured.content,
    error: structured.content,
    messageCode: structured.messageCode,
    messageParams: structured.messageParams || null,
    rawDetail: structured.rawDetail,
    role: structured.role,
  };
}

export function buildStructuredChatErrorStreamEvent(structuredError: ReturnType<typeof createStructuredChatError>) {
  return {
    type: 'error',
    text: structuredError.content,
    messageCode: structuredError.messageCode,
    messageParams: structuredError.messageParams,
    rawDetail: structuredError.rawDetail,
    role: structuredError.role,
  };
}

function getStructuredChatMessage(content?: string | null) {
  // 外部运行时的会话命令结果（`⌘ ` + JSON）：同一条结构化通道，界面按码本地化。
  const commandResult = parseCommandResultContent(content);
  if (commandResult) {
    return {
      messageCode: commandResult.messageCode,
      messageParams: commandResult.messageParams as StructuredMessageParams | undefined,
      rawDetail: commandResult.rawDetail ?? null,
      displayContent: commandResult.fallbackText,
      role: 'system' as const,
      agent_id: undefined,
      agent_name: undefined,
    };
  }
  if (!content || !content.startsWith(CHAT_RUN_ERROR_PREFIX)) return {};

  const detail = content.slice(CHAT_RUN_ERROR_PREFIX.length).trim();
  if (!detail) return {};

  return {
    messageCode: detail === CHAT_GATEWAY_DISCONNECTED_DETAIL
      ? CHAT_GATEWAY_DISCONNECTED_CODE
      : isContextWindowTooSmallError(detail) ? CONTEXT_WINDOW_TOO_SMALL_CODE : CHAT_RUN_ERROR_CODE,
    messageParams: undefined as StructuredMessageParams | undefined,
    rawDetail: detail,
    role: 'system' as const,
    agent_id: 'system',
    agent_name: 'System',
  };
}

function parsePositiveIntegerQueryParam(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getHistoryPageQueryParams(query: Record<string, unknown>) {
  const beforeId = parsePositiveIntegerQueryParam(query.beforeId);
  const requestedLimit = parsePositiveIntegerQueryParam(query.limit);
  const limit = Math.min(requestedLimit ?? DEFAULT_HISTORY_PAGE_LIMIT, MAX_HISTORY_PAGE_LIMIT);
  return { beforeId, limit };
}

export function buildHistoryPageResponse<T>(rows: T[], pageInfo: MessagePageInfo) {
  return {
    success: true as const,
    messages: rows,
    pageInfo,
  };
}

export function buildHistorySearchResponse(matches: MessageSearchMatch[]) {
  return {
    success: true as const,
    matches: matches.map((match) => ({
      messageId: String(match.id),
      anchorBeforeId: match.anchorBeforeId ?? null,
    })),
  };
}

export type ChatMessagesDeps = {
  sessionRuntime: SessionRuntime;
};

export function createChatMessages(ctx: ChatMessagesDeps) {
  const { getSessionWorkspacePath } = ctx.sessionRuntime;

  function withStructuredChatMessage<T extends { content?: string | null; process_content?: string | null; process_streaming?: boolean | number | null; role?: 'user' | 'assistant' | 'system'; messageCode?: string; messageParams?: StructuredMessageParams | null; rawDetail?: string | null; agent_id?: string | null; agent_name?: string | null }>(
    message: T,
    options?: { sessionId?: string | null }
  ): T & { process_content?: string | null; process_streaming?: boolean | number | null; role?: 'user' | 'assistant' | 'system'; messageCode?: string; messageParams?: StructuredMessageParams; rawDetail?: string | null; agent_id?: string | null; agent_name?: string | null } {
    const content = typeof message.content === 'string'
      ? rewriteOpenClawMediaPaths(message.content, options?.sessionId ? getSessionWorkspacePath(options.sessionId) : undefined)
      : message.content;
    const processContent = typeof message.process_content === 'string'
      ? rewriteOpenClawMediaPaths(message.process_content, options?.sessionId ? getSessionWorkspacePath(options.sessionId) : undefined)
      : message.process_content;
    const processStreaming = Boolean(message.process_streaming);
    const structured = getStructuredChatMessage(content);
    return {
      ...message,
      content: 'displayContent' in structured && structured.displayContent ? structured.displayContent : content,
      process_content: processContent,
      process_streaming: structured.messageCode ? false : processStreaming,
      role: structured.role ?? message.role,
      messageCode: message.messageCode ?? structured.messageCode,
      messageParams: message.messageParams ?? structured.messageParams,
      rawDetail: message.rawDetail ?? structured.rawDetail,
      agent_id: structured.agent_id ?? (message.agent_id ?? null),
      agent_name: structured.agent_name ?? (message.agent_name ?? null),
    };
  }

  return {
    withStructuredChatMessage,
  };
}
export type ChatMessages = ReturnType<typeof createChatMessages>;
