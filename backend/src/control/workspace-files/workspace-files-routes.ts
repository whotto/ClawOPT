import type { AuthMiddleware } from '../../core/auth';
import { buildStructuredApiError, readRequestedRevision, REVISION_CONFLICT_ERROR_CODE, type RouteApp } from '../../core/http';
import { AGENT_ID_PATTERN, controlHandler, requireString } from '../shared/control-http';
import { RevisionConflict, type WorkspaceFilesService } from './workspace-files-service';

export type WorkspaceFilesRoutesDeps = {
  auth: AuthMiddleware;
  workspaceFiles: WorkspaceFilesService;
};

/**
 * 工作区身份文件。读：该 Agent 已授权即可；写：admin，且必须带版本号（`If-Match`）。
 * 冲突回 412 + 当前内容与版本号，界面提示「已在别处修改」并重新载入。
 */
export function registerWorkspaceFilesRoutes(app: RouteApp, ctx: WorkspaceFilesRoutesDeps): void {
  const { workspaceFiles } = ctx;
  const { requireAgentAccess, requireAdminAuth } = ctx.auth;
  const agentIdOf = (raw: unknown) => requireString(raw, 'workspaceFiles.invalidAgent', { pattern: AGENT_ID_PATTERN });

  app.get('/api/agents/:agentId/workspace-files', requireAgentAccess, controlHandler(async (req, res) => {
    res.json({ success: true, ...(await workspaceFiles.list(agentIdOf(req.params.agentId))) });
  }));

  app.get('/api/agents/:agentId/workspace-files/:name', requireAgentAccess, controlHandler(async (req, res) => {
    const file = await workspaceFiles.read(agentIdOf(req.params.agentId), req.params.name);
    res.setHeader('ETag', `"${file.revision}"`);
    res.json({ success: true, file });
  }));

  app.put('/api/agents/:agentId/workspace-files/:name', requireAdminAuth, requireAgentAccess, controlHandler(async (req, res) => {
    try {
      const result = await workspaceFiles.write(agentIdOf(req.params.agentId), req.params.name, req.body?.content, readRequestedRevision(req));
      res.setHeader('ETag', `"${result.revision}"`);
      res.json({ success: true, ...result });
    } catch (error) {
      if (!(error instanceof RevisionConflict)) throw error;
      res.status(412).json({
        ...buildStructuredApiError(REVISION_CONFLICT_ERROR_CODE),
        current: { revision: error.current.revision, value: { content: error.current.content ?? '', exists: error.current.content !== null } },
      });
    }
  }));
}
