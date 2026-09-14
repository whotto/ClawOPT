import type { SessionManager } from '../../collab/sessions';
import type { AuthMiddleware } from '../../core/auth';
import {
  AGENT_CONFIG_READ_FAILED_ERROR_CODE,
  AGENT_ID_ALREADY_EXISTS_ERROR_CODE,
  AGENT_ID_REQUIRED_ERROR_CODE,
  buildStructuredApiError,
  type RouteApp,
} from '../../core/http';
import { listRosterEntries, readOpenClawConfigSafe, resolveRosterShape } from '../../openclaw';
import { ConfigReadError } from './agent-provisioner';

export type AgentRoutesDeps = {
  sessionManager: SessionManager;
  auth: AuthMiddleware;
};

export function registerAgentRoutes(app: RouteApp, ctx: AgentRoutesDeps): void {
  const { sessionManager } = ctx;
  const { requireAdminAuth } = ctx.auth;

  /**
   * 可选的 agent 运行时。**前端不该自己硬编码这张表**——
   * 硬编码的副本会和后端分家，而分家的那天用户会看到一个选不了的选项。
   */
  /**
   * 引擎名册里有、而 ClawOPT 自己库里没有的 Agent。
   *
   * ## 为什么需要这个
   *
   * ClawOPT 的会话列表来自它自己的 SQLite（`sessionManager.getAllSessions()`），
   * **不读 `openclaw.json`**。所以任何在引擎侧建的 Agent——用 `openclaw agents`
   * 建的、手改配置建的、或者从别处迁移过来的——ClawOPT 都看不见，
   * 既不能单聊也不能加进团队。
   *
   * 这不是 ACP 带来的新问题，是一直存在的：两边各有一份名册，而只有一个方向同步。
   * 2026-09-03 在生产机上实测确认（引擎里建的 ACP Agent，ClawOPT 列表仍是 7 个）。
   *
   * 这个接口只**报告差异**，不自动导入——自动把引擎里的东西塞进用户的会话列表
   * 是一个他没要求过的副作用。导入由 `POST /api/agents/import` 显式触发。
   */
  app.get('/api/agents/orphans', (_req, res) => {
    try {
      const config = readOpenClawConfigSafe();
      if (!config) return res.json({ success: true, orphans: [] });

      const shape = resolveRosterShape(config as Record<string, unknown>).shape;
      const known = new Set(sessionManager.getAllSessions().map((s) => s.agentId).filter(Boolean));

      const orphans = listRosterEntries(config as Record<string, unknown>, shape)
        .filter((entry) => !known.has(entry.id))
        .map((entry) => ({
          agentId: entry.id,
          workspace: typeof entry.workspace === 'string' ? entry.workspace : null,
        }));

      res.json({ success: true, orphans });
    } catch (error) {
      if (error instanceof ConfigReadError) {
        return res.status(500).json(
          buildStructuredApiError(AGENT_CONFIG_READ_FAILED_ERROR_CODE, error.detail, { reason: error.reason }),
        );
      }
      throw error;
    }
  });

  /**
   * 把引擎名册里的一个 Agent 纳进 ClawOPT。
   *
   * **只建 ClawOPT 侧的会话记录，不碰 `openclaw.json`**——那个 Agent 在引擎里
   * 已经是对的了，我们没有理由重写它的配置。写回去只会引入一次不必要的
   * gateway 重载，以及一个「导入把我的配置改了」的意外。
   */
  app.post('/api/agents/import', requireAdminAuth, (req, res) => {
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
    if (!agentId) {
      return res.status(400).json(buildStructuredApiError(AGENT_ID_REQUIRED_ERROR_CODE, null, {}));
    }

    const config = readOpenClawConfigSafe();
    const shape = config ? resolveRosterShape(config as Record<string, unknown>).shape : 'list';
    const entry = config ? listRosterEntries(config as Record<string, unknown>, shape).find((e) => e.id === agentId) : null;
    if (!entry) {
      return res.status(404).json(buildStructuredApiError('agents.notInRoster', agentId, { agentId }));
    }

    if (sessionManager.getAllSessions().some((s) => s.agentId === agentId)) {
      return res.status(409).json(buildStructuredApiError(AGENT_ID_ALREADY_EXISTS_ERROR_CODE, agentId, { agentId }));
    }

    const session = sessionManager.createSession({ id: agentId, name: agentId, agentId });
    res.json({ success: true, session });
  });
}
