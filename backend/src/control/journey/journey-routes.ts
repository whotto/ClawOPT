import type { AuthMiddleware } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import { controlHandler } from '../shared/control-http';
import type { JourneyService } from './journey-service';

export type JourneyRoutesDeps = {
  auth: AuthMiddleware;
  journey: JourneyService;
};

/** 成长轨迹：该 Agent 已授权即可读。 */
export function registerJourneyRoutes(app: RouteApp, ctx: JourneyRoutesDeps): void {
  const { journey } = ctx;
  app.get('/api/agents/:agentId/journey', ctx.auth.requireAgentAccess, controlHandler(async (req, res) => {
    res.json({ success: true, graph: await journey.graph(String(req.params.agentId)) });
  }));
}
