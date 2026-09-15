/**
 * 工作流引擎门面：准入、预检、启动、停止、审批、重跑、重启恢复。
 *
 * - **准入互斥**：同一工作流的准入串行（promise 链锁），锁内查「已有活跃运行」→ 预检 → 写运行行。
 *   写行成功即「持久受理」，HTTP 这时才回 202；静态上界超限在写行之前就拒绝。
 * - **终态**：completed / completed_with_failures / failed / canceled。
 *   `completed_with_failures`：有节点失败，但每一个失败都经 failure / always 路由被接住。
 * - **重启恢复**：活跃运行一律按失败收尾，不续跑（fail closed）。
 */
import { AutomationError, WORKFLOW_ERROR, conflict, notFound } from '../shared/errors';
import type { AutomationSettings } from '../shared/settings';
import type { AgentDirectory, AttachmentResolver, BusinessEventPublisher, WorkflowAgentRunner } from '../ports';
import { activeNodeIds, compileWorkflow, MAX_WORKFLOW_RUN_EXECUTIONS, staticExecutionBound } from './compiler';
import type { DefinitionStore } from './definition-store';
import { GraphError } from './normalize';
import { RunContext, RunFatal } from './run-context';
import type { RunRecord, RunStore } from './run-store';
import { fatalFor, runRegion, triggerFatal } from './scheduler';
import type { RuntimeStatus, StatusHub } from './status-hub';
import { TERMINAL_RUN_STATUSES, type CompiledGraph, type RunStatus, type TriggerSource, type WorkflowEdge } from './types';

export const RUN_INTERRUPTED_MESSAGE = 'Workflow runtime cannot safely resume because the server restarted';
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 86_400_000;

export type EngineDeps = {
  defs: DefinitionStore;
  runStore: RunStore;
  runner: WorkflowAgentRunner;
  directory: AgentDirectory;
  resolveAttachment: AttachmentResolver;
  publishEvent: BusinessEventPublisher;
  settings: AutomationSettings;
  hub: StatusHub;
  resolveWorkspace: (workflowId: string, configured: string | null) => string;
  now?: () => number;
};

export type StartRunOptions = {
  input?: string | null;
  startNodeIds?: string[];
  timeoutMs?: number | null;
  triggerSource?: TriggerSource;
  scheduledAt?: number | null;
};

export function graphErrorToAutomation(error: unknown): unknown {
  if (error instanceof GraphError) {
    return new AutomationError(400, WORKFLOW_ERROR.invalidGraph, error.message, { reason: error.reason, ...error.params });
  }
  return error;
}

export function createWorkflowEngine(deps: EngineDeps) {
  const now = deps.now ?? Date.now;
  const contexts = new Map<string, RunContext>();
  const completions = new Map<string, Promise<void>>();
  const locks = new Map<string, Promise<unknown>>();

  function withLock<T>(workflowId: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = locks.get(workflowId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    locks.set(workflowId, tail);
    void tail.then(() => {
      if (locks.get(workflowId) === tail) locks.delete(workflowId);
    });
    return next;
  }

  function validateTimeout(timeoutMs: number | null | undefined): number | null {
    if (timeoutMs === null || timeoutMs === undefined) return null;
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      throw new AutomationError(400, WORKFLOW_ERROR.invalidBody, 'timeout_ms must be an integer 1000..86400000', { field: 'timeout_ms' });
    }
    return timeoutMs;
  }

  /** 预检：静态上界 → Agent 可用 → 技能可解析 → 附件可服务。任何一项不过都不写运行行。 */
  function preflight(graph: CompiledGraph, active: Set<string>): void {
    const bound = staticExecutionBound(graph.loops, active);
    if (bound > MAX_WORKFLOW_RUN_EXECUTIONS) {
      throw new AutomationError(400, WORKFLOW_ERROR.budgetExceeded,
        `static execution bound ${bound} exceeds run budget ${MAX_WORKFLOW_RUN_EXECUTIONS}`, { bound, budget: MAX_WORKFLOW_RUN_EXECUTIONS });
    }
    for (const node of graph.nodes) {
      if (!active.has(node.id)) continue;
      const availability = deps.directory.availability(node.data.agent);
      if (!availability.available) {
        throw conflict(WORKFLOW_ERROR.agentUnavailable, availability.reason, { nodeId: node.id, agent: node.data.agent.id });
      }
      for (const skill of node.data.skills) {
        if (deps.directory.readSkill(node.data.agent, skill) === null) {
          throw conflict(WORKFLOW_ERROR.skillMissing, `skill not found: ${skill}`, { nodeId: node.id, skill });
        }
      }
      for (const attachment of node.data.attachments) {
        if (!deps.resolveAttachment(attachment.url)) {
          throw conflict(WORKFLOW_ERROR.attachmentMissing, attachment.url, { nodeId: node.id, name: attachment.name });
        }
      }
    }
  }

  function runtimeStatus(ctx: RunContext | null, run: RunRecord): RuntimeStatus {
    return {
      workflowId: run.workflowId,
      runId: run.id,
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: now(),
      finishedAt: run.finishedAt,
      error: run.error,
      errorCode: run.errorCode,
      evidenceSeq: run.evidenceSeq,
      nodeStatuses: ctx ? Object.fromEntries(ctx.nodeStatus) : {},
      pendingApprovals: ctx ? [...ctx.approvals.values()].map(({ nodeId, executionId }) => ({ nodeId, executionId })) : [],
    };
  }

  function publish(ctx: RunContext): void {
    const fresh = deps.runStore.getRun(ctx.runId);
    if (fresh) ctx.run = fresh;
    deps.hub.update(runtimeStatus(ctx, ctx.run));
  }

  function eventPayload(ctx: RunContext) {
    return {
      workflowId: ctx.run.workflowId,
      workflowName: ctx.options.workflowName,
      runId: ctx.runId,
      status: ctx.run.status,
      triggerSource: ctx.run.triggerSource,
      error: ctx.run.error,
      errorCode: ctx.run.errorCode,
      startedAt: ctx.run.startedAt,
      finishedAt: ctx.run.finishedAt,
    };
  }

  function finalize(ctx: RunContext): void {
    if (ctx.deadlineTimer) clearTimeout(ctx.deadlineTimer);
    if (!ctx.fatal) {
      const unresolved = ctx.failures.filter((failure) => !failure.resolved);
      let status: RunStatus = 'completed';
      let error: string | null = null;
      let errorCode: string | null = null;
      if (unresolved.length) {
        const unhandled = unresolved.find((failure) => !failure.handled);
        if (unhandled) {
          status = 'failed';
          const title = ctx.nodeById.get(unhandled.nodeId)?.data.title ?? unhandled.nodeId;
          error = `Node ${title} failed: ${unhandled.error}`;
          errorCode = 'workflows.nodeFailed';
        } else {
          status = 'completed_with_failures';
          error = `${unresolved.length} node failure(s) were handled by failure routes`;
          errorCode = 'workflows.completedWithFailures';
        }
      }
      deps.runStore.setRunStatus(ctx.runId, status, { error, errorCode });
    }
    publish(ctx);
    deps.publishEvent(`workflow.run.${ctx.run.status}`, eventPayload(ctx));
    contexts.delete(ctx.runId);
  }

  function launch(ctx: RunContext): Promise<void> {
    contexts.set(ctx.runId, ctx);
    if (ctx.run.deadlineAt !== null) {
      const wait = Math.max(0, ctx.run.deadlineAt - now());
      ctx.deadlineTimer = setTimeout(() => triggerFatal(ctx, fatalFor('timeout', ctx)), wait);
      ctx.deadlineTimer.unref?.();
    }
    publish(ctx);
    deps.publishEvent('workflow.run.started', eventPayload(ctx));
    const completion = (async () => {
      try {
        await runRegion(ctx, null, ctx.rootPath(), new Map(), null);
      } catch (error) {
        if (!(error instanceof RunFatal)) triggerFatal(ctx, fatalFor('internal', ctx, (error as Error)?.message));
        else if (!ctx.fatal) triggerFatal(ctx, error);
      }
      try {
        finalize(ctx);
      } catch (error) {
        console.error('[Workflow] finalize failed:', (error as Error)?.message);
        contexts.delete(ctx.runId);
      }
    })();
    completions.set(ctx.runId, completion);
    void completion.finally(() => completions.delete(ctx.runId));
    return completion;
  }

  function contextFor(run: RunRecord, graph: CompiledGraph, active: Set<string>, workflowName: string, extra: {
    scope: string | null; boundaryEdgeIds?: Set<string>; clearStartNodeIds?: Set<string>;
  }): RunContext {
    return new RunContext(run, graph, active, new Set(run.startNodeIds), {
      inputOverride: run.input,
      inputStartNodeIds: new Set(run.inputStartNodeIds),
      scope: extra.scope,
      boundaryEdgeIds: extra.boundaryEdgeIds ?? new Set(),
      clearStartNodeIds: extra.clearStartNodeIds ?? new Set(),
      workflowName,
      workspace: deps.resolveWorkspace(run.workflowId, run.workspace),
    }, {
      runStore: deps.runStore,
      runner: deps.runner,
      directory: deps.directory,
      resolveAttachment: deps.resolveAttachment,
      publishEvent: deps.publishEvent,
      onStatusChange: publish,
      now,
    });
  }

  async function startRun(workflowId: string, options: StartRunOptions = {}): Promise<RunRecord> {
    const timeoutMs = validateTimeout(options.timeoutMs);
    const { run, ctx } = await withLock(workflowId, () => {
      const def = deps.defs.get(workflowId);
      if (!def) throw notFound(WORKFLOW_ERROR.notFound, workflowId);
      if (deps.runStore.activeRunForWorkflow(workflowId)) throw conflict(WORKFLOW_ERROR.alreadyRunning, 'workflow is already running');
      let graph: CompiledGraph;
      try {
        graph = compileWorkflow(def.nodes, def.edges, { requestedStartNodeIds: options.startNodeIds, requireConnected: true });
      } catch (error) {
        throw graphErrorToAutomation(error);
      }
      const active = activeNodeIds(graph, graph.startNodeIds);
      preflight(graph, active);
      const startedAt = now();
      const created = deps.runStore.createRun({
        workflowId,
        workspace: def.workspace,
        status: 'running',
        startNodeIds: graph.startNodeIds,
        input: typeof options.input === 'string' && options.input.length ? options.input : null,
        inputStartNodeIds: graph.startNodeIds,
        snapshotNodes: graph.nodes,
        snapshotEdges: graph.edges,
        compiledLoops: graph.loops,
        requestedTimeoutMs: timeoutMs,
        deadlineAt: timeoutMs === null ? null : startedAt + timeoutMs,
        maxConcurrency: deps.settings.effectiveConcurrency().effective,
        triggerSource: options.triggerSource ?? 'manual',
        scheduledAt: options.scheduledAt ?? null,
        startedAt,
      });
      return { run: created, ctx: contextFor(created, graph, active, def.name, { scope: null }) };
    });
    void launch(ctx);
    return run;
  }

  function stopRun(workflowId: string, runId: string): RunRecord {
    const run = deps.runStore.getRun(runId);
    if (!run || run.workflowId !== workflowId) throw notFound(WORKFLOW_ERROR.runNotFound, runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    const ctx = contexts.get(runId);
    if (ctx) {
      triggerFatal(ctx, fatalFor('canceled', ctx));
    } else {
      deps.runStore.closeActiveExecutions(runId, 'canceled', 'Workflow run canceled by user');
      deps.runStore.setRunStatus(runId, 'canceled', { error: 'Workflow run canceled by user', errorCode: 'workflows.runCanceled' });
    }
    return deps.runStore.getRun(runId)!;
  }

  function resolveApproval(workflowId: string, runId: string, nodeId: string, input: { approved: boolean; executionId?: string | null }): void {
    const run = deps.runStore.getRun(runId);
    if (!run || run.workflowId !== workflowId) throw notFound(WORKFLOW_ERROR.runNotFound, runId);
    const ctx = contexts.get(runId);
    const matches = ctx
      ? [...ctx.approvals.values()].filter((item) => item.nodeId === nodeId && (!input.executionId || item.executionId === input.executionId))
      : [];
    if (matches.length !== 1) throw conflict(WORKFLOW_ERROR.noPendingApproval, 'no single matching pending approval', { nodeId });
    matches[0].resolve(input.approved);
  }

  async function rerunFromNode(workflowId: string, runId: string, input: { nodeId: string; preserveStartNode: boolean; timeoutMs?: number | null }): Promise<RunRecord> {
    const timeoutMs = validateTimeout(input.timeoutMs);
    const { run, ctx } = await withLock(workflowId, () => {
      const current = deps.runStore.getRun(runId);
      if (!current || current.workflowId !== workflowId) throw notFound(WORKFLOW_ERROR.runNotFound, runId);
      if (!TERMINAL_RUN_STATUSES.has(current.status)) throw conflict(WORKFLOW_ERROR.runNotTerminal, 'run is still active');
      if (deps.runStore.activeRunForWorkflow(workflowId)) throw conflict(WORKFLOW_ERROR.alreadyRunning, 'workflow is already running');
      let graph: CompiledGraph;
      try {
        graph = compileWorkflow(current.snapshotNodes, current.snapshotEdges, { requireConnected: false });
      } catch (error) {
        throw graphErrorToAutomation(error);
      }
      if (!graph.nodes.some((node) => node.id === input.nodeId)) {
        throw new AutomationError(400, WORKFLOW_ERROR.invalidBody, 'node not in run snapshot', { nodeId: input.nodeId });
      }
      const latestExec = deps.runStore.latestExecutions(runId);
      const latestEval = deps.runStore.latestEdgeEvaluations(runId);
      const forwardOut = (id: string) => graph.edges.filter((edge) => edge.source === id && !edge.data.orchestration.feedback);

      let starts: string[];
      if (input.preserveStartNode) {
        const exec = latestExec.get(input.nodeId);
        if (!exec || exec.status !== 'completed') throw conflict(WORKFLOW_ERROR.rerunNodeNotCompleted, input.nodeId, { nodeId: input.nodeId });
        starts = [...new Set(forwardOut(input.nodeId).filter((edge) => latestEval.get(edge.id)?.status === 'taken').map((edge) => edge.target))];
        if (!starts.length) throw new AutomationError(400, WORKFLOW_ERROR.rerunNothingToRun, input.nodeId, { nodeId: input.nodeId });
      } else {
        starts = [input.nodeId];
      }

      const active = activeNodeIds(graph, starts);
      if (input.preserveStartNode && !starts.some((id) => activeNodeIds(graph, [id]).has(input.nodeId))) active.delete(input.nodeId);
      const boundary = new Set<string>();
      const byTarget = new Map<string, WorkflowEdge[]>();
      for (const edge of graph.edges) {
        if (edge.data.orchestration.feedback) continue;
        if (!byTarget.has(edge.target)) byTarget.set(edge.target, []);
        byTarget.get(edge.target)!.push(edge);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of [...active]) {
          for (const edge of byTarget.get(id) ?? []) {
            if (active.has(edge.source)) continue;
            if (latestExec.get(edge.source)?.status === 'completed') {
              if (!latestEval.get(edge.id)) throw conflict(WORKFLOW_ERROR.rerunMissingDecision, edge.id, { edgeId: edge.id });
              boundary.add(edge.id);
            } else {
              active.add(edge.source);
              changed = true;
            }
          }
        }
      }
      for (const edgeId of [...boundary]) {
        const edge = graph.edges.find((item) => item.id === edgeId)!;
        if (active.has(edge.source)) boundary.delete(edgeId);
      }
      preflight(graph, active);

      const startedAt = Math.max(now(), current.startedAt + 1);
      const ok = deps.runStore.resetForRerun(runId, current, {
        startedAt,
        deadlineAt: timeoutMs === null ? null : startedAt + timeoutMs,
        requestedTimeoutMs: timeoutMs,
        maxConcurrency: deps.settings.effectiveConcurrency().effective,
        startNodeIds: starts,
      });
      if (!ok) throw conflict(WORKFLOW_ERROR.rerunChanged, 'run changed during rerun preflight');
      const reset = deps.runStore.getRun(runId)!;
      const def = deps.defs.get(workflowId);
      const context = contextFor(reset, graph, active, def?.name ?? workflowId, {
        scope: `rerun:${startedAt}`,
        boundaryEdgeIds: boundary,
        clearStartNodeIds: input.preserveStartNode ? new Set() : new Set([input.nodeId]),
      });
      // 边界：非活跃且已完成的上游，产出从持久化的执行记录读回，判定从持久化的证据读回。
      for (const edgeId of boundary) {
        const edge = graph.edges.find((item) => item.id === edgeId)!;
        const exec = latestExec.get(edge.source)!;
        context.outputs.set(edge.source, { output: exec.outputText ?? '', executionId: exec.executionId });
        const evaluation = latestEval.get(edgeId)!;
        context.latest.set(edgeId, { status: evaluation.status, evaluationId: evaluation.id });
      }
      return { run: reset, ctx: context };
    });
    void launch(ctx);
    return run;
  }

  function recoverOnBoot(): { recovered: string[] } {
    const recovered: string[] = [];
    for (const run of deps.runStore.listActiveRuns()) {
      const evidence = deps.runStore.evidence(run.id);
      const active = evidence.nodeExecutions.filter((exec) => ['queued', 'running', 'pending_approval'].includes(exec.status));
      for (const exec of active) {
        for (let depth = 1; depth <= exec.iterationPath.steps.length; depth++) {
          const steps = exec.iterationPath.steps.slice(0, depth);
          const step = steps[steps.length - 1];
          try {
            deps.runStore.appendLoopEpoch({
              runId: run.id, workflowId: run.workflowId, loopId: step.loopId, iteration: step.iteration,
              iterationPath: { scope: exec.iterationPath.scope, steps }, status: 'failed', exitReason: RUN_INTERRUPTED_MESSAGE,
              startedAt: exec.startedAt ?? now(),
            });
          } catch (error) {
            console.warn('[Workflow] recovery epoch write failed:', (error as Error)?.message);
          }
        }
        if (exec.sessionId) {
          try {
            void Promise.resolve(deps.runner.abort(exec.sessionId)).catch(() => undefined);
          } catch {
            // 尽力而为
          }
        }
      }
      deps.runStore.closeActiveExecutions(run.id, 'failed', RUN_INTERRUPTED_MESSAGE);
      deps.runStore.setRunStatus(run.id, 'failed', { error: RUN_INTERRUPTED_MESSAGE, errorCode: 'workflows.runInterruptedByRestart' });
      recovered.push(run.id);
    }
    return { recovered };
  }

  async function deleteRun(workflowId: string, runId: string): Promise<void> {
    const run = deps.runStore.getRun(runId);
    if (!run || run.workflowId !== workflowId) throw notFound(WORKFLOW_ERROR.runNotFound, runId);
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      stopRun(workflowId, runId);
      await completions.get(runId)?.catch(() => undefined);
    }
    deps.runStore.deleteRun(runId);
    if (deps.hub.get(workflowId)?.runId === runId) deps.hub.forget(workflowId);
  }

  async function deleteWorkflowRuns(workflowId: string): Promise<void> {
    for (const runId of deps.runStore.runIdsForWorkflow(workflowId)) await deleteRun(workflowId, runId);
    deps.hub.forget(workflowId);
  }

  function pendingApprovals() {
    const out: Array<{ workflowId: string; workflowName: string; runId: string; nodeId: string; nodeTitle: string; executionId: string }> = [];
    for (const ctx of contexts.values()) {
      for (const approval of ctx.approvals.values()) {
        out.push({
          workflowId: ctx.run.workflowId,
          workflowName: ctx.options.workflowName,
          runId: ctx.runId,
          nodeId: approval.nodeId,
          nodeTitle: ctx.nodeById.get(approval.nodeId)?.data.title ?? approval.nodeId,
          executionId: approval.executionId,
        });
      }
    }
    return out;
  }

  return {
    startRun,
    stopRun,
    resolveApproval,
    rerunFromNode,
    recoverOnBoot,
    deleteRun,
    deleteWorkflowRuns,
    pendingApprovals,
    isRunLive: (runId: string) => contexts.has(runId),
    /** 测试与关停用：等某次运行的调度真正结束。 */
    waitForRun: (runId: string) => completions.get(runId) ?? Promise.resolve(),
    stopAll(): void {
      for (const ctx of contexts.values()) triggerFatal(ctx, fatalFor('canceled', ctx));
    },
  };
}

export type WorkflowEngine = ReturnType<typeof createWorkflowEngine>;
