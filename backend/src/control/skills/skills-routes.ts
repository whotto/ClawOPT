import type express from 'express';

import { type AuthMiddleware, getRequestIdentity } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import { ControlInputError, controlHandler } from '../shared/control-http';
import type { SkillsService } from './skills-service';

export type SkillsRoutesDeps = {
  auth: AuthMiddleware;
  skills: SkillsService;
};

/**
 * 技能浏览。读：登录即可；带 `?agent=` 的按 Agent 视图要求该 Agent 已授权。
 * 安装 / 更新 / 启停：admin。
 */
export function registerSkillsRoutes(app: RouteApp, ctx: SkillsRoutesDeps): void {
  const { skills } = ctx;
  const { requireAdminAuth, canAccessAgent } = ctx.auth;

  const agentQuery = (req: express.Request): string | undefined => {
    const agent = typeof req.query.agent === 'string' && req.query.agent ? req.query.agent : undefined;
    if (agent && !canAccessAgent(getRequestIdentity(req), agent)) throw new ControlInputError('auth.agentForbidden', 403);
    return agent;
  };

  app.get('/api/skills', controlHandler(async (req, res) => {
    res.json({ success: true, ...(await skills.list(agentQuery(req))) });
  }));

  app.get('/api/skills/check', controlHandler(async (req, res) => {
    res.json({ success: true, ...(await skills.check(agentQuery(req))) });
  }));

  app.get('/api/skills/search', controlHandler(async (req, res) => {
    res.json({ success: true, ...(await skills.search(req.query.q)) });
  }));

  app.get('/api/skills/:name', controlHandler(async (req, res) => {
    res.json({ success: true, skill: await skills.info(String(req.params.name), agentQuery(req)) });
  }));

  app.post('/api/skills/install', requireAdminAuth, controlHandler(async (req, res) => {
    await skills.install({ ref: req.body?.ref, agentId: req.body?.agentId, global: req.body?.global === true, version: req.body?.version, acknowledgeRisk: req.body?.acknowledgeRisk === true });
    res.json({ success: true });
  }));

  app.post('/api/skills/update', requireAdminAuth, controlHandler(async (req, res) => {
    await skills.update({ ref: req.body?.ref, agentId: req.body?.agentId, global: req.body?.global === true, acknowledgeRisk: req.body?.acknowledgeRisk === true });
    res.json({ success: true });
  }));

  app.post('/api/skills/verify', requireAdminAuth, controlHandler(async (req, res) => {
    res.json({ success: true, ...(await skills.verify(req.body?.ref, req.body?.agentId)) });
  }));

  app.put('/api/skills/:key/enabled', requireAdminAuth, controlHandler(async (req, res) => {
    await skills.setEnabled(String(req.params.key), req.body?.enabled);
    res.json({ success: true });
  }));
}
