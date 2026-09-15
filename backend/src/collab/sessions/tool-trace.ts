/**
 * 单聊的工具轨迹（P1b）：按运行分组的工具调用摘要，给助手消息下方的「N 个工具 · 名字…」卡片用。
 *
 * 数据来自协调器原子落库的 `run_tool_calls`（有调用必有结果）；消息 → 运行靠 `chat_messages.run_marker`。
 * 线上只给截断后的参数与结果（`truncateForWire`：JSON 按结构截、diff 不按 1000 截），完整内容按调用 id 另取（复制完整内容）。
 */
import type Database from 'better-sqlite3';

import { previewToolArguments, truncateForWire } from '../../runtime';

export const TOOL_TRACE_MAX_MESSAGES = 200;

export type ToolTraceCall = {
  id: number;
  callId: string;
  name: string;
  status: 'completed' | 'failed' | 'interrupted' | null;
  durationMs: number | null;
  preview: string;
  arguments: { text: string; truncated: boolean; originalLength: number; format: string };
  output: { text: string; truncated: boolean; originalLength: number; format: string } | null;
};

export type ToolTraceRun = { messageId: number; runMarker: string; calls: ToolTraceCall[] };

type ToolRow = { id: number; run_marker: string; call_id: string; name: string; arguments: string; output: string | null; status: string | null; started_at: number | null; completed_at: number | null };

export function parseMessageIdList(raw: unknown): number[] {
  const text = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  return [...new Set(text.split(',').map((part) => Number(part.trim())).filter((id) => Number.isInteger(id) && id > 0))].slice(0, TOOL_TRACE_MAX_MESSAGES);
}

function toCall(row: ToolRow): ToolTraceCall {
  const status = row.status === 'completed' || row.status === 'failed' || row.status === 'interrupted' ? row.status : null;
  return {
    id: row.id,
    callId: row.call_id,
    name: row.name,
    status,
    durationMs: row.started_at && row.completed_at && row.completed_at >= row.started_at ? row.completed_at - row.started_at : null,
    preview: previewToolArguments(row.arguments),
    arguments: truncateForWire(row.arguments),
    output: row.output === null ? null : truncateForWire(row.output),
  };
}

/** 这些助手消息所在运行的工具调用（只查属于这个会话的行）。 */
export function listToolTraces(db: Database.Database, sessionKey: string, messageIds: number[]): ToolTraceRun[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => '?').join(',');
  const messages = db.prepare(`SELECT id, run_marker FROM chat_messages WHERE session_key = ? AND id IN (${placeholders}) AND run_marker IS NOT NULL`)
    .all(sessionKey, ...messageIds) as Array<{ id: number; run_marker: string }>;
  if (messages.length === 0) return [];
  const markers = [...new Set(messages.map((message) => message.run_marker))];
  const rows = db.prepare(`SELECT id, run_marker, call_id, name, arguments, output, status, started_at, completed_at FROM run_tool_calls WHERE session_key = ? AND run_marker IN (${markers.map(() => '?').join(',')}) ORDER BY id ASC`)
    .all(sessionKey, ...markers) as ToolRow[];
  const byMarker = new Map<string, ToolTraceCall[]>();
  for (const row of rows) {
    const list = byMarker.get(row.run_marker) ?? [];
    list.push(toCall(row));
    byMarker.set(row.run_marker, list);
  }
  return messages
    .filter((message) => byMarker.has(message.run_marker))
    .map((message) => ({ messageId: message.id, runMarker: message.run_marker, calls: byMarker.get(message.run_marker)! }));
}

/** 按行 id 取完整参数与结果（复制完整内容）；不属于这个会话按不存在。 */
export function getToolCallFull(db: Database.Database, sessionKey: string, id: number): { name: string; arguments: string; output: string | null } | null {
  const row = db.prepare('SELECT name, arguments, output FROM run_tool_calls WHERE session_key = ? AND id = ?').get(sessionKey, id) as { name: string; arguments: string; output: string | null } | undefined;
  return row ?? null;
}
