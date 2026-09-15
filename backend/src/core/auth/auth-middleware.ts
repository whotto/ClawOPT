import express from 'express';

import type { ConfigManager } from '../config';
import { AUTH_LOGIN_REQUIRED_ERROR_CODE, StructuredRequestError } from '../http';
import { normalizeCliText } from '../util';
import { AUTH_COOKIE_NAME, type AuthStore, readCookie } from './auth-store';
import { type AuthRole, roleAtLeast, type UserStore } from './user-store';

export function readRequestAuthToken(req: express.Request): string {
  const forwarded = req.header('x-clawopt-auth-token');
  if (forwarded) return normalizeCliText(forwarded);
  const authorization = normalizeCliText(req.header('authorization'));
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  // Cookie 是 Web 端的主通道：SSE 的 EventSource 设不了自定义头，而前端有 80 处
  // fetch 调用点——逐个加头既慢又必漏。同源请求自动带 cookie，一次覆盖全部。
  // 头这条保留给 CLI 与脚本（CLAWOPT_TOKEN）。
  return readCookie(req.headers.cookie, AUTH_COOKIE_NAME);
}

export function issueAuthCookie(res: express.Response, token: string, maxAgeMs: number): void {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',            // 关键：JS 读不到，XSS 偷不走
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearAuthCookie(res: express.Response): void {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * 全局 API 鉴权。
 *
 * 之前鉴权是逐路由手挂的，108 个路由只挂了 15 个——数据面（建会话、发消息、删会话、
 * 建群、传文件）全部裸奔，登录页只挡住了「改配置」和「装包」。手挂的名单不可能不漏，
 * 所以改成默认全保护 + 白名单放行。新增路由自动受保护，这是这次改动真正的收益。
 */
export const AUTH_PUBLIC_PATHS = new Set([
  '/api/auth/check',
  '/api/auth/login',
  '/api/version',
  // 存活 / 就绪探针（bootstrap/health.ts）。它们不在 /api 前缀下、本就不经过闸门，
  // 登记在这里是为了让「有意公开」在白名单里看得见。
  '/livez',
  '/readyz',
]);

export type AuthMiddlewareDeps = {
  authStore: AuthStore;
  configManager: ConfigManager;
  userStore: UserStore;
};

/**
 * 一次请求的身份。登录未开启时是「隐式 super_admin」——单用户部署的行为与多用户之前一致。
 */
export type RequestIdentity = {
  userId: number | null;
  username: string | null;
  role: AuthRole;
  implicit: boolean;
  mustChangePassword: boolean;
};

const IMPLICIT_OWNER: RequestIdentity = { userId: null, username: null, role: 'super_admin', implicit: true, mustChangePassword: false };
const identities = new WeakMap<express.Request, RequestIdentity>();

/** 闸门之后的处理器里取身份。闸门没跑过（不该发生）时按最小权限的 member 处理，而不是放大。 */
export function getRequestIdentity(req: express.Request): RequestIdentity {
  return identities.get(req) ?? { userId: null, username: null, role: 'member', implicit: false, mustChangePassword: false };
}

/** 口令必须先改时，仍允许访问的路径（看自己、改口令、登出）。 */
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout', '/api/auth/check']);

export const AUTH_FORBIDDEN_ERROR_CODE = 'auth.forbidden';
export const AUTH_AGENT_FORBIDDEN_ERROR_CODE = 'auth.agentForbidden';
export const AUTH_PASSWORD_CHANGE_REQUIRED_ERROR_CODE = 'auth.passwordChangeRequired';

export function createAuthMiddleware(ctx: AuthMiddlewareDeps) {
  const { authStore, configManager, userStore } = ctx;

  type Outcome = { ok: true; identity: RequestIdentity } | { ok: false; error: StructuredRequestError };

  function loginRequired(): StructuredRequestError {
    return new StructuredRequestError(401, AUTH_LOGIN_REQUIRED_ERROR_CODE, 'Login is required to perform this action.');
  }

  function authenticate(req: express.Request): Outcome {
    const cached = identities.get(req);
    if (cached) return { ok: true, identity: cached };
    if (!configManager.getConfig().loginEnabled) {
      identities.set(req, IMPLICIT_OWNER);
      return { ok: true, identity: IMPLICIT_OWNER };
    }
    const session = authStore.resolve(readRequestAuthToken(req));
    if (!session) return { ok: false, error: loginRequired() };
    // 还没有任何用户（启动迁移没跑成）：仍是多用户之前的单主人模式，会话持有者就是主人。
    if (typeof session.userId !== 'number' && userStore.count() === 0) {
      const owner: RequestIdentity = { ...IMPLICIT_OWNER, implicit: false };
      identities.set(req, owner);
      return { ok: true, identity: owner };
    }
    // 多用户之前签发的会话没有 userId：那时只有一个口令、一个主人，归属到第一个 super_admin。
    const user = typeof session.userId === 'number' ? userStore.get(session.userId) : userStore.firstActiveSuperAdmin();
    if (!user || user.status !== 'active') return { ok: false, error: loginRequired() };
    const identity: RequestIdentity = {
      userId: user.id,
      username: user.username,
      role: user.role,
      implicit: false,
      mustChangePassword: user.mustChangePassword,
    };
    identities.set(req, identity);
    return { ok: true, identity };
  }

  function requestPath(req: express.Request): string {
    return String(req.originalUrl || req.url || '').split('?')[0];
  }

  function requireSessionAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
    const outcome = authenticate(req);
    if (!outcome.ok) return next(outcome.error);
    if (outcome.identity.mustChangePassword && !PASSWORD_CHANGE_ALLOWED_PATHS.has(requestPath(req))) {
      return next(new StructuredRequestError(403, AUTH_PASSWORD_CHANGE_REQUIRED_ERROR_CODE, 'Change the password before continuing.'));
    }
    return next();
  }

  function requireRole(required: AuthRole) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      requireSessionAuth(req, res, (error?: unknown) => {
        if (error) return next(error);
        if (!roleAtLeast(getRequestIdentity(req).role, required)) {
          return next(new StructuredRequestError(403, AUTH_FORBIDDEN_ERROR_CODE, `Role ${required} is required.`));
        }
        return next();
      });
    };
  }

  /**
   * 管理员闸门：自己完成鉴权（有的路由注册在全局闸门之前，只靠它），再要求 admin 及以上。
   * 在登记表里按函数身份标成 adminOnly。
   */
  const requireAdminAuth = requireRole('admin');
  const requireSuperAdmin = requireRole('super_admin');

  /** 当前身份能不能看这个 Agent：admin 及以上全量；member 只看被授权的。 */
  function canAccessAgent(identity: RequestIdentity, agentId: string): boolean {
    if (roleAtLeast(identity.role, 'admin')) return true;
    return identity.userId !== null && userStore.hasAgent(identity.userId, agentId);
  }

  /**
   * Agent 作用域的路由：路径参数 `:agentId` 必须在当前用户的授权里。
   * 是中间件本身而不是工厂——路由登记期（OpenAPI 生成、鉴权覆盖测试）不允许调用上下文里的函数。
   */
  function requireAgentAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
    requireSessionAuth(req, res, (error?: unknown) => {
      if (error) return next(error);
      const agentId = String(req.params.agentId || '');
      if (!agentId || !canAccessAgent(getRequestIdentity(req), agentId)) {
        return next(new StructuredRequestError(403, AUTH_AGENT_FORBIDDEN_ERROR_CODE, 'This agent is not assigned to you.'));
      }
      return next();
    });
  }

  return {
    requireAdminAuth,
    requireSuperAdmin,
    requireSessionAuth,
    requireAgentAccess,
    canAccessAgent,
    authenticate,
  };
}
export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;
