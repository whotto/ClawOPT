import type { AuthMiddleware } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import { controlHandler } from '../shared/control-http';
import type { UsageService } from '../usage/usage-service';
import type { GatewayStatusCache } from './gateway-status-cache';
import type { LogsService } from './logs-service';

export type ObservabilityRoutesDeps = {
  auth: AuthMiddleware;
  logs: LogsService;
  usage: UsageService;
  gatewayStatus: GatewayStatusCache;
};

/**
 * 用量 / 日志 / 网关状态卡。日志带运行现场（路径、会话 key）、用量是跨全部 Agent 的花费，都只给 admin；
 * 状态卡登录即可看。网关重启沿用既有的 `POST /api/config/restart`（带重启状态机），这里不另开一条。
 */
export function registerObservabilityRoutes(app: RouteApp, ctx: ObservabilityRoutesDeps): void {
  const { logs, usage, gatewayStatus } = ctx;
  const { requireAdminAuth } = ctx.auth;

  // 引擎全局用量（跨全部 Agent 的花费），不按用户过滤，所以只给管理员。
  app.get('/api/usage/summary', requireAdminAuth, controlHandler(async (req, res) => {
    res.json({ success: true, ...(await usage.summary(req.query.days)) });
  }));

  app.get('/api/logs', requireAdminAuth, controlHandler(async (req, res) => {
    res.json({ success: true, ...(await logs.read({ source: req.query.source, level: req.query.level, q: req.query.q, limit: req.query.limit })) });
  }));

  app.get('/api/gateway/service-status', controlHandler(async (req, res) => {
    res.json({ success: true, ...(await gatewayStatus.get({ refresh: req.query.refresh === '1' })) });
  }));
}
