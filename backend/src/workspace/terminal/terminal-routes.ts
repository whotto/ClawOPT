import type { AuthMiddleware } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import type { TerminalService } from './terminal-service';

export type TerminalRoutesDeps = {
  auth: AuthMiddleware;
  terminal: TerminalService;
};

/** Web 终端的 HTTP 面：全部 super_admin。WebSocket 在 `bootstrap/terminal.ts` 装到 `/ws/terminal`。 */
export function registerTerminalRoutes(app: RouteApp, ctx: TerminalRoutesDeps): void {
  const { terminal } = ctx;
  app.get('/api/terminal/status', ctx.auth.requireSuperAdmin, (_req, res) => {
    void terminal.availability().then((availability) => res.json({ success: true, ...availability }));
  });
}
