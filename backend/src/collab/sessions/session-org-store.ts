/**
 * 单聊会话的组织与元数据（P1b）：分类、归档、对话标题、来历（人建 / 诊断 / 自动化）、分叉血缘。
 *
 * ## 为什么不加在 sessions 表上
 *
 * ClawOPT 的单聊会话 = 一个 Agent 的一条连续对话，`sessions` 行是**全局**的（名字是 Agent 显示名，
 * 建改删会装配 / 撤销 Agent，只有管理员能动）。「怎么整理侧栏」却是**每个人自己的事**：
 * member 看到的是过滤过的列表，按它去改一份全局状态，会把别人的整理弄乱（侧栏收藏吃过这个亏）。
 * 所以分类与归档按用户存（`owner_key`），对话标题、来历、血缘跟着会话走（全局一份），全部在本文件的表里，
 * `sessions` 行与 `db.ts` 一个字都不动；会话被删时由 `SessionManager` 的 `sessionDeleted` 事件清理。
 *
 * ## 表
 *
 * - `session_categories(id, owner_key, name, name_key)`：`name_key` = 空白折叠 + 小写，(owner_key, name_key) 唯一；
 * - `session_org(owner_key, session_id, category_id, archived)`：每人每会话一行，没有行 = 未分类、未归档；
 * - `session_meta(session_id, title, title_source, origin, parent_session_id, fork_point_message_id)`。
 */
import type Database from 'better-sqlite3';

export const CATEGORY_NAME_MAX_CHARS = 40;
export const SESSION_TITLE_MAX_CHARS = 120;
export const AUTO_TITLE_MAX_CHARS = 60;

/** 对话标题从哪来。优先级 manual > runtime > auto：运行时提议只替换自动标题，手动改名永远赢。 */
export type SessionTitleSource = 'auto' | 'runtime' | 'manual';
/** 会话是谁建的。只有 human 出现在「只看人建的」筛选里。 */
export type SessionOrigin = 'human' | 'diagnosis' | 'automation';

export type SessionCategory = { id: number; name: string; createdAt: number; updatedAt: number };
export type SessionOrgEntry = { categoryId: number | null; archived: boolean };
export type SessionMeta = {
  title: string | null;
  titleSource: SessionTitleSource | null;
  origin: SessionOrigin | null;
  parentSessionId: string | null;
  forkPointMessageId: number | null;
};

export function applySessionOrgSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_key TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (owner_key, name_key)
    );

    CREATE TABLE IF NOT EXISTS session_org (
      owner_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      category_id INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_key, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_org_category ON session_org(owner_key, category_id);

    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      title TEXT,
      title_source TEXT CHECK (title_source IN ('auto', 'runtime', 'manual')),
      origin TEXT CHECK (origin IN ('human', 'diagnosis', 'automation')),
      parent_session_id TEXT,
      fork_point_message_id INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** 登录关闭（单用户部署）时的隐式所有者，与用户 id 的形状分开，免得撞上某个真实用户。 */
export const IMPLICIT_OWNER_KEY = 'owner';

export function sessionOrgOwnerKey(identity: { userId: number | null }): string {
  return identity.userId === null ? IMPLICIT_OWNER_KEY : `user:${identity.userId}`;
}

export type CategoryNameResult = { ok: true; name: string; key: string } | { ok: false; reason: 'empty' | 'tooLong' };

/** 分类名：空白折叠、去首尾空白、≤40 字符；唯一性按小写比较。 */
export function normalizeCategoryName(raw: unknown): CategoryNameResult {
  const name = String(typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'empty' };
  if ([...name].length > CATEGORY_NAME_MAX_CHARS) return { ok: false, reason: 'tooLong' };
  return { ok: true, name, key: name.toLowerCase() };
}

const SOURCE_RANK: Record<SessionTitleSource, number> = { auto: 0, runtime: 1, manual: 2 };

/**
 * 标题更新的唯一判据。返回 null 表示不改。
 * - manual 永远写（包括改回和自动标题一样的文字——来源从此是 manual）；
 * - runtime 只替换「没有标题 / 自动标题 / 上一次运行时提议」；
 * - auto 只在没有标题时写。
 */
export function resolveTitleUpdate(
  current: { title: string | null; titleSource: SessionTitleSource | null },
  candidate: { title: string; source: SessionTitleSource },
): { title: string; titleSource: SessionTitleSource } | null {
  const title = candidate.title.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_MAX_CHARS);
  if (!title) return null;
  if (candidate.source === 'manual') return { title, titleSource: 'manual' };
  if (!current.title || !current.titleSource) return { title, titleSource: candidate.source };
  if (candidate.source === 'auto') return null;
  return SOURCE_RANK[current.titleSource] <= SOURCE_RANK.runtime ? { title, titleSource: 'runtime' } : null;
}

/**
 * 从第一条用户消息推一个自动标题：去掉引用块（新旧两种包裹）、Markdown 图片与链接地址（附件上传后是链接），
 * 取折叠空白后的前 60 个字符。只剩附件、没有文字时不给标题。
 */
export function deriveAutoTitle(message: string): string | null {
  const text = String(message ?? '')
    .replace(/<quoted_message\b[^>]*>[\s\S]*?<\/quoted_message>/gi, ' ')
    .replace(/\[引用开始[^\]]*\][\s\S]*?\[引用结束\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length > AUTO_TITLE_MAX_CHARS ? `${chars.slice(0, AUTO_TITLE_MAX_CHARS).join('')}…` : text;
}

/**
 * 「人建的」判据：优先看建会话时记下的来历；没有记录的老会话里，只有「运行时管理页 → 让 AI 诊断」
 * 建出的固定 id `diagnose-<运行时>`（且确实是那个运行时的外部单聊）算诊断会话。
 */
export function isHumanCreatedSession(
  session: { id: string; external_runtime?: string | null },
  meta: Pick<SessionMeta, 'origin'> | null | undefined,
): boolean {
  if (meta?.origin) return meta.origin === 'human';
  return !(session.external_runtime && session.id === `diagnose-${session.external_runtime}`);
}

export type RenameCategoryResult = 'ok' | 'not_found' | 'conflict';

const META_COLUMNS = 'session_id, title, title_source, origin, parent_session_id, fork_point_message_id';
type MetaRow = { session_id: string; title: string | null; title_source: SessionTitleSource | null; origin: SessionOrigin | null; parent_session_id: string | null; fork_point_message_id: number | null };
function metaFromRow(row: MetaRow): SessionMeta {
  return { title: row.title, titleSource: row.title_source, origin: row.origin, parentSessionId: row.parent_session_id, forkPointMessageId: row.fork_point_message_id };
}

export class SessionOrgStore {
  constructor(private readonly db: Database.Database) {
    applySessionOrgSchema(db);
  }

  // ---------------------------------------------------------------- 分类（按用户）

  listCategories(owner: string): SessionCategory[] {
    const rows = this.db.prepare('SELECT id, name, created_at, updated_at FROM session_categories WHERE owner_key = ? ORDER BY name_key ASC, id ASC')
      .all(owner) as Array<{ id: number; name: string; created_at: number; updated_at: number }>;
    return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  private findCategory(owner: string, id: number): SessionCategory | null {
    return this.listCategories(owner).find((category) => category.id === id) ?? null;
  }

  /** 同名（不分大小写）已存在就回那一条：建分类是幂等的。 */
  createCategory(owner: string, name: string, key: string, now = Date.now()): { category: SessionCategory; created: boolean } {
    const existing = this.db.prepare('SELECT id FROM session_categories WHERE owner_key = ? AND name_key = ?').get(owner, key) as { id: number } | undefined;
    if (existing) return { category: this.findCategory(owner, existing.id)!, created: false };
    const result = this.db.prepare('INSERT INTO session_categories (owner_key, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(owner, name, key, now, now);
    return { category: this.findCategory(owner, Number(result.lastInsertRowid))!, created: true };
  }

  renameCategory(owner: string, id: number, name: string, key: string, now = Date.now()): RenameCategoryResult {
    if (!this.findCategory(owner, id)) return 'not_found';
    const clash = this.db.prepare('SELECT id FROM session_categories WHERE owner_key = ? AND name_key = ? AND id <> ?').get(owner, key, id);
    if (clash) return 'conflict';
    this.db.prepare('UPDATE session_categories SET name = ?, name_key = ?, updated_at = ? WHERE owner_key = ? AND id = ?').run(name, key, now, owner, id);
    return 'ok';
  }

  /** 删分类与「把它下面的会话挪回未分类」在同一个事务里：不会出现指向已删分类的会话。 */
  deleteCategory(owner: string, id: number): boolean {
    return this.db.transaction(() => {
      const removed = this.db.prepare('DELETE FROM session_categories WHERE owner_key = ? AND id = ?').run(owner, id).changes > 0;
      if (removed) this.db.prepare('UPDATE session_org SET category_id = NULL WHERE owner_key = ? AND category_id = ?').run(owner, id);
      return removed;
    })();
  }

  // ---------------------------------------------------------------- 会话归属（按用户）

  entries(owner: string): Map<string, SessionOrgEntry> {
    const rows = this.db.prepare('SELECT session_id, category_id, archived FROM session_org WHERE owner_key = ?')
      .all(owner) as Array<{ session_id: string; category_id: number | null; archived: number }>;
    return new Map(rows.map((row) => [row.session_id, { categoryId: row.category_id, archived: row.archived === 1 }]));
  }

  private upsertEntry(owner: string, sessionId: string, patch: Partial<SessionOrgEntry>, now: number): void {
    const current = this.entries(owner).get(sessionId) ?? { categoryId: null, archived: false };
    const next = { ...current, ...patch };
    this.db.prepare(`
      INSERT INTO session_org (owner_key, session_id, category_id, archived, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_key, session_id) DO UPDATE SET category_id = excluded.category_id, archived = excluded.archived, updated_at = excluded.updated_at
    `).run(owner, sessionId, next.categoryId, next.archived ? 1 : 0, now);
  }

  /** 挪到分类（null = 未分类）。分类不是这个人的或不存在 → `category_not_found`。 */
  setCategory(owner: string, sessionId: string, categoryId: number | null, now = Date.now()): 'ok' | 'category_not_found' {
    if (categoryId !== null && !this.findCategory(owner, categoryId)) return 'category_not_found';
    this.upsertEntry(owner, sessionId, { categoryId }, now);
    return 'ok';
  }

  setArchived(owner: string, sessionId: string, archived: boolean, now = Date.now()): void {
    this.upsertEntry(owner, sessionId, { archived }, now);
  }

  // ---------------------------------------------------------------- 元数据（跟着会话）

  getMeta(sessionId: string): SessionMeta | null {
    const row = this.db.prepare(`SELECT ${META_COLUMNS} FROM session_meta WHERE session_id = ?`).get(sessionId) as MetaRow | undefined;
    return row ? metaFromRow(row) : null;
  }

  allMeta(): Map<string, SessionMeta> {
    const rows = this.db.prepare(`SELECT ${META_COLUMNS} FROM session_meta`).all() as MetaRow[];
    return new Map(rows.map((row) => [row.session_id, metaFromRow(row)]));
  }

  private writeMeta(sessionId: string, patch: Partial<SessionMeta>, now: number): void {
    const current = this.getMeta(sessionId) ?? { title: null, titleSource: null, origin: null, parentSessionId: null, forkPointMessageId: null };
    const next = { ...current, ...patch };
    this.db.prepare(`
      INSERT INTO session_meta (session_id, title, title_source, origin, parent_session_id, fork_point_message_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, title_source = excluded.title_source, origin = excluded.origin,
        parent_session_id = excluded.parent_session_id, fork_point_message_id = excluded.fork_point_message_id, updated_at = excluded.updated_at
    `).run(sessionId, next.title, next.titleSource, next.origin, next.parentSessionId, next.forkPointMessageId, now);
  }

  setOrigin(sessionId: string, origin: SessionOrigin, now = Date.now()): void {
    this.writeMeta(sessionId, { origin }, now);
  }

  /** 按 `resolveTitleUpdate` 的优先级写标题；返回写后的元数据，没改返回 null。 */
  proposeTitle(sessionId: string, title: string, source: SessionTitleSource, now = Date.now()): SessionMeta | null {
    const current = this.getMeta(sessionId);
    const update = resolveTitleUpdate({ title: current?.title ?? null, titleSource: current?.titleSource ?? null }, { title, source });
    if (!update) return null;
    this.writeMeta(sessionId, update, now);
    return this.getMeta(sessionId);
  }

  /** 第一条用户消息落库后调：只在还没有标题时写自动标题。 */
  recordUserMessageForTitle(sessionId: string, message: string, now = Date.now()): void {
    const auto = deriveAutoTitle(message);
    if (auto) this.proposeTitle(sessionId, auto, 'auto', now);
  }

  /** 清空历史（重置会话）后，自动 / 运行时标题跟着作废；手动标题是人起的名字，保留。 */
  clearGeneratedTitle(sessionId: string, now = Date.now()): void {
    const current = this.getMeta(sessionId);
    if (!current?.title || current.titleSource === 'manual') return;
    this.writeMeta(sessionId, { title: null, titleSource: null }, now);
  }

  setLineage(sessionId: string, lineage: { parentSessionId: string; forkPointMessageId: number | null }, now = Date.now()): void {
    this.writeMeta(sessionId, lineage, now);
  }

  // ---------------------------------------------------------------- 派生

  /** 每个会话最近一条消息的时间（epoch ms），给 Recent 分组排序用。没有消息的会话不在表里。 */
  lastActivity(): Map<string, number> {
    const rows = this.db.prepare("SELECT session_key, MAX(id) AS last_id, strftime('%s', MAX(created_at)) AS last_at FROM chat_messages GROUP BY session_key")
      .all() as Array<{ session_key: string; last_id: number; last_at: string | null }>;
    return new Map(rows.map((row) => [row.session_key, row.last_at ? Number(row.last_at) * 1000 : 0]));
  }

  /** 会话被删：所有人的分类归属、归档与它的元数据一起清掉。 */
  removeSession(sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_org WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(sessionId);
    })();
  }
}
