/**
 * 网关聊天运行的协议级辅助：会话键、终态文本判定、断线判定、中止与重试。
 *
 * 这些原先散在 collab/sessions 里（chat-lifecycle / chat-run-managers / session-runtime），
 * 但它们只和网关协议有关、和单聊页面无关。P1a 把 OpenClaw 运行链路做成 runtime 下的适配器，
 * 适配器按模块边界只能依赖 openclaw 与 core，于是它们回到 openclaw 模块。
 */
import { normalizeCliText, selectPreferredTextSnapshot } from '../core/util';
import { isNonTerminalAssistantMessage } from './chat-history-reconciliation';
import { extractOpenClawMessageText } from './openclaw-client';

/** 单聊运行用到的网关客户端能力。真客户端是 OpenClawClient；测试用假网关实现同一组方法。 */
export interface GatewayChatClient {
  connect(): Promise<void>;
  subscribeSessionEvents(): Promise<void>;
  unsubscribeSessionEvents(): Promise<void>;
  getChatHistory(sessionKey: string, limit?: number): Promise<any>;
  sendChatMessageStreaming(params: {
    sessionKey: string;
    message: string;
    agentId?: string;
    attachments?: { type: string; mimeType: string; content: string }[];
  }): Promise<{ runId: string; sessionKey: string }>;
  waitForRun(runId: string, timeoutMs?: number): Promise<void>;
  abortChat(params: { sessionKey: string; runId?: string; timeoutMs?: number }): Promise<{ aborted: boolean; runIds?: string[] }>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/** 一次 chat.abort 的时限。 */
export const OPENCLAW_CHAT_ABORT_TIMEOUT_MS = 5000;
/** abort 没成功时的重试间隔。 */
export const OPENCLAW_CHAT_ABORT_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];
/** 对账读 chat.history 的条数。 */
export const OPENCLAW_CHAT_HISTORY_PROBE_LIMIT = 60;

export function buildOpenClawChatSessionKey(sessionId: string, agentId: string): string {
  return sessionId.startsWith('agent:') ? sessionId : `agent:${agentId}:chat:${sessionId}`;
}

export function resolveChatFinalTextSnapshot(text: string, message: any): string {
  if (isNonTerminalAssistantMessage(message)) {
    return '';
  }
  return selectPreferredTextSnapshot(text, extractOpenClawMessageText(message));
}

export function isRecoverableGatewayDisconnectDetail(detail?: string | null): boolean {
  const normalized = normalizeCliText(detail);
  if (!normalized) return false;
  return /Client disconnected|connection is not open|ECONNREFUSED|ECONNRESET|EPIPE|gateway connect timeout|Gateway connect failed|WebSocket/i.test(normalized);
}

export function scheduleOpenClawSessionAbortRetry(
  client: Pick<GatewayChatClient, 'abortChat'>,
  sessionKey: string,
  context: string,
  attempt = 0,
) {
  if (attempt >= OPENCLAW_CHAT_ABORT_RETRY_DELAYS_MS.length) {
    console.warn(`[chat] Exhausted OpenClaw abort retries for ${context} (${sessionKey}).`);
    return;
  }

  const delay = OPENCLAW_CHAT_ABORT_RETRY_DELAYS_MS[attempt];
  const timer = setTimeout(() => {
    void client.abortChat({
      sessionKey,
      timeoutMs: OPENCLAW_CHAT_ABORT_TIMEOUT_MS,
    }).then((result) => {
      if (result.aborted) {
        return;
      }
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context, attempt + 1);
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[chat] OpenClaw abort retry ${attempt + 1} failed for ${context} (${sessionKey}): ${detail}`);
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context, attempt + 1);
    });
  }, delay);
  timer.unref?.();
}

export async function abortOpenClawSessionRuns(
  client: Pick<GatewayChatClient, 'abortChat'>,
  sessionKey: string,
  context: string,
  options?: { retryOnMiss?: boolean },
): Promise<{ aborted: boolean; runIds: string[] }> {
  try {
    const result = await client.abortChat({
      sessionKey,
      timeoutMs: OPENCLAW_CHAT_ABORT_TIMEOUT_MS,
    });
    const runIds = Array.isArray(result.runIds) ? result.runIds : [];
    if (!result.aborted && options?.retryOnMiss) {
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context);
    }
    return {
      aborted: result.aborted,
      runIds,
    };
  } catch (error) {
    console.warn(`[chat] Failed to abort orphan OpenClaw runs for ${context} (${sessionKey}):`, error);
    if (options?.retryOnMiss) {
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context);
    }
    return {
      aborted: false,
      runIds: [],
    };
  }
}
