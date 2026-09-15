/**
 * 终端审计：只记生命周期（签发票据、打开、接回、断开、关闭、空闲回收、退出、拒绝），**不记按键**——
 * 按键里会有人在 sudo / ssh 提示下敲的口令，审计表会变成一张口令表。
 */
import type Database from 'better-sqlite3';

export const TERMINAL_AUDIT_EVENTS = ['ticket_issued', 'open', 'attach', 'detach', 'close', 'kill_idle', 'kill_shutdown', 'exit', 'reject'] as const;
export type TerminalAuditEvent = (typeof TERMINAL_AUDIT_EVENTS)[number];

export type TerminalAuditRow = {
  id: number;
  ts: number;
  userId: number | null;
  username: string | null;
  sessionId: string | null;
  event: TerminalAuditEvent;
  shell: string | null;
  detail: string | null;
};

const MAX_ROWS = 5000;

export function createTerminalAudit(sql: Database.Database, now: () => number = Date.now) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS terminal_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id INTEGER,
      username TEXT,
      session_id TEXT,
      event TEXT NOT NULL,
      shell TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_audit_ts ON terminal_audit(ts);
  `);
  const insert = sql.prepare('INSERT INTO terminal_audit (ts, user_id, username, session_id, event, shell, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const prune = sql.prepare('DELETE FROM terminal_audit WHERE id <= (SELECT id FROM terminal_audit ORDER BY id DESC LIMIT 1 OFFSET ?)');
  let writes = 0;

  return {
    record(entry: { userId: number | null; username: string | null; sessionId?: string | null; event: TerminalAuditEvent; shell?: string | null; detail?: string | null }): void {
      try {
        insert.run(now(), entry.userId, entry.username, entry.sessionId ?? null, entry.event, entry.shell ?? null, entry.detail ? entry.detail.slice(0, 500) : null);
        writes += 1;
        if (writes % 200 === 0) prune.run(MAX_ROWS);
      } catch (error) {
        console.warn(`[Terminal] audit write failed: ${(error as Error)?.name ?? 'Error'}`);
      }
    },
    list(limit = 200): TerminalAuditRow[] {
      const capped = Math.min(1000, Math.max(1, Math.floor(limit) || 200));
      const rows = sql.prepare('SELECT * FROM terminal_audit ORDER BY id DESC LIMIT ?').all(capped) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: Number(row.id),
        ts: Number(row.ts),
        userId: row.user_id === null ? null : Number(row.user_id),
        username: (row.username as string | null) ?? null,
        sessionId: (row.session_id as string | null) ?? null,
        event: row.event as TerminalAuditEvent,
        shell: (row.shell as string | null) ?? null,
        detail: (row.detail as string | null) ?? null,
      }));
    },
  };
}

export type TerminalAudit = ReturnType<typeof createTerminalAudit>;
