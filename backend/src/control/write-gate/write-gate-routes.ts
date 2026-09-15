import { type AuthMiddleware, getRequestIdentity } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import { AGENT_ID_PATTERN, ControlInputError, controlHandler, requireString } from '../shared/control-http';
import type { WriteGateService } from './write-gate-service';

export type WriteGateRoutesDeps = {
  auth: AuthMiddleware;
  writeGate: WriteGateService;
};

/**
 * 写入审批。列表与审阅：登录即可，member 只看被授权 Agent 的记录；
 * 开关、批准、拒绝：admin。批准必须带审阅时看到的 baseHash / proposedHash（记录被新改动覆盖则 409）。
 */
export function registerWriteGateRoutes(app: RouteApp, ctx: WriteGateRoutesDeps): void {
  const { writeGate } = ctx;
  const { requireAdminAuth, canAccessAgent } = ctx.auth;

  app.get('/api/write-gate/settings', controlHandler(async (req, res) => {
    const identity = getRequestIdentity(req);
    res.json({ success: true, settings: writeGate.listSettings().filter((entry) => canAccessAgent(identity, entry.agentId)) });
  }));

  app.put('/api/write-gate/settings/:agentId', requireAdminAuth, controlHandler(async (req, res) => {
    const agentId = requireString(req.params.agentId, 'writeGate.invalidAgent', { pattern: AGENT_ID_PATTERN });
    await writeGate.setEnabled(agentId, req.body?.enabled);
    res.json({ success: true });
  }));

  app.get('/api/write-gate/pending', controlHandler(async (req, res) => {
    const identity = getRequestIdentity(req);
    const { records } = writeGate.listPending();
    const visible = records.filter((record) => canAccessAgent(identity, record.agentId));
    const counts: Record<string, number> = {};
    for (const record of visible) counts[record.agentId] = (counts[record.agentId] ?? 0) + 1;
    res.json({ success: true, records: visible, counts });
  }));

  app.get('/api/write-gate/pending/:id', controlHandler(async (req, res) => {
    const review = writeGate.review(String(req.params.id));
    if (!canAccessAgent(getRequestIdentity(req), review.record.agentId)) throw new ControlInputError('auth.agentForbidden', 403);
    res.json({ success: true, review });
  }));

  app.post('/api/write-gate/pending/:id/approve', requireAdminAuth, controlHandler(async (req, res) => {
    res.json({ success: true, ...(await writeGate.approve(String(req.params.id), { baseHash: req.body?.baseHash, proposedHash: req.body?.proposedHash })) });
  }));

  app.post('/api/write-gate/pending/:id/reject', requireAdminAuth, controlHandler(async (req, res) => {
    res.json({ success: true, ...(await writeGate.reject(String(req.params.id))) });
  }));
}
