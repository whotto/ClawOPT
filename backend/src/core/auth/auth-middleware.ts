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
]);

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
