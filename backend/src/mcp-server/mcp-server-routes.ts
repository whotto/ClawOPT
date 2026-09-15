import type { AuthMiddleware } from '../core/auth';
import type { RouteApp } from '../core/http';
import type { McpServerService } from './mcp-server-service';

export type McpServerRoutesDeps = {
  auth: AuthMiddleware;
  mcpServer: McpServerService;
};

/**
 * 管理面（管理员）：按运行时开关、工具集、令牌审计。
 * MCP 子进程回连的桥接口有意公开（带不了登录 cookie），安全性全在处理器里的范围令牌校验。
 */
export function registerMcpServerRoutes(app: RouteApp, ctx: McpServerRoutesDeps): void {
  const { mcpServer } = ctx;
  app.get('/api/mcp-server/settings', ctx.auth.requireAdminAuth, (_req, res) => {
    res.json({ success: true, ...mcpServer.settings() });
  });
}
