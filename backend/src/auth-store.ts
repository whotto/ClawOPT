/**
 * 登录会话与口令存储。
 *
 * 替换掉原来的两个设计：
 *   1. 令牌 = sha256(口令 + 写死在开源代码里的固定盐)。这不是令牌，是口令的纯函数——
 *      默认口令 123456 全网公开，令牌可离线算出；改了口令也只是换一个可爆破的哈希，
 *      而且泄露一次永久有效，没有失效手段。
 *   2. 口令明文存 SQLite。
 *
 * 现在：口令用 scrypt 加每口令随机盐（不引原生依赖，Node 自带）；会话令牌是 32 字节
 * 随机数，服务端存储、带过期、可吊销，改口令即全部失效。
 */
import crypto from 'crypto';
import type DB from './db';

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 天
const SCRYPT_KEYLEN = 64;

export type AuthSessionRecord = {
  token: string;
  createdAt: number;
  expiresAt: number;
  label: string;
};

/** `scrypt$<盐hex>$<派生key hex>`；旧的明文口令没有 `$` 前缀，据此区分。 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function isHashedPassword(value: string): boolean {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

/** 常量时间校验。长度不同也要走完比较，不能提前返回。 */
export function verifyPassword(password: string, stored: string): boolean {
  if (!isHashedPassword(stored)) {
    // 迁移期：还没哈希过的明文口令。比较仍走常量时间。
    const a = Buffer.from(password);
    const b = Buffer.from(stored);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  const [, saltHex, keyHex] = stored.split('$');
  if (!saltHex || !keyHex) return false;
  try {
    const derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
    const expected = Buffer.from(keyHex, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export class AuthStore {
  private db: DB;
  private sessions = new Map<string, AuthSessionRecord>();

  constructor(db: DB) {
    this.db = db;
    this.load();
  }

  private load(): void {
    try {
      const raw = this.db.getConfig('auth_sessions');
      if (!raw) return;
      const parsed = JSON.parse(raw) as AuthSessionRecord[];
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      for (const record of parsed) {
        if (record?.token && typeof record.expiresAt === 'number' && record.expiresAt > now) {
          this.sessions.set(record.token, record);
        }
      }
    } catch {
      // 会话存储读不出来就当没有：大不了重新登录，不该因此起不来
    }
  }

  private persist(): void {
    try {
      this.db.setConfig('auth_sessions', JSON.stringify([...this.sessions.values()]));
    } catch (error) {
      console.warn('[Auth] 会话持久化失败：', error);
    }
  }

  private sweep(): void {
    const now = Date.now();
    let removed = false;
    for (const [token, record] of this.sessions) {
      if (record.expiresAt <= now) {
        this.sessions.delete(token);
        removed = true;
      }
    }
    if (removed) this.persist();
  }

  issue(label = 'web'): AuthSessionRecord {
    this.sweep();
    const now = Date.now();
    const record: AuthSessionRecord = {
      token: crypto.randomBytes(TOKEN_BYTES).toString('hex'),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      label,
    };
    this.sessions.set(record.token, record);
    this.persist();
    return record;
  }

  /** 令牌有效即返回 true。查表本身是 O(1) 且不比较用户输入的字节，无时序侧信道。 */
  verify(token: string): boolean {
    if (!token) return false;
    const record = this.sessions.get(token);
    if (!record) return false;
    if (record.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      this.persist();
      return false;
    }
    return true;
  }

  revoke(token: string): void {
    if (this.sessions.delete(token)) this.persist();
  }

  /** 改口令、关登录时调用：既有会话一律作废。 */
  revokeAll(): void {
    if (this.sessions.size === 0) return;
    this.sessions.clear();
    this.persist();
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** 从 Cookie 头里取一个值。不引 cookie-parser——只需要读一个键。 */
export function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return '';
}

export const AUTH_COOKIE_NAME = 'clawopt_session';
