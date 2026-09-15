import express from 'express';
import type { IncomingHttpHeaders } from 'http';

import type { ConfigManager } from '../config';
import { AUTH_LOGIN_REQUIRED_ERROR_CODE, StructuredRequestError } from '../http';
import { normalizeCliText } from '../util';
import { AUTH_COOKIE_NAME, type AuthStore, readCookie } from './auth-store';

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
  // 本地模型代理（P2，runtime/proxy）：调用方是 ClawOPT 自己拉起的外部 CLI（Claude Code、Codex……），
  // 它们带不了登录 cookie，只拿得到代理签发的**每目标令牌**。安全性在处理器里：
  // 未知 key 404、令牌（x-api-key 或 Bearer）常数时间比较不符 401；上游 key 只在服务端内存与加密恢复文件里。
  '/api/runtime-proxy/anthropic/:key/v1/models',
  '/api/runtime-proxy/anthropic/:key/v1/messages',
  '/api/runtime-proxy/responses/:key/v1/models',
  '/api/runtime-proxy/responses/:key/v1/responses',
]);

/**
 * 请求路径是否命中公开白名单。条目里的 `:param` 只匹配**恰好一个非空段**——
 * `/api/runtime-proxy/anthropic/x/extra/v1/messages` 与 `/api/runtime-proxy/anthropicX/...` 都不算公开。
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
};

export function createAuthMiddleware(ctx: AuthMiddlewareDeps) {
  const { authStore, configManager } = ctx;

  function requireAdminAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
    const config = configManager.getConfig();
    if (!config.loginEnabled) {
      return next();
    }

    if (authStore.verify(readRequestAuthToken(req))) {
      return next();
    }

    return next(new StructuredRequestError(401, AUTH_LOGIN_REQUIRED_ERROR_CODE, 'Login is required to perform this action.'));
  }

  function requireSessionAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
    const config = configManager.getConfig();
    if (!config.loginEnabled) return next();
    if (authStore.verify(readRequestAuthToken(req))) return next();
    return next(new StructuredRequestError(401, AUTH_LOGIN_REQUIRED_ERROR_CODE, 'Login is required to perform this action.'));
  }

  /** WebSocket 升级与连接期间的复查用：登录关闭时一律放行，开启时校验会话令牌。 */
  function isAuthenticatedHeaders(headers: IncomingHttpHeaders): boolean {
    const config = configManager.getConfig();
    if (!config.loginEnabled) return true;
    return authStore.verify(readHeadersAuthToken(headers));
  }

  return {
    requireAdminAuth,
    requireSessionAuth,
    isAuthenticatedHeaders,
  };
}
export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;
