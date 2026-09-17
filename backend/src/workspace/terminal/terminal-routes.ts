import type express from 'express';

import { getRequestIdentity, type AuthMiddleware } from '../../core/auth';
import { buildStructuredApiError, type RouteApp } from '../../core/http';
import { TerminalError, type TerminalService } from './terminal-service';

export type TerminalRoutesDeps = {
  auth: AuthMiddleware;
  terminal: TerminalService;
};

const handle = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown): express.RequestHandler => (req, res) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .catch((error) => {
      if (res.headersSent) return;
      if (error instanceof TerminalError) {
        res.status(error.status).json(buildStructuredApiError(error.code));
        return;
      }
      console.error(`[Terminal] request failed: ${(error as Error)?.name ?? 'Error'}`);
      res.status(500).json(buildStructuredApiError('terminal.internalError'));
    });
};

/**
 * Web 终端的 HTTP 面：**全部 super_admin**。WebSocket 在 `bootstrap/terminal.ts` 装到 `/ws/terminal`，
 * 连接要先经 `POST /api/terminal/tickets` 拿一次性票据（URL 里不带任何凭据）。
 */
export function registerTerminalRoutes(app: RouteApp, ctx: TerminalRoutesDeps): void {
  const { terminal } = ctx;
  const superAdmin = ctx.auth.requireSuperAdmin;

  app.get('/api/terminal/status', superAdmin, handle(async (req, res) => {
    res.json({ success: true, ...(await terminal.availability(req.query.refresh === '1')) });
  }));

  app.get('/api/terminal/shells', superAdmin, handle((_req, res) => {
    res.json({ success: true, shells: terminal.shells() });
  }));

  app.get('/api/terminal/sessions', superAdmin, handle((req, res) => {
    res.json({ success: true, sessions: terminal.listSessions(getRequestIdentity(req)) });
  }));

  app.post('/api/terminal/tickets', superAdmin, handle((req, res) => {
    const issued = terminal.issueTicket(getRequestIdentity(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, ...issued });
  }));

  app.get('/api/terminal/audit', superAdmin, handle((req, res) => {
    res.json({ success: true, entries: terminal.audit(Number(req.query.limit) || 200) });
  }));
}
