import express from 'express';

import type { RouteApp } from '../../core/http';
import { RUNTIME_PROXY_PREFIX, type LocalProviderProxy } from './provider-proxy';

/**
 * 代理请求体上限。Codex 每一轮都重发整段历史（含工具输出），全局 `express.json()` 的 100 KB 默认值
 * 第二三轮就会 413。这个解析器**必须注册在全局 json 之前**：body-parser 看到 `req._body` 已置位就跳过。
 */
export const RUNTIME_PROXY_BODY_LIMIT = '64mb';

export function registerRuntimeProxyBodyParser(app: RouteApp): void {
  app.use(RUNTIME_PROXY_PREFIX, express.json({ limit: RUNTIME_PROXY_BODY_LIMIT }));
}

export type RuntimeProxyRoutesDeps = {
  providerProxy: LocalProviderProxy;
};

/**
 * 公开路由（令牌在处理器里校验），模式必须与 `AUTH_PUBLIC_PATHS` 里的条目逐字相同。
 */
export function registerRuntimeProxyRoutes(app: RouteApp, ctx: RuntimeProxyRoutesDeps): void {
  const { providerProxy } = ctx;
  app.get(`${RUNTIME_PROXY_PREFIX}/anthropic/:key/v1/models`, (req, res) => providerProxy.handleModels('anthropic', req, res));
  app.post(`${RUNTIME_PROXY_PREFIX}/anthropic/:key/v1/messages`, (req, res) => { void providerProxy.handleMessages(req, res); });
  app.get(`${RUNTIME_PROXY_PREFIX}/responses/:key/v1/models`, (req, res) => providerProxy.handleModels('responses', req, res));
  app.post(`${RUNTIME_PROXY_PREFIX}/responses/:key/v1/responses`, (req, res) => { void providerProxy.handleResponses(req, res); });
}
