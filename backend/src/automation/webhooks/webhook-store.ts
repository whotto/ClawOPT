/**
 * 端点与 outbox 仓储。
 *
 * outbox 是**数据库表**，不是内存队列：进程重启时 `delivering` 的行回到 `pending` 再投一次
 * （至少一次）；接收方按事件 id 去重。每个端点严格先进先出：队头没投完（成功 / 最终失败），后面的不动。
 */
import type Database from 'better-sqlite3';

import { AutomationError, WEBHOOK_ERROR, notFound } from '../shared/errors';
import { newId, parseJson } from '../shared/util';
import { WEBHOOK_EVENT_TYPES } from './webhook-events';

export type EndpointRecord = {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  eventTypes: string[];
  enabled: boolean;
  includeContent: boolean;
  allowPrivateNetwork: boolean;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
};

/** 给前端的形状：没有 secret，只有 has_secret。 */
export type EndpointView = Omit<EndpointRecord, 'secret'> & { hasSecret: boolean };

export type OutboxRow = {
  id: number;
  endpointId: string;
  eventId: string;
  eventType: string;
  payloadJson: string;
  status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'dropped';
  attempts: number;
  nextAttemptAt: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: number;
  finishedAt: number | null;
};

const endpointFromRow = (row: any): EndpointRecord => ({
  id: row.id,
  name: row.name,
  url: row.url,
  secret: row.secret,
  eventTypes: parseJson(row.event_types_json, []),
  enabled: row.enabled === 1,
  includeContent: row.include_content === 1,
  allowPrivateNetwork: row.allow_private_network === 1,
  maxRetries: row.max_retries,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const outboxFromRow = (row: any): OutboxRow => ({
  id: row.id,
  endpointId: row.endpoint_id,
  eventId: row.event_id,
  eventType: row.event_type,
  payloadJson: row.payload_json,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastStatus: row.last_status,
  lastError: row.last_error,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

export function toEndpointView(record: EndpointRecord): EndpointView {
  const { secret, ...rest } = record;
  return { ...rest, hasSecret: Boolean(secret) };
}

const invalid = (field: string) => new AutomationError(400, WEBHOOK_ERROR.invalidBody, field, { field });

export function parseEndpointBody(body: Record<string, unknown>, current?: EndpointRecord) {
  const name = body.name !== undefined ? String(body.name).trim() : current?.name ?? '';
  if (!name || name.length > 100) throw invalid('name');
  const url = body.url !== undefined ? String(body.url).trim() : current?.url ?? '';
  if (!url || url.length > 2048) throw invalid('url');
  const rawTypes = body.event_types ?? body.eventTypes;
  const eventTypes = rawTypes !== undefined ? rawTypes : current?.eventTypes;
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) throw invalid('event_types');
  const types = [...new Set(eventTypes.map(String))];
  if (types.some((type) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(type))) throw invalid('event_types');
  const maxRetriesRaw = body.max_retries ?? body.maxRetries;
  const maxRetries = maxRetriesRaw !== undefined ? Number(maxRetriesRaw) : current?.maxRetries ?? 3;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw invalid('max_retries');
  // 凭据只进不出：空串 = 不修改；显式 clear_secret 才清空。
  let secret = current?.secret ?? null;
  if (typeof body.secret === 'string' && body.secret.length) {
    if (body.secret.length > 4096) throw invalid('secret');
    secret = body.secret;
  }
  if (body.clear_secret === true || body.clearSecret === true) secret = null;
  const flag = (snake: string, camel: string, fallback: boolean) => {
    const value = body[snake] ?? body[camel];
    return value === undefined ? fallback : value === true;
  };
  return {
    name,
    url,
    secret,
    eventTypes: types,
    enabled: flag('enabled', 'enabled', current?.enabled ?? true),
    includeContent: flag('include_content', 'includeContent', current?.includeContent ?? false),
    allowPrivateNetwork: flag('allow_private_network', 'allowPrivateNetwork', current?.allowPrivateNetwork ?? false),
    maxRetries,
  };
}

export function createWebhookStore(db: Database.Database, now: () => number = Date.now) {
  const store = {
    listEndpoints(): EndpointRecord[] {
      return db.prepare('SELECT * FROM webhook_endpoints ORDER BY created_at').all().map(endpointFromRow);
    },

    getEndpoint(id: string): EndpointRecord {
      const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id);
      if (!row) throw notFound(WEBHOOK_ERROR.notFound, id);
      return endpointFromRow(row);
    },

    saveEndpoint(input: ReturnType<typeof parseEndpointBody>, id?: string): EndpointRecord {
      const at = now();
      if (id) {
        db.prepare(`UPDATE webhook_endpoints SET name = ?, url = ?, secret = ?, event_types_json = ?, enabled = ?, include_content = ?,
            allow_private_network = ?, max_retries = ?, updated_at = ? WHERE id = ?`).run(
          input.name, input.url, input.secret, JSON.stringify(input.eventTypes), input.enabled ? 1 : 0, input.includeContent ? 1 : 0,
          input.allowPrivateNetwork ? 1 : 0, input.maxRetries, at, id,
        );
        return store.getEndpoint(id);
      }
      const newEndpointId = newId();
      db.prepare(`INSERT INTO webhook_endpoints (id, name, url, secret, event_types_json, enabled, include_content, allow_private_network,
          max_retries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newEndpointId, input.name, input.url, input.secret, JSON.stringify(input.eventTypes), input.enabled ? 1 : 0,
        input.includeContent ? 1 : 0, input.allowPrivateNetwork ? 1 : 0, input.maxRetries, at, at,
      );
      return store.getEndpoint(newEndpointId);
    },

    deleteEndpoint(id: string): void {
      store.getEndpoint(id);
      db.transaction(() => {
        db.prepare("UPDATE webhook_outbox SET status = 'dropped', finished_at = ? WHERE endpoint_id = ? AND status IN ('pending', 'delivering')").run(now(), id);
        db.prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(id);
      })();
    },

    /** 入队；同一端点同一事件 id 只入一次。返回是否真的新入队。 */
    enqueue(endpointId: string, eventId: string, eventType: string, payloadJson: string): boolean {
      const at = now();
      return db.prepare(`INSERT OR IGNORE INTO webhook_outbox (endpoint_id, event_id, event_type, payload_json, status, attempts, next_attempt_at, created_at)
        VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`).run(endpointId, eventId, eventType, payloadJson, at, at).changes === 1;
    },

    /** 端点队头：最早的未完成行。 */
    head(endpointId: string): OutboxRow | null {
      const row = db.prepare("SELECT * FROM webhook_outbox WHERE endpoint_id = ? AND status IN ('pending', 'delivering') ORDER BY id ASC LIMIT 1").get(endpointId);
      return row ? outboxFromRow(row) : null;
    },

    markDelivering(id: number): void {
      db.prepare("UPDATE webhook_outbox SET status = 'delivering', attempts = attempts + 1 WHERE id = ?").run(id);
    },

    markDelivered(id: number, status: number): void {
      db.prepare("UPDATE webhook_outbox SET status = 'delivered', last_status = ?, last_error = NULL, finished_at = ? WHERE id = ?").run(status, now(), id);
    },

    markRetry(id: number, status: number, error: string | null, nextAttemptAt: number): void {
      db.prepare("UPDATE webhook_outbox SET status = 'pending', last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?").run(status, error, nextAttemptAt, id);
    },

    markFailed(id: number, status: number, error: string | null): void {
      db.prepare("UPDATE webhook_outbox SET status = 'failed', last_status = ?, last_error = ?, finished_at = ? WHERE id = ?").run(status, error, now(), id);
    },

    /** 启动时：上次投到一半的行回到 pending（至少一次）。 */
    resetInFlight(): number {
      return db.prepare("UPDATE webhook_outbox SET status = 'pending' WHERE status = 'delivering'").run().changes;
    },

    stats(endpointId: string) {
      const counts = db.prepare('SELECT status, COUNT(*) AS n FROM webhook_outbox WHERE endpoint_id = ? GROUP BY status').all(endpointId) as Array<{ status: string; n: number }>;
      const last = db.prepare('SELECT * FROM webhook_outbox WHERE endpoint_id = ? AND attempts > 0 ORDER BY COALESCE(finished_at, next_attempt_at) DESC LIMIT 1').get(endpointId);
      const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.n]));
      return {
        pending: (byStatus.pending ?? 0) + (byStatus.delivering ?? 0),
        delivered: byStatus.delivered ?? 0,
        failed: byStatus.failed ?? 0,
        dropped: byStatus.dropped ?? 0,
        last: last ? outboxFromRow(last) : null,
      };
    },

    recentDeliveries(endpointId: string, limit = 20): OutboxRow[] {
      return db.prepare('SELECT * FROM webhook_outbox WHERE endpoint_id = ? ORDER BY id DESC LIMIT ?').all(endpointId, limit).map(outboxFromRow);
    },

    pruneFinished(olderThan: number): void {
      db.prepare("DELETE FROM webhook_outbox WHERE status IN ('delivered', 'failed', 'dropped') AND finished_at < ?").run(olderThan);
    },
  };
  return store;
}

export type WebhookStore = ReturnType<typeof createWebhookStore>;
