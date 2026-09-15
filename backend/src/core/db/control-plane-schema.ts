/**
 * 控制面（P5a）的表：多用户与授权、登录 IP 锁、服务商审计、模型目录缓存与偏好、写入审批。
 *
 * 只加表不改表（增量 schema），全部 `IF NOT EXISTS`，重复执行无害。
 * 单独成文件是为了让 `db.ts` 的改动只有一行调用——那个文件多条线在并行改。
 */
import type Database from 'better-sqlite3';

export function applyControlPlaneSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    );

    -- 用户 ↔ Agent 授权。super_admin / admin 不看这张表（全量可见）。
    CREATE TABLE IF NOT EXISTS user_agents (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (user_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS login_ip_locks (
      ip TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      first_failure_at INTEGER NOT NULL,
      locked_until INTEGER
    );

    -- 服务商编辑审计。details 入库前已脱敏；90 天 / 1 万行上限由写入方裁剪。
    CREATE TABLE IF NOT EXISTS provider_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor_user_id INTEGER,
      actor_username TEXT,
      actor_role TEXT,
      provider_id TEXT NOT NULL,
      action TEXT NOT NULL,
      fields TEXT,
      result TEXT NOT NULL,
      details TEXT,
      revision_before TEXT,
      revision_after TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_provider_audit_ts ON provider_audit(ts);

    -- 模型目录缓存：每个服务商一行，带一步撤销快照。
    CREATE TABLE IF NOT EXISTS model_catalog (
      provider_id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      models TEXT NOT NULL DEFAULT '[]',
      unavailable_models TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'live',
      updated_at INTEGER NOT NULL,
      previous_models TEXT,
      previous_unavailable_models TEXT,
      previous_updated_at INTEGER
    );

    -- 只影响界面挑选器的偏好（引擎配置不动）：可见性白名单。
    CREATE TABLE IF NOT EXISTS model_prefs (
      provider_id TEXT PRIMARY KEY,
      visibility_mode TEXT NOT NULL DEFAULT 'all' CHECK (visibility_mode IN ('all', 'include')),
      visible_models TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    -- Agent 头像：存在 ClawOPT 自己的库里、按 Agent id 取，不写引擎目录，也不走按路径出文件。
    CREATE TABLE IF NOT EXISTS agent_avatars (
      agent_id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS write_gate_settings (
      agent_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- 受守护文件的「已批准」内容。content 为 NULL 表示该文件被批准为不存在。
    CREATE TABLE IF NOT EXISTS write_gate_baselines (
      agent_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      content TEXT,
      hash TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, rel_path)
    );

    CREATE TABLE IF NOT EXISTS write_gate_pending (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      base_content TEXT,
      base_hash TEXT,
      proposed_content TEXT,
      proposed_hash TEXT,
      origin TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_write_gate_pending_agent ON write_gate_pending(agent_id, rel_path);
  `);
}
