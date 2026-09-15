import express from 'express';

import type { ConfigManager } from '../config';
import { AUTH_LOGIN_REQUIRED_ERROR_CODE, StructuredRequestError } from '../http';
import { normalizeCliText } from '../util';
import { AUTH_COOKIE_NAME, type AuthStore, readCookie } from './auth-store';

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
  // 入站 Webhook 触发工作流：调用方是外部系统，带不了登录 cookie。安全性在处理器里：
  // HMAC 签名 + ±5 分钟时间窗 + 签名防重放（automation/hooks/inbound-hooks.ts）。
  '/api/hooks/workflows/:hookId',
  // 出站 Webhook 的本机回环测试收件箱：只收回环来源、HMAC 派生令牌常数时间比较。
  '/api/hooks/webhook-test/:token',
]);

/**
 * 请求路径是否命中公开白名单。条目里的 `:param` 只匹配**恰好一个非空段**——
 * `/api/hooks/workflows/x/extra` 与 `/api/hooks/workflowsX` 都不算公开。
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

  return {
    requireAdminAuth,
    requireSessionAuth,
  };
}
export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;
