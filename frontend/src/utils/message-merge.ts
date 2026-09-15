/**
 * 消息合并与内容保留 —— 从 UnifiedChatView.tsx 原样搬出，**一个字符都没有改**。
 *
 * 搬出来的唯一理由是「测得动」：这一族是纯函数，但它们原来住在一个 4,200 行的
 * 组件文件里，测试一 import 就会把 react-markdown / katex / pdfjs 整条依赖链
 * 拖进进程。
 *
 * 它们守的是一类**不会报错**的故障：流式过程中用旧文本覆盖新文本、把半截回答
 * 当成完整回答。后端为同一条红线写了 text-snapshot-protection.ts 与配套用例；
 * 前端此前一个用例都没有。AGENTS.md 反对的「同一条判据两处分家」，这里就是一处。
 *
 * 对应用例：src/utils/message-merge.test.ts
 */

export type StructuredMessageParams = Record<string, string | number | boolean | null>;

export interface ChatMessage {
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
  /** 群协作元数据（P3）：发送人身份、附件、挂在回复上的工作区 diff。只由群历史 / 群事件映射填，单聊没有。 */
  room?: {
    senderGuestId?: string | null;
    senderMemberId?: string | null;
    mentionDepth?: number;
    messageKind?: string;
    attachments?: Array<{ id: string; name: string; mediaType: string; size: number; url: string; kind: 'image' | 'file' }>;
    workspaceChanges?: any[];
  };
}

export function parsePositiveCursorValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function hasOwnMessageField<T extends object>(value: T, key: keyof any): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function hasExplicitProcessState(incoming: Partial<ChatMessage>): boolean {
  const hasProcessContent = hasOwnMessageField(incoming, 'processContent')
    && typeof incoming.processContent === 'string'
    && incoming.processContent.trim().length > 0;
  const hasProcessStreaming = hasOwnMessageField(incoming, 'processStreaming')
    && typeof incoming.processStreaming === 'boolean';
  return hasProcessContent || hasProcessStreaming;
}

export function shouldPreferIncomingMessageContent(
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

export function shouldPreferIncomingSupplementalContent(
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

export function shouldAllowTerminalProcessContentReplacement(incoming: Partial<ChatMessage>): boolean {
  return hasOwnMessageField(incoming, 'processContent')
    && hasOwnMessageField(incoming, 'processStreaming')
    && incoming.processStreaming === false;
}

export function mergeMessagePreservingContent(existing: ChatMessage, incoming: Partial<ChatMessage>): ChatMessage {
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

export function mergeMessagePatchPreservingContent(
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

export function mergeMessageCollectionPreservingContent(
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
