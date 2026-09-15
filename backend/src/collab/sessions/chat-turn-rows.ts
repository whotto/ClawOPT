/**
 * 单聊一轮的「行」：用户行 + 助手占位行，以及它们在实时通道上的回声。
 *
 * 立即开始的一轮在路由里先落行再提交（与迁移前一致，SSE 的 `ids` 帧要先写）；
 * **排队的一轮在出队那一刻才落行**（协调器的 `beforeStart`）——否则用户行的 id 比正在跑的那一轮的助手行还小，
 * 时间线顺序就乱了。两条路共用这个持有者：投影器工厂与请求闭包都读它，出队时由 `beforeStart` 填上。
 *
 * 是类实例而不是普通对象：协调器对排队请求做快照深拷贝时只拷贝纯数据，类实例按引用保留。
 */
import type { DB } from '../../core/db';
import type { RealtimeHub } from '../../core/realtime';
import { chatSessionTopic } from './chat-stream';

/** 用户行落库后在 `session:<id>` 主题发的回声：其他标签页据此补上用户气泡与助手占位，发起方按 `clientTurnId` 认出自己。 */
export const CHAT_USER_MESSAGE_EVENT = 'chat.user_message';

export class ChatTurnRows {
  userMessageId: number | null = null;
  assistantMessageId = 0;
  runMarkerMessageIds: number[] = [];

  static of(rows: { userMessageId: number | null; assistantMessageId: number; runMarkerMessageIds: number[] }): ChatTurnRows {
    const holder = new ChatTurnRows();
    holder.userMessageId = rows.userMessageId;
    holder.assistantMessageId = rows.assistantMessageId;
    holder.runMarkerMessageIds = rows.runMarkerMessageIds;
    return holder;
  }

  get ready(): boolean {
    return this.assistantMessageId > 0;
  }
}

export type ChatTurnEcho = {
  sessionId: string;
  clientTurnId: string | null;
  userMessageId: number | null;
  assistantMessageId: number;
  parentId: number | null;
  content: string | null;
  agentId: string;
  agentName: string;
  modelUsed: string;
  queued: boolean;
};

/** 用户行 + 助手占位行（父子关系与迁移前一致：用户行挂在当前最新一行下面）。 */
export function persistChatTurnRows(
  db: Pick<DB, 'getMessages' | 'saveMessage'>,
  params: { sessionId: string; content: string; agentId: string; agentName: string; modelUsed: string; parentId?: number },
): { userMessageId: number; assistantMessageId: number; parentId: number | null } {
  let parentId = params.parentId;
  if (parentId === undefined) {
    const history = db.getMessages(params.sessionId, 1);
    parentId = history.length > 0 ? Number(history[history.length - 1].id) : undefined;
  }
  const userMessageId = Number(db.saveMessage({ session_key: params.sessionId, parent_id: parentId, role: 'user', content: params.content }));
  const assistantMessageId = Number(db.saveMessage({
    session_key: params.sessionId,
    parent_id: userMessageId,
    role: 'assistant',
    content: '',
    model_used: params.modelUsed,
    agent_id: params.agentId,
    agent_name: params.agentName,
  }));
  return { userMessageId, assistantMessageId, parentId: parentId ?? null };
}

export function publishChatTurnEcho(hub: RealtimeHub, echo: ChatTurnEcho, origin?: string): void {
  hub.publish({
    topic: chatSessionTopic(echo.sessionId),
    type: CHAT_USER_MESSAGE_EVENT,
    payload: {
      client_turn_id: echo.clientTurnId,
      user_message_id: echo.userMessageId,
      assistant_message_id: echo.assistantMessageId,
      parent_id: echo.parentId,
      content: echo.content,
      agent_id: echo.agentId,
      agent_name: echo.agentName,
      model_used: echo.modelUsed,
      queued: echo.queued,
      created_at: new Date().toISOString(),
    },
    origin,
  });
}

/** 前端生成的这一轮的引用 id：只收短的安全字符，其余一律忽略（它只用于认领 / 去重，不进库）。 */
export function readClientTurnId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{6,80}$/.test(trimmed) ? trimmed : null;
}
