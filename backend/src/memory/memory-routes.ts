import type { AuthMiddleware } from '../core/auth';
import type { RouteApp } from '../core/http';
import type { MemoryService } from './memory-service';

export type MemoryRoutesDeps = {
  auth: AuthMiddleware;
  memory: MemoryService;
};

/** 记忆浏览（管理员）：列表 / 图谱 / 编辑（带版本号）/ 软删除 / 「记住」。 */
export function registerMemoryRoutes(app: RouteApp, ctx: MemoryRoutesDeps): void {
  const { memory } = ctx;
  app.get('/api/memory/cards', ctx.auth.requireAdminAuth, (req, res) => {
    res.json({ success: true, ...memory.list({ query: typeof req.query.q === 'string' ? req.query.q : undefined }) });
  });
}
