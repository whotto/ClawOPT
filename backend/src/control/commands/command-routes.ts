import type { AuthMiddleware } from '../../core/auth';
import type { DB } from '../../core/db';
import type { RouteApp } from '../../core/http';

export type CommandRoutesDeps = {
  db: DB;
  auth: AuthMiddleware;
};

export function registerCommandRoutes(app: RouteApp, ctx: CommandRoutesDeps): void {
  const { db } = ctx;
  // 快捷指令是全体共用的配置：多用户之后增删改只给 admin。
  const { requireAdminAuth } = ctx.auth;

  app.get('/api/commands', (_req, res) => {
    const commands = db.getQuickCommands();
    res.json({ success: true, commands });
  });

  app.post('/api/commands', requireAdminAuth, (req, res) => {
    const { command, description } = req.body;
    if (!command || !description) return res.status(400).json({ success: false, error: 'Missing command or description' });
    try {
      db.saveQuickCommand(command, description);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.put('/api/commands/:id', requireAdminAuth, (req, res) => {
    const { command, description } = req.body;
    const { id } = req.params;
    if (!command || !description) return res.status(400).json({ success: false, error: 'Missing command or description' });
    try {
      db.updateQuickCommand(Number(id), command, description);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/commands/:id', requireAdminAuth, (req, res) => {
    const { id } = req.params;
    try {
      db.deleteQuickCommand(Number(id));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
