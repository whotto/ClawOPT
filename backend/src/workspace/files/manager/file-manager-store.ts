/**
 * 文件管理器的配置：super_admin 配的额外根与远端连接（SSH / Docker）。表只加不改，`IF NOT EXISTS`。
 * 私钥只存本机路径，永不回给前端（只报 `hasKey`）。
 */
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

export type ExtraRootRow = { id: string; name: string; path: string; createdAt: number };

export type ConnectionRow = {
  id: string;
  kind: 'ssh' | 'docker';
  name: string;
  host: string | null;
  port: number | null;
  user: string | null;
  keyPath: string | null;
  container: string | null;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
};

export function createFileManagerStore(sql: Database.Database, now: () => number = Date.now) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS file_manager_extra_roots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_manager_connections (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('ssh', 'docker')),
      name TEXT NOT NULL,
      host TEXT,
      port INTEGER,
      user TEXT,
      key_path TEXT,
      container TEXT,
      root_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const mapRoot = (row: any): ExtraRootRow => ({ id: row.id, name: row.name, path: row.path, createdAt: row.created_at });
  const mapConnection = (row: any): ConnectionRow => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    host: row.host,
    port: row.port,
    user: row.user,
    keyPath: row.key_path,
    container: row.container,
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    listExtraRoots(): ExtraRootRow[] {
      return (sql.prepare('SELECT * FROM file_manager_extra_roots ORDER BY created_at').all() as any[]).map(mapRoot);
    },
    getExtraRoot(id: string): ExtraRootRow | null {
      const row = sql.prepare('SELECT * FROM file_manager_extra_roots WHERE id = ?').get(id);
      return row ? mapRoot(row) : null;
    },
    addExtraRoot(input: { name: string; path: string }): ExtraRootRow {
      const id = randomUUID();
      sql.prepare('INSERT INTO file_manager_extra_roots (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(id, input.name, input.path, now());
      return this.getExtraRoot(id)!;
    },
    removeExtraRoot(id: string): boolean {
      return sql.prepare('DELETE FROM file_manager_extra_roots WHERE id = ?').run(id).changes > 0;
    },
    listConnections(): ConnectionRow[] {
      return (sql.prepare('SELECT * FROM file_manager_connections ORDER BY created_at').all() as any[]).map(mapConnection);
    },
    getConnection(id: string): ConnectionRow | null {
      const row = sql.prepare('SELECT * FROM file_manager_connections WHERE id = ?').get(id);
      return row ? mapConnection(row) : null;
    },
    saveConnection(input: Omit<ConnectionRow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): ConnectionRow {
      const id = input.id ?? randomUUID();
      const at = now();
      sql.prepare(`
        INSERT INTO file_manager_connections (id, kind, name, host, port, user, key_path, container, root_path, created_at, updated_at)
        VALUES (@id, @kind, @name, @host, @port, @user, @keyPath, @container, @rootPath, @at, @at)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host, port = excluded.port, user = excluded.user,
          key_path = excluded.key_path, container = excluded.container, root_path = excluded.root_path, updated_at = excluded.updated_at
      `).run({ id, kind: input.kind, name: input.name, host: input.host, port: input.port, user: input.user, keyPath: input.keyPath, container: input.container, rootPath: input.rootPath, at });
      return this.getConnection(id)!;
    },
    removeConnection(id: string): boolean {
      return sql.prepare('DELETE FROM file_manager_connections WHERE id = ?').run(id).changes > 0;
    },
  };
}

export type FileManagerStore = ReturnType<typeof createFileManagerStore>;
