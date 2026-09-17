/**
 * 记忆 sidecar 的库结构与版本化迁移（spec 06 §4.2）。
 *
 * - 每个组件一行版本号（`memory_schema_version`），迁移在 `BEGIN IMMEDIATE` 事务里跑，锁冲突重试 3 次；
 * - FTS5 不可用（极少数自编译的 SQLite）时不建镜像表，检索退回逐卡片打分，并在结果里报 `degraded: 'ftsUnavailable'`；
 * - 唯一部分索引：同一 (profile, 作用域, 键) 只能有一张 active 卡——并发的两次写入最多一个成功，另一个按约束失败整批回滚。
 */
import type Database from 'better-sqlite3';

type Migration = { version: number; up: (db: Database.Database, fts: boolean) => void };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db, fts) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_messages (
          profile_id TEXT NOT NULL,
          id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          origin TEXT,
          created_at TEXT,
          captured_at INTEGER NOT NULL,
          PRIMARY KEY (profile_id, id)
        );

        CREATE TABLE IF NOT EXISTS memory_nodes (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          supersedes_id TEXT,
          profile_id TEXT NOT NULL,
          scope_type TEXT NOT NULL CHECK (scope_type IN ('profile', 'context', 'session')),
          scope_ns TEXT NOT NULL DEFAULT '',
          scope_id TEXT NOT NULL,
          origin TEXT,
          kind TEXT NOT NULL,
          domain TEXT NOT NULL,
          category_path TEXT NOT NULL,
          type TEXT NOT NULL,
          key TEXT NOT NULL,
          revision INTEGER NOT NULL,
          value_json TEXT,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'expired', 'deleted')),
          confidence REAL NOT NULL,
          importance REAL NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          entities TEXT NOT NULL DEFAULT '[]',
          source_message_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS memory_nodes_active_slot
          ON memory_nodes(profile_id, scope_type, scope_ns, scope_id, key) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS memory_nodes_profile_status ON memory_nodes(profile_id, status);
        CREATE INDEX IF NOT EXISTS memory_nodes_updated ON memory_nodes(updated_at);

        CREATE TABLE IF NOT EXISTS memory_audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          profile_id TEXT NOT NULL,
          node_id TEXT,
          action TEXT NOT NULL CHECK (action IN ('create', 'update', 'supersede', 'expire', 'delete', 'forget')),
          actor TEXT NOT NULL,
          reason TEXT,
          payload TEXT
        );
        CREATE INDEX IF NOT EXISTS memory_audit_ts ON memory_audit_events(ts);

        -- 嵌入钩子：不随包提供模型；接了 EmbeddingProvider 才有行。
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          node_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          dims INTEGER NOT NULL,
          vector TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      if (fts) {
        // 独立 FTS 表：写入的是已经切好的词（汉字二元组 + 拉丁词），unicode61 按空格切回来。与卡片行在同一事务里同步。
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(node_id UNINDEXED, title, content, key, tags, entities, value, tokenize = 'unicode61')`);
      }
    },
  },
];

export const MEMORY_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function detectFts5(db: Database.Database): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.memory_fts_probe USING fts5(x); DROP TABLE temp.memory_fts_probe;');
    return true;
  } catch {
    return false;
  }
}

function isLockError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? '';
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

export function migrateMemorySchema(db: Database.Database, options: { fts: boolean }): void {
  db.exec('CREATE TABLE IF NOT EXISTS memory_schema_version (component TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  const run = db.transaction(() => {
    const row = db.prepare("SELECT version FROM memory_schema_version WHERE component = 'memory'").get() as { version: number } | undefined;
    const current = row?.version ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      migration.up(db, options.fts);
    }
    db.prepare("INSERT INTO memory_schema_version (component, version) VALUES ('memory', ?) ON CONFLICT(component) DO UPDATE SET version = excluded.version").run(MEMORY_SCHEMA_VERSION);
    // FTS5 后来才可用（换了 SQLite）：补建镜像表，交给服务启动时重建索引。
    if (options.fts) migration1Fts(db);
  });
  for (let attempt = 1; ; attempt += 1) {
    try {
      run.immediate();
      return;
    } catch (error) {
      if (!isLockError(error) || attempt >= 3) throw error;
    }
  }
}

function migration1Fts(db: Database.Database): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(node_id UNINDEXED, title, content, key, tags, entities, value, tokenize = 'unicode61')`);
}
