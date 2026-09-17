/**
 * 每次运行的范围令牌（ClawOPT 作为 MCP 服务，spec 07 §3.4）。
 *
 * - 令牌是 32 字节随机数，**库里只存 sha256**；签发时只交给这一次运行的 MCP 子进程；
 * - 绑定运行（runId / 会话键 / Agent / 运行时 / 表面）、范围（Agent、会话、群、工作流）与操作白名单；
 * - TTL 有上限；运行结束（`chat.run.completed|failed|aborted`）立即吊销；服务停机全部吊销；
 * - **绝不**从用户登录会话或任何主令牌派生，也不回落到它们——桥接口只认这张表里的令牌。
 *
 * 审计表只记操作名、结果与已脱敏的短码，不记参数（参数里可能有记忆正文、对话内容）。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type Database from 'better-sqlite3';

/** 缺省 TTL：2 小时。长运行（工作流节点）靠这个上限兜底，不靠「永不过期」。 */
export const MCP_TOKEN_DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
/** TTL 的硬上限：再长的运行也不给超过 12 小时的令牌。 */
export const MCP_TOKEN_MAX_TTL_MS = 12 * 60 * 60 * 1000;
/** 审计保留行数上限（写入时裁剪）。 */
export const MCP_AUDIT_MAX_ROWS = 10_000;

export type McpSurface = 'single-chat' | 'group-chat' | 'workflow' | 'kanban' | 'other';

export type McpTokenScope = {
  /** 授权判定用的 Agent id（`accessAgentId` 形状）。 */
  agentIds: string[];
  sessionKeys: string[];
  workflowIds: string[];
  roomId: string | null;
  /** chat_run 允许委派的目标（管理员按运行时配置；缺省空）。 */
  delegateAgents: string[];
  /** 这次运行本身是委派出来的：签发时不含 chat_run（深度上限 1）。 */
  delegated: boolean;
};

export type McpTokenRecord = {
  id: string;
  runId: string;
  sessionKey: string;
  agentId: string;
  runtime: string;
  surface: McpSurface;
  scope: McpTokenScope;
  operations: string[];
  /** 签发时捕获的可信证据消息 id（调用时会再刷新一次）。 */
  evidenceIds: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokeReason: string | null;
};

export type McpAuditOutcome = 'allowed' | 'denied_scope' | 'denied_operation' | 'expired' | 'revoked' | 'invalid' | 'failed';

export type McpAuditRow = {
  id: number;
  ts: number;
  tokenId: string | null;
  runId: string | null;
  runtime: string | null;
  agentId: string | null;
  operation: string;
  outcome: McpAuditOutcome;
  detail: string | null;
};

export type TokenVerdict =
  | { ok: true; record: McpTokenRecord }
  | { ok: false; outcome: 'invalid' | 'expired' | 'revoked'; record: McpTokenRecord | null };

type TokenRow = {
  id: string;
  token_hash: string;
  run_id: string;
  session_key: string;
  agent_id: string;
  runtime: string;
  surface: string;
  scope_json: string;
  operations_json: string;
  evidence_json: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
};

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function ensureMcpServerSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      surface TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_tokens_run ON mcp_tokens(run_id);
    CREATE TABLE IF NOT EXISTS mcp_token_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      token_id TEXT,
      run_id TEXT,
      runtime TEXT,
      agent_id TEXT,
      operation TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_token_audit_ts ON mcp_token_audit(ts);
    CREATE TABLE IF NOT EXISTS mcp_server_settings (
      runtime TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      toolsets_json TEXT NOT NULL DEFAULT '[]',
      delegate_agents_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `);
}

function parseList(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toRecord(row: TokenRow): McpTokenRecord {
  let scope: McpTokenScope;
  try {
    const parsed = JSON.parse(row.scope_json);
    scope = {
      agentIds: Array.isArray(parsed.agentIds) ? parsed.agentIds : [],
      sessionKeys: Array.isArray(parsed.sessionKeys) ? parsed.sessionKeys : [],
      workflowIds: Array.isArray(parsed.workflowIds) ? parsed.workflowIds : [],
      roomId: typeof parsed.roomId === 'string' ? parsed.roomId : null,
      delegateAgents: Array.isArray(parsed.delegateAgents) ? parsed.delegateAgents : [],
      delegated: parsed.delegated === true,
    };
  } catch {
    // 范围读不懂：当作空范围（一切资源判定都会拒绝），不当作全开。
    scope = { agentIds: [], sessionKeys: [], workflowIds: [], roomId: null, delegateAgents: [], delegated: true };
  }
  return {
    id: row.id,
    runId: row.run_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    runtime: row.runtime,
    surface: row.surface as McpSurface,
    scope,
    operations: parseList(row.operations_json),
    evidenceIds: parseList(row.evidence_json),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
}

export function createMcpTokenStore(db: Database.Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  ensureMcpServerSchema(db);

  const insert = db.prepare(`INSERT INTO mcp_tokens (id, token_hash, run_id, session_key, agent_id, runtime, surface, scope_json, operations_json, evidence_json, issued_at, expires_at)
    VALUES (@id, @token_hash, @run_id, @session_key, @agent_id, @runtime, @surface, @scope_json, @operations_json, @evidence_json, @issued_at, @expires_at)`);
  const byHash = db.prepare('SELECT * FROM mcp_tokens WHERE token_hash = ?');
  const auditInsert = db.prepare('INSERT INTO mcp_token_audit (ts, token_id, run_id, runtime, agent_id, operation, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

  function mint(input: {
    runId: string;
    sessionKey: string;
    agentId: string;
    runtime: string;
    surface: McpSurface;
    scope: McpTokenScope;
    operations: string[];
    evidenceIds?: string[];
    ttlMs?: number;
  }): { token: string; record: McpTokenRecord } {
    const token = randomBytes(32).toString('base64url');
    const issuedAt = now();
    const ttl = Math.min(Math.max(1000, input.ttlMs ?? MCP_TOKEN_DEFAULT_TTL_MS), MCP_TOKEN_MAX_TTL_MS);
    const row: TokenRow = {
      id: randomUUID(),
      token_hash: hashMcpToken(token),
      run_id: input.runId,
      session_key: input.sessionKey,
      agent_id: input.agentId,
      runtime: input.runtime,
      surface: input.surface,
      scope_json: JSON.stringify(input.scope),
      operations_json: JSON.stringify([...new Set(input.operations)]),
      evidence_json: JSON.stringify(input.evidenceIds ?? []),
      issued_at: issuedAt,
      expires_at: issuedAt + ttl,
      revoked_at: null,
      revoke_reason: null,
    };
    insert.run(row);
    return { token, record: toRecord(row) };
  }

  /** 校验令牌：按哈希取行后再做一次常数时间比较；过期、吊销分别报。 */
  function verify(presented: string | null | undefined): TokenVerdict {
    if (typeof presented !== 'string' || presented.length < 16 || presented.length > 256) return { ok: false, outcome: 'invalid', record: null };
    const hash = hashMcpToken(presented);
    const row = byHash.get(hash) as TokenRow | undefined;
    if (!row) return { ok: false, outcome: 'invalid', record: null };
    const expected = Buffer.from(row.token_hash, 'hex');
    const actual = Buffer.from(hash, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, outcome: 'invalid', record: null };
    const record = toRecord(row);
    if (record.revokedAt !== null) return { ok: false, outcome: 'revoked', record };
    if (now() >= record.expiresAt) return { ok: false, outcome: 'expired', record };
    return { ok: true, record };
  }

  function revokeRun(runId: string, reason: string): number {
    return db.prepare('UPDATE mcp_tokens SET revoked_at = ?, revoke_reason = ? WHERE run_id = ? AND revoked_at IS NULL').run(now(), reason, runId).changes;
  }

  function revokeId(id: string, reason: string): boolean {
    return db.prepare('UPDATE mcp_tokens SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL').run(now(), reason, id).changes > 0;
  }

  function revokeAll(reason: string): number {
    return db.prepare('UPDATE mcp_tokens SET revoked_at = ?, revoke_reason = ? WHERE revoked_at IS NULL').run(now(), reason).changes;
  }

  /** 生效中的令牌（未吊销、未过期）。不回哈希。 */
  function listActive(): McpTokenRecord[] {
    return (db.prepare('SELECT * FROM mcp_tokens WHERE revoked_at IS NULL AND expires_at > ? ORDER BY issued_at DESC LIMIT 500').all(now()) as TokenRow[]).map(toRecord);
  }

  function get(id: string): McpTokenRecord | null {
    const row = db.prepare('SELECT * FROM mcp_tokens WHERE id = ?').get(id) as TokenRow | undefined;
    return row ? toRecord(row) : null;
  }

  function audit(entry: { record: McpTokenRecord | null; operation: string; outcome: McpAuditOutcome; detail?: string | null }): void {
    const detail = entry.detail ? entry.detail.replace(/[\r\n]+/g, ' ').slice(0, 200) : null;
    auditInsert.run(now(), entry.record?.id ?? null, entry.record?.runId ?? null, entry.record?.runtime ?? null, entry.record?.agentId ?? null, entry.operation.slice(0, 80), entry.outcome, detail);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM mcp_token_audit').get() as { n: number }).n;
    if (count > MCP_AUDIT_MAX_ROWS) {
      db.prepare('DELETE FROM mcp_token_audit WHERE id IN (SELECT id FROM mcp_token_audit ORDER BY id ASC LIMIT ?)').run(count - MCP_AUDIT_MAX_ROWS);
    }
  }

  function listAudit(limit = 200): McpAuditRow[] {
    const rows = db.prepare('SELECT * FROM mcp_token_audit ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(1, limit), 1000)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      ts: Number(row.ts),
      tokenId: (row.token_id as string | null) ?? null,
      runId: (row.run_id as string | null) ?? null,
      runtime: (row.runtime as string | null) ?? null,
      agentId: (row.agent_id as string | null) ?? null,
      operation: String(row.operation),
      outcome: row.outcome as McpAuditOutcome,
      detail: (row.detail as string | null) ?? null,
    }));
  }

  return { mint, verify, revokeRun, revokeId, revokeAll, listActive, get, audit, listAudit };
}

export type McpTokenStore = ReturnType<typeof createMcpTokenStore>;
