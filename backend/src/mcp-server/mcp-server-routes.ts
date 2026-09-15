import type express from 'express';

import type { AuthMiddleware } from '../core/auth';
import { buildStructuredApiError, type RouteApp } from '../core/http';
import type { BridgeResponse, McpServerService } from './mcp-server-service';
import { McpSettingsError } from './settings-store';

export type McpServerRoutesDeps = {
  auth: AuthMiddleware;
  mcpServer: McpServerService;
};

export const MCP_BRIDGE_TOOLS_PATH = '/api/mcp-bridge/tools';
export const MCP_BRIDGE_CALL_PATH = '/api/mcp-bridge/call';

const handle = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown): express.RequestHandler => (req, res) => {
  Promise.resolve().then(() => fn(req, res)).catch((error) => {
    if (res.headersSent) return;
    if (error instanceof McpSettingsError) {
      res.status(400).json(buildStructuredApiError(error.code));
      return;
    }
    console.error(`[McpServer] request failed: ${(error as Error)?.name ?? 'Error'}`);
    res.status(500).json(buildStructuredApiError('mcpServer.internalError'));
  });
};

const bridgeRequest = (req: express.Request) => ({
  remoteAddress: req.socket.remoteAddress,
  authorization: req.headers.authorization,
  forwarded: Boolean(req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']),
});

const send = (res: express.Response, response: BridgeResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(response.status).json(response.body);
};

/**
 * 管理面（管理员）：按运行时开关、工具集、委派名单、生效令牌与吊销、审计。
 *
 * 桥接口（`/api/mcp-bridge/*`）**有意公开**（登记在 AUTH_PUBLIC_PATHS）：调用方是 ClawOPT 拉起的 MCP 子进程，
 * 带不了登录 cookie。安全性全在处理器里：只收本机回环、只认 `Authorization: Bearer <范围令牌>`（不读 cookie、
 * 不认登录会话）、按令牌的操作白名单与范围判定。
 */
export function registerMcpServerRoutes(app: RouteApp, ctx: McpServerRoutesDeps): void {
  const { mcpServer } = ctx;
  const admin = ctx.auth.requireAdminAuth;

  app.get(MCP_BRIDGE_TOOLS_PATH, handle((req, res) => {
    // 没带 Bearer 就不必碰服务（登记期替身也不会被调用）。
    if (!/^Bearer\s+\S+$/i.test(String(req.headers.authorization ?? '').trim())) {
      res.status(401).json(buildStructuredApiError('mcpServer.tokenInvalid'));
      return;
    }
    send(res, mcpServer.listTools(bridgeRequest(req)));
  }));

  app.post(MCP_BRIDGE_CALL_PATH, handle(async (req, res) => {
    if (!/^Bearer\s+\S+$/i.test(String(req.headers.authorization ?? '').trim())) {
      res.status(401).json(buildStructuredApiError('mcpServer.tokenInvalid'));
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    send(res, await mcpServer.call(bridgeRequest(req), body.operation, body.arguments));
  }));

  app.get('/api/mcp-server/settings', admin, handle((_req, res) => {
    res.json({ success: true, ...mcpServer.settings() });
  }));

  app.put('/api/mcp-server/runtimes/:runtime', admin, handle((req, res) => {
    res.json({ success: true, runtime: mcpServer.saveRuntime(String(req.params.runtime), req.body) });
  }));

  app.get('/api/mcp-server/tokens', admin, handle((_req, res) => {
    res.json({ success: true, tokens: mcpServer.activeTokens() });
  }));

  app.post('/api/mcp-server/tokens/:id/revoke', admin, handle((req, res) => {
    res.json({ success: true, revoked: mcpServer.revokeToken(String(req.params.id)) });
  }));

  app.get('/api/mcp-server/audit', admin, handle((req, res) => {
    res.json({ success: true, entries: mcpServer.audit(Number(req.query.limit) || 200) });
  }));
}
