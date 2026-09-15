// 后端载荷 → ChatMessage 的映射，以及发送 / 流式失败时的结构化错误。
import type { TFunction } from 'i18next';
import type { ChatMessage } from '../../../utils/message-merge';

export function isPersistedMessageId(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}

export function mergeHistoryMessages(olderMessages: ChatMessage[], newerMessages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  const seen = new Set<string>();

  [...olderMessages, ...newerMessages].forEach((message) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    merged.push(message);
  });

  return merged;
}

export function resolveStructuredMessageContent(message: ChatMessage, t: TFunction): string {
  if (!message.messageCode) return message.content;

  const translated = t(message.messageCode, (message.messageParams || {}) as any);
  if (typeof translated !== 'string') {
    return message.content;
  }
  return translated === message.messageCode ? message.content : translated;
}

export function mapChatHistoryMessage(m: any): ChatMessage {
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

/**
 * `delta` / `final` 帧 → 消息补丁。三处流（发送、重新生成、接回）共用这一份。
 * 帧带 `messageCode` 时（外部运行时的会话命令结果 `runtimeCommand.*`）按结构化消息落：角色、文案码、参数、详情，
 * 界面按当前语言本地化，而不是显示后端给的英文兜底文本。
 */
export function mapStreamingContentPatch(evt: any): Partial<ChatMessage> {
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
  if (typeof evt.messageCode === 'string' && evt.messageCode) {
    patch.messageCode = evt.messageCode;
    if (evt.role === 'system') patch.role = 'system';
    if (evt.messageParams && typeof evt.messageParams === 'object') patch.messageParams = evt.messageParams;
    if (typeof evt.rawDetail === 'string' && evt.rawDetail.trim()) patch.rawDetail = evt.rawDetail;
  }
  return patch;
}

export function mapStreamingErrorUpdate(evt: any, fallbackContent: string): Partial<ChatMessage> {
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

export async function mapHttpErrorResponse(response: Response, fallbackContent: string): Promise<Partial<ChatMessage>> {
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

export function createClientStructuredChatError(detail: string): Partial<ChatMessage> {
  const trimmedDetail = detail.trim() || 'Unknown error';
  return {
    role: 'system',
    content: `❌ Error: ${trimmedDetail}`,
    messageCode: 'chat.runError',
    rawDetail: trimmedDetail,
  };
}

export function resolveSubmitError(
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

/**
 * 群聊发送成功后的提示（不是错误）：后端在 `notice` 里说明哪些 @ 没有叫起（member 未被授权的 Agent）。
 * 名字按界面语言拼接；没有提示返回空串。
 */
export function resolveGroupSendNotice(payload: unknown, t: TFunction, locale: string): string {
  const notice = (payload as { notice?: { messageCode?: unknown; agentNames?: unknown } } | null)?.notice;
  if (!notice || typeof notice.messageCode !== 'string') return '';
  const names = Array.isArray(notice.agentNames) ? notice.agentNames.filter((name): name is string => typeof name === 'string' && name.length > 0) : [];
  const separator = locale.startsWith('zh') ? '、' : ', ';
  return String(t(notice.messageCode, { agents: names.join(separator) }));
}

// 群聊消息行（DB / SSE 载荷）→ ChatMessage。
export function mapGroupMsg(m: any): ChatMessage {
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
    ...mapRoomMeta(m),
  };
}

/** P3 群协作元数据：历史行与编辑帧带着才填（增量帧不带，合并时保留已有的）。 */
function mapRoomMeta(m: any): Pick<ChatMessage, 'room'> {
  const hasMeta = Array.isArray(m?.workspace_changes) || Array.isArray(m?.attachments) || typeof m?.sender_guest_id === 'string' || typeof m?.message_kind === 'string';
  if (!hasMeta) return {};
  return {
    room: {
      senderGuestId: typeof m.sender_guest_id === 'string' ? m.sender_guest_id : null,
      senderMemberId: typeof m.sender_member_id === 'string' ? m.sender_member_id : null,
      mentionDepth: typeof m.mention_depth === 'number' ? m.mention_depth : 0,
      messageKind: typeof m.message_kind === 'string' ? m.message_kind : '',
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      workspaceChanges: Array.isArray(m.workspace_changes) ? m.workspace_changes : [],
    },
  };
}
