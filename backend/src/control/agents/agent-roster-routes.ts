import { type AuthMiddleware, getRequestIdentity } from '../../core/auth';
import { buildStructuredApiError, type RouteApp } from '../../core/http';
import { AGENT_ID_PATTERN, controlHandler, requireString } from '../shared/control-http';
import type { EngineRoster } from '../shared/engine-roster';
import type { AgentAvatarStore } from './agent-avatar-store';
import type { AgentCloneService } from './agent-clone';

export type AgentRosterRoutesDeps = {
  auth: AuthMiddleware;
  agentClone: AgentCloneService;
  avatars: AgentAvatarStore;
  engineRoster: EngineRoster;
};

/**
 * 名册补强：引擎名册（给 cron / 工作区文件的 Agent 选择器）、克隆、头像。
 * 读：登录即可（member 只看到被授权的 Agent）；克隆、改头像：admin。
 */
export function registerAgentRosterRoutes(app: RouteApp, ctx: AgentRosterRoutesDeps): void {
  const { agentClone, avatars, engineRoster: roster } = ctx;
  const { requireAdminAuth, requireAgentAccess, canAccessAgent } = ctx.auth;
  const agentIdOf = (raw: unknown) => requireString(raw, 'agents.idRequired', { pattern: AGENT_ID_PATTERN });

  app.get('/api/engine/agents', controlHandler(async (req, res) => {
    const identity = getRequestIdentity(req);
    // 只回 id 与标记：工作区 / agentDir 是主机绝对路径（含用户名），界面用不到，不往外给。
    const agents = (await roster.list({ fresh: req.query.refresh === '1' }))
      .filter((agent) => canAccessAgent(identity, agent.id))
      .map((agent) => ({ id: agent.id, isDefault: agent.isDefault, bindings: agent.bindings, hasWorkspace: agent.workspace !== null }));
    res.json({ success: true, agents });
  }));

  app.post('/api/agents/:agentId/clone', requireAdminAuth, controlHandler(async (req, res) => {
    const result = await agentClone.clone(req.params.agentId, { newAgentId: req.body?.newAgentId, name: req.body?.name });
    roster.invalidate();
    res.json({ success: true, ...result });
  }));

  app.get('/api/agent-avatars', controlHandler(async (_req, res) => {
    res.json({ success: true, avatars: avatars.list() });
  }));

  app.get('/api/agents/:agentId/avatar', requireAgentAccess, (req, res) => {
    const avatar = avatars.get(String(req.params.agentId));
    if (!avatar) return res.status(404).json(buildStructuredApiError('agents.avatarNotFound'));
    res.setHeader('Content-Type', avatar.mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(avatar.data);
  });

  app.put('/api/agents/:agentId/avatar', requireAdminAuth, controlHandler(async (req, res) => {
    avatars.set(agentIdOf(req.params.agentId), req.body?.dataUrl);
    res.json({ success: true });
  }));

  app.delete('/api/agents/:agentId/avatar', requireAdminAuth, controlHandler(async (req, res) => {
    avatars.remove(agentIdOf(req.params.agentId));
    res.json({ success: true });
  }));
}
