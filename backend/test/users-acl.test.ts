/**
 * 多用户与授权（P5a）：
 * - 最后一个启用中的 super_admin 不能被降级 / 停用 / 删除；
 * - 登录 IP 锁：失败计数、锁定、成功清零、管理员解锁；来源 IP 只在同机代理时信转发头；
 * - 启动迁移：沿用管理员设过的口令；默认口令只在「登录已开启」时迁出且必须先改；
 * - 中间件：登录未开启 = 隐式主人；member 不能过管理员闸门；Agent 作用域只放行被授权的；
 *   必须改口令的用户除了改口令什么都做不了。
 */
import Database from 'better-sqlite3';
import type express from 'express';
import { describe, expect, it } from 'vitest';
import {
  AuthStore,
  createAuthMiddleware,
  getRequestIdentity,
  hashPassword,
  LoginLockStore,
  migrateLegacyLoginPassword,
  resolveClientIp,
  UserStore,
} from '../src/core/auth';
import { applyControlPlaneSchema } from '../src/core/db/control-plane-schema';

function memoryDb() {
  const db = new Database(':memory:');
  applyControlPlaneSchema(db);
  return db;
}

function configDb() {
  const store = new Map<string, string>();
  return { getConfig: (key: string) => store.get(key), setConfig: (key: string, value: string) => { store.set(key, value); } } as any;
}

describe('UserStore', () => {
  it('建用户不回口令哈希；用户名唯一（忽略大小写）；口令至少 8 位', () => {
    const users = new UserStore(memoryDb());
    const created = users.create({ username: 'Alice', password: 'correct-horse', role: 'admin' });
    expect(Object.keys(created)).not.toContain('password_hash');
    expect(JSON.stringify(created)).not.toContain('scrypt$');
    expect(() => users.create({ username: 'alice', password: 'another-pass', role: 'member' })).toThrowError(/usernameTaken/);
    expect(() => users.create({ username: 'bob', password: 'short', role: 'member' })).toThrowError(/passwordTooShort/);
    expect(() => users.create({ username: 'bad name', password: 'long-enough', role: 'member' })).toThrowError(/invalidUsername/);
  });

  it('最后一个启用中的 super_admin 不能被降级、停用或删除；有第二个之后可以', () => {
    const users = new UserStore(memoryDb());
    const root = users.create({ username: 'root', password: 'root-password', role: 'super_admin' });
    expect(() => users.update(root.id, { role: 'admin' })).toThrowError(/lastSuperAdmin/);
    expect(() => users.update(root.id, { status: 'disabled' })).toThrowError(/lastSuperAdmin/);
    expect(() => users.delete(root.id)).toThrowError(/lastSuperAdmin/);
    expect(users.get(root.id)?.role).toBe('super_admin');

    const second = users.create({ username: 'second', password: 'second-password', role: 'super_admin' });
    expect(users.update(root.id, { role: 'admin' }).role).toBe('admin');
    // 现在 second 是唯一的了
    expect(() => users.delete(second.id)).toThrowError(/lastSuperAdmin/);
  });

  it('停用的 super_admin 不计入「还有别的主人」', () => {
    const users = new UserStore(memoryDb());
    const a = users.create({ username: 'a', password: 'password-a', role: 'super_admin' });
    const b = users.create({ username: 'b', password: 'password-b', role: 'super_admin' });
    users.update(b.id, { status: 'disabled' });
    expect(() => users.update(a.id, { role: 'member' })).toThrowError(/lastSuperAdmin/);
  });

  it('登录校验：停用用户与不存在用户一样失败；Agent 授权可替换', () => {
    const users = new UserStore(memoryDb());
    users.create({ username: 'root', password: 'root-password', role: 'super_admin' });
    const m = users.create({ username: 'm', password: 'member-password', role: 'member' });
    expect(users.verifyLogin('m', 'member-password')?.id).toBe(m.id);
    expect(users.verifyLogin('m', 'wrong-password')).toBeNull();
    expect(users.verifyLogin('ghost', 'member-password')).toBeNull();
    users.update(m.id, { agentIds: ['writer', 'coder', 'writer', ''] });
    expect(users.getAgentIds(m.id)).toEqual(['coder', 'writer']);
    expect(users.hasAgent(m.id, 'coder')).toBe(true);
    users.update(m.id, { status: 'disabled' });
    expect(users.verifyLogin('m', 'member-password')).toBeNull();
  });
});

describe('LoginLockStore', () => {
  it('窗口内 5 次失败即锁，锁期内 lockedFor > 0，成功清零，管理员可解锁', () => {
    let now = 1_000_000;
    const locks = new LoginLockStore(memoryDb(), { maxFailures: 5, windowMs: 60_000, lockMs: 120_000 }, () => now);
    for (let i = 0; i < 4; i += 1) expect(locks.recordFailure('1.2.3.4').lockedUntil).toBeNull();
    expect(locks.recordFailure('1.2.3.4').lockedUntil).toBe(now + 120_000);
    expect(locks.lockedFor('1.2.3.4')).toBe(120_000);
    expect(locks.listLocked().map((entry) => entry.ip)).toEqual(['1.2.3.4']);
    expect(locks.unlock('1.2.3.4')).toBe(true);
    expect(locks.lockedFor('1.2.3.4')).toBe(0);

    locks.recordFailure('5.6.7.8');
    locks.recordSuccess('5.6.7.8');
    now += 1;
    expect(locks.recordFailure('5.6.7.8').failures).toBe(1);
  });

  it('窗口过期后重新计数', () => {
    let now = 0;
    const locks = new LoginLockStore(memoryDb(), { maxFailures: 3, windowMs: 1000, lockMs: 1000 }, () => now);
    locks.recordFailure('ip');
    locks.recordFailure('ip');
    now = 5000;
    expect(locks.recordFailure('ip').failures).toBe(1);
  });

  it('只有对端是本机回环时才信转发头', () => {
    expect(resolveClientIp('203.0.113.9', { 'x-forwarded-for': '1.1.1.1' })).toBe('203.0.113.9');
    expect(resolveClientIp('127.0.0.1', { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' })).toBe('198.51.100.7');
    expect(resolveClientIp('::1', { 'x-real-ip': '198.51.100.8' })).toBe('198.51.100.8');
    expect(resolveClientIp('127.0.0.1', {})).toBe('127.0.0.1');
  });
});

describe('migrateLegacyLoginPassword', () => {
  const raw = (value: Record<string, unknown>) => () => JSON.stringify(value);

  it('沿用管理员设过的口令（哈希原样搬），不要求改口令', () => {
    const users = new UserStore(memoryDb());
    const stored = hashPassword('my-own-password');
    const outcome = migrateLegacyLoginPassword({ userStore: users, readRawAppConfig: raw({ loginEnabled: true, loginPassword: stored }) });
    expect(outcome).toEqual({ status: 'created', username: 'admin', mustChangePassword: false });
    expect(users.verifyLogin('admin', 'my-own-password')?.role).toBe('super_admin');
  });

  it('明文存储的旧口令也能迁出', () => {
    const users = new UserStore(memoryDb());
    migrateLegacyLoginPassword({ userStore: users, readRawAppConfig: raw({ loginEnabled: false, loginPassword: 'plain-legacy-pw' }) });
    expect(users.verifyLogin('admin', 'plain-legacy-pw')).not.toBeNull();
  });

  it('默认口令 + 登录已开启：迁出但必须先改口令', () => {
    const users = new UserStore(memoryDb());
    const outcome = migrateLegacyLoginPassword({ userStore: users, readRawAppConfig: raw({ loginEnabled: true, loginPassword: hashPassword('123456') }) });
    expect(outcome).toEqual({ status: 'created', username: 'admin', mustChangePassword: true });
    expect(users.findByUsername('admin')?.mustChangePassword).toBe(true);
  });

  it('默认口令或无口令 + 登录未开启：不建任何用户（没有默认账号）', () => {
    for (const config of [{}, { loginPassword: hashPassword('123456') }, { loginEnabled: false }]) {
      const users = new UserStore(memoryDb());
      expect(migrateLegacyLoginPassword({ userStore: users, readRawAppConfig: raw(config) }).status).toBe('skipped');
      expect(users.count()).toBe(0);
    }
  });

  it('已有用户就跳过；读不懂的配置按空处理', () => {
    const users = new UserStore(memoryDb());
    users.create({ username: 'root', password: 'root-password', role: 'super_admin' });
    expect(migrateLegacyLoginPassword({ userStore: users, readRawAppConfig: raw({ loginEnabled: true, loginPassword: 'x-legacy-pw' }) })).toEqual({ status: 'skipped', reason: 'usersExist' });
    const empty = new UserStore(memoryDb());
    expect(migrateLegacyLoginPassword({ userStore: empty, readRawAppConfig: () => '{broken' }).status).toBe('skipped');
  });
});

describe('createAuthMiddleware', () => {
  function setup(loginEnabled: boolean) {
    const users = new UserStore(memoryDb());
    const authStore = new AuthStore(configDb());
    const auth = createAuthMiddleware({ authStore, userStore: users, configManager: { getConfig: () => ({ loginEnabled }) } as any });
    return { users, authStore, auth };
  }

  function request(token: string | null, url = '/api/something', params: Record<string, string> = {}) {
    return {
      header: (name: string) => (name.toLowerCase() === 'x-clawopt-auth-token' && token ? token : undefined),
      headers: {},
      originalUrl: url,
      params,
    } as unknown as express.Request;
  }

  function run(middleware: express.RequestHandler, req: express.Request): Promise<{ status: number | null; code: string | null }> {
    return new Promise((resolve) => {
      middleware(req, {} as express.Response, (error?: any) => {
        resolve(error ? { status: error.status, code: error.payload?.errorCode } : { status: null, code: null });
      });
    });
  }

  it('登录未开启：隐式主人，一切放行', async () => {
    const { auth } = setup(false);
    const req = request(null);
    expect(await run(auth.requireSuperAdmin, req)).toEqual({ status: null, code: null });
    expect(getRequestIdentity(req)).toMatchObject({ role: 'super_admin', implicit: true });
  });

  it('member 过不了管理员闸门；admin 过得了管理员、过不了 super_admin', async () => {
    const { users, authStore, auth } = setup(true);
    users.create({ username: 'root', password: 'root-password', role: 'super_admin' });
    const member = users.create({ username: 'mem', password: 'member-password', role: 'member' });
    const admin = users.create({ username: 'adm', password: 'admin-password', role: 'admin' });
    const memberToken = authStore.issue('web', member.id).token;
    const adminToken = authStore.issue('web', admin.id).token;

    expect(await run(auth.requireAdminAuth, request(null))).toEqual({ status: 401, code: 'auth.loginRequired' });
    expect(await run(auth.requireSessionAuth, request(memberToken))).toEqual({ status: null, code: null });
    expect(await run(auth.requireAdminAuth, request(memberToken))).toEqual({ status: 403, code: 'auth.forbidden' });
    expect(await run(auth.requireAdminAuth, request(adminToken))).toEqual({ status: null, code: null });
    expect(await run(auth.requireSuperAdmin, request(adminToken))).toEqual({ status: 403, code: 'auth.forbidden' });
  });

  it('Agent 作用域：member 只放行被授权的 Agent，admin 全放行', async () => {
    const { users, authStore, auth } = setup(true);
    users.create({ username: 'root', password: 'root-password', role: 'super_admin' });
    const member = users.create({ username: 'mem', password: 'member-password', role: 'member' });
    users.update(member.id, { agentIds: ['writer'] });
    const token = authStore.issue('web', member.id).token;
    const guard = auth.requireAgentAccess;
    expect(await run(guard, request(token, '/api/x', { agentId: 'writer' }))).toEqual({ status: null, code: null });
    expect(await run(guard, request(token, '/api/x', { agentId: 'coder' }))).toEqual({ status: 403, code: 'auth.agentForbidden' });
    const root = users.findByUsername('root')!;
    expect(await run(guard, request(authStore.issue('web', root.id).token, '/api/x', { agentId: 'coder' }))).toEqual({ status: null, code: null });
  });

  it('停用的用户会话立即失效；旧会话（无 userId）归属第一个 super_admin', async () => {
    const { users, authStore, auth } = setup(true);
    const root = users.create({ username: 'root', password: 'root-password', role: 'super_admin' });
    const other = users.create({ username: 'other', password: 'other-password', role: 'admin' });
    const token = authStore.issue('web', other.id).token;
    users.update(other.id, { status: 'disabled' });
    expect(await run(auth.requireSessionAuth, request(token))).toEqual({ status: 401, code: 'auth.loginRequired' });

    const legacyReq = request(authStore.issue('web').token);
    expect(await run(auth.requireSuperAdmin, legacyReq)).toEqual({ status: null, code: null });
    expect(getRequestIdentity(legacyReq).userId).toBe(root.id);
  });

  it('必须改口令的用户：除改口令 / 看自己 / 登出外一律 403', async () => {
    const { users, authStore, auth } = setup(true);
    const outcome = migrateLegacyLoginPassword({ userStore: users, readRawAppConfig: () => JSON.stringify({ loginEnabled: true }) });
    expect(outcome.status).toBe('created');
    const admin = users.findByUsername('admin')!;
    const token = authStore.issue('web', admin.id).token;
    expect(await run(auth.requireSessionAuth, request(token, '/api/cron/jobs'))).toEqual({ status: 403, code: 'auth.passwordChangeRequired' });
    expect(await run(auth.requireSessionAuth, request(token, '/api/auth/change-password'))).toEqual({ status: null, code: null });
    expect(await run(auth.requireSessionAuth, request(token, '/api/auth/me?x=1'))).toEqual({ status: null, code: null });
  });
});
