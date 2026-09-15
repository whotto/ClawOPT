/**
 * 单聊导出（P1b）：完整 JSON（原始消息行 + 工具调用 + 用量汇总）或 Markdown 文字记录。
 *
 * - **流式、有界**：消息按自增 id 每批 500 行读、边读边写，不把整段历史读进内存；
 *   单个字段超过 256 KB 截断并标 `truncated`，总行数超过 20000 停在那里并在结果里说明。
 * - **不带本机坐标**：会话元数据只给 id / Agent 名 / 标题 / 运行时 / 血缘，不给工作目录、续话句柄、
 *   外部配置（这些是本机环境，不是对话内容）；消息正文原样（它本来就是用户在界面上看到的东西）。
 * - 文件名 = 清洗后的标题 + 会话 id 前 8 位；Content-Disposition 同时给 ASCII 兜底与 RFC 5987 UTF-8 名。
 */
import type Database from 'better-sqlite3';
import type express from 'express';

import type { SessionRow } from '../../core/db';
import { parseCommandResultContent } from './chat-command-result';
import type { SessionMeta } from './session-org-store';

export const EXPORT_BATCH_ROWS = 500;
export const EXPORT_MAX_ROWS = 20_000;
export const EXPORT_MAX_FIELD_CHARS = 256 * 1024;
export const EXPORT_MAX_TOOL_CALLS = 5_000;

export type ExportFormat = 'json' | 'markdown';

export function parseExportFormat(raw: unknown): ExportFormat | null {
  const value = String(raw ?? 'json').toLowerCase();
  if (value === 'json') return 'json';
  if (value === 'md' || value === 'markdown') return 'markdown';
  return null;
}

/** 文件名主体：去掉路径分隔与控制字符、空白换成 `-`、≤60 字符；空了用 `conversation`。 */
export function buildExportFilename(title: string | null | undefined, sessionId: string, format: ExportFormat): string {
  const base = String(title ?? '')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const stem = [...base].slice(0, 60).join('') || 'conversation';
  const shortId = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'session';
  return `${stem}-${shortId}.${format === 'json' ? 'json' : 'md'}`;
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function clip(value: string | null | undefined): { text: string | null; truncated: boolean } {
  if (value === null || value === undefined) return { text: null, truncated: false };
  if (value.length <= EXPORT_MAX_FIELD_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, EXPORT_MAX_FIELD_CHARS), truncated: true };
}

type MessageRow = {
  id: number;
  parent_id: number | null;
  role: string;
  content: string;
  process_content: string | null;
  model_used: string | null;
  agent_id: string | null;
  agent_name: string | null;
  run_marker: string | null;
  created_at: string;
};

function* messageBatches(db: Database.Database, sessionId: string): Generator<MessageRow[]> {
  const select = db.prepare(`
    SELECT id, parent_id, role, content, process_content, model_used, agent_id, agent_name, run_marker,
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at
    FROM chat_messages WHERE session_key = ? AND id > ? ORDER BY id ASC LIMIT ?
  `);
  let after = 0;
  let total = 0;
  while (total < EXPORT_MAX_ROWS) {
    const rows = select.all(sessionId, after, Math.min(EXPORT_BATCH_ROWS, EXPORT_MAX_ROWS - total)) as MessageRow[];
    if (rows.length === 0) return;
    yield rows;
    total += rows.length;
    after = rows[rows.length - 1].id;
  }
}

function hasRowsBeyondCap(db: Database.Database, sessionId: string): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_key = ?').get(sessionId) as { n: number };
  return row.n > EXPORT_MAX_ROWS;
}

export type ExportSource = {
  db: Database.Database;
  session: SessionRow;
  meta: SessionMeta | null;
  now?: () => Date;
};

function sessionHeader(source: ExportSource) {
  const { session, meta } = source;
  return {
    id: session.id,
    agentId: session.agentId,
    agentName: session.name,
    title: meta?.title ?? null,
    runtime: session.external_runtime || 'openclaw',
    parentSessionId: meta?.parentSessionId ?? null,
    forkPointMessageId: meta?.forkPointMessageId ?? null,
  };
}

function usageSummary(db: Database.Database, sessionId: string) {
  return db.prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens, SUM(cost_usd) AS costUsd
    FROM session_usage WHERE session_key = ?
  `).get(sessionId) as Record<string, number | null>;
}

/** 写 JSON 导出。按批 `write`，调用方负责响应头。 */
export function writeJsonExport(out: { write(chunk: string): unknown }, source: ExportSource): void {
  const { db, session } = source;
  const exportedAt = (source.now?.() ?? new Date()).toISOString();
  out.write(`{"format":"clawopt.chat-export","version":1,"exportedAt":${JSON.stringify(exportedAt)},"session":${JSON.stringify(sessionHeader(source))},"messages":[`);
  let first = true;
  for (const batch of messageBatches(db, session.id)) {
    const parts = batch.map((row) => {
      const content = clip(row.content);
      const process = clip(row.process_content);
      return JSON.stringify({
        id: row.id,
        parentId: row.parent_id,
        role: row.role,
        content: content.text,
        processContent: process.text,
        ...(content.truncated || process.truncated ? { truncated: true } : {}),
        modelUsed: row.model_used,
        agentId: row.agent_id,
        agentName: row.agent_name,
        runMarker: row.run_marker,
        createdAt: row.created_at,
      });
    });
    out.write(`${first ? '' : ','}${parts.join(',')}`);
    first = false;
  }
  out.write('],"toolCalls":[');
  const tools = db.prepare(`
    SELECT run_marker, call_id, name, arguments, output, status, started_at, completed_at
    FROM run_tool_calls WHERE session_key = ? ORDER BY id ASC LIMIT ?
  `).all(session.id, EXPORT_MAX_TOOL_CALLS) as Array<{ run_marker: string; call_id: string; name: string; arguments: string; output: string | null; status: string | null; started_at: number | null; completed_at: number | null }>;
  out.write(tools.map((tool) => {
    const args = clip(tool.arguments);
    const output = clip(tool.output);
    return JSON.stringify({
      runMarker: tool.run_marker,
      callId: tool.call_id,
      name: tool.name,
      arguments: args.text,
      output: output.text,
      ...(args.truncated || output.truncated ? { truncated: true } : {}),
      status: tool.status,
      startedAt: tool.started_at,
      completedAt: tool.completed_at,
    });
  }).join(','));
  out.write(`],"usage":${JSON.stringify(usageSummary(db, session.id))},"limits":${JSON.stringify({ messagesTruncated: hasRowsBeyondCap(db, session.id), maxMessages: EXPORT_MAX_ROWS, maxFieldChars: EXPORT_MAX_FIELD_CHARS })}}`);
}

const ROLE_LABEL: Record<string, string> = { user: 'User', assistant: 'Assistant', system: 'System' };

/** Markdown 文字记录：一条消息一节，结构化命令结果用它的英文兜底句（导出文件不随界面语言变）。 */
export function writeMarkdownExport(out: { write(chunk: string): unknown }, source: ExportSource): void {
  const { db, session, meta } = source;
  const header = sessionHeader(source);
  const exportedAt = (source.now?.() ?? new Date()).toISOString();
  const lines = [
    `# ${meta?.title || session.name || session.id}`,
    '',
    `- Agent: ${header.agentName} (${header.runtime})`,
    `- Session: ${header.id}`,
    ...(header.parentSessionId ? [`- Forked from: ${header.parentSessionId}`] : []),
    `- Exported: ${exportedAt}`,
    '',
  ];
  out.write(`${lines.join('\n')}\n`);
  for (const batch of messageBatches(db, session.id)) {
    out.write(batch.map((row) => {
      const who = row.role === 'user' ? ROLE_LABEL.user : `${ROLE_LABEL[row.role] ?? row.role}${row.agent_name ? ` · ${row.agent_name}` : ''}`;
      const structured = parseCommandResultContent(row.content);
      const body = clip(structured ? structured.fallbackText : row.content);
      return `## ${who} · ${row.created_at}\n\n${body.text ?? ''}${body.truncated ? '\n\n_[truncated]_' : ''}\n\n`;
    }).join(''));
  }
  if (hasRowsBeyondCap(db, session.id)) out.write(`_[Only the first ${EXPORT_MAX_ROWS} messages were exported.]_\n`);
}

export function sendSessionExport(res: express.Response, source: ExportSource, format: ExportFormat): void {
  const filename = buildExportFilename(source.meta?.title || source.session.name, source.session.id, format);
  res.status(200);
  res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (format === 'json') writeJsonExport(res, source);
  else writeMarkdownExport(res, source);
  res.end();
}
