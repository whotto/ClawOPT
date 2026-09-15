/**
 * 工作流 HTTP 接口：定义 CRUD、运行、证据、审批、重跑、导入导出、定时、入站钩子、设置、Agent 名册、SSE 状态流。
 * 全部在 `/api` 闸门之后注册，默认受保护。
 */
import express from 'express';

import { getRequestIdentity, type ResourceAccess } from '../core/auth';
import type { RouteApp } from '../core/http';
import type { Automation } from './create-automation';
import { AutomationError, WORKFLOW_ERROR, notFound } from './shared/errors';
import { bodyOf, handle, openSse } from './shared/http';
import { MAX_CONCURRENT_NODES_LIMIT } from './shared/settings';
import { clampInt, pick, uniqueStrings } from './shared/util';
import { workflowTopic, type HubMessage } from './workflow/status-hub';

export type WorkflowRoutesDeps = { automation: Automation; access: ResourceAccess };

const WORKFLOW_SSE_KEEPALIVE_MS = 25_000;

function parseTimeout(body: Record<string, unknown>): number | null {
  const raw = pick(body, 'timeout_ms', 'timeoutMs');
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new AutomationError(400, WORKFLOW_ERROR.invalidBody, 'timeout_ms', { field: 'timeout_ms' });
  return value;
}

export function registerWorkflowRoutes(app: RouteApp, ctx: WorkflowRoutesDeps): void {
  const importText = express.text({ type: 'text/plain', limit: '1100kb' });
  const automation = () => ctx.automation;

  app.get('/api/workflows', handle(() => ({ success: true, workflows: automation().workflows.list() })));
  app.post('/api/workflows', handle((req, res) => {
    res.status(201);
    return { success: true, workflow: automation().workflows.create(bodyOf(req)) };
  }));
  app.post('/api/workflows/batch-delete', handle(async (req) => ({ success: true, ...(await automation().workflows.batchDelete(bodyOf(req).ids)) })));

  app.post('/api/workflows/import/preview', importText, handle((req) => {
    const document = typeof req.body === 'string' ? req.body : bodyOf(req).document;
    return { success: true, ...automation().workflows.previewImport(document) };
  }));
  app.post('/api/workflows/import/confirm', handle((req, res) => {
    res.status(201);
    return { success: true, workflow: automation().workflows.confirmImport(bodyOf(req).token) };
  }));
  app.post('/api/workflows/import/cancel', handle((req) => ({ success: true, canceled: automation().workflows.cancelImport(bodyOf(req).token) })));

  app.get('/api/workflows/agents', handle(async () => ({ success: true, agents: await automation().directory.list(), fakeRunner: automation().fakeRunner })));
  // 待办中心的数据源（WS 的 approvals:workflows 只提醒「变了」）：按用户过滤到看得见的工作流。
  app.get('/api/workflows/pending-approvals', handle((req) => {
    const identity = getRequestIdentity(req);
    const approvals = automation().engine.pendingApprovals()
      .filter((item) => ctx.access.canAccessWorkflow(identity, automation().workflowAgentIds(item.workflowId)));
    return { success: true, approvals };
  }));
  app.get('/api/workflows/settings', handle(() => ({ success: true, concurrency: automation().settings.effectiveConcurrency(), maxConcurrencyLimit: MAX_CONCURRENT_NODES_LIMIT })));
  app.put('/api/workflows/settings', handle((req) => {
    const raw = pick(bodyOf(req), 'max_concurrent_nodes', 'maxConcurrentNodes');
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENT_NODES_LIMIT) {
      throw new AutomationError(400, WORKFLOW_ERROR.invalidBody, 'max_concurrent_nodes', { field: 'max_concurrent_nodes' });
    }
    automation().settings.setConfiguredConcurrency(value);
    return { success: true, concurrency: automation().settings.effectiveConcurrency(), maxConcurrencyLimit: MAX_CONCURRENT_NODES_LIMIT };
  }));

  app.get('/api/workflows/:id', handle((req) => ({
    success: true,
    workflow: automation().workflows.get(req.params.id),
    runtime: automation().hub.get(req.params.id),
  })));
  app.patch('/api/workflows/:id', handle((req) => ({ success: true, workflow: automation().workflows.update(req.params.id, bodyOf(req)) })));
  app.delete('/api/workflows/:id', handle(async (req) => {
    await automation().workflows.remove(req.params.id);
    return { success: true };
  }));
  app.get('/api/workflows/:id/export', handle((req) => ({ success: true, envelope: automation().workflows.exportEnvelope(req.params.id) })));

  app.post('/api/workflows/:id/run', handle(async (req, res) => {
    const body = bodyOf(req);
    const input = pick(body, 'input');
    const run = await automation().engine.startRun(req.params.id, {
      input: typeof input === 'string' ? input : null,
      startNodeIds: uniqueStrings(pick(body, 'start_node_ids', 'startNodeIds')),
      timeoutMs: parseTimeout(body),
      triggerSource: 'manual',
    });
    res.status(202);
    return { success: true, status: 'accepted', run };
  }));

  app.get('/api/workflows/:id/runs', handle((req) => {
    automation().workflows.get(req.params.id);
    const limit = clampInt(req.query.limit, 1, 500, 100);
    return { success: true, runs: automation().runStore.listRuns(req.params.id, limit).map(({ snapshotNodes: _n, snapshotEdges: _e, ...run }) => run) };
  }));
  app.get('/api/workflows/:id/runs/:runId', handle((req) => {
    const run = automation().runStore.getRun(req.params.runId);
    if (!run || run.workflowId !== req.params.id) throw notFound(WORKFLOW_ERROR.runNotFound, req.params.runId);
    return { success: true, run, evidence: automation().runStore.evidence(run.id), live: automation().engine.isRunLive(run.id) };
  }));
  app.get('/api/workflows/:id/runs/:runId/transcript', handle((req) => {
    const run = automation().runStore.getRun(req.params.runId);
    if (!run || run.workflowId !== req.params.id) throw notFound(WORKFLOW_ERROR.runNotFound, req.params.runId);
    const execution = automation().runStore.getExecution(run.id, String(req.query.executionId ?? ''));
    if (!execution) throw notFound(WORKFLOW_ERROR.runNotFound, String(req.query.executionId ?? ''));
    return {
      success: true,
      transcript: {
        executionId: execution.executionId,
        nodeId: execution.nodeId,
        sessionId: execution.sessionId,
        agent: { kind: execution.agentKind, id: execution.agentId },
        status: execution.status,
        prompt: execution.promptText,
        output: execution.outputText,
        error: execution.error,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        // 节点作为协调器会话运行（workflow 表面，不进聊天列表）：工具调用、用量与会话状态；运行中的增量订阅 `topic`。
        session: automation().nodeSession(execution.sessionId),
      },
    };
  }));
  app.post('/api/workflows/:id/runs/:runId/stop', handle((req) => ({ success: true, run: automation().engine.stopRun(req.params.id, req.params.runId) })));
  app.delete('/api/workflows/:id/runs/:runId', handle(async (req) => {
    await automation().engine.deleteRun(req.params.id, req.params.runId);
    return { success: true };
  }));
  app.post('/api/workflows/:id/runs/:runId/nodes/:nodeId/approval', handle((req) => {
    const body = bodyOf(req);
    const executionId = pick(body, 'execution_id', 'executionId');
    automation().engine.resolveApproval(req.params.id, req.params.runId, req.params.nodeId, {
      approved: body.approved !== false,
      executionId: typeof executionId === 'string' ? executionId : null,
    });
    return { success: true };
  }));
  app.post('/api/workflows/:id/runs/:runId/rerun-from-node', handle(async (req, res) => {
    const body = bodyOf(req);
    const nodeId = pick(body, 'node_id', 'nodeId');
    if (typeof nodeId !== 'string' || !nodeId) throw new AutomationError(400, WORKFLOW_ERROR.invalidBody, 'node_id', { field: 'node_id' });
    const run = await automation().engine.rerunFromNode(req.params.id, req.params.runId, {
      nodeId,
      preserveStartNode: pick(body, 'preserve_start_node', 'preserveStartNode') === true,
      timeoutMs: parseTimeout(body),
    });
    res.status(202);
    return { success: true, status: 'accepted', run };
  }));

  /**
   * 状态流的 SSE 兜底（主通道是 `/ws` 的 `workflow:<id>` 主题）：先推当前状态，再推增量证据。
   * `since=<seq>&runId=` 让重连从已有序号续上。授权与 WS 主题同一判据。
   */
  app.get('/api/workflows/:id/events', (req, res) => {
    const workflowId = req.params.id;
    if (!ctx.access.canAccessWorkflow(getRequestIdentity(req), automation().workflowAgentIds(workflowId))) {
      const error = notFound(WORKFLOW_ERROR.notFound, workflowId).toRequestError();
      res.status(error.status).json(error.payload);
      return;
    }
    openSse(res);
    const runId = typeof req.query.runId === 'string' ? req.query.runId : '';
    const since = Number(req.query.since);
    const send = (message: HubMessage) => {
      try {
        res.write(`event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
      } catch {
        // 连接已断，取消订阅在 close 里做
      }
    };
    res.write(`event: connected\ndata: ${JSON.stringify({ topic: workflowTopic(workflowId) })}\n\n`);
    const unsubscribe = ctx.automation.hub.subscribe(workflowId, send, runId && Number.isInteger(since) && since >= 0 ? { runId, seq: since } : undefined);
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* 已断开 */ }
    }, WORKFLOW_SSE_KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.get('/api/workflows/:id/schedules', handle((req) => {
    automation().workflows.get(req.params.id);
    return { success: true, schedules: automation().schedules.list(req.params.id) };
  }));
  app.post('/api/workflows/:id/schedules', handle((req, res) => {
    automation().workflows.get(req.params.id);
    res.status(201);
    return { success: true, schedule: automation().schedules.create(req.params.id, bodyOf(req)) };
  }));
  app.patch('/api/workflows/:id/schedules/:scheduleId', handle((req) => ({ success: true, schedule: automation().schedules.update(req.params.id, req.params.scheduleId, bodyOf(req)) })));
  app.delete('/api/workflows/:id/schedules/:scheduleId', handle((req) => {
    automation().schedules.remove(req.params.id, req.params.scheduleId);
    return { success: true };
  }));
  app.get('/api/workflows/:id/schedules/:scheduleId/events', handle((req) => ({
    success: true,
    events: automation().schedules.events(req.params.id, req.params.scheduleId, Number(req.query.limit) || 50),
  })));

  app.get('/api/workflows/:id/hooks', handle((req) => {
    automation().workflows.get(req.params.id);
    return { success: true, hooks: automation().hooks.list(req.params.id) };
  }));
  app.post('/api/workflows/:id/hooks', handle((req, res) => {
    automation().workflows.get(req.params.id);
    res.status(201);
    return { success: true, ...automation().hooks.create(req.params.id, bodyOf(req)) };
  }));
  app.patch('/api/workflows/:id/hooks/:hookId', handle((req) => ({ success: true, hook: automation().hooks.update(req.params.id, req.params.hookId, bodyOf(req)) })));
  app.post('/api/workflows/:id/hooks/:hookId/rotate-secret', handle((req) => ({ success: true, ...automation().hooks.rotateSecret(req.params.id, req.params.hookId) })));
  app.delete('/api/workflows/:id/hooks/:hookId', handle((req) => {
    automation().hooks.remove(req.params.id, req.params.hookId);
    return { success: true };
  }));
}
