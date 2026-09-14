import type { DB } from '../../core/db';
import type { RouteApp } from '../../core/http';

export type CommandRoutesDeps = {
  db: DB;
};

export function registerCommandRoutes(app: RouteApp, ctx: CommandRoutesDeps): void {
  const { db } = ctx;

  app.get('/api/commands', (_req, res) => {
    const commands = db.getQuickCommands();
    res.json({ success: true, commands });
  });

  app.post('/api/commands', (req, res) => {
    const { command, description } = req.body;
    if (!command || !description) return res.status(400).json({ success: false, error: 'Missing command or description' });
    try {
      db.saveQuickCommand(command, description);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.put('/api/commands/:id', (req, res) => {
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

  app.delete('/api/commands/:id', (req, res) => {
    const { id } = req.params;
    try {
      db.deleteQuickCommand(Number(id));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
