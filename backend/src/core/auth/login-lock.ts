/**
 * 登录失败按来源 IP 计数与锁定。
 *
 * 规则：窗口内连续失败 `maxFailures` 次 → 锁 `lockMs`；登录成功清零；管理员可在用户页解锁。
 * 落 SQLite 而不是内存：重启不该等于「免费再试五次」。
 *
 * 来源 IP 的取法见 `resolveClientIp`：只有 TCP 对端是本机回环（同机反向代理）时才信
 * `X-Real-IP` / `X-Forwarded-For` 的第一跳，直连时这些头由客户端随便写，信了就能换 IP 绕锁。
 */
import type Database from 'better-sqlite3';

export type LoginLockPolicy = { maxFailures: number; windowMs: number; lockMs: number };

export const DEFAULT_LOGIN_LOCK_POLICY: LoginLockPolicy = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
};

export type LoginLockEntry = { ip: string; failures: number; firstFailureAt: number; lockedUntil: number | null };

type Row = { ip: string; failures: number; first_failure_at: number; locked_until: number | null };

export class LoginLockStore {
  constructor(
    private readonly db: Database.Database,
    private readonly policy: LoginLockPolicy = DEFAULT_LOGIN_LOCK_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /** 锁着就返回剩余毫秒，否则 0。 */
  lockedFor(ip: string): number {
    const row = this.db.prepare('SELECT * FROM login_ip_locks WHERE ip = ?').get(ip) as Row | undefined;
    if (!row?.locked_until) return 0;
    return Math.max(0, row.locked_until - this.now());
  }

  recordFailure(ip: string): LoginLockEntry {
    const ts = this.now();
    const row = this.db.prepare('SELECT * FROM login_ip_locks WHERE ip = ?').get(ip) as Row | undefined;
    const windowExpired = !row || ts - row.first_failure_at > this.policy.windowMs || (row.locked_until !== null && row.locked_until <= ts);
    const failures = windowExpired ? 1 : row!.failures + 1;
    const firstFailureAt = windowExpired ? ts : row!.first_failure_at;
    const lockedUntil = failures >= this.policy.maxFailures ? ts + this.policy.lockMs : null;
    this.db.prepare(
      'INSERT INTO login_ip_locks (ip, failures, first_failure_at, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, first_failure_at = excluded.first_failure_at, locked_until = excluded.locked_until',
    ).run(ip, failures, firstFailureAt, lockedUntil);
    return { ip, failures, firstFailureAt, lockedUntil };
  }

  recordSuccess(ip: string): void {
    this.db.prepare('DELETE FROM login_ip_locks WHERE ip = ?').run(ip);
  }

  /** 当前处于锁定中的 IP。 */
  listLocked(): LoginLockEntry[] {
    const rows = this.db.prepare('SELECT * FROM login_ip_locks WHERE locked_until IS NOT NULL AND locked_until > ? ORDER BY locked_until DESC').all(this.now()) as Row[];
    return rows.map((row) => ({ ip: row.ip, failures: row.failures, firstFailureAt: row.first_failure_at, lockedUntil: row.locked_until }));
  }

  unlock(ip: string): boolean {
    return this.db.prepare('DELETE FROM login_ip_locks WHERE ip = ?').run(ip).changes > 0;
  }

  unlockAll(): number {
    return this.db.prepare('DELETE FROM login_ip_locks').run().changes;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function resolveClientIp(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>): string {
  const remote = (remoteAddress || '').trim() || 'unknown';
  if (!LOOPBACK.has(remote)) return remote;
  const realIp = headers['x-real-ip'];
  const forwarded = headers['x-forwarded-for'];
  const candidate = (Array.isArray(realIp) ? realIp[0] : realIp)
    || (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0];
  const trimmed = (candidate || '').trim();
  return trimmed && trimmed.length <= 64 ? trimmed : remote;
}
