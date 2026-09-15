/**
 * 入站 Webhook 触发工作流（spec 里对方没有）。公开路由 `POST /api/hooks/workflows/:hookId`。
 *
 * 公开路由的全部安全性都在这里，所以三道检查一个不能少：
 * 1. **时间戳窗口**：`X-ClawOPT-Timestamp`（unix 秒）与服务器时间差 ≤ 5 分钟；
 * 2. **签名**：`X-ClawOPT-Signature-256: sha256=<hex>`，HMAC-SHA256(secret, `<timestamp>.<原始请求体>`)，
 *    常数时间比较（先比长度，再 `timingSafeEqual`）；
 * 3. **防重放**：窗口内同一个签名只收一次（签名落库，主键冲突即拒绝）。
 *
 * 钩子不存在与已停用返回同一个 404——不给探测者「这个 id 存在」的信号。
 * 密钥只在创建与轮换时返回一次，之后只报 `has_secret`。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type Database from 'better-sqlite3';

import { AutomationError, HOOK_ERROR, WORKFLOW_ERROR, notFound } from '../shared/errors';
import { newId, parseJson, uniqueStrings } from '../shared/util';
import type { DefinitionStore } from '../workflow/definition-store';
import type { WorkflowEngine } from '../workflow/engine';

export const HOOK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
export const HOOK_NONCE_TTL_MS = 2 * HOOK_TIMESTAMP_WINDOW_MS;
export const MAX_HOOK_INPUT_CHARS = 100_000;

export type HookView = {
  id: string;
  workflowId: string;
  name: string;
  enabled: boolean;
  startNodeIds: string[];
  timeoutMs: number | null;
  lastTriggeredAt: number | null;
  lastRunId: string | null;
  hasSecret: boolean;
  createdAt: number;
  updatedAt: number;
};

const toView = (row: any): HookView => ({
  id: row.id,
  workflowId: row.workflow_id,
  name: row.name,
  enabled: row.enabled === 1,
  startNodeIds: parseJson(row.start_node_ids_json, []),
  timeoutMs: row.timeout_ms,
  lastTriggeredAt: row.last_triggered_at,
  lastRunId: row.last_run_id,
  hasSecret: Boolean(row.secret),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function signHookBody(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
}

/** 常数时间比较两个签名头。长度不同直接判不等（timingSafeEqual 要求等长）。 */
export function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(provided, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function hookInputFromBody(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'object' && !Array.isArray(body) && typeof (body as Record<string, unknown>).input === 'string') {
    return ((body as Record<string, unknown>).input as string).slice(0, MAX_HOOK_INPUT_CHARS);
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text ? text.slice(0, MAX_HOOK_INPUT_CHARS) : null;
}

export function createInboundHooks(deps: { db: Database.Database; defs: DefinitionStore; engine: WorkflowEngine; now?: () => number }) {
  const { db, defs, engine } = deps;
  const now = deps.now ?? Date.now;
  const row = (id: string) => db.prepare('SELECT * FROM workflow_hooks WHERE id = ?').get(id) as any;

  function requireHook(workflowId: string, id: string) {
    const found = row(id);
    if (!found || found.workflow_id !== workflowId) throw notFound(HOOK_ERROR.notFound, id);
    return found;
  }

  function parseStartNodes(workflowId: string, value: unknown): string[] {
    const def = defs.get(workflowId);
    if (!def) throw notFound(WORKFLOW_ERROR.notFound, workflowId);
    const ids = uniqueStrings(value);
    for (const id of ids) {
      if (!def.nodes.some((node) => node.id === id)) throw new AutomationError(400, WORKFLOW_ERROR.invalidBody, id, { field: 'start_node_ids' });
    }
    return ids;
  }

  function parseTimeout(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const ms = Number(value);
    if (!Number.isInteger(ms) || ms < 1_000 || ms > 86_400_000) throw new AutomationError(400, WORKFLOW_ERROR.invalidBody, 'timeout_ms', { field: 'timeout_ms' });
    return ms;
  }

  return {
    list(workflowId: string): HookView[] {
      return db.prepare('SELECT * FROM workflow_hooks WHERE workflow_id = ? ORDER BY created_at').all(workflowId).map(toView);
    },

    create(workflowId: string, body: Record<string, unknown>): { hook: HookView; secret: string } {
      const startNodeIds = parseStartNodes(workflowId, body.start_node_ids ?? body.startNodeIds);
      const id = randomBytes(18).toString('base64url');
      const secret = randomBytes(32).toString('hex');
      const at = now();
      db.prepare(`INSERT INTO workflow_hooks (id, workflow_id, name, secret, enabled, start_node_ids_json, timeout_ms, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, workflowId, typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '', secret, body.enabled === false ? 0 : 1,
        JSON.stringify(startNodeIds), parseTimeout(body.timeout_ms ?? body.timeoutMs), at, at,
      );
      return { hook: toView(row(id)), secret };
    },

    update(workflowId: string, id: string, body: Record<string, unknown>): HookView {
      const current = requireHook(workflowId, id);
      db.prepare('UPDATE workflow_hooks SET name = ?, enabled = ?, start_node_ids_json = ?, timeout_ms = ?, updated_at = ? WHERE id = ?').run(
        body.name !== undefined ? String(body.name).trim().slice(0, 120) : current.name,
        body.enabled !== undefined ? (body.enabled === true ? 1 : 0) : current.enabled,
        (body.start_node_ids ?? body.startNodeIds) !== undefined ? JSON.stringify(parseStartNodes(workflowId, body.start_node_ids ?? body.startNodeIds)) : current.start_node_ids_json,
        (body.timeout_ms ?? body.timeoutMs) !== undefined ? parseTimeout(body.timeout_ms ?? body.timeoutMs) : current.timeout_ms,
        now(), id,
      );
      return toView(row(id));
    },

    rotateSecret(workflowId: string, id: string): { hook: HookView; secret: string } {
      requireHook(workflowId, id);
      const secret = randomBytes(32).toString('hex');
      db.prepare('UPDATE workflow_hooks SET secret = ?, updated_at = ? WHERE id = ?').run(secret, now(), id);
      db.prepare('DELETE FROM workflow_hook_nonces WHERE hook_id = ?').run(id);
      return { hook: toView(row(id)), secret };
    },

    remove(workflowId: string, id: string): void {
      requireHook(workflowId, id);
      db.prepare('DELETE FROM workflow_hook_nonces WHERE hook_id = ?').run(id);
      db.prepare('DELETE FROM workflow_hooks WHERE id = ?').run(id);
    },

    deleteForWorkflow(workflowId: string): void {
      const ids = (db.prepare('SELECT id FROM workflow_hooks WHERE workflow_id = ?').all(workflowId) as Array<{ id: string }>).map((item) => item.id);
      for (const id of ids) db.prepare('DELETE FROM workflow_hook_nonces WHERE hook_id = ?').run(id);
      db.prepare('DELETE FROM workflow_hooks WHERE workflow_id = ?').run(workflowId);
    },

    /** 校验 + 触发。任何一道检查不过都在启动运行之前拒绝。 */
    async trigger(hookId: string, input: { rawBody: Buffer; body: unknown; timestamp: string | undefined; signature: string | undefined }) {
      const hook = typeof hookId === 'string' && hookId.length <= 64 ? row(hookId) : undefined;
      if (!hook || hook.enabled !== 1) throw notFound(HOOK_ERROR.notFound, 'hook not found');
      const at = now();
      const ts = input.timestamp && /^\d{1,12}$/.test(input.timestamp) ? Number(input.timestamp) * 1000 : NaN;
      if (!Number.isFinite(ts) || Math.abs(at - ts) > HOOK_TIMESTAMP_WINDOW_MS) {
        throw new AutomationError(401, HOOK_ERROR.timestampOutOfWindow, 'timestamp outside the allowed window');
      }
      const provided = typeof input.signature === 'string' ? input.signature.trim() : '';
      const expected = signHookBody(hook.secret, input.timestamp!, input.rawBody);
      if (!signaturesMatch(expected, provided)) throw new AutomationError(401, HOOK_ERROR.signatureInvalid, 'signature mismatch');
      db.prepare('DELETE FROM workflow_hook_nonces WHERE expires_at <= ?').run(at);
      const fresh = db.prepare('INSERT OR IGNORE INTO workflow_hook_nonces (hook_id, signature, expires_at) VALUES (?, ?, ?)')
        .run(hook.id, provided, at + HOOK_NONCE_TTL_MS).changes === 1;
      if (!fresh) throw new AutomationError(409, HOOK_ERROR.replayed, 'signature already used');

      const run = await engine.startRun(hook.workflow_id, {
        input: hookInputFromBody(input.body),
        startNodeIds: parseJson<string[]>(hook.start_node_ids_json, []).length ? parseJson<string[]>(hook.start_node_ids_json, []) : undefined,
        timeoutMs: hook.timeout_ms,
        triggerSource: 'hook',
      });
      db.prepare('UPDATE workflow_hooks SET last_triggered_at = ?, last_run_id = ? WHERE id = ?').run(at, run.id, hook.id);
      return { runId: run.id, workflowId: hook.workflow_id, requestId: newId() };
    },
  };
}

export type InboundHooks = ReturnType<typeof createInboundHooks>;
