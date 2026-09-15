/**
 * 出站 Webhook 的事件类型与负载。来源是业务事件总线（`core/events`）。
 *
 * - `chat.run.*` / `chat.tool.*` / `chat.approval.*`：运行协调器发出的运行事实（开始 / 完成 / 失败 / 中止、工具调用、审批），
 *   覆盖单聊、群聊外部成员与工作流节点（`summary.surface` 区分），发布点只在 `runtime/coordinator`；
 * - `workflow.run.*` 与 `workflow.node.approval_requested`：工作流（对方不对 HTTP 端点开放，我们开放）。
 *
 * 事件 id **由内容派生且稳定**：`sha256(type:subject:occurrence)` 取前 32 位。同一件事重投多少次都是同一个 id，
 * 接收方据此去重；outbox 也用它做 (端点, 事件) 唯一键，重复发布不会重复入队。
 */
import { createHash, createHmac } from 'crypto';

export const WEBHOOK_EVENT_TYPES = [
  'chat.run.started',
  'chat.run.completed',
  'chat.run.failed',
  'chat.run.aborted',
  'chat.tool.started',
  'chat.tool.completed',
  'chat.tool.failed',
  'chat.approval.requested',
  'chat.approval.resolved',
  'workflow.run.started',
  'workflow.run.completed',
  'workflow.run.completed_with_failures',
  'workflow.run.failed',
  'workflow.run.canceled',
  'workflow.node.approval_requested',
] as const;
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

export const WEBHOOK_TEST_EVENT_TYPE = 'webhook.test';
export const MAX_MESSAGE_TEXT_BYTES = 64 * 1024;

export type WebhookPayload = {
  schema_version: 1;
  id: string;
  type: string;
  occurred_at: string;
  source: 'chat' | 'workflow' | 'test';
  subject: Record<string, string>;
  summary: Record<string, string | number | null>;
  message?: { text: string; truncated: boolean };
};

export function stableEventId(type: string, subject: string, occurrence: string): string {
  return createHash('sha256').update(`${type}:${subject}:${occurrence}`).digest('hex').slice(0, 32);
}

/** 按 UTF-8 字节截断，不切坏多字节字符。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf-8'), truncated: true };
}

const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));

/** 业务事件 → Webhook 负载。认不出的类型返回 null（不外发）。`includeContent` 控制是否带正文。 */
export function buildWebhookPayload(type: string, payload: Record<string, unknown>, publishedAt: number, includeContent: boolean): WebhookPayload | null {
  const occurredAt = new Date(publishedAt).toISOString();
  if (type.startsWith('chat.')) {
    const sessionId = str(payload.sessionId);
    const runId = str(payload.runId);
    if (!sessionId || !runId) return null;
    const [, family, phase] = type.split('.');
    // 同一次运行里的多个工具调用 / 审批各是一件事：occurrence 带上调用 / 审批 id。
    const itemId = family === 'tool' ? str(payload.callId) : family === 'approval' ? str(payload.approvalId) : '';
    if (family !== 'run' && !itemId) return null;
    const result: WebhookPayload = {
      schema_version: 1,
      id: stableEventId(type, sessionId, itemId ? `${runId}:${itemId}` : runId),
      type,
      occurred_at: occurredAt,
      source: 'chat',
      subject: {
        session_id: sessionId,
        run_id: runId,
        agent_id: str(payload.agentId),
        ...(family === 'tool' ? { call_id: itemId } : {}),
        ...(family === 'approval' ? { approval_id: itemId } : {}),
      },
      summary: {
        status: phase ?? null,
        agent_name: str(payload.agentName) || null,
        runtime: str(payload.runtime) || null,
        surface: str(payload.surface) || null,
        error_kind: type === 'chat.run.failed' || type === 'chat.tool.failed' ? (str(payload.errorCode) || 'run_error') : null,
        ...(family === 'tool' ? { tool_name: str(payload.toolName) || null } : {}),
        ...(family === 'approval' && phase === 'resolved' ? { decision: str(payload.decision) || null } : {}),
      },
    };
    if (includeContent && type === 'chat.run.completed' && typeof payload.text === 'string') {
      result.message = truncateUtf8(payload.text, MAX_MESSAGE_TEXT_BYTES);
    }
    return result;
  }
  if (type.startsWith('workflow.')) {
    const workflowId = str(payload.workflowId);
    const runId = str(payload.runId);
    if (!workflowId || !runId) return null;
    const occurrence = type === 'workflow.node.approval_requested' ? `${runId}:${str(payload.executionId)}` : `${runId}:${str(payload.startedAt)}`;
    return {
      schema_version: 1,
      id: stableEventId(type, workflowId, occurrence),
      type,
      occurred_at: occurredAt,
      source: 'workflow',
      subject: {
        workflow_id: workflowId,
        run_id: runId,
        ...(payload.nodeId ? { workflow_node_id: str(payload.nodeId) } : {}),
        ...(payload.executionId ? { execution_id: str(payload.executionId) } : {}),
      },
      summary: {
        status: str(payload.status) || (type === 'workflow.node.approval_requested' ? 'requested' : null),
        workflow_name: str(payload.workflowName) || null,
        trigger: str(payload.triggerSource) || null,
        error_code: str(payload.errorCode) || null,
      },
    };
  }
  return null;
}

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
