/**
 * 定时任务路由。读：登录即可（member 只看分配给自己的 Agent 的任务）；写：admin。
 * 编辑必须带版本号（`If-Match` 或 body.revision），不符 412 + 当前任务，缺失 428。
 */
import { type AuthMiddleware, getRequestIdentity } from '../../core/auth';
import { enforceRevision, type RouteApp } from '../../core/http';
import { controlHandler } from '../shared/control-http';
import { assertJobId, cronJobConfig, normalizeCronJob, type CronJobInput, type CronService } from './cron-service';

export type CronRoutesDeps = {
  auth: AuthMiddleware;
  cron: CronService;
};

export function registerCronRoutes(app: RouteApp, ctx: CronRoutesDeps): void {
  const { cron } = ctx;
  const { requireAdminAuth, canAccessAgent } = ctx.auth;

  app.get('/api/cron/status', controlHandler(async (_req, res) => {
    res.json({ success: true, status: await cron.status() });
  }));

  app.get('/api/cron/jobs', controlHandler(async (req, res) => {
    const identity = getRequestIdentity(req);
    const jobs = (await cron.listJobs()).filter((job) => canAccessAgent(identity, job.agentId ?? 'main'));
    res.json({ success: true, jobs });
  }));

  app.post('/api/cron/jobs', requireAdminAuth, controlHandler(async (req, res) => {
    const job = await cron.createJob(req.body as CronJobInput);
    res.json({ success: true, job });
  }));

  app.put('/api/cron/jobs/:id', requireAdminAuth, controlHandler(async (req, res) => {
    const id = assertJobId(req.params.id);
    const current = await cron.getRaw(id);
    if (!enforceRevision(req, res, { value: cronJobConfig(current), view: normalizeCronJob(current), required: true })) return;
    const job = await cron.updateJob(id, req.body as CronJobInput);
    res.json({ success: true, job });
  }));

  app.post('/api/cron/jobs/:id/enable', requireAdminAuth, controlHandler(async (req, res) => {
    await cron.setEnabled(assertJobId(req.params.id), true);
    res.json({ success: true });
  }));

  app.post('/api/cron/jobs/:id/disable', requireAdminAuth, controlHandler(async (req, res) => {
    await cron.setEnabled(assertJobId(req.params.id), false);
    res.json({ success: true });
  }));

  app.post('/api/cron/jobs/:id/run', requireAdminAuth, controlHandler(async (req, res) => {
    res.json({ success: true, ...(await cron.runNow(assertJobId(req.params.id))) });
  }));

  app.delete('/api/cron/jobs/:id', requireAdminAuth, controlHandler(async (req, res) => {
    await cron.removeJob(assertJobId(req.params.id));
    res.json({ success: true });
  }));

  app.get('/api/cron/jobs/:id/runs', controlHandler(async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ success: true, runs: await cron.listRuns(assertJobId(req.params.id), limit) });
  }));
}
