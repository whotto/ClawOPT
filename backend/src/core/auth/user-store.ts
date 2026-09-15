/**
 * 用户、角色与 用户↔Agent 授权。
 *
 * 角色三级：`super_admin`（管用户、全部能力）> `admin`（改配置、全部 Agent）> `member`（只读，只见被授权的 Agent）。
 *
 * ## 不变量
 *
 * - **最后一个启用中的 super_admin 不能被降级、停用或删除。** 否则这台主机就没人能再管用户了，
 *   而 ClawOPT 刻意不提供「匿名重置」通道（那正是默认口令类漏洞的来源）。
 * - **不存在默认账号。** 用户只经三条路出现：启动迁移（沿用管理员已设置的登录口令）、
 *   通用设置里首次开启登录时设置口令、super_admin 在用户页新建。
 * - 口令只存 scrypt 哈希（沿用 `auth-store.ts` 的 `hashPassword`）；接口永远不回口令字段。
 */
import type Database from 'better-sqlite3';

import { hashPassword, verifyPassword } from './auth-store';

export type AuthRole = 'super_admin' | 'admin' | 'member';
export type UserStatus = 'active' | 'disabled';

export const AUTH_ROLES: readonly AuthRole[] = ['super_admin', 'admin', 'member'];
const ROLE_RANK: Record<AuthRole, number> = { member: 0, admin: 1, super_admin: 2 };

export function roleAtLeast(role: AuthRole, required: AuthRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export type UserRecord = {
  id: number;
  username: string;
  role: AuthRole;
  status: UserStatus;
  mustChangePassword: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
};

/** 给前端的形状：没有口令哈希。 */
export type PublicUser = UserRecord & { agentIds: string[] };

export class UserStoreError extends Error {
  constructor(readonly errorCode: string, readonly status: number, message?: string) {
    super(message ?? errorCode);
    this.name = 'UserStoreError';
  }
}

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
/** 用户不存在时也跑一次 scrypt，免得靠响应耗时枚举用户名。 */
const DUMMY_HASH = hashPassword('clawopt-dummy-password-for-timing');

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: AuthRole;
  status: UserStatus;
  must_change_password: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
};

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

function assertRole(role: unknown): AuthRole {
  if (typeof role === 'string' && (AUTH_ROLES as readonly string[]).includes(role)) return role as AuthRole;
  throw new UserStoreError('users.invalidRole', 400);
}

function assertStatus(status: unknown): UserStatus {
  if (status === 'active' || status === 'disabled') return status;
  throw new UserStoreError('users.invalidStatus', 400);
}

export function validateNewPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new UserStoreError('users.passwordTooShort', 400);
  }
  return password;
}

export type CreateUserInput = {
  username: string;
  password?: string;
  /** 迁移路径：沿用已存在的 scrypt 哈希，不重新要求口令强度。 */
  passwordHash?: string;
  role: AuthRole;
  status?: UserStatus;
  mustChangePassword?: boolean;
};

export type UpdateUserInput = {
  role?: AuthRole;
  status?: UserStatus;
  password?: string;
  agentIds?: string[];
};

export class UserStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  list(): PublicUser[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
    return rows.map((row) => ({ ...toRecord(row), agentIds: this.getAgentIds(row.id) }));
  }

  get(id: number): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toRecord(row) : null;
  }

  findByUsername(username: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 第一个启用中的 super_admin：旧版（无用户 id 的）会话归属到它。 */
  firstActiveSuperAdmin(): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE role = 'super_admin' AND status = 'active' ORDER BY id LIMIT 1").get() as UserRow | undefined;
    return row ? toRecord(row) : null;
  }

  create(input: CreateUserInput): PublicUser {
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    if (!USERNAME_PATTERN.test(username)) throw new UserStoreError('users.invalidUsername', 400);
    const role = assertRole(input.role);
    const status = assertStatus(input.status ?? 'active');
    const passwordHash = input.passwordHash ?? hashPassword(validateNewPassword(input.password));
    if (this.findByUsername(username)) throw new UserStoreError('users.usernameTaken', 409);
    const ts = this.now();
    const result = this.db.prepare(
      'INSERT INTO users (username, password_hash, role, status, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(username, passwordHash, role, status, input.mustChangePassword ? 1 : 0, ts, ts);
    const created = this.get(Number(result.lastInsertRowid))!;
    return { ...created, agentIds: [] };
  }

  update(id: number, input: UpdateUserInput): PublicUser {
    const existing = this.get(id);
    if (!existing) throw new UserStoreError('users.notFound', 404);
    const role = input.role !== undefined ? assertRole(input.role) : existing.role;
    const status = input.status !== undefined ? assertStatus(input.status) : existing.status;
    const losesSuperAdmin = existing.role === 'super_admin' && existing.status === 'active' && (role !== 'super_admin' || status !== 'active');

    const apply = this.db.transaction(() => {
      if (losesSuperAdmin && this.countActiveSuperAdmins() <= 1) {
        throw new UserStoreError('users.lastSuperAdmin', 409);
      }
      const ts = this.now();
      this.db.prepare('UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?').run(role, status, ts, id);
      if (input.password !== undefined && input.password !== '') {
        this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
          .run(hashPassword(validateNewPassword(input.password)), ts, id);
      }
      if (input.agentIds !== undefined) this.replaceAgentIds(id, input.agentIds);
    });
    apply();
    return { ...this.get(id)!, agentIds: this.getAgentIds(id) };
  }

  delete(id: number): void {
    const existing = this.get(id);
    if (!existing) throw new UserStoreError('users.notFound', 404);
    const remove = this.db.transaction(() => {
      if (existing.role === 'super_admin' && existing.status === 'active' && this.countActiveSuperAdmins() <= 1) {
        throw new UserStoreError('users.lastSuperAdmin', 409);
      }
      this.db.prepare('DELETE FROM user_agents WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    remove();
  }

  /** 校验登录。停用的用户与不存在的用户同样返回 null（不区分，防枚举）。 */
  verifyLogin(username: string, password: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    const ok = verifyPassword(String(password ?? ''), row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok || row.status !== 'active') return null;
    return toRecord(row);
  }

  /** 本人改口令：要先证明知道旧口令。 */
  changeOwnPassword(id: number, currentPassword: string, nextPassword: string): void {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!row) throw new UserStoreError('users.notFound', 404);
    if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) {
      throw new UserStoreError('users.currentPasswordInvalid', 403);
    }
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(hashPassword(validateNewPassword(nextPassword)), this.now(), id);
  }

  /** 通用设置里改登录口令（管理员已登录或登录未开启）：不要求旧口令，但同样检查强度。 */
  setPassword(id: number, nextPassword: string): void {
    if (!this.get(id)) throw new UserStoreError('users.notFound', 404);
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(hashPassword(validateNewPassword(nextPassword)), this.now(), id);
  }

  recordLogin(id: number): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.now(), id);
  }

  getAgentIds(id: number): string[] {
    return (this.db.prepare('SELECT agent_id FROM user_agents WHERE user_id = ? ORDER BY agent_id').all(id) as { agent_id: string }[])
      .map((row) => row.agent_id);
  }

  hasAgent(id: number, agentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM user_agents WHERE user_id = ? AND agent_id = ?').get(id, agentId);
  }

  private replaceAgentIds(id: number, agentIds: string[]): void {
    const clean = [...new Set(agentIds.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
    this.db.prepare('DELETE FROM user_agents WHERE user_id = ?').run(id);
    const insert = this.db.prepare('INSERT INTO user_agents (user_id, agent_id) VALUES (?, ?)');
    for (const agentId of clean) insert.run(id, agentId);
  }

  private countActiveSuperAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND status = 'active'").get() as { n: number }).n;
  }
}
