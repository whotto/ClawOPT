import type { AuthMiddleware } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import { controlHandler } from '../shared/control-http';
import type { PluginsService } from './plugins-service';

export type PluginsRoutesDeps = {
  auth: AuthMiddleware;
  plugins: PluginsService;
};

/** 插件清单。读：登录即可；启停 / 安装 / 卸载 / 更新：admin。 */
export function registerPluginsRoutes(app: RouteApp, ctx: PluginsRoutesDeps): void {
  const { plugins } = ctx;
  const { requireAdminAuth } = ctx.auth;

  app.get('/api/plugins', controlHandler(async (req, res) => {
    res.json({ success: true, ...(await plugins.list({ fresh: req.query.refresh === '1' })) });
  }));

  app.get('/api/plugins/:id', controlHandler(async (req, res) => {
    res.json({ success: true, plugin: await plugins.inspect(String(req.params.id)) });
  }));

  app.post('/api/plugins/:id/enable', requireAdminAuth, controlHandler(async (req, res) => {
    await plugins.enable(String(req.params.id));
    res.json({ success: true });
  }));

  app.post('/api/plugins/:id/disable', requireAdminAuth, controlHandler(async (req, res) => {
    await plugins.disable(String(req.params.id));
    res.json({ success: true });
  }));

  app.post('/api/plugins/install', requireAdminAuth, controlHandler(async (req, res) => {
    await plugins.install(req.body?.spec, { acknowledgeRisk: req.body?.acknowledgeRisk === true });
    res.json({ success: true });
  }));

  app.post('/api/plugins/update-all', requireAdminAuth, controlHandler(async (_req, res) => {
    await plugins.update(null);
    res.json({ success: true });
  }));

  app.post('/api/plugins/:id/update', requireAdminAuth, controlHandler(async (req, res) => {
    await plugins.update(String(req.params.id));
    res.json({ success: true });
  }));

  app.delete('/api/plugins/:id', requireAdminAuth, controlHandler(async (req, res) => {
    await plugins.uninstall(String(req.params.id));
    res.json({ success: true });
  }));
}
