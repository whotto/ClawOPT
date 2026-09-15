/**
 * 出站 Webhook 管理、看板，以及两个**有意公开**的入口：
 * - `POST /api/hooks/workflows/:hookId`：入站钩子触发工作流（签名 + 时间窗 + 防重放，见 hooks/inbound-hooks.ts）；
 * - `POST /api/hooks/webhook-test/:token`：本机回环测试收件箱（只收回环来源 + HMAC 派生令牌）。
 * 两者登记在 `AUTH_PUBLIC_PATHS`，由 `test/auth-coverage.test.ts` 与 `test/automation/hooks-public.test.ts` 守着。
 *
 * 授权（判据在 `core/auth/resource-access.ts`，矩阵由 `test/automation-acl.test.ts` 守着）：
 * - 出站 Webhook（端点、投递记录、本机测试收件箱）整组 `requireAdminAuth`：投递负载里是全部 Agent 的运行摘要；
 *   事件类型清单是静态的，登录即可读；
 * - 看板：看板管理、建任务、改任务（含改负责人）、批量、依赖链接 `requireAdminAuth`；
 *   列表按用户过滤（看板计数只数看得见的任务）；详情、评论与 complete / block / dispatch 动作按任务的负责 Agent 判
 *   （`guardTask`），其余动作是管理员的。
 */
import type express from 'express';

import {
  AUTH_AGENT_FORBIDDEN_ERROR_CODE,
  AUTH_FORBIDDEN_ERROR_CODE,
  getRequestIdentity,
  MEMBER_KANBAN_ACTIONS,
  type AuthMiddleware,
  type RequestIdentity,
  type ResourceAccess,
} from '../core/auth';
import type { RouteApp } from '../core/http';
import type { Automation } from './create-automation';
import { AutomationError, KANBAN_ERROR, notFound } from './shared/errors';
import { bodyOf, handle } from './shared/http';
import { WEBHOOK_EVENT_TYPES } from './webhooks/webhook-events';

export type AutomationRoutesDeps = { automation: Automation; access: ResourceAccess; auth: Pick<AuthMiddleware, 'requireAdminAuth'> };

export const WORKFLOW_HOOK_PUBLIC_PATH = '/api/hooks/workflows/:hookId';
export const WEBHOOK_TEST_RECEIVER_PUBLIC_PATH = '/api/hooks/webhook-test/:token';

const rawBodyOf = (req: express.Request): Buffer => {
  const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
  return Buffer.isBuffer(raw) ? raw : Buffer.from(req.body === undefined ? '' : JSON.stringify(req.body));
};

export function registerAutomationRoutes(app: RouteApp, ctx: AutomationRoutesDeps): void {
  const automation = () => ctx.automation;
  const { requireAdminAuth } = ctx.auth;

  /**
   * 按任务 id 的读与 member 可做的动作：负责 Agent 不在授权里 → 403 `auth.agentForbidden`。
   * 任务不存在：admin 404；member 同样 403（不泄露存在性）。
   */
  const guardTask = (identity: RequestIdentity, taskId: string) => {
    const task = automation().kanban.getTask(taskId);
    if (!task) {
      if (ctx.access.isAdmin(identity)) throw notFound(KANBAN_ERROR.taskNotFound, taskId);
      throw new AutomationError(403, AUTH_AGENT_FORBIDDEN_ERROR_CODE, 'This task is not assigned to your agents.');
    }
    if (!ctx.access.canAccessKanbanTask(identity, task.assignee)) {
      throw new AutomationError(403, AUTH_AGENT_FORBIDDEN_ERROR_CODE, 'This task is not assigned to your agents.');
    }
    return task;
  };

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
  app.get('/api/webhooks/endpoints', requireAdminAuth, handle(() => ({ success: true, endpoints: automation().webhooks.list() })));
  app.post('/api/webhooks/endpoints', requireAdminAuth, handle(async (req, res) => {
    res.status(201);
    return { success: true, endpoint: await automation().webhooks.create(bodyOf(req)) };
  }));
  app.patch('/api/webhooks/endpoints/:endpointId', requireAdminAuth, handle(async (req) => ({ success: true, endpoint: await automation().webhooks.update(req.params.endpointId, bodyOf(req)) })));
  app.delete('/api/webhooks/endpoints/:endpointId', requireAdminAuth, handle((req) => {
    automation().webhooks.remove(req.params.endpointId);
    return { success: true };
  }));
  app.post('/api/webhooks/endpoints/:endpointId/test', requireAdminAuth, handle(async (req, res) => {
    const outcome = await automation().webhooks.sendTest(req.params.endpointId);
    res.status(outcome.ok ? 200 : 502);
    return { success: outcome.ok, outcome };
  }));
  app.get('/api/webhooks/endpoints/:endpointId/deliveries', requireAdminAuth, handle((req) => ({ success: true, deliveries: automation().webhooks.deliveries(req.params.endpointId) })));
  app.get('/api/webhooks/local-test-target', requireAdminAuth, handle(() => ({ success: true, ...automation().webhooks.localTestTarget() })));
  app.get('/api/webhooks/local-test-events', requireAdminAuth, handle(() => ({ success: true, events: automation().webhooks.testEvents() })));
  app.delete('/api/webhooks/local-test-events', requireAdminAuth, handle(() => {
    automation().webhooks.clearTestEvents();
    return { success: true };
  }));

  app.get('/api/kanban/boards', handle((req) => {
    const identity = getRequestIdentity(req);
    const boards = automation().kanban.listBoards();
    if (ctx.access.isAdmin(identity)) return { success: true, boards };
    // member：计数只数自己看得见的任务，不透露别人的任务量。
    return {
      success: true,
      boards: boards.map((board) => {
        const counts: Record<string, number> = {};
        const visible = automation().kanban.listTasks(board.id, {}).filter((task) => ctx.access.canAccessKanbanTask(identity, task.assignee));
        for (const task of visible) counts[task.status] = (counts[task.status] ?? 0) + 1;
        return { ...board, counts, total: visible.length };
      }),
    };
  }));
  app.post('/api/kanban/boards', requireAdminAuth, handle((req, res) => {
    res.status(201);
    return { success: true, board: automation().kanban.createBoard(bodyOf(req)) };
  }));
  app.patch('/api/kanban/boards/:boardId', requireAdminAuth, handle((req) => ({ success: true, board: automation().kanban.updateBoard(req.params.boardId, bodyOf(req)) })));
  app.get('/api/kanban/boards/:boardId/tasks', handle((req) => {
    const identity = getRequestIdentity(req);
    const tasks = automation().kanban.listTasks(req.params.boardId, req.query as Record<string, unknown>)
      .filter((task) => ctx.access.canAccessKanbanTask(identity, task.assignee));
    return { success: true, tasks };
  }));
  app.post('/api/kanban/boards/:boardId/tasks', requireAdminAuth, handle((req, res) => {
    res.status(201);
    return { success: true, task: automation().kanban.createTask(req.params.boardId, bodyOf(req)) };
  }));
  app.post('/api/kanban/tasks/bulk', requireAdminAuth, handle((req) => ({ success: true, ...automation().kanban.bulk(bodyOf(req)) })));
  app.post('/api/kanban/links', requireAdminAuth, handle((req) => {
    automation().kanban.link(bodyOf(req));
    return { success: true };
  }));
  app.delete('/api/kanban/links', requireAdminAuth, handle((req) => ({ success: true, removed: automation().kanban.unlink(bodyOf(req)) })));
  app.get('/api/kanban/tasks/:taskId', handle((req) => {
    guardTask(getRequestIdentity(req), req.params.taskId);
    return { success: true, ...automation().kanban.detail(req.params.taskId) };
  }));
  app.patch('/api/kanban/tasks/:taskId', requireAdminAuth, handle((req) => ({ success: true, task: automation().kanban.updateTask(req.params.taskId, bodyOf(req)) })));
  app.post('/api/kanban/tasks/:taskId/actions', handle((req) => {
    const body = bodyOf(req);
    const action = String(body.action ?? '');
    const identity = getRequestIdentity(req);
    guardTask(identity, req.params.taskId);
    if (!ctx.access.isAdmin(identity) && !MEMBER_KANBAN_ACTIONS.has(action)) {
      throw new AutomationError(403, AUTH_FORBIDDEN_ERROR_CODE, `Action ${action} requires an admin.`);
    }
    return { success: true, task: automation().kanban.act(req.params.taskId, action, body) };
  }));
  app.post('/api/kanban/tasks/:taskId/comments', handle((req, res) => {
    const identity = getRequestIdentity(req);
    guardTask(identity, req.params.taskId);
    const body = bodyOf(req);
    res.status(201);
    // member 的评论署自己的用户名，不能冒名。
    const comment = automation().kanban.comment(req.params.taskId, ctx.access.isAdmin(identity) ? body : { ...body, author: identity.username ?? 'member' });
    return { success: true, comment };
  }));
}
