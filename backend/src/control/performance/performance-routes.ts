import type { AuthMiddleware } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import { controlHandler } from '../shared/control-http';
import type { PerformanceService } from './performance-service';

export type PerformanceRoutesDeps = {
  auth: AuthMiddleware;
  performance: PerformanceService;
};

/** 性能监控：进程与运行现场，只给 super_admin。 */
export function registerPerformanceRoutes(app: RouteApp, ctx: PerformanceRoutesDeps): void {
  const { performance } = ctx;
  app.get('/api/performance/runtime', ctx.auth.requireSuperAdmin, controlHandler(async (_req, res) => {
    res.json({ success: true, snapshot: await performance.snapshot() });
  }));
}
