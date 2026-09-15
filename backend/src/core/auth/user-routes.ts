/**
 * 用户与权限（super_admin）、登录 IP 锁（admin）。
 *
 * 响应里永远没有口令哈希；改角色 / 停用 / 删除 / 重置口令都会作废该用户的全部会话——
 * 否则「把他停用了」这个动作挡不住已经拿到令牌的人。
 */
import type { RouteApp } from '../http';
import { buildStructuredApiError } from '../http';
import { type AuthMiddleware, getRequestIdentity } from './auth-middleware';
import { sendUserStoreError } from './auth-routes';
import type { AuthStore } from './auth-store';
import type { LoginLockStore } from './login-lock';
import type { AuthRole, UserStatus, UserStore } from './user-store';

export type UserRoutesDeps = {
  authStore: AuthStore;
  userStore: UserStore;
  loginLocks: LoginLockStore;
  auth: AuthMiddleware;
};

function parseId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
}

export function registerUserRoutes(app: RouteApp, ctx: UserRoutesDeps): void {
  const { authStore, userStore, loginLocks } = ctx;
  const { requireSuperAdmin, requireAdminAuth } = ctx.auth;

  app.get('/api/users', requireSuperAdmin, (_req, res) => {
    res.json({ success: true, users: userStore.list() });
  });

  app.post('/api/users', requireSuperAdmin, (req, res) => {
    try {
      const created = userStore.create({
        username: req.body?.username,
        password: req.body?.password,
        role: req.body?.role as AuthRole,
        status: (req.body?.status ?? 'active') as UserStatus,
      });
      const agentIds = stringList(req.body?.agentIds);
      const user = agentIds ? userStore.update(created.id, { agentIds }) : created;
      res.json({ success: true, user });
    } catch (error) {
      if (sendUserStoreError(res, error)) return;
      throw error;
    }
  });

  app.put('/api/users/:id', requireSuperAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json(buildStructuredApiError('users.notFound'));
    try {
      const before = userStore.get(id);
      const user = userStore.update(id, {
        role: req.body?.role,
        status: req.body?.status,
        password: typeof req.body?.password === 'string' ? req.body.password : undefined,
        agentIds: stringList(req.body?.agentIds),
      });
      const privilegeChanged = before && (before.role !== user.role || before.status !== user.status);
      const passwordReset = typeof req.body?.password === 'string' && req.body.password !== '';
      if (privilegeChanged || passwordReset) authStore.revokeForUser(id);
      res.json({ success: true, user });
    } catch (error) {
      if (sendUserStoreError(res, error)) return;
      throw error;
    }
  });

  app.delete('/api/users/:id', requireSuperAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json(buildStructuredApiError('users.notFound'));
    if (getRequestIdentity(req).userId === id) {
      return res.status(409).json(buildStructuredApiError('users.cannotDeleteSelf'));
    }
    try {
      userStore.delete(id);
      authStore.revokeForUser(id);
      res.json({ success: true });
    } catch (error) {
      if (sendUserStoreError(res, error)) return;
      throw error;
    }
  });

  app.get('/api/auth/locked-ips', requireAdminAuth, (_req, res) => {
    res.json({ success: true, locks: loginLocks.listLocked() });
  });

  app.delete('/api/auth/locked-ips', requireAdminAuth, (req, res) => {
    const ip = typeof req.body?.ip === 'string' ? req.body.ip.trim() : '';
    const removed = ip ? (loginLocks.unlock(ip) ? 1 : 0) : loginLocks.unlockAll();
    res.json({ success: true, removed });
  });
}
