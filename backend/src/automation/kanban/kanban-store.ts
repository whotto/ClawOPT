import type Database from 'better-sqlite3';

import { newId, parseJson } from '../shared/util';

export const KANBAN_STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived'] as const;
export type KanbanStatus = typeof KANBAN_STATUSES[number];
export const DEFAULT_BOARD_ID = 'default';

export type BoardRecord = { id: string; name: string; description: string; archived: boolean; createdAt: number; updatedAt: number };
export type TaskRecord = {
  id: string;
  boardId: string;
  title: string;
  body: string;
  assignee: { kind: 'openclaw' | 'external'; id: string } | null;
  status: KanbanStatus;
  priority: number;
  workspacePath: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};
export type CommentRecord = { id: string; taskId: string; author: string; body: string; createdAt: number };
export type EventRecord = { id: string; taskId: string; kind: string; payload: Record<string, unknown>; runId: string | null; createdAt: number };
export type RunRecord = {
  id: string; taskId: string; agentKind: string; agentId: string; sessionId: string;
  status: 'running' | 'completed' | 'failed' | 'canceled'; output: string | null; error: string | null; startedAt: number; endedAt: number | null;
};

const boardFromRow = (row: any): BoardRecord => ({
  id: row.id, name: row.name, description: row.description, archived: row.archived === 1, createdAt: row.created_at, updatedAt: row.updated_at,
});
const taskFromRow = (row: any): TaskRecord => ({
  id: row.id,
  boardId: row.board_id,
  title: row.title,
  body: row.body,
  assignee: row.assignee_kind && row.assignee_id ? { kind: row.assignee_kind, id: row.assignee_id } : null,
  status: row.status,
  priority: row.priority,
  workspacePath: row.workspace_path,
  result: row.result,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

export function createKanbanStore(db: Database.Database, now: () => number = Date.now) {
  const store = {
    ensureDefaultBoard(): void {
      const at = now();
      db.prepare("INSERT OR IGNORE INTO kanban_boards (id, name, description, archived, created_at, updated_at) VALUES (?, 'Default', '', 0, ?, ?)")
        .run(DEFAULT_BOARD_ID, at, at);
    },
    listBoards(): Array<BoardRecord & { counts: Record<string, number>; total: number }> {
      store.ensureDefaultBoard();
      const boards = db.prepare('SELECT * FROM kanban_boards ORDER BY created_at').all().map(boardFromRow);
      const counts = db.prepare('SELECT board_id, status, COUNT(*) AS n FROM kanban_tasks GROUP BY board_id, status').all() as Array<{ board_id: string; status: string; n: number }>;
      return boards.map((board) => {
        const byStatus: Record<string, number> = {};
        for (const row of counts) if (row.board_id === board.id) byStatus[row.status] = row.n;
        return { ...board, counts: byStatus, total: Object.values(byStatus).reduce((sum, n) => sum + n, 0) };
      });
    },
    getBoard(id: string): BoardRecord | null {
      const row = db.prepare('SELECT * FROM kanban_boards WHERE id = ?').get(id);
      return row ? boardFromRow(row) : null;
    },
    createBoard(name: string, description: string): BoardRecord {
      const id = newId();
      const at = now();
      db.prepare('INSERT INTO kanban_boards (id, name, description, archived, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run(id, name, description, at, at);
      return store.getBoard(id)!;
    },
    updateBoard(id: string, patch: { name?: string; description?: string; archived?: boolean }): BoardRecord {
      const current = store.getBoard(id)!;
      db.prepare('UPDATE kanban_boards SET name = ?, description = ?, archived = ?, updated_at = ? WHERE id = ?').run(
        patch.name ?? current.name, patch.description ?? current.description, (patch.archived ?? current.archived) ? 1 : 0, now(), id,
      );
      return store.getBoard(id)!;
    },

    listTasks(boardId: string, filter: { statuses?: string[]; assigneeId?: string; query?: string } = {}): TaskRecord[] {
      const clauses = ['board_id = ?'];
      const params: unknown[] = [boardId];
      if (filter.statuses?.length) {
        clauses.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
        params.push(...filter.statuses);
      }
      if (filter.assigneeId) {
        clauses.push('assignee_id = ?');
        params.push(filter.assigneeId);
      }
      if (filter.query) {
        clauses.push('(title LIKE ? OR body LIKE ?)');
        params.push(`%${filter.query}%`, `%${filter.query}%`);
      }
      return db.prepare(`SELECT * FROM kanban_tasks WHERE ${clauses.join(' AND ')} ORDER BY priority DESC, updated_at DESC LIMIT 1000`).all(...params).map(taskFromRow);
    },
    getTask(id: string): TaskRecord | null {
      const row = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id);
      return row ? taskFromRow(row) : null;
    },
    createTask(input: Omit<TaskRecord, 'id' | 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt' | 'result'>): TaskRecord {
      const id = newId();
      const at = now();
      db.prepare(`INSERT INTO kanban_tasks (id, board_id, title, body, assignee_kind, assignee_id, status, priority, workspace_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.boardId, input.title, input.body, input.assignee?.kind ?? null, input.assignee?.id ?? null, input.status, input.priority,
        input.workspacePath, at, at,
      );
      return store.getTask(id)!;
    },
    updateTask(id: string, patch: Partial<Pick<TaskRecord, 'title' | 'body' | 'assignee' | 'priority' | 'workspacePath' | 'result'>>): TaskRecord {
      const current = store.getTask(id)!;
      const next = { ...current, ...patch };
      db.prepare(`UPDATE kanban_tasks SET title = ?, body = ?, assignee_kind = ?, assignee_id = ?, priority = ?, workspace_path = ?, result = ?, updated_at = ?
        WHERE id = ?`).run(next.title, next.body, next.assignee?.kind ?? null, next.assignee?.id ?? null, next.priority, next.workspacePath, next.result, now(), id);
      return store.getTask(id)!;
    },
    /** 条件状态迁移：只有当前状态还在 `from` 里才改（读后改之间被别人改过就返回 false）。 */
    transition(id: string, from: readonly string[], to: KanbanStatus, extra: { result?: string | null } = {}): boolean {
      const at = now();
      const result = db.prepare(`UPDATE kanban_tasks SET status = ?, updated_at = ?,
          started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
          completed_at = CASE WHEN ? = 'done' THEN ? WHEN ? IN ('ready', 'todo', 'triage') THEN NULL ELSE completed_at END,
          result = COALESCE(?, result)
        WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`).run(to, at, to, at, to, at, to, extra.result ?? null, id, ...from);
      return result.changes === 1;
    },

    addComment(taskId: string, author: string, body: string): CommentRecord {
      const id = newId();
      db.prepare('INSERT INTO kanban_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, taskId, author, body, now());
      return { id, taskId, author, body, createdAt: now() };
    },
    comments(taskId: string): CommentRecord[] {
      return (db.prepare('SELECT * FROM kanban_comments WHERE task_id = ? ORDER BY created_at').all(taskId) as any[])
        .map((row) => ({ id: row.id, taskId: row.task_id, author: row.author, body: row.body, createdAt: row.created_at }));
    },
    addEvent(taskId: string, kind: string, payload: Record<string, unknown> = {}, runId: string | null = null): void {
      db.prepare('INSERT INTO kanban_events (id, task_id, kind, payload_json, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), taskId, kind, JSON.stringify(payload), runId, now());
    },
    events(taskId: string): EventRecord[] {
      return (db.prepare('SELECT * FROM kanban_events WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as any[])
        .map((row) => ({ id: row.id, taskId: row.task_id, kind: row.kind, payload: parseJson(row.payload_json, {}), runId: row.run_id, createdAt: row.created_at }));
    },
    createRun(taskId: string, agent: { kind: string; id: string }, sessionId: string): RunRecord {
      const id = newId();
      db.prepare("INSERT INTO kanban_runs (id, task_id, agent_kind, agent_id, session_id, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
        .run(id, taskId, agent.kind, agent.id, sessionId, now());
      return store.runs(taskId).find((run) => run.id === id)!;
    },
    finishRun(runId: string, status: RunRecord['status'], output: string | null, error: string | null): boolean {
      return db.prepare("UPDATE kanban_runs SET status = ?, output = ?, error = ?, ended_at = ? WHERE id = ? AND status = 'running'")
        .run(status, output, error, now(), runId).changes === 1;
    },
    runs(taskId: string): RunRecord[] {
      return (db.prepare('SELECT * FROM kanban_runs WHERE task_id = ? ORDER BY started_at DESC').all(taskId) as any[]).map((row) => ({
        id: row.id, taskId: row.task_id, agentKind: row.agent_kind, agentId: row.agent_id, sessionId: row.session_id, status: row.status,
        output: row.output, error: row.error, startedAt: row.started_at, endedAt: row.ended_at,
      }));
    },
    activeRun(taskId: string): RunRecord | null {
      return store.runs(taskId).find((run) => run.status === 'running') ?? null;
    },
    link(parentId: string, childId: string): void {
      db.prepare('INSERT OR IGNORE INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)').run(parentId, childId, now());
    },
    unlink(parentId: string, childId: string): boolean {
      return db.prepare('DELETE FROM kanban_links WHERE parent_id = ? AND child_id = ?').run(parentId, childId).changes === 1;
    },
    children(parentId: string): string[] {
      return (db.prepare('SELECT child_id FROM kanban_links WHERE parent_id = ?').all(parentId) as Array<{ child_id: string }>).map((row) => row.child_id);
    },
    parents(childId: string): string[] {
      return (db.prepare('SELECT parent_id FROM kanban_links WHERE child_id = ?').all(childId) as Array<{ parent_id: string }>).map((row) => row.parent_id);
    },
    /** 启动时：上次进程里还在跑的派活没有人会来收尾了——标失败，任务退回 blocked。 */
    recoverRunning(): number {
      const rows = db.prepare("SELECT id, task_id FROM kanban_runs WHERE status = 'running'").all() as Array<{ id: string; task_id: string }>;
      for (const row of rows) {
        store.finishRun(row.id, 'failed', null, 'server restarted');
        if (store.transition(row.task_id, ['running'], 'blocked')) store.addEvent(row.task_id, 'recovered_after_restart', {}, row.id);
      }
      return rows.length;
    },
  };
  return store;
}

export type KanbanStore = ReturnType<typeof createKanbanStore>;
