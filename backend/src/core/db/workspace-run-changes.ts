/**
 * 每次运行的工作区改动（P1b）：一次运行一行变更集 + 每个文件一行。
 *
 * - 由协调器的工作区 diff 检查点（`runtime/coordinator/workspace-diff`）在运行终态、最终消息 id 已知之后写入；
 * - 界面按「这一页里的助手消息 id」取摘要（卡片），点开某个文件时才取那一个文件的 patch（懒加载）；
 * - 跟着会话走：删会话 / 清空历史 / 删群 / 删工作流运行时由 `db.ts` 里对应的删除一并删掉
 *   （这个库的级联是手写的，漏一处就是孤儿行越积越多）。
 *
 * 只加表不改表，全部 `IF NOT EXISTS`。单独成文件，`db.ts` 只多一行调用。
 */
import path from 'path';

import type Database from 'better-sqlite3';

export type WorkspaceChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export interface WorkspaceRunChangeFileInput {
  path: string;
  oldPath: string | null;
  changeType: WorkspaceChangeType;
  additions: number;
  deletions: number;
  oldSize: number | null;
  newSize: number | null;
  patch: string | null;
  patchBytes: number;
  truncated: boolean;
  binary: boolean;
}

export interface WorkspaceRunChangeInput {
  id: string;
  sessionKey: string;
  surface: string | null;
  runId: string;
  runMarker: string;
  assistantMessageId: string | null;
  mode: 'git' | 'scan';
  /** 检查点时工作区的 realpath（「查看文件」据此拼绝对路径，再交给可服务路径闸门；老行没有）。 */
  workspaceRoot?: string | null;
  /** 改动文件总数（可能多于落库的文件行：超过文件数上限时只存前面的）。 */
  fileCount: number;
  additions: number;
  deletions: number;
  patchBytes: number;
  truncated: boolean;
  createdAt: number;
  files: WorkspaceRunChangeFileInput[];
}

export interface WorkspaceRunChangeFileView {
  id: number;
  path: string;
  oldPath: string | null;
  changeType: WorkspaceChangeType;
  additions: number;
  deletions: number;
  oldSize: number | null;
  newSize: number | null;
  patchBytes: number;
  truncated: boolean;
  binary: boolean;
  hasPatch: boolean;
}

export interface WorkspaceRunChangeView {
  changeId: string;
  sessionKey: string;
  runId: string;
  runMarker: string;
  messageId: string | null;
  mode: 'git' | 'scan';
  fileCount: number;
  additions: number;
  deletions: number;
  patchBytes: number;
  truncated: boolean;
  createdAt: number;
  files: WorkspaceRunChangeFileView[];
}

export interface WorkspaceRunChangeFilePatch {
  id: number;
  path: string;
  oldPath: string | null;
  changeType: WorkspaceChangeType;
  patch: string | null;
  truncated: boolean;
  binary: boolean;
  /**
   * 运行后这个文件在磁盘上的绝对路径（删除的文件、老行、路径不像相对路径时为 null）。
   * 只是一个**候选路径**：看原文走 `/api/files/*`，那里先过可服务路径闸门（realpath、白名单根、凭据文件名）再过数据面授权。
   */
  contentPath: string | null;
}

/** 变更集里的相对路径 + 工作区根 → 绝对路径。拒绝绝对路径与带 `..` 段的（库里的数据也不信）。 */
export function workspaceChangeContentPath(root: string | null | undefined, relPath: string, changeType: WorkspaceChangeType): string | null {
  if (!root || !path.isAbsolute(root) || changeType === 'deleted') return null;
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).some((segment) => segment === '..')) return null;
  return path.join(root, relPath);
}

export function applyWorkspaceRunChangesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_run_changes (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      surface TEXT,
      run_id TEXT NOT NULL,
      run_marker TEXT NOT NULL,
      assistant_message_id TEXT,
      workspace_mode TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      patch_bytes INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      workspace_root TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_run_changes_message ON workspace_run_changes(session_key, assistant_message_id);

    CREATE TABLE IF NOT EXISTS workspace_run_change_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL,
      path TEXT NOT NULL,
      old_path TEXT,
      change_type TEXT NOT NULL CHECK (change_type IN ('added', 'modified', 'deleted', 'renamed')),
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      old_size INTEGER,
      new_size INTEGER,
      patch TEXT,
      patch_bytes INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      binary INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_run_change_files_change ON workspace_run_change_files(change_id, id);
  `);
  // 工作区根晚于表本身加入（P1b 收尾「查看文件」）：已经建过表的库补一列，只加不改。
  const columns = db.prepare('PRAGMA table_info(workspace_run_changes)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'workspace_root')) db.exec('ALTER TABLE workspace_run_changes ADD COLUMN workspace_root TEXT');
}

type ChangeRow = {
  id: string; session_key: string; run_id: string; run_marker: string; assistant_message_id: string | null;
  workspace_mode: string; file_count: number; additions: number; deletions: number; patch_bytes: number; truncated: number; created_at: number;
};
type FileRow = {
  id: number; change_id: string; path: string; old_path: string | null; change_type: WorkspaceChangeType; additions: number; deletions: number;
  old_size: number | null; new_size: number | null; patch_bytes: number; truncated: number; binary: number; has_patch: number;
};

/** 一次最多按多少个消息 id 取摘要（一页历史的量级；再多就是调用方用错了）。 */
export const WORKSPACE_CHANGE_QUERY_MAX_MESSAGES = 500;

export class WorkspaceRunChangeRepository {
  constructor(private readonly db: Database.Database) {}

  save(input: WorkspaceRunChangeInput): void {
    const insertChange = this.db.prepare(`
      INSERT INTO workspace_run_changes (id, session_key, surface, run_id, run_marker, assistant_message_id, workspace_mode,
        file_count, additions, deletions, patch_bytes, truncated, created_at, workspace_root)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFile = this.db.prepare(`
      INSERT INTO workspace_run_change_files (change_id, path, old_path, change_type, additions, deletions, old_size, new_size,
        patch, patch_bytes, truncated, binary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      insertChange.run(
        input.id, input.sessionKey, input.surface, input.runId, input.runMarker, input.assistantMessageId, input.mode,
        input.fileCount, input.additions, input.deletions, input.patchBytes, input.truncated ? 1 : 0, input.createdAt,
        input.workspaceRoot ?? null,
      );
      for (const file of input.files) {
        insertFile.run(
          input.id, file.path, file.oldPath, file.changeType, file.additions, file.deletions, file.oldSize, file.newSize,
          file.patch, file.patchBytes, file.truncated ? 1 : 0, file.binary ? 1 : 0,
        );
      }
    })();
  }

  /** 按会话 + 助手消息 id 取变更集摘要（不带 patch 正文）。 */
  listForMessages(sessionKey: string, messageIds: string[]): WorkspaceRunChangeView[] {
    const ids = [...new Set(messageIds.filter(Boolean))].slice(0, WORKSPACE_CHANGE_QUERY_MAX_MESSAGES);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const changes = this.db.prepare(`
      SELECT * FROM workspace_run_changes
      WHERE session_key = ? AND assistant_message_id IN (${placeholders})
      ORDER BY created_at ASC
    `).all(sessionKey, ...ids) as ChangeRow[];
    if (changes.length === 0) return [];
    const filePlaceholders = changes.map(() => '?').join(', ');
    const files = this.db.prepare(`
      SELECT id, change_id, path, old_path, change_type, additions, deletions, old_size, new_size, patch_bytes, truncated, binary,
        CASE WHEN patch IS NULL THEN 0 ELSE 1 END AS has_patch
      FROM workspace_run_change_files WHERE change_id IN (${filePlaceholders}) ORDER BY id ASC
    `).all(...changes.map((change) => change.id)) as FileRow[];
    const byChange = new Map<string, WorkspaceRunChangeFileView[]>();
    for (const file of files) {
      const list = byChange.get(file.change_id) ?? [];
      list.push({
        id: file.id,
        path: file.path,
        oldPath: file.old_path,
        changeType: file.change_type,
        additions: file.additions,
        deletions: file.deletions,
        oldSize: file.old_size,
        newSize: file.new_size,
        patchBytes: file.patch_bytes,
        truncated: file.truncated === 1,
        binary: file.binary === 1,
        hasPatch: file.has_patch === 1,
      });
      byChange.set(file.change_id, list);
    }
    return changes.map((change) => ({
      changeId: change.id,
      sessionKey: change.session_key,
      runId: change.run_id,
      runMarker: change.run_marker,
      messageId: change.assistant_message_id,
      mode: change.workspace_mode === 'git' ? 'git' : 'scan',
      fileCount: change.file_count,
      additions: change.additions,
      deletions: change.deletions,
      patchBytes: change.patch_bytes,
      truncated: change.truncated === 1,
      createdAt: change.created_at,
      files: byChange.get(change.id) ?? [],
    }));
  }

  /** 一个文件的 patch：变更集必须属于这个会话，否则当作不存在。 */
  getFilePatch(sessionKey: string, changeId: string, fileId: number): WorkspaceRunChangeFilePatch | null {
    const row = this.db.prepare(`
      SELECT f.id, f.path, f.old_path, f.change_type, f.patch, f.truncated, f.binary, c.workspace_root
      FROM workspace_run_change_files f
      JOIN workspace_run_changes c ON c.id = f.change_id
      WHERE c.session_key = ? AND c.id = ? AND f.id = ?
    `).get(sessionKey, changeId, fileId) as { id: number; path: string; old_path: string | null; change_type: WorkspaceChangeType; patch: string | null; truncated: number; binary: number; workspace_root: string | null } | undefined;
    if (!row) return null;
    return {
      id: row.id, path: row.path, oldPath: row.old_path, changeType: row.change_type, patch: row.patch, truncated: row.truncated === 1, binary: row.binary === 1,
      contentPath: workspaceChangeContentPath(row.workspace_root, row.path, row.change_type),
    };
  }

  /** 助手消息被删（重新生成、删消息）时，挂在它上面的变更集一起删。 */
  deleteByMessages(sessionKey: string, messageIds: string[]): void {
    const ids = [...new Set(messageIds.filter(Boolean))];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM workspace_run_change_files WHERE change_id IN (SELECT id FROM workspace_run_changes WHERE session_key = ? AND assistant_message_id IN (${placeholders}))`).run(sessionKey, ...ids);
      this.db.prepare(`DELETE FROM workspace_run_changes WHERE session_key = ? AND assistant_message_id IN (${placeholders})`).run(sessionKey, ...ids);
    })();
  }

  deleteBySession(sessionKey: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workspace_run_change_files WHERE change_id IN (SELECT id FROM workspace_run_changes WHERE session_key = ?)').run(sessionKey);
      this.db.prepare('DELETE FROM workspace_run_changes WHERE session_key = ?').run(sessionKey);
    })();
  }

  /** 按会话键前缀删（群里每个外部成员是 `room:<群>:member:<成员>` 一个会话）。用 substr 比较，不让 `_` / `%` 当通配符。 */
  deleteBySessionPrefix(prefix: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workspace_run_change_files WHERE change_id IN (SELECT id FROM workspace_run_changes WHERE substr(session_key, 1, ?) = ?)').run(prefix.length, prefix);
      this.db.prepare('DELETE FROM workspace_run_changes WHERE substr(session_key, 1, ?) = ?').run(prefix.length, prefix);
    })();
  }
}
