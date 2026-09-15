import express from 'express';
import type { IncomingHttpHeaders } from 'http';

import type { ConfigManager } from '../config';
import { AUTH_LOGIN_REQUIRED_ERROR_CODE, StructuredRequestError } from '../http';
import { normalizeCliText } from '../util';
import { accessAgentId } from './agent-ids';
import { AUTH_COOKIE_NAME, type AuthStore, readCookie } from './auth-store';
import { type AuthRole, roleAtLeast, type UserStore } from './user-store';

export function readRequestAuthToken(req: express.Request): string {
  return readHeadersAuthToken(req.headers);
}

/**
 * 从请求头里取令牌。HTTP 请求与 WebSocket 升级请求共用这一处——两条通道的判据不许分家。
 * **不读查询串**：查询串会进访问日志、代理日志和浏览器历史。
 */
export function readHeadersAuthToken(headers: IncomingHttpHeaders): string {
  const forwardedHeader = headers['x-clawopt-auth-token'];
  const forwarded = Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader;
  if (forwarded) return normalizeCliText(forwarded);
  const authorization = normalizeCliText(headers.authorization);
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  // Cookie 是 Web 端的主通道：SSE 的 EventSource 与浏览器的 WebSocket 都设不了自定义头，
  // 而前端有 80 处 fetch 调用点——逐个加头既慢又必漏。同源请求自动带 cookie，一次覆盖全部。
  // 头这条保留给 CLI 与脚本（CLAWOPT_TOKEN）。
  return readCookie(headers.cookie, AUTH_COOKIE_NAME);
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
  // 入站 Webhook 触发工作流：调用方是外部系统，带不了登录 cookie。安全性在处理器里：
  // HMAC 签名 + ±5 分钟时间窗 + 签名防重放（automation/hooks/inbound-hooks.ts）。
  '/api/hooks/workflows/:hookId',
  // 出站 Webhook 的本机回环测试收件箱：只收回环来源、HMAC 派生令牌常数时间比较。
  '/api/hooks/webhook-test/:token',
  // 本地模型代理（P2，runtime/proxy）：调用方是 ClawOPT 自己拉起的外部 CLI（Claude Code、Codex……），
  // 它们带不了登录 cookie，只拿得到代理签发的**每目标令牌**。安全性在处理器里：
  // 未知 key 404、令牌（x-api-key 或 Bearer）常数时间比较不符 401；上游 key 只在服务端内存与加密恢复文件里。
  '/api/runtime-proxy/anthropic/:key/v1/models',
  '/api/runtime-proxy/anthropic/:key/v1/messages',
  '/api/runtime-proxy/responses/:key/v1/models',
  '/api/runtime-proxy/responses/:key/v1/responses',
  // 远程 Agent relay（P3，collab/relay）：调用方是另一台 ClawOPT 的服务端，没有本机登录。安全性在处理器里：
  // 配对回调认请求密钥（x-clawopt-relay-secret，只存 SHA-256、常数时间比较、请求 10 分钟过期）；
  // 远程工作区认每跳令牌（Bearer，只存 SHA-256，跑完即吊销，次数上限，路径闸门同群工作区编辑器）。
  '/api/relay/v1/pairings/:requestId/submit',
  '/api/relay/v1/pairings/:requestId/status',
  '/api/relay/v1/pairings/:requestId/failure',
  '/api/room-relay/workspace/actions',
  '/api/room-relay/workspace/file',
]);

/**
 * 请求路径是否命中公开白名单。条目里的 `:param` 只匹配**恰好一个非空段**——
 * `/api/hooks/workflows/x/extra`、`/api/hooks/workflowsX` 与 `/api/runtime-proxy/anthropic/x/extra/v1/messages` 都不算公开。
 * 登记表（RouteRegistry）按路由模式原文比对同一个集合，所以条目必须与注册的路由模式逐字相同。
 */
export function isAuthPublicPath(requestPath: string): boolean {
  if (AUTH_PUBLIC_PATHS.has(requestPath)) return true;
  const segments = requestPath.split('/');
  for (const entry of AUTH_PUBLIC_PATHS) {
    if (!entry.includes('/:')) continue;
    const pattern = entry.split('/');
    if (pattern.length !== segments.length) continue;
    if (pattern.every((part, index) => (part.startsWith(':') ? segments[index].length > 0 : part === segments[index]))) return true;
  }
  return false;
}

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

  /**
   * 身份解析的唯一实现：HTTP 请求与 WebSocket 升级（以及连接期间的心跳复查）都走这里，
   * 被停用的用户、被吊销 / 过期的会话在两条通道上同时失效。
   */
  function resolveIdentityFromHeaders(headers: IncomingHttpHeaders): Outcome {
    if (!configManager.getConfig().loginEnabled) return { ok: true, identity: IMPLICIT_OWNER };
    const session = authStore.resolve(readHeadersAuthToken(headers));
    if (!session) return { ok: false, error: loginRequired() };
    // 还没有任何用户（启动迁移没跑成）：仍是多用户之前的单主人模式，会话持有者就是主人。
    if (typeof session.userId !== 'number' && userStore.count() === 0) {
      return { ok: true, identity: { ...IMPLICIT_OWNER, implicit: false } };
    }
    // 多用户之前签发的会话没有 userId：那时只有一个口令、一个主人，归属到第一个 super_admin。
    const user = typeof session.userId === 'number' ? userStore.get(session.userId) : userStore.firstActiveSuperAdmin();
    if (!user || user.status !== 'active') return { ok: false, error: loginRequired() };
    return {
      ok: true,
      identity: {
        userId: user.id,
        username: user.username,
        role: user.role,
        implicit: false,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  function authenticate(req: express.Request): Outcome {
    const cached = identities.get(req);
    if (cached) return { ok: true, identity: cached };
    const outcome = resolveIdentityFromHeaders(req.headers);
    if (outcome.ok) identities.set(req, outcome.identity);
    return outcome;
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

  /**
   * 当前身份能不能看这个 Agent：admin 及以上全量；member 只看被授权的。
   * 外部运行时的 id（`ext:<运行时>[:…]`）先归一成可授权的 `ext:<运行时>`（`agent-ids.ts`）。
   */
  function canAccessAgent(identity: RequestIdentity, agentId: string): boolean {
    if (roleAtLeast(identity.role, 'admin')) return true;
    return identity.userId !== null && userStore.hasAgent(identity.userId, accessAgentId(agentId));
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

  /**
   * WebSocket 升级与连接期间的复查用：与 HTTP 同一套身份解析。
   * 登录关闭时是隐式主人；开启时校验会话令牌与用户状态。口令必须先改的用户不给实时通道（HTTP 上也只剩改口令几条路）。
   */
  function authenticateHeaders(headers: IncomingHttpHeaders): RequestIdentity | null {
    const outcome = resolveIdentityFromHeaders(headers);
    if (!outcome.ok || outcome.identity.mustChangePassword) return null;
    return outcome.identity;
  }

  return {
    requireAdminAuth,
    requireSuperAdmin,
    requireSessionAuth,
    requireAgentAccess,
    canAccessAgent,
    authenticate,
    authenticateHeaders,
  };
}
export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;
