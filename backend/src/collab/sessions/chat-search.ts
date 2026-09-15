/**
 * 单聊全文检索（Ctrl/Cmd+K）：索引维护与排序查询。表与触发器在 `core/db/chat-search-schema.ts`。
 *
 * ## 查询语义
 * - 查询串按空白切词，去掉纯标点 / 符号，大小写不敏感去重，最多 20 个词；**每个词都要命中**（AND）。
 * - 词长 ≥3 个字符走 FTS5（trigram，子串语义，中日韩不用分词）；<3 个字符 trigram 无法索引，改走转义过的 `LIKE`。
 * - 用户输入**永远不会变成 FTS 运算符**：每个词都作为双引号短语字面量（内部引号加倍），`NEAR` / `*` / `-` / `:` 都是普通字符。
 * - 排序：会话名与查询完全相同（0）> 会话名包含全部词（1）> 某条消息包含全部词（2，按 bm25，再按新近）。
 *   每个会话只出一行；消息命中带 `matchedMessageId` 与片段，前端据此跳到那条消息。
 * - **可见性过滤在排序查询里面**（`visibleSessionIds` 进 SQL），看不见的会话不会占掉 limit。
 *
 * ## 索引维护
 * 触发器只把变过的消息 id 记进 `chat_search_dirty`；检索前与启动一次性任务里 `flushChatSearchIndex` 批量刷。
 * 结构化的会话命令结果（`⌘ ` 前缀）与运行错误（`❌ Error: ` 前缀）、非 user / assistant 行不进索引。
 */
import type Database from 'better-sqlite3';

import { CHAT_RUN_ERROR_PREFIX } from './chat-constants';
import { CHAT_COMMAND_RESULT_PREFIX } from './chat-command-result';

export const CHAT_SEARCH_MAX_TERMS = 20;
export const CHAT_SEARCH_MAX_TERM_CHARS = 200;
export const CHAT_SEARCH_DEFAULT_LIMIT = 10;
export const CHAT_SEARCH_MAX_LIMIT = 50;
export const CHAT_SEARCH_RECENT_DEFAULT_LIMIT = 8;
/** 进索引的正文上限（字符）。超长消息只索引前一段——检索是找会话，不是全文取证。 */
export const CHAT_SEARCH_INDEX_MAX_CHARS = 200_000;
/** 生成片段时最多读这么多正文。 */
const SNIPPET_SOURCE_MAX_CHARS = 262_144;
const SNIPPET_BEFORE = 30;
const SNIPPET_LENGTH = 160;
/** 只有短词（全部 <3 字符）时是扫表，最多看这么多条（最新的在前，已按可见性过滤）。 */
const SHORT_QUERY_SCAN_LIMIT = 5000;
const FLUSH_BATCH = 500;

const INDEXABLE_ROLES = new Set(['user', 'assistant']);

export interface ChatSearchResult {
  sessionId: string;
  sessionName: string;
  matchedField: 'title' | 'message';
  matchedMessageId: number | null;
  /**
   * 跳到这条消息时历史分页用的 `beforeId`：这条消息之后的第一条用户消息 id（没有则 null = 最新一页）。
   * 与会话内搜索（`/api/history/:id/search`）的 `anchorBeforeId` 同一语义，前端复用同一套跳转。
   */
  anchorBeforeId: number | null;
  snippet: string;
  role: string | null;
  timestamp: string | null;
}

export interface ChatRecentSession {
  sessionId: string;
  sessionName: string;
  timestamp: string | null;
}

export function isIndexableChatMessage(role: string | null | undefined, content: string | null | undefined): boolean {
  if (!role || !INDEXABLE_ROLES.has(role) || !content) return false;
  if (content.startsWith(CHAT_COMMAND_RESULT_PREFIX) || content.startsWith(CHAT_RUN_ERROR_PREFIX)) return false;
  return content.trim().length > 0;
}

/**
 * 与 `isIndexableChatMessage` 同一判据的 SQL 版（只有短词时的扫表路径用；FTS 路径天然只命中进过索引的行）。
 * 按需构造：前缀常量所在的模块与本文件在 barrel 里有加载顺序环，模块顶层读它们可能还是 undefined。
 */
function indexableSql(): string {
  const prefixCheck = (prefix: string) => `substr(m.content, 1, ${[...prefix].length}) <> '${prefix.replace(/'/g, "''")}'`;
  return `m.role IN ('user', 'assistant') AND ${prefixCheck(CHAT_COMMAND_RESULT_PREFIX)} AND ${prefixCheck(CHAT_RUN_ERROR_PREFIX)}`;
}

const PURE_PUNCTUATION = /^[\p{P}\p{S}]+$/u;

export function parseChatSearchTerms(query: unknown): string[] {
  if (typeof query !== 'string') return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const term = [...raw].slice(0, CHAT_SEARCH_MAX_TERM_CHARS).join('');
    if (!term || PURE_PUNCTUATION.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= CHAT_SEARCH_MAX_TERMS) break;
  }
  return terms;
}

const charLength = (value: string) => [...value].length;
export const isFtsTerm = (term: string) => charLength(term) >= 3;

/** FTS5 MATCH 表达式：每个词都是双引号短语字面量，AND 连接。没有 ≥3 字符的词返回 null。 */
export function buildChatSearchMatchExpression(terms: string[]): string | null {
  const phrases = terms.filter(isFtsTerm).map((term) => `"${term.replace(/"/g, '""')}"`);
  return phrases.length > 0 ? phrases.join(' AND ') : null;
}

export function escapeLikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** 把脏表里的消息刷进 FTS。返回处理的条数。 */
export function flushChatSearchIndex(sql: Database.Database): number {
  const select = sql.prepare(`
    SELECT d.message_id AS id, m.role AS role, substr(m.content, 1, ?) AS content
    FROM chat_search_dirty d LEFT JOIN chat_messages m ON m.id = d.message_id
    ORDER BY d.message_id LIMIT ?
  `);
  const removeIndexed = sql.prepare('DELETE FROM chat_search_fts WHERE rowid = ?');
  const insertIndexed = sql.prepare('INSERT INTO chat_search_fts(rowid, body) VALUES (?, ?)');
  const clearDirty = sql.prepare('DELETE FROM chat_search_dirty WHERE message_id = ?');
  const batch = sql.transaction((rows: Array<{ id: number; role: string | null; content: string | null }>) => {
    for (const row of rows) {
      removeIndexed.run(row.id);
      if (isIndexableChatMessage(row.role, row.content)) insertIndexed.run(row.id, row.content);
      clearDirty.run(row.id);
    }
  });
  let total = 0;
  for (;;) {
    const rows = select.all(CHAT_SEARCH_INDEX_MAX_CHARS, FLUSH_BATCH) as Array<{ id: number; role: string | null; content: string | null }>;
    if (rows.length === 0) return total;
    batch(rows);
    total += rows.length;
  }
}

/** 整个索引从头重建（启动一次性任务；重复跑结果相同）。 */
export function rebuildChatSearchIndex(sql: Database.Database): { messages: number; sessions: number } {
  const sessions = sql.transaction(() => {
    sql.exec("INSERT INTO chat_search_fts(chat_search_fts) VALUES ('delete-all')");
    sql.exec('DELETE FROM chat_search_title_fts');
    const inserted = sql.prepare('INSERT INTO chat_search_title_fts(name, session_id) SELECT name, id FROM sessions').run().changes;
    sql.exec('INSERT OR IGNORE INTO chat_search_dirty(message_id) SELECT id FROM chat_messages');
    return inserted;
  })();
  return { messages: flushChatSearchIndex(sql), sessions };
}

/** 片段：第一个命中词附近的一小段（空白折叠），有界。 */
export function buildChatSearchSnippet(content: string | null | undefined, terms: string[]): string {
  const source = String(content ?? '').slice(0, SNIPPET_SOURCE_MAX_CHARS);
  const firstHit = (text: string) => {
    const lower = text.toLowerCase();
    let index = -1;
    for (const term of terms) {
      const found = lower.indexOf(term.toLowerCase());
      if (found >= 0 && (index < 0 || found < index)) index = found;
    }
    return index;
  };
  const rawHit = firstHit(source);
  const rawStart = rawHit < 0 ? 0 : Math.max(0, rawHit - SNIPPET_BEFORE * 8);
  const rawEnd = rawStart + SNIPPET_LENGTH * 8;
  const window = source.slice(rawStart, rawEnd).replace(/\s+/g, ' ');
  const hit = firstHit(window);
  const chars = [...window];
  const hitChar = hit < 0 ? 0 : [...window.slice(0, hit)].length;
  const start = Math.max(0, hitChar - SNIPPET_BEFORE);
  const body = chars.slice(start, start + SNIPPET_LENGTH).join('');
  const prefix = rawStart > 0 || start > 0 ? '…' : '';
  const suffix = start + SNIPPET_LENGTH < chars.length || rawEnd < source.length ? '…' : '';
  return `${prefix}${rawStart > 0 || start > 0 ? body.trimStart() : body.trim()}${suffix}`.trimEnd();
}

function clampLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(CHAT_SEARCH_MAX_LIMIT, Math.floor(parsed));
}

const normalizeTitle = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

export function searchChats(sql: Database.Database, options: { query: string; visibleSessionIds: string[]; limit?: unknown }): { terms: string[]; results: ChatSearchResult[] } {
  const terms = parseChatSearchTerms(options.query);
  if (terms.length === 0 || options.visibleSessionIds.length === 0) return { terms, results: [] };
  const limit = clampLimit(options.limit, CHAT_SEARCH_DEFAULT_LIMIT);
  flushChatSearchIndex(sql);

  const visible = JSON.stringify(options.visibleSessionIds);
  const match = buildChatSearchMatchExpression(terms);
  const shortTerms = terms.filter((term) => !isFtsTerm(term));

  // ---- 会话名：包含全部词 ----
  const titleLikes = shortTerms.map(() => "s.name LIKE ? ESCAPE '\\'").join(' AND ');
  const titleRows = sql.prepare(`
    SELECT s.id AS id, s.name AS name,
      (SELECT MAX(id) FROM chat_messages WHERE session_key = s.id) AS last_id,
      (SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MAX(created_at)) FROM chat_messages WHERE session_key = s.id) AS last_at,
      s.updated_at AS updated_at
    FROM sessions s
    WHERE s.id IN (SELECT value FROM json_each(?))
      ${match ? 'AND s.id IN (SELECT session_id FROM chat_search_title_fts WHERE chat_search_title_fts MATCH ?)' : ''}
      ${titleLikes ? `AND ${titleLikes}` : ''}
  `).all(visible, ...(match ? [match] : []), ...shortTerms.map(escapeLikePattern)) as Array<{ id: string; name: string; last_id: number | null; last_at: string | null; updated_at: string }>;

  const exact = normalizeTitle(terms.join(' '));
  const titleResults = titleRows
    .map((row) => ({ row, tier: normalizeTitle(row.name) === exact ? 0 : 1 }))
    .sort((a, b) => a.tier - b.tier || (b.row.last_id ?? 0) - (a.row.last_id ?? 0) || String(b.row.updated_at).localeCompare(String(a.row.updated_at)))
    .slice(0, limit)
    .map(({ row }): ChatSearchResult => ({
      sessionId: row.id,
      sessionName: row.name,
      matchedField: 'title',
      matchedMessageId: null,
      anchorBeforeId: null,
      snippet: row.name,
      role: null,
      timestamp: row.last_at,
    }));

  const remaining = limit - titleResults.length;
  if (remaining <= 0) return { terms, results: titleResults };

  // ---- 消息：包含全部词，每个会话取最好的一条 ----
  const likes = shortTerms.map(() => "m.content LIKE ? ESCAPE '\\'");
  const hits = match
    ? `SELECT m.id AS message_id, m.session_key AS session_key, bm25(chat_search_fts) AS score
       FROM chat_search_fts JOIN chat_messages m ON m.id = chat_search_fts.rowid
       WHERE chat_search_fts MATCH ?
         AND m.session_key IN (SELECT value FROM json_each(?))
         ${likes.length ? `AND ${likes.join(' AND ')}` : ''}`
    : `SELECT m.id AS message_id, m.session_key AS session_key, 0 AS score
       FROM chat_messages m
       WHERE m.session_key IN (SELECT value FROM json_each(?))
         AND ${indexableSql()}
         AND ${likes.join(' AND ')}
       ORDER BY m.id DESC LIMIT ${SHORT_QUERY_SCAN_LIMIT}`;
  const titleSessionIds = JSON.stringify(titleResults.map((result) => result.sessionId));
  const messageRows = sql.prepare(`
    WITH hits AS (${hits}),
    ranked AS (
      SELECT message_id, session_key, score,
        ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY score ASC, message_id DESC) AS rn
      FROM hits
      WHERE session_key NOT IN (SELECT value FROM json_each(?))
    )
    SELECT r.message_id AS message_id, r.session_key AS session_key, s.name AS name, m.role AS role,
      substr(m.content, 1, ${SNIPPET_SOURCE_MAX_CHARS}) AS content,
      strftime('%Y-%m-%dT%H:%M:%SZ', m.created_at) AS created_at,
      (SELECT MIN(n.id) FROM chat_messages n WHERE n.session_key = r.session_key AND n.id > r.message_id AND n.role = 'user') AS anchor_before_id
    FROM ranked r
      JOIN chat_messages m ON m.id = r.message_id
      JOIN sessions s ON s.id = r.session_key
    WHERE r.rn = 1
    ORDER BY r.score ASC, r.message_id DESC
    LIMIT ?
  `).all(
    ...(match ? [match, visible] : [visible]),
    ...shortTerms.map(escapeLikePattern),
    titleSessionIds,
    remaining,
  ) as Array<{ message_id: number; session_key: string; name: string; role: string; content: string; created_at: string | null; anchor_before_id: number | null }>;

  return {
    terms,
    results: [
      ...titleResults,
      ...messageRows.map((row): ChatSearchResult => ({
        sessionId: row.session_key,
        sessionName: row.name,
        matchedField: 'message',
        matchedMessageId: row.message_id,
        anchorBeforeId: row.anchor_before_id ?? null,
        snippet: buildChatSearchSnippet(row.content, terms),
        role: row.role,
        timestamp: row.created_at,
      })),
    ],
  };
}

/** 查询为空时的「最近会话」：按最后一条消息排序（没有消息的按更新时间，排在后面）。 */
export function listRecentChatSessions(sql: Database.Database, options: { visibleSessionIds: string[]; limit?: unknown }): ChatRecentSession[] {
  if (options.visibleSessionIds.length === 0) return [];
  const limit = clampLimit(options.limit, CHAT_SEARCH_RECENT_DEFAULT_LIMIT);
  const rows = sql.prepare(`
    SELECT s.id AS id, s.name AS name,
      (SELECT MAX(id) FROM chat_messages WHERE session_key = s.id) AS last_id,
      (SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MAX(created_at)) FROM chat_messages WHERE session_key = s.id) AS last_at,
      s.updated_at AS updated_at
    FROM sessions s
    WHERE s.id IN (SELECT value FROM json_each(?))
    ORDER BY last_id IS NULL, last_id DESC, s.updated_at DESC
    LIMIT ?
  `).all(JSON.stringify(options.visibleSessionIds), limit) as Array<{ id: string; name: string; last_at: string | null; updated_at: string }>;
  return rows.map((row) => ({ sessionId: row.id, sessionName: row.name, timestamp: row.last_at ?? row.updated_at ?? null }));
}
