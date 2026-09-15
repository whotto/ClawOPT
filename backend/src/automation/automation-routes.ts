/**
 * 出站 Webhook 管理、看板，以及两个**有意公开**的入口：
 * - `POST /api/hooks/workflows/:hookId`：入站钩子触发工作流（签名 + 时间窗 + 防重放，见 hooks/inbound-hooks.ts）；
 * - `POST /api/hooks/webhook-test/:token`：本机回环测试收件箱（只收回环来源 + HMAC 派生令牌）。
 * 两者登记在 `AUTH_PUBLIC_PATHS`，由 `test/auth-coverage.test.ts` 与 `test/automation/hooks-public.test.ts` 守着。
 */
import type express from 'express';

import type { RouteApp } from '../core/http';
import type { Automation } from './create-automation';
import { bodyOf, handle } from './shared/http';
import { WEBHOOK_EVENT_TYPES } from './webhooks/webhook-events';

export type AutomationRoutesDeps = { automation: Automation };

export const WORKFLOW_HOOK_PUBLIC_PATH = '/api/hooks/workflows/:hookId';
export const WEBHOOK_TEST_RECEIVER_PUBLIC_PATH = '/api/hooks/webhook-test/:token';

const rawBodyOf = (req: express.Request): Buffer => {
  const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
  return Buffer.isBuffer(raw) ? raw : Buffer.from(req.body === undefined ? '' : JSON.stringify(req.body));
};

export function registerAutomationRoutes(app: RouteApp, ctx: AutomationRoutesDeps): void {
  const automation = () => ctx.automation;

  app.post(WORKFLOW_HOOK_PUBLIC_PATH, handle(async (req, res) => {
    const result = await automation().hooks.trigger(req.params.hookId, {
      rawBody: rawBodyOf(req),
      body: req.body,
      timestamp: req.header('x-clawopt-timestamp') ?? undefined,
      signature: req.header('x-clawopt-signature-256') ?? undefined,
    });
    res.status(202);
    return { success: true, status: 'accepted', runId: result.runId };
  }));

  app.post(WEBHOOK_TEST_RECEIVER_PUBLIC_PATH, (req, res) => {
    const accepted = automation().webhooks.receiveTest({
      token: req.params.token,
      remoteAddress: req.socket.remoteAddress,
      headers: {
        'x-clawopt-event': req.header('x-clawopt-event') ?? undefined,
        'x-clawopt-event-id': req.header('x-clawopt-event-id') ?? undefined,
        'x-clawopt-delivery': req.header('x-clawopt-delivery') ?? undefined,
        'x-clawopt-timestamp': req.header('x-clawopt-timestamp') ?? undefined,
        'x-clawopt-signature-256': req.header('x-clawopt-signature-256') ?? undefined,
      },
      rawBody: rawBodyOf(req),
      body: req.body,
    });
    // 不区分拒绝原因：公开入口不给探测者反馈。
    res.status(accepted ? 204 : 404).end();
  });

  app.get('/api/webhooks/event-types', handle(() => ({ success: true, eventTypes: WEBHOOK_EVENT_TYPES })));
  app.get('/api/webhooks/endpoints', handle(() => ({ success: true, endpoints: automation().webhooks.list() })));
  app.post('/api/webhooks/endpoints', handle(async (req, res) => {
    res.status(201);
    return { success: true, endpoint: await automation().webhooks.create(bodyOf(req)) };
  }));
  app.patch('/api/webhooks/endpoints/:endpointId', handle(async (req) => ({ success: true, endpoint: await automation().webhooks.update(req.params.endpointId, bodyOf(req)) })));
  app.delete('/api/webhooks/endpoints/:endpointId', handle((req) => {
    automation().webhooks.remove(req.params.endpointId);
    return { success: true };
  }));
  app.post('/api/webhooks/endpoints/:endpointId/test', handle(async (req, res) => {
    const outcome = await automation().webhooks.sendTest(req.params.endpointId);
    res.status(outcome.ok ? 200 : 502);
    return { success: outcome.ok, outcome };
  }));
  app.get('/api/webhooks/endpoints/:endpointId/deliveries', handle((req) => ({ success: true, deliveries: automation().webhooks.deliveries(req.params.endpointId) })));
  app.get('/api/webhooks/local-test-target', handle(() => ({ success: true, ...automation().webhooks.localTestTarget() })));
  app.get('/api/webhooks/local-test-events', handle(() => ({ success: true, events: automation().webhooks.testEvents() })));
  app.delete('/api/webhooks/local-test-events', handle(() => {
    automation().webhooks.clearTestEvents();
    return { success: true };
  }));

  app.get('/api/kanban/boards', handle(() => ({ success: true, boards: automation().kanban.listBoards() })));
  app.post('/api/kanban/boards', handle((req, res) => {
    res.status(201);
    return { success: true, board: automation().kanban.createBoard(bodyOf(req)) };
  }));
  app.patch('/api/kanban/boards/:boardId', handle((req) => ({ success: true, board: automation().kanban.updateBoard(req.params.boardId, bodyOf(req)) })));
  app.get('/api/kanban/boards/:boardId/tasks', handle((req) => ({ success: true, tasks: automation().kanban.listTasks(req.params.boardId, req.query as Record<string, unknown>) })));
  app.post('/api/kanban/boards/:boardId/tasks', handle((req, res) => {
    res.status(201);
    return { success: true, task: automation().kanban.createTask(req.params.boardId, bodyOf(req)) };
  }));
  app.post('/api/kanban/tasks/bulk', handle((req) => ({ success: true, ...automation().kanban.bulk(bodyOf(req)) })));
  app.post('/api/kanban/links', handle((req) => {
    automation().kanban.link(bodyOf(req));
    return { success: true };
  }));
  app.delete('/api/kanban/links', handle((req) => ({ success: true, removed: automation().kanban.unlink(bodyOf(req)) })));
  app.get('/api/kanban/tasks/:taskId', handle((req) => ({ success: true, ...automation().kanban.detail(req.params.taskId) })));
  app.patch('/api/kanban/tasks/:taskId', handle((req) => ({ success: true, task: automation().kanban.updateTask(req.params.taskId, bodyOf(req)) })));
  app.post('/api/kanban/tasks/:taskId/actions', handle((req) => {
    const body = bodyOf(req);
    return { success: true, task: automation().kanban.act(req.params.taskId, String(body.action ?? ''), body) };
  }));
  app.post('/api/kanban/tasks/:taskId/comments', handle((req, res) => {
    res.status(201);
    return { success: true, comment: automation().kanban.comment(req.params.taskId, bodyOf(req)) };
  }));
}
