/**
 * MCP 管理路由。读：登录即可；写 / 探测 / 重载：admin。
 * 覆盖已存在的服务器必须带版本号（412 回当前已脱敏配置）；新建时服务器已存在也按冲突处理。
 */
import type { AuthMiddleware } from '../../core/auth';
import { buildStructuredApiError, computeRevision, enforceRevision, type RouteApp } from '../../core/http';
import { controlHandler } from '../shared/control-http';
import { assertMcpName, redactMcpConfig, type McpService } from './mcp-service';

export type McpRoutesDeps = {
  auth: AuthMiddleware;
  mcp: McpService;
};

export function registerMcpRoutes(app: RouteApp, ctx: McpRoutesDeps): void {
  const { mcp } = ctx;
  const { requireAdminAuth } = ctx.auth;

  app.get('/api/mcp/servers', controlHandler(async (_req, res) => {
    res.json({ success: true, servers: await mcp.list() });
  }));

  app.put('/api/mcp/servers/:name', requireAdminAuth, controlHandler(async (req, res) => {
    const name = assertMcpName(req.params.name);
    const current = await mcp.getRaw(name);
    const creating = req.body?.create === true;
    if (creating && current) {
      return res.status(409).json({ ...buildStructuredApiError('mcp.alreadyExists'), current: { revision: computeRevision(current), value: redactMcpConfig(current) } });
    }
    if (!creating) {
      if (!current) return res.status(404).json(buildStructuredApiError('mcp.notFound'));
      if (!enforceRevision(req, res, { value: current, view: redactMcpConfig(current), required: true })) return;
    }
    await mcp.save(name, req.body?.config, current);
    const saved = await mcp.getRaw(name);
    res.json({ success: true, revision: saved ? computeRevision(saved) : null });
  }));

  app.delete('/api/mcp/servers/:name', requireAdminAuth, controlHandler(async (req, res) => {
    await mcp.remove(assertMcpName(req.params.name));
    res.json({ success: true });
  }));

  app.post('/api/mcp/servers/:name/probe', requireAdminAuth, controlHandler(async (req, res) => {
    res.json({ success: true, probe: await mcp.probe(assertMcpName(req.params.name)) });
  }));

  app.put('/api/mcp/servers/:name/tools', requireAdminAuth, controlHandler(async (req, res) => {
    await mcp.setToolFilter(assertMcpName(req.params.name), { mode: req.body?.mode, tools: req.body?.tools });
    res.json({ success: true });
  }));

  app.post('/api/mcp/reload', requireAdminAuth, controlHandler(async (_req, res) => {
    await mcp.reload();
    res.json({ success: true });
  }));
}
