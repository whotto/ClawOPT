/**
 * 等人答复的运行审批（协调器审批注册表）：待办中心与聊天里的审批卡用。
 *
 * 真审批的运行时（Pi、Hermes，今后声明了 `approvals` 的都算）在单聊、群聊外部成员里发起的请求都在这里；
 * 工作流节点是无人值守的（`autoApprove`），不进列表。
 *
 * - `GET /api/run-approvals`：登录即可，**按用户过滤**（`ResourceAccess.canAccessRunSession`：单聊看会话、群看群、其余看运行的 Agent）；
 * - `POST /api/run-approvals/:id/respond` `{ choice }`：先找到请求、再判这个用户看得见它所在的会话；
 *   member 看不见或请求不存在一律 403（不泄露存在性），admin 不存在 404；答复经协调器的注册表（选项不在请求里按拒绝收）。
 * 变化提醒走 `/ws` 的 `approvals:runs`（不带内容），WebSocket 客户端也可以直接发 `interaction.respond`，判据相同。
 */
import type express from 'express';

import { getRequestIdentity, type ResourceAccess, sendResourceForbidden } from '../core/auth';
import { buildStructuredApiError, type RouteApp } from '../core/http';
import type { RunCoordinator } from './coordinator';

export type RunApprovalRoutesDeps = {
  runCoordinator: Pick<RunCoordinator, 'pendingApprovals' | 'respondInteraction'>;
  access: ResourceAccess;
};

export function registerRunApprovalRoutes(app: RouteApp, ctx: RunApprovalRoutesDeps): void {
  const visible = (req: express.Request) => {
    const identity = getRequestIdentity(req);
    return ctx.runCoordinator.pendingApprovals().filter((item) => ctx.access.canAccessRunSession(identity, item.sessionKey));
  };

  app.get('/api/run-approvals', (req, res) => {
    res.json({ success: true, approvals: visible(req) });
  });

  app.post('/api/run-approvals/:id/respond', (req, res) => {
    const choice = typeof req.body?.choice === 'string' ? req.body.choice : '';
    const item = visible(req).find((entry) => entry.id === req.params.id);
    if (!item) {
      if (!ctx.access.isAdmin(getRequestIdentity(req))) return sendResourceForbidden(res);
      return res.status(404).json(buildStructuredApiError('runApprovals.notFound'));
    }
    const result = ctx.runCoordinator.respondInteraction(item.sessionKey, item.id, { choice });
    if (!result.resolved) return res.status(409).json(buildStructuredApiError('runApprovals.notActive', result.error ?? null));
    return res.json({ success: true });
  });
}
