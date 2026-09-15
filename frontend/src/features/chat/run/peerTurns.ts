// 别的来源开始的一轮（另一个标签页发的、或自己排队后出队的）怎么进时间线：纯函数，带单测。
import type { ChatMessage } from '../../../utils/message-merge';

export type ChatTurnEcho = {
  clientTurnId: string | null;
  userMessageId: number | null;
  assistantMessageId: number | null;
  parentId: number | null;
  content: string;
  agentId: string | null;
  agentName: string | null;
  modelUsed: string | null;
  queued: boolean;
  createdAt: string | null;
};

export function parseChatTurnEcho(payload: any): ChatTurnEcho | null {
  if (!payload || typeof payload !== 'object') return null;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const assistantMessageId = num(payload.assistant_message_id);
  if (assistantMessageId === null) return null;
  return {
    clientTurnId: text(payload.client_turn_id),
    userMessageId: num(payload.user_message_id),
    assistantMessageId,
    parentId: num(payload.parent_id),
    content: text(payload.content) ?? '',
    agentId: text(payload.agent_id),
    agentName: text(payload.agent_name),
    modelUsed: text(payload.model_used),
    queued: payload.queued === true,
    createdAt: text(payload.created_at),
  };
}

/**
 * 回声 → 要补进时间线的两条消息；不需要补时返回 null：
 * - 这一轮是本标签页**立即发送**的（本地流已经有乐观气泡，靠 `ids` 帧换成真 id）；
 * - 两条消息都已经在时间线里（历史对账先到、或者重复回声）。
 * 本标签页排队的那一条出队时照样要补：排队期间它只在队列面板里，不在时间线里。
 */
export function planPeerTurnMessages(
  messages: Pick<ChatMessage, 'id'>[],
  echo: ChatTurnEcho,
  locallyStreamedRefs: ReadonlySet<string>,
  now: () => Date = () => new Date(),
): ChatMessage[] | null {
  if (echo.clientTurnId && locallyStreamedRefs.has(echo.clientTurnId)) return null;
  const known = new Set(messages.map((message) => message.id));
  const userId = echo.userMessageId !== null ? String(echo.userMessageId) : null;
  const assistantId = String(echo.assistantMessageId);
  const additions: ChatMessage[] = [];
  const timestamp = echo.createdAt ? new Date(echo.createdAt) : now();
  if (userId && !known.has(userId)) {
    additions.push({
      id: userId,
      role: 'user',
      content: echo.content,
      timestamp,
      parentId: echo.parentId !== null ? String(echo.parentId) : undefined,
    });
  }
  if (!known.has(assistantId)) {
    additions.push({
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp,
      model: echo.modelUsed ?? undefined,
      agentId: echo.agentId ?? undefined,
      agentName: echo.agentName ?? undefined,
      parentId: userId ?? undefined,
    });
  }
  return additions.length > 0 ? additions : null;
}
