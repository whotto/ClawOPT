import type { RouteApp } from '../core/http';

export type HealthRoutesDeps = {
  connections: Map<string, unknown>;
};

export function registerHealthRoutes(app: RouteApp, ctx: HealthRoutesDeps): void {
  const { connections } = ctx;

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      connections: connections.size,
    });
  });
}
