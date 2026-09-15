import type { AuthMiddleware } from '../../../core/auth';
import type { RouteApp } from '../../../core/http';
import type { FileManagerService } from './file-manager-service';

export type FileManagerRoutesDeps = {
  auth: AuthMiddleware;
  fileManager: FileManagerService;
};

/** 文件管理器 `/api/fs/*`：读按资源授权（member 只见自己 Agent 的工作区），改动管理员，额外根与远端后端 super_admin。 */
export function registerFileManagerRoutes(app: RouteApp, ctx: FileManagerRoutesDeps): void {
  const { fileManager } = ctx;
  app.get('/api/fs/roots', (_req, res) => {
    void fileManager.listRoots().then((roots) => res.json({ success: true, roots }));
  });
}
