/**
 * 记忆服务（sidecar，引擎无关，spec 06 §4）。独立 SQLite 文件 `<数据目录>/memory/memory.sqlite`，FTS5 检索，可选嵌入钩子。
 *
 * 规则（改这里之前先读 `types.ts` 的文件头与 `test/memory/memory-behavior.test.ts`）：
 * - 所有改动**同步发生在调用里**、失败抛真实错误：模型不能声称存了其实没存；
 * - 写入先静态校验（种类、值、作用域、来源、策略与意图），再在一个 IMMEDIATE 事务里做依赖库内状态的判定与改动；
 *   批里任何一条失败整批不生效，错误带失败序号（`detail.index`）；
 * - 修改一律 supersede：新 id、revision+1、旧卡 `superseded` 留作历史；更新 / 过期 / 删除必须带 `expectedRevision`；
 * - FTS 镜像只放 active 卡，与卡片行在同一事务里增删；嵌入在提交之后算（钩子，失败只记日志，不影响写入结果）；
 * - `:memory:` 是临时库：写与忘拒绝（`memoryService.ephemeralStore`），检索结果标 `degraded`，不把「临时库」报成「空库」。
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { detectMemoryIntent, isListAllQuery, type MemoryIntent } from './intent';
import { detectFts5, migrateMemorySchema } from './schema';
import { ALWAYS_RECALLED_KINDS, canonicalKey, MEMORY_SLOTS, normalizeValue, slotFor } from './slots';
import { estimateTokens, ftsQuery, ftsText, kindsForQuery, tokenize } from './text';
import {
  MEMORY_CARD_STATUSES,
  MemoryError,
  type MemoryCard,
  type MemoryCardStatus,
  type MemoryCardType,
  type MemoryHostContext,
  type MemoryOrigin,
  type MemoryScopeRef,
} from './types';

/** 语义检索钩子：不随包提供模型，宿主或测试注入。向量维度由提供者决定。 */
export interface EmbeddingProvider {
  id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type MemoryServiceDeps = {
  /** SQLite 文件路径；`:memory:` 只给测试（此时写工具拒绝，说明是临时库）。 */
  dbPath: string;
  now?: () => number;
  embeddings?: EmbeddingProvider | null;
  log?: (message: string) => void;
};

export type MemorySearchInput = {
  query?: string;
  domain?: string;
  categoryPrefix?: string;
  types?: string[];
  kinds?: string[];
  key?: string;
  value?: string;
  tags?: string[];
  entities?: string[];
  limit?: number;
  all?: boolean;
};

export type MemoryOmission = { id: string; reason: 'expired' | 'superseded' | 'low_confidence' | 'conflict_lost' | 'over_limit' };

export type MemorySearchResult = {
  exact: MemoryCard[];
  relevant: MemoryCard[];
  omitted: MemoryOmission[];
  /** 检索是降级的：临时库（不是「没有记忆」），或 FTS5 不可用（退回逐卡打分）。 */
  degraded?: 'ephemeralStore' | 'ftsUnavailable';
};

export type MemoryWriteOperation =
  | { op: 'create'; kind: string; itemKey?: string; title: string; content: string; value?: unknown; scope?: MemoryScopeRef; tags?: string[]; entities?: string[]; sourceMessageIds?: string[]; type?: string }
  | { op: 'update'; targetId: string; expectedRevision: number; title?: string; content?: string; value?: unknown; valuePatch?: Record<string, unknown>; unsetValueFields?: string[]; tags?: string[]; entities?: string[]; sourceMessageIds?: string[] }
  | { op: 'expire'; targetId: string; expectedRevision: number }
  | { op: 'delete'; targetId: string; expectedRevision: number; hard?: boolean };

export type MemoryWriteResult = {
  done: true;
  results: Array<{ index: number; op: string; outcome: 'created' | 'superseded' | 'noop' | 'expired' | 'deleted'; card: MemoryCard | null }>;
  note: string;
};

export type MemoryForgetInput = {
  all?: boolean;
  targets?: Array<{ id: string; revision: number }>;
  id?: string;
  revision?: number;
  filter?: { domain?: string; categoryPrefix?: string; type?: string; key?: string; value?: string };
};

export type MemoryRecallResult = { cards: MemoryCard[]; omittedCount: number; text: string };

export type MemoryListInput = { profileId?: string | null; profileIds?: string[] | null; query?: string; status?: string; limit?: number; offset?: number };

export type MemoryGraphEdge = { id: string; source: string; target: string; kind: 'revision' | 'source' | 'entity' };

export type MemoryAuditEvent = { id: number; ts: number; profileId: string; nodeId: string | null; action: string; actor: string; reason: string | null; payload: unknown };

export const MEMORY_WRITE_MAX_OPERATIONS = 50;
export const MEMORY_SEARCH_MAX_LIMIT = 50;
export const MEMORY_DEFAULT_TOKEN_BUDGET = 4000;
export const MEMORY_MIN_RECALL_CONFIDENCE = 0.35;
const WRITE_DONE_NOTE = 'Saved. These changes are durable — do not call memory_write again for them.';

type NodeRow = {
  id: string;
  parent_id: string | null;
  supersedes_id: string | null;
  profile_id: string;
  scope_type: 'profile' | 'context' | 'session';
  scope_ns: string;
  scope_id: string;
  origin: string | null;
  kind: string;
  domain: string;
  category_path: string;
  type: string;
  key: string;
  revision: number;
  value_json: string | null;
  title: string;
  content: string;
  status: MemoryCardStatus;
  confidence: number;
  importance: number;
  tags: string;
  entities: string;
  source_message_ids: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

const parseJson = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function scopeKey(scope: MemoryScopeRef): string {
  return scope.type === 'context' ? `context:${scope.namespace}:${scope.id}` : `${scope.type}:${scope.id}`;
}

function scopeOfRow(row: Pick<NodeRow, 'scope_type' | 'scope_ns' | 'scope_id'>): MemoryScopeRef {
  return row.scope_type === 'context' ? { type: 'context', namespace: row.scope_ns, id: row.scope_id } : { type: row.scope_type, id: row.scope_id };
}

function toCard(row: NodeRow): MemoryCard {
  return {
    id: row.id,
    profileId: row.profile_id,
    scope: scopeOfRow(row),
    origin: parseJson<MemoryOrigin | null>(row.origin, null),
    kind: row.kind,
    key: row.key,
    domain: row.domain,
    categoryPath: row.category_path,
    type: row.type as MemoryCardType,
    revision: row.revision,
    status: row.status,
    title: row.title,
    content: row.content,
    value: parseJson<unknown>(row.value_json, null),
    confidence: row.confidence,
    importance: row.importance,
    tags: parseJson<string[]>(row.tags, []),
    entities: parseJson<string[]>(row.entities, []),
    sourceMessageIds: parseJson<string[]>(row.source_message_ids, []),
    parentId: row.parent_id,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function validScope(raw: unknown): MemoryScopeRef {
  const scope = raw as Partial<Record<string, unknown>> | null;
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
  if (scope && scope.type === 'profile' && text(scope.id)) return { type: 'profile', id: String(scope.id) };
  if (scope && scope.type === 'session' && text(scope.id)) return { type: 'session', id: String(scope.id) };
  if (scope && scope.type === 'context' && text(scope.id) && text(scope.namespace)) return { type: 'context', namespace: String(scope.namespace), id: String(scope.id) };
  throw new MemoryError('memoryService.invalidScope', 'scope must be {type: profile|session, id} or {type: context, namespace, id}');
}

function stringList(raw: unknown, field: string, max = 20): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) throw new MemoryError('memoryService.invalidInput', `${field} must be an array of strings`, { field });
  return [...new Set((raw as string[]).map((item) => item.trim().slice(0, 80)).filter(Boolean))].slice(0, max);
}

function requiredText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new MemoryError('memoryService.titleContentRequired', `${field} is required`, { field });
  return raw.trim().slice(0, max);
}

function expectedRevisionOf(raw: unknown): number {
  const value = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isInteger(value) || value < 1) {
    throw new MemoryError('memoryService.revisionRequired', 'expectedRevision is required — search again before mutating');
  }
  return value;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index];
    na += a[index] * a[index];
    nb += b[index] * b[index];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** 同一 (作用域, 领域, 键) 里谁赢：correction 先，然后最新、置信度、重要度。 */
function winnerOrder(a: MemoryCard, b: MemoryCard): number {
  if ((a.type === 'correction') !== (b.type === 'correction')) return a.type === 'correction' ? -1 : 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return b.importance - a.importance;
}

export function createMemoryService(deps: MemoryServiceDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const ephemeral = deps.dbPath === ':memory:';
  if (!ephemeral) {
    fs.mkdirSync(path.dirname(deps.dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new Database(deps.dbPath);
  if (!ephemeral) {
    try {
      db.pragma('busy_timeout = 5000');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    } catch (error) {
      log(`[Memory] pragma setup failed: ${(error as Error)?.name}`);
    }
  }
  const fts = detectFts5(db);
  migrateMemorySchema(db, { fts });
  if (!fts) log('[Memory] SQLite FTS5 unavailable: lexical search falls back to per-card scoring');

  const nowIso = () => new Date(now()).toISOString();
  const selectNode = db.prepare('SELECT * FROM memory_nodes WHERE id = ?');
  const selectActiveSlot = db.prepare("SELECT * FROM memory_nodes WHERE profile_id = ? AND scope_type = ? AND scope_ns = ? AND scope_id = ? AND key = ? AND status = 'active'");
  const insertNode = db.prepare(`
    INSERT INTO memory_nodes (id, parent_id, supersedes_id, profile_id, scope_type, scope_ns, scope_id, origin, kind, domain, category_path, type, key,
      revision, value_json, title, content, status, confidence, importance, tags, entities, source_message_ids, created_at, updated_at, expires_at)
    VALUES (@id, @parent_id, @supersedes_id, @profile_id, @scope_type, @scope_ns, @scope_id, @origin, @kind, @domain, @category_path, @type, @key,
      @revision, @value_json, @title, @content, @status, @confidence, @importance, @tags, @entities, @source_message_ids, @created_at, @updated_at, @expires_at)
  `);
  const setStatus = db.prepare('UPDATE memory_nodes SET status = ?, revision = ?, updated_at = ?, expires_at = COALESCE(?, expires_at) WHERE id = ?');
  const insertAudit = db.prepare('INSERT INTO memory_audit_events (ts, profile_id, node_id, action, actor, reason, payload) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertEvidence = db.prepare('INSERT OR IGNORE INTO memory_messages (profile_id, id, role, content, origin, created_at, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const ftsInsert = fts ? db.prepare('INSERT INTO memory_nodes_fts (node_id, title, content, key, tags, entities, value) VALUES (?, ?, ?, ?, ?, ?, ?)') : null;
  const ftsDelete = fts ? db.prepare('DELETE FROM memory_nodes_fts WHERE node_id = ?') : null;

  const ftsAdd = (row: NodeRow) => {
    ftsInsert?.run(row.id, ftsText(row.title), ftsText(row.content), ftsText(row.key), ftsText(parseJson<string[]>(row.tags, []).join(' ')), ftsText(parseJson<string[]>(row.entities, []).join(' ')), ftsText(row.value_json ?? ''));
  };
  const ftsRemove = (id: string) => ftsDelete?.run(id);

  // 启动自检：镜像行数与 active 卡数对不上就整表重建（进程崩在两个语句之间不会发生——同一事务——但换过 SQLite / 手改过库会）。
  if (fts) {
    const active = (db.prepare("SELECT COUNT(*) AS n FROM memory_nodes WHERE status = 'active'").get() as { n: number }).n;
    const mirrored = (db.prepare('SELECT COUNT(*) AS n FROM memory_nodes_fts').get() as { n: number }).n;
    if (active !== mirrored) {
      db.transaction(() => {
        db.exec('DELETE FROM memory_nodes_fts');
        for (const row of db.prepare("SELECT * FROM memory_nodes WHERE status = 'active'").all() as NodeRow[]) ftsAdd(row);
      }).immediate();
    }
  }

  const audit = (profileId: string, nodeId: string | null, action: string, actor: string, reason: string | null, payload: unknown) => {
    insertAudit.run(now(), profileId, nodeId, action, actor, reason, payload === undefined ? null : JSON.stringify(payload));
  };

  function assertContext(ctx: MemoryHostContext): { recall: Set<string>; write: Set<string> } {
    if (!ctx || typeof ctx.profileId !== 'string' || !ctx.profileId.trim()) throw new MemoryError('memoryService.invalidContext', 'host context needs a profileId');
    const recall = new Set((ctx.recallScopes ?? []).map((scope) => scopeKey(validScope(scope))));
    const write = new Set((ctx.writeScopes ?? []).map((scope) => scopeKey(validScope(scope))));
    return { recall, write };
  }

  function assertDurable(): void {
    if (ephemeral) throw new MemoryError('memoryService.ephemeralStore', 'Memory is running on an ephemeral in-memory store; durable memories cannot be saved or removed.');
  }

  /** 宿主捕获的可信证据落 memory_messages（确定性 id，重复忽略）。 */
  function captureEvidence(ctx: MemoryHostContext): void {
    const evidence = Array.isArray(ctx.evidence) ? ctx.evidence : [];
    if (!evidence.length) return;
    const origin = ctx.origin ? JSON.stringify(ctx.origin) : null;
    db.transaction(() => {
      for (const message of evidence) {
        if (!message || typeof message.id !== 'string' || !message.id || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') continue;
        insertEvidence.run(ctx.profileId, message.id, message.role, message.content.slice(0, 20_000), origin, message.createdAt ?? null, now());
      }
    })();
  }

  function latestUserIntent(ctx: MemoryHostContext): MemoryIntent {
    const users = (ctx.evidence ?? []).filter((message) => message?.role === 'user');
    return detectMemoryIntent(users.length ? users[users.length - 1].content : null);
  }

  function evidenceSources(ctx: MemoryHostContext, provided: unknown): string[] {
    const allowed = (ctx.evidence ?? []).filter((message) => message?.role === 'user' && typeof message.id === 'string').map((message) => message.id);
    if (provided === undefined || provided === null) return allowed;
    const ids = stringList(provided, 'sourceMessageIds', 50);
    const allowedSet = new Set(allowed);
    const forged = ids.filter((id) => !allowedSet.has(id));
    if (forged.length) {
      throw new MemoryError('memoryService.sourceNotEvidence', 'sourceMessageIds must reference the trusted user messages captured for this run', { ids: forged.join(',') });
    }
    return ids;
  }

  // ---- 写 ----

  type StaticOp =
    | { op: 'create'; slot: ReturnType<typeof slotFor>; key: string; scope: MemoryScopeRef; value: unknown; title: string; content: string; tags: string[]; entities: string[]; sources: string[] }
    | { op: 'update'; targetId: string; expectedRevision: number; raw: Extract<MemoryWriteOperation, { op: 'update' }>; tags: string[] | null; entities: string[] | null; sources: string[] | null }
    | { op: 'expire'; targetId: string; expectedRevision: number }
    | { op: 'delete'; targetId: string; expectedRevision: number; hard: boolean };

  const withIndex = (error: unknown, index: number): never => {
    if (error instanceof MemoryError) throw new MemoryError(error.code, error.message, { ...error.detail, index });
    throw error;
  };

  function prepareStatic(ctx: MemoryHostContext, writable: Set<string>, raw: MemoryWriteOperation, intent: MemoryIntent): StaticOp {
    if (!raw || typeof raw !== 'object') throw new MemoryError('memoryService.invalidInput', 'operation must be an object');
    const explicit = ctx.explicitUserAction === true || intent.remember;
    if ((raw.op === 'create' || raw.op === 'update' || raw.op === 'expire') && ctx.policy === 'explicit-only' && !explicit) {
      throw new MemoryError('memoryService.explicitIntentRequired', 'This conversation only saves memories the user explicitly asks to remember.');
    }
    switch (raw.op) {
      case 'create': {
        // 模型给的 domain / category / type / key 一律不看：槽位由种类决定。
        const slot = slotFor(raw.kind);
        const key = canonicalKey(slot, raw.itemKey);
        const scope = raw.scope === undefined || raw.scope === null ? validScope(ctx.defaultWriteScope) : validScope(raw.scope);
        if (!writable.has(scopeKey(scope))) throw new MemoryError('memoryService.scopeNotWritable', 'this scope is not writable in the current conversation', { scope: scopeKey(scope) });
        return {
          op: 'create',
          slot,
          key,
          scope,
          value: normalizeValue(slot, raw.value),
          title: requiredText(raw.title, 'title', 200),
          content: requiredText(raw.content, 'content', 4000),
          tags: stringList(raw.tags, 'tags'),
          entities: stringList(raw.entities, 'entities'),
          sources: evidenceSources(ctx, raw.sourceMessageIds),
        };
      }
      case 'update':
        if (typeof raw.targetId !== 'string' || !raw.targetId) throw new MemoryError('memoryService.invalidInput', 'targetId is required');
        return {
          op: 'update',
          targetId: raw.targetId,
          expectedRevision: expectedRevisionOf(raw.expectedRevision),
          raw,
          tags: raw.tags === undefined ? null : stringList(raw.tags, 'tags'),
          entities: raw.entities === undefined ? null : stringList(raw.entities, 'entities'),
          sources: raw.sourceMessageIds === undefined ? null : evidenceSources(ctx, raw.sourceMessageIds),
        };
      case 'expire':
      case 'delete':
        if (typeof raw.targetId !== 'string' || !raw.targetId) throw new MemoryError('memoryService.invalidInput', 'targetId is required');
        if (raw.op === 'delete' && ctx.explicitUserAction !== true && !intent.forget) {
          throw new MemoryError('memoryService.forgetIntentRequired', 'Deleting memories requires the user to ask to forget them.');
        }
        return raw.op === 'delete'
          ? { op: 'delete', targetId: raw.targetId, expectedRevision: expectedRevisionOf(raw.expectedRevision), hard: raw.hard === true }
          : { op: 'expire', targetId: raw.targetId, expectedRevision: expectedRevisionOf(raw.expectedRevision) };
      default:
        throw new MemoryError('memoryService.invalidInput', `unknown operation ${(raw as { op?: unknown }).op}`);
    }
  }

  function resolveTarget(ctx: MemoryHostContext, writable: Set<string>, targetId: string, expectedRevision: number): NodeRow {
    const row = selectNode.get(targetId) as NodeRow | undefined;
    if (!row || row.profile_id !== ctx.profileId) throw new MemoryError('memoryService.targetNotFound', 'memory card not found — search again before mutating', { id: targetId });
    if (!writable.has(scopeKey(scopeOfRow(row)))) throw new MemoryError('memoryService.scopeNotWritable', 'this card is not writable in the current conversation', { id: targetId });
    if (row.status !== 'active') throw new MemoryError('memoryService.targetNotActive', 'memory card is no longer active — search again before mutating', { id: targetId, status: row.status });
    if (row.revision !== expectedRevision) {
      throw new MemoryError('memoryService.revisionMismatch', 'memory card has changed — search again before mutating', { id: targetId, currentRevision: row.revision });
    }
    return row;
  }

  const slotIdentity = (profileId: string, scope: MemoryScopeRef, key: string) => `slot:${profileId}|${scopeKey(scope)}|${key}`;

  function newRow(base: Omit<NodeRow, 'id' | 'created_at' | 'updated_at'>): NodeRow {
    const at = nowIso();
    return { ...base, id: `mem_${randomUUID().replace(/-/g, '')}`, created_at: at, updated_at: at };
  }

  async function write(ctx: MemoryHostContext, input: { operations: MemoryWriteOperation[] }): Promise<MemoryWriteResult> {
    const { write: writable } = assertContext(ctx);
    assertDurable();
    const operations = input?.operations;
    if (!Array.isArray(operations) || operations.length === 0) throw new MemoryError('memoryService.batchEmpty', 'operations must be a non-empty array');
    if (operations.length > MEMORY_WRITE_MAX_OPERATIONS) throw new MemoryError('memoryService.batchTooLarge', `at most ${MEMORY_WRITE_MAX_OPERATIONS} operations per call`);
    captureEvidence(ctx);
    const intent = latestUserIntent(ctx);
    const explicit = ctx.explicitUserAction === true || intent.remember;
    const prepared = operations.map((raw, index) => {
      try {
        return prepareStatic(ctx, writable, raw, intent);
      } catch (error) {
        return withIndex(error, index);
      }
    });
    const actor = typeof ctx.actor === 'string' && ctx.actor ? ctx.actor.slice(0, 120) : 'unknown';
    const origin = ctx.origin ? JSON.stringify(ctx.origin) : null;
    const confidence = explicit ? 0.98 : 0.7;
    const importance = explicit ? 0.9 : 0.6;
    const newlyActive: NodeRow[] = [];

    const commit = db.transaction(() => {
      const touched = new Map<string, number>();
      const claim = (identity: string, index: number) => {
        const previous = touched.get(identity);
        if (previous !== undefined) {
          throw new MemoryError('memoryService.batchConflict', 'two operations in one batch touch the same memory', { otherIndex: previous });
        }
        touched.set(identity, index);
      };
      const results: MemoryWriteResult['results'] = [];
      prepared.forEach((op, index) => {
        try {
          if (op.op === 'create') {
            claim(slotIdentity(ctx.profileId, op.scope, op.key), index);
            const scopeNs = op.scope.type === 'context' ? op.scope.namespace : '';
            const existing = selectActiveSlot.get(ctx.profileId, op.scope.type, scopeNs, op.scope.id, op.key) as NodeRow | undefined;
            const valueJson = op.value === null || op.value === undefined ? null : JSON.stringify(op.value);
            if (existing) {
              claim(`node:${existing.id}`, index);
              if (existing.value_json === valueJson && existing.content === op.content) {
                results.push({ index, op: 'create', outcome: 'noop', card: toCard(existing) });
                return;
              }
            }
            const row = newRow({
              parent_id: existing?.id ?? null,
              supersedes_id: existing?.id ?? null,
              profile_id: ctx.profileId,
              scope_type: op.scope.type,
              scope_ns: scopeNs,
              scope_id: op.scope.id,
              origin,
              kind: op.slot.kind,
              domain: op.slot.domain,
              category_path: op.slot.categoryPath,
              type: op.slot.type,
              key: op.key,
              revision: existing ? existing.revision + 1 : 1,
              value_json: valueJson,
              title: op.title,
              content: op.content,
              status: 'active',
              confidence,
              importance,
              tags: JSON.stringify(op.tags),
              entities: JSON.stringify(op.entities),
              source_message_ids: JSON.stringify([...new Set([...(existing ? parseJson<string[]>(existing.source_message_ids, []) : []), ...op.sources])]),
              expires_at: null,
            });
            if (existing) {
              setStatus.run('superseded', existing.revision, row.created_at, null, existing.id);
              ftsRemove(existing.id);
            }
            insertNode.run(row);
            ftsAdd(row);
            newlyActive.push(row);
            audit(ctx.profileId, row.id, existing ? 'supersede' : 'create', actor, existing ? `supersedes ${existing.id}` : null, { key: row.key, scope: scopeKey(op.scope), revision: row.revision });
            results.push({ index, op: 'create', outcome: existing ? 'superseded' : 'created', card: toCard(row) });
            return;
          }

          // 先占节点再解析：同批里先 supersede 了它的那条要报「冲突」，而不是「已经不是 active」。
          claim(`node:${op.targetId}`, index);
          const target = resolveTarget(ctx, writable, op.targetId, op.expectedRevision);
          claim(slotIdentity(target.profile_id, scopeOfRow(target), target.key), index);

          if (op.op === 'update') {
            const slot = MEMORY_SLOTS.get(target.kind) ?? slotFor(target.kind);
            const oldValue = parseJson<unknown>(target.value_json, null);
            let nextValue: unknown = op.raw.value !== undefined ? normalizeValue(slot, op.raw.value) : oldValue;
            if (op.raw.valuePatch !== undefined || op.raw.unsetValueFields !== undefined) {
              if (slot.value === 'text') throw new MemoryError('memoryService.invalidValue', `kind ${slot.kind} has no structured fields to patch`);
              const merged: Record<string, unknown> = { ...((nextValue as Record<string, unknown>) ?? {}), ...(op.raw.valuePatch ?? {}) };
              for (const field of stringList(op.raw.unsetValueFields, 'unsetValueFields')) delete merged[field];
              nextValue = normalizeValue(slot, merged);
            }
            const valueJson = nextValue === null || nextValue === undefined ? null : JSON.stringify(nextValue);
            const valueChanged = valueJson !== target.value_json;
            if (valueChanged && (typeof op.raw.title !== 'string' || !op.raw.title.trim() || typeof op.raw.content !== 'string' || !op.raw.content.trim())) {
              throw new MemoryError('memoryService.titleContentRequired', 'a value change needs a fresh title and content');
            }
            const title = op.raw.title === undefined ? target.title : requiredText(op.raw.title, 'title', 200);
            const content = op.raw.content === undefined ? target.content : requiredText(op.raw.content, 'content', 4000);
            const tags = op.tags ? JSON.stringify(op.tags) : target.tags;
            const entities = op.entities ? JSON.stringify(op.entities) : target.entities;
            if (!valueChanged && title === target.title && content === target.content && tags === target.tags && entities === target.entities) {
              results.push({ index, op: 'update', outcome: 'noop', card: toCard(target) });
              return;
            }
            const row = newRow({
              ...target,
              parent_id: target.id,
              supersedes_id: target.id,
              origin: origin ?? target.origin,
              revision: target.revision + 1,
              value_json: valueJson,
              title,
              content,
              status: 'active',
              confidence: Math.max(target.confidence, explicit ? 0.98 : 0),
              importance: Math.max(target.importance, explicit ? 0.9 : 0),
              tags,
              entities,
              source_message_ids: JSON.stringify([...new Set([...parseJson<string[]>(target.source_message_ids, []), ...(op.sources ?? evidenceSources(ctx, undefined))])]),
              expires_at: null,
            });
            setStatus.run('superseded', target.revision, row.created_at, null, target.id);
            ftsRemove(target.id);
            insertNode.run(row);
            ftsAdd(row);
            newlyActive.push(row);
            audit(ctx.profileId, row.id, 'update', actor, `supersedes ${target.id}`, { key: row.key, revision: row.revision });
            results.push({ index, op: 'update', outcome: 'superseded', card: toCard(row) });
            return;
          }

          if (op.op === 'expire') {
            const at = nowIso();
            setStatus.run('expired', target.revision + 1, at, at, target.id);
            ftsRemove(target.id);
            audit(ctx.profileId, target.id, 'expire', actor, null, { revision: target.revision + 1 });
            results.push({ index, op: 'expire', outcome: 'expired', card: toCard(selectNode.get(target.id) as NodeRow) });
            return;
          }

          // delete
          ftsRemove(target.id);
          if (op.hard) {
            db.prepare('DELETE FROM memory_embeddings WHERE node_id = ?').run(target.id);
            db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(target.id);
            audit(ctx.profileId, target.id, 'delete', actor, 'hard', { key: target.key });
            results.push({ index, op: 'delete', outcome: 'deleted', card: null });
          } else {
            setStatus.run('deleted', target.revision + 1, nowIso(), null, target.id);
            audit(ctx.profileId, target.id, 'delete', actor, 'soft', { key: target.key, revision: target.revision + 1 });
            results.push({ index, op: 'delete', outcome: 'deleted', card: toCard(selectNode.get(target.id) as NodeRow) });
          }
        } catch (error) {
          withIndex(error, index);
        }
      });
      return results;
    });

    let results: MemoryWriteResult['results'];
    try {
      results = commit.immediate();
    } catch (error) {
      if ((error as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new MemoryError('memoryService.concurrentWrite', 'another write changed the same memory at the same time — search again before mutating');
      }
      throw error;
    }
    await embedRows(newlyActive);
    return { done: true, results, note: WRITE_DONE_NOTE };
  }

  async function embedRows(rows: NodeRow[]): Promise<void> {
    const provider = deps.embeddings;
    if (!provider || rows.length === 0) return;
    try {
      const vectors = await provider.embed(rows.map((row) => `${row.title}\n${row.content}`));
      const upsert = db.prepare('INSERT INTO memory_embeddings (node_id, provider, dims, vector, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET provider = excluded.provider, dims = excluded.dims, vector = excluded.vector, updated_at = excluded.updated_at');
      db.transaction(() => {
        rows.forEach((row, index) => {
          const vector = vectors[index];
          if (Array.isArray(vector) && vector.length) upsert.run(row.id, provider.id, vector.length, JSON.stringify(vector), now());
        });
      })();
    } catch (error) {
      log(`[Memory] embedding provider ${provider.id} failed: ${(error as Error)?.name}`);
    }
  }

  // ---- 忘 ----

  async function forget(ctx: MemoryHostContext, input: MemoryForgetInput): Promise<{ done: true; deleted: number }> {
    const { write: writable } = assertContext(ctx);
    assertDurable();
    captureEvidence(ctx);
    const selectors = [input?.all === true, Array.isArray(input?.targets) && input.targets.length > 0, typeof input?.id === 'string', !!input?.filter && typeof input.filter === 'object'].filter(Boolean).length;
    if (selectors !== 1) throw new MemoryError('memoryService.invalidForgetSelector', 'give exactly one of all, targets, id + revision, or filter');
    const intent = latestUserIntent(ctx);
    if (ctx.explicitUserAction !== true) {
      if (input.all === true && !intent.forgetAll) throw new MemoryError('memoryService.forgetAllIntentRequired', 'Forgetting everything requires the user to ask to forget all memories.');
      if (!intent.forget) throw new MemoryError('memoryService.forgetIntentRequired', 'Deleting memories requires the user to ask to forget them.');
    }
    const actor = ctx.actor || 'unknown';
    const run = db.transaction(() => {
      let rows: NodeRow[];
      if (input.all === true || input.filter) {
        const filter = input.filter ?? {};
        rows = (db.prepare("SELECT * FROM memory_nodes WHERE profile_id = ? AND status = 'active'").all(ctx.profileId) as NodeRow[])
          .filter((row) => writable.has(scopeKey(scopeOfRow(row))))
          .filter((row) => (!filter.domain || row.domain === filter.domain)
            && (!filter.categoryPrefix || row.category_path.startsWith(filter.categoryPrefix))
            && (!filter.type || row.type === filter.type)
            && (!filter.key || row.key === filter.key)
            && (!filter.value || (row.value_json ?? '').toLowerCase().includes(filter.value.toLowerCase())));
      } else {
        const targets = input.targets ?? [{ id: input.id as string, revision: input.revision as number }];
        rows = targets.map((target, index) => {
          try {
            return resolveTarget(ctx, writable, String(target?.id ?? ''), expectedRevisionOf(target?.revision));
          } catch (error) {
            return withIndex(error, index);
          }
        });
      }
      const at = nowIso();
      for (const row of rows) {
        setStatus.run('deleted', row.revision + 1, at, null, row.id);
        ftsRemove(row.id);
        audit(ctx.profileId, row.id, 'forget', actor, input.all ? 'all' : input.filter ? 'filter' : 'targets', { key: row.key });
      }
      return rows.length;
    });
    return { done: true, deleted: run.immediate() };
  }

  // ---- 读 ----

  type Scored = { card: MemoryCard; score: number };

  function cardsInScopes(ctx: MemoryHostContext, readable: Set<string>, statuses: MemoryCardStatus[]): MemoryCard[] {
    const placeholders = statuses.map(() => '?').join(',');
    return (db.prepare(`SELECT * FROM memory_nodes WHERE profile_id = ? AND status IN (${placeholders})`).all(ctx.profileId, ...statuses) as NodeRow[])
      .filter((row) => readable.has(scopeKey(scopeOfRow(row))))
      .map(toCard);
  }

  const isExpired = (card: MemoryCard) => card.status === 'expired' || (card.expiresAt !== null && card.expiresAt <= nowIso());

  function lexicalScores(query: string, cards: MemoryCard[]): Map<string, number> {
    const scores = new Map<string, number>();
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return scores;
    let matchedIds: Set<string> | null = null;
    if (fts) {
      const expression = ftsQuery(query);
      matchedIds = new Set(expression ? (db.prepare('SELECT node_id FROM memory_nodes_fts WHERE memory_nodes_fts MATCH ?').all(expression) as { node_id: string }[]).map((row) => row.node_id) : []);
    }
    for (const card of cards) {
      if (matchedIds && card.status === 'active' && !matchedIds.has(card.id)) continue;
      const fields: Array<[number, string]> = [
        [5, card.title], [4, card.entities.join(' ')], [4, card.key], [3, card.tags.join(' ')],
        [3, card.value === null ? '' : typeof card.value === 'string' ? card.value : JSON.stringify(card.value)], [2, card.categoryPath], [2, card.content],
      ];
      let score = 0;
      for (const [weight, text] of fields) {
        const tokens = new Set(tokenize(text));
        for (const term of terms) if (tokens.has(term)) score += weight;
      }
      if (score > 0) scores.set(card.id, score);
    }
    return scores;
  }

  async function semanticScores(query: string, cards: MemoryCard[]): Promise<Map<string, number>> {
    const provider = deps.embeddings;
    const out = new Map<string, number>();
    if (!provider || !query.trim() || cards.length === 0) return out;
    try {
      const [queryVector] = await provider.embed([query]);
      const rows = db.prepare(`SELECT node_id, vector FROM memory_embeddings WHERE provider = ? AND node_id IN (${cards.map(() => '?').join(',')})`).all(provider.id, ...cards.map((card) => card.id)) as { node_id: string; vector: string }[];
      for (const row of rows) out.set(row.node_id, cosine(queryVector ?? [], parseJson<number[]>(row.vector, [])));
    } catch (error) {
      log(`[Memory] embedding provider ${provider.id} failed during search: ${(error as Error)?.name}`);
    }
    return out;
  }

  /** 词法 + 语义：词法按最高分归一，与余弦各占一半；词法为零时余弦 ≥ 0.5 才算相关。 */
  async function rank(query: string, cards: MemoryCard[]): Promise<Scored[]> {
    const lexical = lexicalScores(query, cards);
    const semantic = await semanticScores(query, cards);
    const maxLexical = Math.max(1, ...lexical.values());
    const scored: Scored[] = [];
    for (const card of cards) {
      const lex = lexical.get(card.id) ?? 0;
      const cos = semantic.get(card.id);
      if (cos === undefined) {
        if (lex > 0) scored.push({ card, score: lex / maxLexical });
        continue;
      }
      if (lex > 0 || cos >= 0.5) scored.push({ card, score: (lex / maxLexical) * 0.5 + Math.max(0, cos) * 0.5 });
    }
    return scored.sort((a, b) => b.score - a.score || winnerOrder(a.card, b.card));
  }

  function matchesFilters(card: MemoryCard, input: MemorySearchInput): boolean {
    const lower = (value: unknown) => String(value ?? '').toLowerCase();
    if (input.domain && card.domain !== input.domain) return false;
    if (input.categoryPrefix && !card.categoryPath.startsWith(input.categoryPrefix)) return false;
    if (Array.isArray(input.types) && input.types.length && !input.types.includes(card.type)) return false;
    if (Array.isArray(input.kinds) && input.kinds.length && !input.kinds.includes(card.kind)) return false;
    if (input.key && card.key !== input.key) return false;
    if (input.value && !lower(typeof card.value === 'string' ? card.value : JSON.stringify(card.value)).includes(lower(input.value))) return false;
    if (Array.isArray(input.tags) && input.tags.length && !input.tags.every((tag) => card.tags.includes(tag))) return false;
    if (Array.isArray(input.entities) && input.entities.length && !input.entities.every((entity) => card.entities.includes(entity))) return false;
    return true;
  }

  /** 同一 (作用域, 领域, 键) 只留赢家，其余进 omitted。 */
  function resolveConflicts(cards: MemoryCard[], omitted: MemoryOmission[]): MemoryCard[] {
    const winners = new Map<string, MemoryCard>();
    for (const card of cards) {
      const slot = `${scopeKey(card.scope)}|${card.domain}|${card.key}`;
      const current = winners.get(slot);
      if (!current) winners.set(slot, card);
      else if (winnerOrder(card, current) < 0) {
        omitted.push({ id: current.id, reason: 'conflict_lost' });
        winners.set(slot, card);
      } else {
        omitted.push({ id: card.id, reason: 'conflict_lost' });
      }
    }
    const kept = new Set([...winners.values()].map((card) => card.id));
    return cards.filter((card) => kept.has(card.id));
  }

  async function search(ctx: MemoryHostContext, input: MemorySearchInput = {}): Promise<MemorySearchResult> {
    const { recall: readable } = assertContext(ctx);
    captureEvidence(ctx);
    const limit = Math.min(MEMORY_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(Number(input.limit)) || 10));
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 500) : '';
    const enumerate = input.all === true || isListAllQuery(query);
    const all = cardsInScopes(ctx, readable, ['active', 'superseded', 'expired']).filter((card) => matchesFilters(card, input));
    const omitted: MemoryOmission[] = [];
    const live: MemoryCard[] = [];
    const relevanceQuery = enumerate ? '' : query;
    const lexicalForHistory = relevanceQuery ? lexicalScores(relevanceQuery, all.filter((card) => card.status !== 'active')) : null;
    for (const card of all) {
      const inactiveReason = card.status === 'superseded' ? 'superseded' : isExpired(card) ? 'expired' : card.confidence < MEMORY_MIN_RECALL_CONFIDENCE ? 'low_confidence' : null;
      if (!inactiveReason) {
        live.push(card);
        continue;
      }
      // 只报告「本来会命中」的历史卡，免得 omitted 变成整张历史表。
      if (!relevanceQuery || (lexicalForHistory?.get(card.id) ?? 0) > 0 || card.status === 'active') omitted.push({ id: card.id, reason: inactiveReason });
    }

    let exact: MemoryCard[];
    let relevant: MemoryCard[];
    if (enumerate || !query) {
      exact = [...live].sort(winnerOrder);
      relevant = [];
    } else {
      const kinds = kindsForQuery(query);
      exact = live.filter((card) => kinds.has(card.kind)).sort(winnerOrder);
      const exactIds = new Set(exact.map((card) => card.id));
      relevant = (await rank(query, live.filter((card) => !exactIds.has(card.id)))).map((entry) => entry.card);
    }
    exact = resolveConflicts(exact, omitted);
    relevant = resolveConflicts(relevant, omitted);
    const overflowExact = exact.slice(limit);
    exact = exact.slice(0, limit);
    const overflowRelevant = relevant.slice(Math.max(0, limit - exact.length));
    relevant = relevant.slice(0, Math.max(0, limit - exact.length));
    for (const card of [...overflowExact, ...overflowRelevant]) omitted.push({ id: card.id, reason: 'over_limit' });

    const result: MemorySearchResult = { exact, relevant, omitted };
    if (ephemeral) result.degraded = 'ephemeralStore';
    else if (!fts) result.degraded = 'ftsUnavailable';
    return result;
  }

  async function get(ctx: MemoryHostContext, input: { id: string }): Promise<MemoryCard | null> {
    const { recall: readable } = assertContext(ctx);
    const row = typeof input?.id === 'string' ? selectNode.get(input.id) as NodeRow | undefined : undefined;
    if (!row || row.profile_id !== ctx.profileId || !readable.has(scopeKey(scopeOfRow(row)))) return null;
    return toCard(row);
  }

  function renderCard(card: MemoryCard): string {
    const value = card.value === null ? '' : typeof card.value === 'string' ? card.value : JSON.stringify(card.value);
    return `- [${card.id}] scope=${scopeKey(card.scope)} key=${card.key} rev=${card.revision}${value ? `: ${value}` : ''}\n  ${card.title} — ${card.content}`;
  }

  async function recall(ctx: MemoryHostContext, input: { query?: string; tokenBudget?: number } = {}): Promise<MemoryRecallResult> {
    const { recall: readable } = assertContext(ctx);
    captureEvidence(ctx);
    const budget = Math.max(200, Math.floor(Number(input.tokenBudget)) || MEMORY_DEFAULT_TOKEN_BUDGET);
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 2000) : '';
    const live = cardsInScopes(ctx, readable, ['active']).filter((card) => !isExpired(card) && card.confidence >= MEMORY_MIN_RECALL_CONFIDENCE);
    const kinds = kindsForQuery(query);
    const exact = live.filter((card) => ALWAYS_RECALLED_KINDS.has(card.kind) || card.type === 'correction' || kinds.has(card.kind)).sort(winnerOrder);
    const exactIds = new Set(exact.map((card) => card.id));
    const relevant = query ? (await rank(query, live.filter((card) => !exactIds.has(card.id)))).map((entry) => entry.card) : [];
    const ignored: MemoryOmission[] = [];
    const ordered = [...resolveConflicts(exact, ignored), ...resolveConflicts(relevant, ignored)];

    const header = '## Memory recall (partial — not the whole store; newer constraints and corrections win)';
    let used = estimateTokens(header);
    const packed: MemoryCard[] = [];
    let omittedCount = ignored.length;
    for (const card of ordered) {
      const cost = estimateTokens(renderCard(card)) + 1;
      if (used + cost > budget) {
        omittedCount += 1;
        continue;
      }
      used += cost;
      packed.push(card);
    }
    const groups: Array<[string, (card: MemoryCard) => boolean]> = [
      ['### Active constraints', (card) => card.type === 'constraint' || card.type === 'correction'],
      ['### Active tasks', (card) => card.type === 'task'],
      ['### User preferences', (card) => card.type === 'preference'],
      ['### Other relevant facts and decisions', () => true],
    ];
    const placed = new Set<string>();
    const sections: string[] = [header];
    for (const [title, predicate] of groups) {
      const members = packed.filter((card) => !placed.has(card.id) && predicate(card));
      if (!members.length) continue;
      for (const card of members) placed.add(card.id);
      sections.push(title, ...members.map(renderCard));
    }
    if (omittedCount > 0) sections.push(`(${omittedCount} more memories not shown — search before saying you don't know)`);
    if (ephemeral) sections.push('(memory store is ephemeral — nothing here is durable)');
    return { cards: packed, omittedCount, text: packed.length || omittedCount || ephemeral ? sections.join('\n') : '' };
  }

  // ---- 管理面 ----

  function list(input: MemoryListInput = {}): { cards: MemoryCard[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.profileId) {
      where.push('profile_id = ?');
      params.push(input.profileId);
    }
    if (Array.isArray(input.profileIds)) {
      if (input.profileIds.length === 0) return { cards: [], total: 0 };
      where.push(`profile_id IN (${input.profileIds.map(() => '?').join(',')})`);
      params.push(...input.profileIds);
    }
    if (input.status && input.status !== 'all') {
      if (!(MEMORY_CARD_STATUSES as readonly string[]).includes(input.status)) throw new MemoryError('memoryService.invalidInput', 'unknown status', { status: input.status });
      where.push('status = ?');
      params.push(input.status);
    }
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 200) : '';
    if (query) {
      where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR entities LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      const like = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      params.push(like, like, like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, Math.floor(Number(input.limit)) || 100));
    const offset = Math.max(0, Math.floor(Number(input.offset)) || 0);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM memory_nodes ${clause}`).get(...params) as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM memory_nodes ${clause} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(...params, limit, offset) as NodeRow[];
    return { cards: rows.map(toCard), total };
  }

  function getCard(id: string): MemoryCard | null {
    const row = selectNode.get(id) as NodeRow | undefined;
    return row ? toCard(row) : null;
  }

  /** 版本链：从最早的一版到最新的一版。 */
  function revisionChain(id: string): MemoryCard[] {
    const start = selectNode.get(id) as NodeRow | undefined;
    if (!start) return [];
    const back: NodeRow[] = [];
    let cursor: NodeRow | undefined = start;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      back.unshift(cursor);
      cursor = cursor.supersedes_id ? selectNode.get(cursor.supersedes_id) as NodeRow | undefined : undefined;
    }
    const successor = db.prepare('SELECT * FROM memory_nodes WHERE supersedes_id = ?');
    let next = successor.get(start.id) as NodeRow | undefined;
    while (next && !seen.has(next.id)) {
      seen.add(next.id);
      back.push(next);
      next = successor.get(next.id) as NodeRow | undefined;
    }
    return back.map(toCard);
  }

  function listAllForProfile(profileId: string): MemoryCard[] {
    return (db.prepare('SELECT * FROM memory_nodes WHERE profile_id = ? ORDER BY created_at, id').all(profileId) as NodeRow[]).map(toCard);
  }

  /**
   * 图谱（服务端算边）：节点是该 profile 的卡片（默认不含已删除），边三种——
   * revision（supersedes → 新版）、source（共用同一条证据消息）、entity（共用实体）。
   * 共用关系按时间串成链（相邻两张连一条），不做两两全连：几十张卡共用一个实体时图还能看。
   */
  function graph(profileId: string, options: { includeDeleted?: boolean; limit?: number } = {}): { cards: MemoryCard[]; edges: MemoryGraphEdge[]; truncated: boolean } {
    const limit = Math.min(1000, Math.max(1, options.limit ?? 500));
    const rows = (db.prepare(`SELECT * FROM memory_nodes WHERE profile_id = ? ${options.includeDeleted ? '' : "AND status != 'deleted'"} ORDER BY updated_at DESC LIMIT ?`).all(profileId, limit + 1) as NodeRow[]);
    const truncated = rows.length > limit;
    const cards = rows.slice(0, limit).map(toCard).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const ids = new Set(cards.map((card) => card.id));
    const edges: MemoryGraphEdge[] = [];
    for (const card of cards) {
      if (card.supersedesId && ids.has(card.supersedesId)) edges.push({ id: `revision:${card.supersedesId}:${card.id}`, source: card.supersedesId, target: card.id, kind: 'revision' });
    }
    const chain = (kind: 'source' | 'entity', keysOf: (card: MemoryCard) => string[]) => {
      const groups = new Map<string, MemoryCard[]>();
      for (const card of cards) for (const key of keysOf(card)) groups.set(key, [...(groups.get(key) ?? []), card]);
      const seen = new Set<string>();
      for (const members of groups.values()) {
        for (let index = 1; index < members.length; index += 1) {
          const id = `${kind}:${members[index - 1].id}:${members[index].id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          edges.push({ id, source: members[index - 1].id, target: members[index].id, kind });
        }
      }
    };
    chain('source', (card) => card.sourceMessageIds);
    chain('entity', (card) => card.entities.map((entity) => entity.toLowerCase()));
    return { cards, edges, truncated };
  }

  function profiles(): Array<{ profileId: string; active: number; total: number }> {
    return (db.prepare("SELECT profile_id AS profileId, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, COUNT(*) AS total FROM memory_nodes GROUP BY profile_id ORDER BY profile_id").all() as Array<{ profileId: string; active: number; total: number }>);
  }

  function auditEvents(input: { profileId?: string | null; nodeId?: string | null; limit?: number } = {}): MemoryAuditEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.profileId) { where.push('profile_id = ?'); params.push(input.profileId); }
    if (input.nodeId) { where.push('node_id = ?'); params.push(input.nodeId); }
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(input.limit)) || 200));
    const rows = db.prepare(`SELECT * FROM memory_audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...params, limit) as Array<{ id: number; ts: number; profile_id: string; node_id: string | null; action: string; actor: string; reason: string | null; payload: string | null }>;
    return rows.map((row) => ({ id: row.id, ts: row.ts, profileId: row.profile_id, nodeId: row.node_id, action: row.action, actor: row.actor, reason: row.reason, payload: parseJson<unknown>(row.payload, null) }));
  }

  return {
    search,
    get,
    write,
    forget,
    recall,
    list,
    listAllForProfile,
    getCard,
    revisionChain,
    graph,
    profiles,
    auditEvents,
    /** 诊断：是临时库、FTS5 在不在。 */
    storeInfo: () => ({ ephemeral, fts }),
    close(): void {
      try {
        db.close();
      } catch {
        // 已关闭。
      }
    },
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
