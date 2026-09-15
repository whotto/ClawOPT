import type express from 'express';

import type { ConfigManager } from '../config';
import { buildStructuredApiError, type RouteApp } from '../http';
import {
  isAuthPublicPath,
  type AuthMiddleware,
  clearAuthCookie,
  getRequestIdentity,
  issueAuthCookie,
  readRequestAuthToken,
} from './auth-middleware';
import { type AuthStore, verifyPassword } from './auth-store';
import { type LoginLockStore, resolveClientIp } from './login-lock';
import { LEGACY_DEFAULT_LOGIN_PASSWORD } from './login-migration';
import { type UserStore, UserStoreError } from './user-store';

export type AuthGateDeps = {
  auth: AuthMiddleware;
};

export function registerAuthGate(app: RouteApp, ctx: AuthGateDeps): void {
  const { requireSessionAuth } = ctx.auth;

  app.use('/api', (req, res, next) => {
    const routePath = req.path.startsWith('/') ? `/api${req.path}` : `/api/${req.path}`;
    if (isAuthPublicPath(routePath)) return next();
    return requireSessionAuth(req, res, next);
  });

  // /openclaw 与 /uploads 不在 /api 前缀下，得单独挂——它们出的是工作区文件与
  // 用户上传，正是开了登录之后最不该匿名可取的东西。浏览器加载 <img src="/uploads/...">
  // 是同源请求，cookie 会自动带上，所以加了鉴权也不会打断图片显示。
  app.use('/openclaw', requireSessionAuth);
  app.use('/uploads', requireSessionAuth);
}

export type AuthRoutesDeps = {
  authStore: AuthStore;
  configManager: ConfigManager;
  userStore: UserStore;
  loginLocks: LoginLockStore;
  auth: AuthMiddleware;
};

/** 用户名缺省时按 `admin` 登录：沿用多用户之前「只填口令」的登录方式（迁移出来的主人叫 admin）。 */
const DEFAULT_LOGIN_USERNAME = 'admin';

export function sendUserStoreError(res: express.Response, error: unknown): boolean {
  if (error instanceof UserStoreError) {
    res.status(error.status).json(buildStructuredApiError(error.errorCode));
    return true;
  }
  return false;
}

function clientIp(req: express.Request): string {
  return resolveClientIp(req.socket?.remoteAddress, req.headers as Record<string, string | string[] | undefined>);
}

export function registerAuthRoutes(app: RouteApp, ctx: AuthRoutesDeps): void {
  const { authStore, configManager, userStore, loginLocks } = ctx;
  const { requireSessionAuth } = ctx.auth;

  app.get('/api/auth/check', (req, res) => {
    const config = configManager.getConfig();
    if (!config.loginEnabled) {
      return res.json({ loginRequired: false });
    }
    // 令牌从 cookie / 头里读，不再走 query——查询串会进访问日志、代理日志和浏览器历史。
    res.json({ loginRequired: !authStore.verify(readRequestAuthToken(req)) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readRequestAuthToken(req);
    if (token) authStore.revoke(token);
    clearAuthCookie(res);
    res.json({ success: true });
  });

  app.post('/api/auth/login', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const username = typeof req.body?.username === 'string' && req.body.username.trim() ? req.body.username.trim() : DEFAULT_LOGIN_USERNAME;
    const config = configManager.getConfig();

    if (!config.loginEnabled) {
      return res.json({ success: true, token: 'disabled' });
    }

    const ip = clientIp(req);
    const lockedForMs = loginLocks.lockedFor(ip);
    if (lockedForMs > 0) {
      return res.status(429).json(buildStructuredApiError('auth.ipLocked', null, { retryAfterSeconds: Math.ceil(lockedForMs / 1000) }));
    }

    // 没有任何用户 = 登录开着却从没设过口令（迁移会给「开着登录」的主机建出 admin，正常走不到这里）。
    // **不再回落默认口令 123456**：宁可拒绝，也不留一个全网公开的凭据。
    if (userStore.count() === 0) {
      const stored = typeof config.loginPassword === 'string' ? config.loginPassword : '';
      if (!stored || verifyPassword(LEGACY_DEFAULT_LOGIN_PASSWORD, stored) || !verifyPassword(password, stored)) {
        loginLocks.recordFailure(ip);
        return res.status(401).json(buildStructuredApiError('auth.invalidPassword'));
      }
      loginLocks.recordSuccess(ip);
      const session = authStore.issue('web');
      issueAuthCookie(res, session.token, session.expiresAt - Date.now());
      return res.json({ success: true, token: session.token, user: null });
    }

    const user = userStore.verifyLogin(username, password);
    if (!user) {
      const entry = loginLocks.recordFailure(ip);
      if (entry.lockedUntil) {
        return res.status(429).json(buildStructuredApiError('auth.ipLocked', null, { retryAfterSeconds: Math.ceil((entry.lockedUntil - Date.now()) / 1000) }));
      }
      return res.status(401).json(buildStructuredApiError('auth.invalidPassword'));
    }

    loginLocks.recordSuccess(ip);
    userStore.recordLogin(user.id);
    // 令牌是随机数、服务端存储、30 天过期、可吊销——不再是口令的哈希。
    const session = authStore.issue('web', user.id);
    issueAuthCookie(res, session.token, session.expiresAt - Date.now());
    return res.json({
      success: true,
      token: session.token,
      user: { id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword },
    });
  });

  app.get('/api/auth/me', requireSessionAuth, (req, res) => {
    const identity = getRequestIdentity(req);
    const agentIds = identity.userId !== null && identity.role === 'member' ? userStore.getAgentIds(identity.userId) : null;
    res.json({
      success: true,
      user: {
        id: identity.userId,
        username: identity.username,
        role: identity.role,
        implicit: identity.implicit,
        mustChangePassword: identity.mustChangePassword,
        // null = 不受限（admin 及以上，或登录未开启）
        agentIds,
      },
    });
  });

  app.post('/api/auth/change-password', requireSessionAuth, (req, res) => {
    const identity = getRequestIdentity(req);
    if (identity.userId === null) {
      return res.status(400).json(buildStructuredApiError('auth.noUserSession'));
    }
    try {
      userStore.changeOwnPassword(identity.userId, req.body?.currentPassword, req.body?.newPassword);
      authStore.revokeForUser(identity.userId);
      const session = authStore.issue('web', identity.userId);
      issueAuthCookie(res, session.token, session.expiresAt - Date.now());
      return res.json({ success: true });
    } catch (error) {
      if (sendUserStoreError(res, error)) return;
      throw error;
    }
  });
}
