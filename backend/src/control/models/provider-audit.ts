/**
 * 服务商编辑审计（spec 05 F5）：谁、什么时候、对哪个服务商、做了什么、改了哪些字段、结果如何。
 *
 * - details 入库前脱敏：键名像凭据的值换成 `[redacted]`，URL 去掉用户信息、查询串与片段；
 * - 保留 90 天、最多 1 万行，写入时顺手裁剪；
 * - **审计写失败只记日志，绝不让主请求失败**——审计是旁路，不是闸门。
 */
import type { RequestIdentity } from '../../core/auth';
import type { DB } from '../../core/db';

export type ProviderAuditAction =
  | 'provider.create'
  | 'provider.update'
  | 'provider.delete'
  | 'provider.test'
  | 'provider.context.update'
  | 'provider.visibility.update'
  | 'provider.models.refresh'
  | 'provider.models.refresh.preview'
  | 'provider.models.restore';

export type ProviderAuditResult = 'success' | 'failed' | 'conflict';

export type ProviderAuditEntry = {
  id: number;
  ts: number;
  actor: { userId: number | null; username: string | null; role: string | null };
  providerId: string;
  action: string;
  fields: string[];
  result: string;
  details: unknown;
  revisionBefore: string | null;
  revisionAfter: string | null;
};

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 10_000;
const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|credential)/i;

export function sanitizeAuditDetails(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth]';
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        return value;
      }
    }
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeAuditDetails(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : sanitizeAuditDetails(item, depth + 1)]));
}

type Row = {
  id: number;
  ts: number;
  actor_user_id: number | null;
  actor_username: string | null;
  actor_role: string | null;
  provider_id: string;
  action: string;
  fields: string | null;
  result: string;
  details: string | null;
  revision_before: string | null;
  revision_after: string | null;
};

export function createProviderAudit(deps: { db: DB; now?: () => number; log?: (message: string) => void }) {
  const sql = deps.db.connection();
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(message));

  function record(input: {
    identity: RequestIdentity | null;
    providerId: string;
    action: ProviderAuditAction;
    result: ProviderAuditResult;
    fields?: string[];
    details?: unknown;
    revisionBefore?: string | null;
    revisionAfter?: string | null;
  }): void {
    try {
      const ts = now();
      sql.prepare('INSERT INTO provider_audit (ts, actor_user_id, actor_username, actor_role, provider_id, action, fields, result, details, revision_before, revision_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          ts,
          input.identity?.userId ?? null,
          input.identity?.username ?? null,
          input.identity?.role ?? null,
          input.providerId,
          input.action,
          JSON.stringify(input.fields ?? []),
          input.result,
          input.details === undefined ? null : JSON.stringify(sanitizeAuditDetails(input.details)),
          input.revisionBefore ?? null,
          input.revisionAfter ?? null,
        );
      sql.prepare('DELETE FROM provider_audit WHERE ts < ?').run(ts - RETENTION_MS);
      sql.prepare('DELETE FROM provider_audit WHERE id NOT IN (SELECT id FROM provider_audit ORDER BY id DESC LIMIT ?)').run(MAX_ROWS);
    } catch (error) {
      log(`[ProviderAudit] append failed: ${(error as { code?: string })?.code ?? 'error'}`);
    }
  }

  function list(options: { limit?: number; providerId?: string } = {}): ProviderAuditEntry[] {
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
    const rows = (options.providerId
      ? sql.prepare('SELECT * FROM provider_audit WHERE provider_id = ? ORDER BY id DESC LIMIT ?').all(options.providerId, limit)
      : sql.prepare('SELECT * FROM provider_audit ORDER BY id DESC LIMIT ?').all(limit)) as Row[];
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      actor: { userId: row.actor_user_id, username: row.actor_username, role: row.actor_role },
      providerId: row.provider_id,
      action: row.action,
      fields: (() => {
        try {
          return JSON.parse(row.fields ?? '[]');
        } catch {
          return [];
        }
      })(),
      result: row.result,
      details: (() => {
        try {
          return row.details ? JSON.parse(row.details) : null;
        } catch {
          return null;
        }
      })(),
      revisionBefore: row.revision_before,
      revisionAfter: row.revision_after,
    }));
  }

  return { record, list };
}

export type ProviderAudit = ReturnType<typeof createProviderAudit>;
