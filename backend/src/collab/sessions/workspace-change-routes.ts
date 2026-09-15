/**
 * 单聊的「每次运行的工作区改动」（P1b）：助手消息上的「N 个文件改动 +a −d」卡片与侧栏 diff。
 *
 * - `GET /api/sessions/:sessionId/workspace-changes?messageIds=1,2,3`：这一页里这些助手消息挂着的变更集摘要（不带 patch 正文）；
 * - `GET /api/sessions/:sessionId/workspace-changes/:changeId/files/:fileId`：点开某个文件时才取它的 patch（懒加载）。
 *
 * 两条都挂 `chatSessionParamGuard`（会话看不见 403）；变更集不属于路径里的会话按不存在处理（404），
 * 不能拿自己会话的路径去读别人会话的 patch。这里只出库里存的 patch 文本，不按路径读工作区文件——
 * 看文件原文仍走 `/api/files/*` 的可服务路径闸门与数据面授权。
 */
import type { ResourceAccess } from '../../core/auth';
import { type DB, WORKSPACE_CHANGE_QUERY_MAX_MESSAGES } from '../../core/db';
import { buildStructuredApiError, type RouteApp } from '../../core/http';
import { chatSessionParamGuard } from './session-routes';

export type WorkspaceChangeRoutesDeps = {
  db: Pick<DB, 'workspaceRunChanges'>;
  access: ResourceAccess;
};

export function parseMessageIdsQuery(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  return [...new Set(text.split(',').map((part) => part.trim()).filter((part) => /^[A-Za-z0-9_-]{1,64}$/.test(part)))]
    .slice(0, WORKSPACE_CHANGE_QUERY_MAX_MESSAGES);
}

export function registerWorkspaceChangeRoutes(app: RouteApp, ctx: WorkspaceChangeRoutesDeps): void {
  const guard = chatSessionParamGuard(ctx, 'sessionId');

  app.get('/api/sessions/:sessionId/workspace-changes', guard, (req, res) => {
    const messageIds = parseMessageIdsQuery(req.query.messageIds);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, changes: ctx.db.workspaceRunChanges.listForMessages(req.params.sessionId, messageIds) });
  });

  app.get('/api/sessions/:sessionId/workspace-changes/:changeId/files/:fileId', guard, (req, res) => {
    const fileId = Number(req.params.fileId);
    const patch = Number.isInteger(fileId) && fileId > 0
      ? ctx.db.workspaceRunChanges.getFilePatch(req.params.sessionId, req.params.changeId, fileId)
      : null;
    if (!patch) return res.status(404).json(buildStructuredApiError('workspaceDiff.notFound'));
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, file: patch });
  });
}
