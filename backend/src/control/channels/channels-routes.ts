import type { AuthMiddleware } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import { controlHandler } from '../shared/control-http';
import type { ChannelAddInput, ChannelsService } from './channels-service';

export type ChannelsRoutesDeps = {
  auth: AuthMiddleware;
  channels: ChannelsService;
};

/**
 * 频道。读（列表、状态、能力）：登录即可，响应里凭据只剩 `hasXxx`；
 * 探测（`?probe=1` 会拿凭据去连平台）与一切写操作：admin。
 */
export function registerChannelsRoutes(app: RouteApp, ctx: ChannelsRoutesDeps): void {
  const { channels } = ctx;
  const { requireAdminAuth } = ctx.auth;

  app.get('/api/channels', controlHandler(async (req, res) => {
    res.json({ success: true, ...(await channels.list({ all: req.query.all === '1' })) });
  }));

  app.get('/api/channels/status', controlHandler(async (_req, res) => {
    res.json({ success: true, status: await channels.status() });
  }));

  app.post('/api/channels/probe', requireAdminAuth, controlHandler(async (_req, res) => {
    res.json({ success: true, status: await channels.status({ probe: true }) });
  }));

  app.get('/api/channels/:channel/capabilities', controlHandler(async (req, res) => {
    res.json({ success: true, capabilities: await channels.capabilities(String(req.params.channel), req.query.account) });
  }));

  app.post('/api/channels', requireAdminAuth, controlHandler(async (req, res) => {
    await channels.add(req.body as ChannelAddInput);
    res.json({ success: true });
  }));

  app.post('/api/channels/:channel/login', requireAdminAuth, controlHandler(async (req, res) => {
    res.json({ success: true, ...(await channels.login(String(req.params.channel), req.body?.account)) });
  }));

  app.post('/api/channels/:channel/logout', requireAdminAuth, controlHandler(async (req, res) => {
    await channels.logout(String(req.params.channel), req.body?.account);
    res.json({ success: true });
  }));

  app.post('/api/channels/:channel/clear-credentials', requireAdminAuth, controlHandler(async (req, res) => {
    res.json({ success: true, ...(await channels.clearCredentials(String(req.params.channel))) });
  }));

  app.delete('/api/channels/:channel', requireAdminAuth, controlHandler(async (req, res) => {
    await channels.remove(String(req.params.channel), req.body?.account, req.body?.delete === true);
    res.json({ success: true });
  }));
}
