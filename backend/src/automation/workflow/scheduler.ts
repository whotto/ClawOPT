/**
 * 调度器：一个递归的「区域」调度器同时覆盖无循环的 DAG 与嵌套循环。
 *
 * - 区域 = 根（全部活跃节点）或某个循环体；单元 = 区域里直属的节点 + 直接子循环。
 * - 就绪判定：节点看它在本区域内的前向入边（加重跑边界边）的汇合；子循环看入口节点从循环外进来的边。
 * - 边的判定查找：来源是直属节点 → 本轮判定；来源在子循环里 → 子循环结束后交回的判定（没结束就是未决）；
 *   边界边 → 持久化的最新判定。这样循环没跑完之前，下游不会被第 0 轮的出口判定提前放行。
 * - 无循环时区域就是根、单元都是节点，行为与 spec 的完成驱动 DAG 调度器一致（见报告「偏离」一节）。
 *
 * 致命错误（停止 / 到期 / 审批拒绝 / 证据写入失败 / 执行预算）走 `triggerFatal`：
 * 先把运行与活跃执行落成终态，再中止 Agent、拒绝挂起的审批（先落库再中止）。
 */
import { randomUUID } from 'crypto';

import { AttachmentMissingError, buildContentBlocks, buildNodePromptText, contentBlocksToText, type SkillBlock, type UpstreamBlock } from './prompt';
import { decideEdge, decideJoin, needsStructuredOutput, parseStructuredOutput, type DecisionContext, type JoinState } from './decisions';
import { MAX_WORKFLOW_RUN_EXECUTIONS } from './compiler';
import { TerminalRunError } from './run-store';
import { pathHasPrefix, RUN_CANCELED_MESSAGE, RunFatal, runTimeoutMessage, type RunContext } from './run-context';
import type { CompiledLoop, DecisionStatus, EdgeDecision, IterationPath, LoopEpochStatus, SourceOutcome, WorkflowEdge } from './types';

type PassDecisions = Map<string, DecisionStatus>;

export function fatalFor(kind: RunFatal['kind'], ctx: RunContext, detail?: string): RunFatal {
  switch (kind) {
    case 'canceled': return new RunFatal('canceled', RUN_CANCELED_MESSAGE, 'workflows.runCanceled');
    case 'timeout': return new RunFatal('timeout', runTimeoutMessage(ctx.run.requestedTimeoutMs), 'workflows.runTimedOut');
    case 'approval_rejected': return new RunFatal('approval_rejected', `Node ${detail} approval rejected`, 'workflows.approvalRejected');
    case 'evidence': return new RunFatal('evidence', `workflow evidence could not be written: ${detail ?? ''}`, 'workflows.evidenceWriteFailed');
    case 'budget': return new RunFatal('budget', `execution budget exceeded (${MAX_WORKFLOW_RUN_EXECUTIONS})`, 'workflows.executionBudgetExceeded');
    default: return new RunFatal('internal', detail || 'workflow scheduler error', 'workflows.schedulerError');
  }
}

/** 第一次致命错误赢；之后的都忽略。先落库，再中止。 */
export function triggerFatal(ctx: RunContext, fatal: RunFatal): RunFatal {
  if (ctx.fatal) return ctx.fatal;
  ctx.fatal = fatal;
  const { runStore } = ctx.deps;
  const execStatus = fatal.kind === 'timeout' ? 'failed' : 'canceled';
  try {
    runStore.closeActiveExecutions(ctx.runId, execStatus, fatal.message);
    runStore.setRunStatus(ctx.runId, fatal.kind === 'canceled' ? 'canceled' : 'failed', { error: fatal.message, errorCode: fatal.code });
  } catch (error) {
    console.error('[Workflow] failed to persist fatal state:', (error as Error)?.message);
  }
  for (const [nodeId, status] of ctx.nodeStatus) {
    if (status === 'queued' || status === 'running' || status === 'pending_approval') {
      ctx.nodeStatus.set(nodeId, execStatus === 'failed' ? 'failed' : 'canceled');
    }
  }
  if (ctx.deadlineTimer) clearTimeout(ctx.deadlineTimer);
  ctx.deps.onStatusChange(ctx);
  // 落库之后才中止：迟到的完成看到的是终态，改不动任何东西。
  ctx.abort.abort();
  for (const sessionId of ctx.inflightSessions.values()) {
    try {
      void Promise.resolve(ctx.deps.runner.abort(sessionId)).catch(() => undefined);
    } catch {
      // 中止是尽力而为
    }
  }
  for (const approval of [...ctx.approvals.values()]) approval.resolve(false);
  ctx.semaphore.drain();
  return fatal;
}

function asFatal(ctx: RunContext, error: unknown): RunFatal {
  if (error instanceof RunFatal) return error;
  if (error instanceof TerminalRunError) return ctx.fatal ?? fatalFor('canceled', ctx);
  return fatalFor('internal', ctx, (error as Error)?.message);
}

function persistDecision(
  ctx: RunContext, edge: WorkflowEdge, sourceExecutionId: string | null, path: IterationPath,
  outcome: SourceOutcome, decision: EdgeDecision,
): string {
  try {
    const record = ctx.deps.runStore.appendEdgeEvaluation({
      runId: ctx.runId,
      workflowId: ctx.run.workflowId,
      edge,
      sourceExecutionId,
      iterationPath: path,
      sourceOutcome: outcome,
      status: decision.status,
      reason: decision.reason,
      conditionEvaluation: decision.evaluation,
    });
    ctx.latest.set(edge.id, { status: decision.status, evaluationId: record.id });
    return record.id;
  } catch (error) {
    // 判定没写进去，目标就绝不启动（fail closed）。
    if (error instanceof TerminalRunError) throw ctx.fatal ?? fatalFor('canceled', ctx);
    throw triggerFatal(ctx, fatalFor('evidence', ctx, (error as Error)?.message));
  }
}

function evaluateOutgoing(
  ctx: RunContext, nodeId: string, executionId: string | null, path: IterationPath,
  outcome: SourceOutcome, context: DecisionContext, pass: PassDecisions,
): EdgeDecision[] {
  const edges = ctx.forwardOut.get(nodeId)!.filter((edge) => ctx.active.has(edge.target));
  if (outcome === 'success' && context.output !== undefined && needsStructuredOutput(edges.map((edge) => edge.data.orchestration))) {
    const parsed = parseStructuredOutput(context.output);
    if (parsed.ok) context = { ...context, outputJson: parsed.value };
  }
  const decisions: EdgeDecision[] = [];
  for (const edge of edges) {
    const decision = decideEdge(edge.data.orchestration, outcome, context);
    persistDecision(ctx, edge, executionId, path, outcome, decision);
    pass.set(edge.id, decision.status);
    decisions.push(decision);
  }
  return decisions;
}

function skipNode(ctx: RunContext, nodeId: string, path: IterationPath, pass: PassDecisions): void {
  ctx.nodeStatus.set(nodeId, 'skipped');
  ctx.outputs.delete(nodeId);
  evaluateOutgoing(ctx, nodeId, null, path, 'skipped', {}, pass);
  ctx.deps.onStatusChange(ctx);
}

function collectUpstream(ctx: RunContext, nodeId: string): { blocks: UpstreamBlock[]; evaluationIds: string[] } {
  const blocks: UpstreamBlock[] = [];
  const evaluationIds: string[] = [];
  for (const edge of ctx.allIn.get(nodeId)!) {
    const decision = ctx.latest.get(edge.id);
    if (decision?.status !== 'taken') continue;
    const source = ctx.outputs.get(edge.source);
    if (!source || (source.output === undefined && source.error === undefined)) continue;
    const title = ctx.nodeById.get(edge.source)?.data.title ?? edge.source;
    blocks.push({ title, text: source.output ?? source.error ?? '', failed: source.output === undefined });
    if (decision.evaluationId) evaluationIds.push(decision.evaluationId);
  }
  return { blocks, evaluationIds };
}

async function executeNode(ctx: RunContext, nodeId: string, path: IterationPath, pass: PassDecisions): Promise<void> {
  ctx.checkFatal();
  const node = ctx.nodeById.get(nodeId)!;
  ctx.executionCount += 1;
  if (ctx.executionCount > MAX_WORKFLOW_RUN_EXECUTIONS) throw triggerFatal(ctx, fatalFor('budget', ctx));
  const executionId = ctx.executionId(nodeId, path);
  const { runStore, runner, directory, now } = ctx.deps;

  const release = await ctx.semaphore.acquire();
  let releaseOnce = release;
  try {
    ctx.checkFatal();
    const remaining = ctx.remainingMs();
    if (remaining !== null && remaining <= 0) throw triggerFatal(ctx, fatalFor('timeout', ctx));

    const upstream = collectUpstream(ctx, nodeId);
    const skills: SkillBlock[] = [];
    let preparationError: string | null = null;
    for (const name of node.data.skills) {
      const content = directory.readSkill(node.data.agent, name);
      if (content === null) {
        preparationError = `skill not found: ${name}`;
        break;
      }
      skills.push({ name, content });
    }
    const useOverride = ctx.options.inputOverride !== null
      && ctx.options.inputStartNodeIds.has(nodeId)
      && path.steps.every((step) => step.iteration === 0);
    const task = useOverride ? ctx.options.inputOverride! : node.data.input;
    const promptText = buildNodePromptText({ upstream: upstream.blocks, skills, task });
    let blocks;
    try {
      blocks = buildContentBlocks(promptText, node.data.attachments, ctx.deps.resolveAttachment);
    } catch (error) {
      if (!(error instanceof AttachmentMissingError)) throw error;
      preparationError = preparationError ?? error.message;
    }

    const sessionId = randomUUID();
    runStore.insertExecution({
      runId: ctx.runId,
      workflowId: ctx.run.workflowId,
      nodeId,
      executionId,
      iterationPath: path,
      consumedEdgeEvaluationIds: upstream.evaluationIds,
      sessionId,
      agentKind: node.data.agent.kind,
      agentId: node.data.agent.id,
      status: 'running',
      promptText: blocks ? contentBlocksToText(blocks) : promptText,
      remainingTimeoutMsAtStart: remaining,
    });
    ctx.nodeStatus.set(nodeId, 'running');
    ctx.outputs.delete(nodeId);
    ctx.deps.onStatusChange(ctx);

    let result: { ok: boolean; output: string; error?: string; timedOut?: boolean };
    if (preparationError || !blocks) {
      result = { ok: false, output: '', error: preparationError ?? 'prompt preparation failed' };
    } else {
      ctx.inflightSessions.set(executionId, sessionId);
      try {
        result = await runner.runAndWait({
          sessionId,
          agentRef: node.data.agent,
          input: blocks,
          workspace: ctx.options.workspace,
          timeoutMs: remaining ?? 24 * 60 * 60 * 1000,
          autoApprove: 'once',
          signal: ctx.abort.signal,
          ...(node.data.model ? { model: node.data.model } : {}),
        });
      } catch (error) {
        result = { ok: false, output: '', error: (error as Error)?.message || String(error) };
      } finally {
        ctx.inflightSessions.delete(executionId);
      }
    }
    releaseOnce();
    releaseOnce = () => undefined;

    // 迟到的完成：停止 / 到期之后回来的结果一律丢弃，不派发下游。
    ctx.checkFatal();

    if (!result.ok) {
      const deadlineHit = ctx.run.deadlineAt !== null && now() >= ctx.run.deadlineAt - 50;
      if (result.timedOut && deadlineHit) throw triggerFatal(ctx, fatalFor('timeout', ctx));
      const error = result.error || 'agent run failed';
      if (!runStore.updateExecution(ctx.runId, executionId, { status: 'failed', error })) throw asFatal(ctx, new TerminalRunError(ctx.runId));
      ctx.nodeStatus.set(nodeId, 'failed');
      ctx.outputs.set(nodeId, { error, executionId });
      const failure = { executionId, nodeId, error, path, handled: false, resolved: false };
      ctx.failures.push(failure);
      const decisions = evaluateOutgoing(ctx, nodeId, executionId, path, 'failure', { error }, pass);
      failure.handled = decisions.some((decision, index) => decision.status === 'taken'
        && ctx.forwardOut.get(nodeId)!.filter((edge) => ctx.active.has(edge.target))[index].data.orchestration.route !== 'success');
      ctx.deps.onStatusChange(ctx);
      return;
    }

    const output = result.output;
    if (node.data.approvalRequired) {
      if (!runStore.updateExecution(ctx.runId, executionId, { status: 'pending_approval', outputText: output })) {
        throw asFatal(ctx, new TerminalRunError(ctx.runId));
      }
      ctx.nodeStatus.set(nodeId, 'pending_approval');
      const approved = await new Promise<boolean>((resolve) => {
        ctx.approvals.set(executionId, { nodeId, executionId, resolve });
        ctx.deps.onStatusChange(ctx);
        ctx.deps.publishEvent('workflow.node.approval_requested', {
          workflowId: ctx.run.workflowId, workflowName: ctx.options.workflowName, runId: ctx.runId, nodeId, executionId,
          nodeTitle: node.data.title,
        });
      });
      ctx.approvals.delete(executionId);
      ctx.checkFatal();
      if (!approved) {
        runStore.updateExecution(ctx.runId, executionId, { status: 'approval_rejected', error: 'approval rejected' });
        ctx.nodeStatus.set(nodeId, 'approval_rejected');
        throw triggerFatal(ctx, fatalFor('approval_rejected', ctx, node.data.title));
      }
    }
    if (!runStore.updateExecution(ctx.runId, executionId, { status: 'completed', outputText: output })) {
      throw asFatal(ctx, new TerminalRunError(ctx.runId));
    }
    ctx.nodeStatus.set(nodeId, 'completed');
    ctx.outputs.set(nodeId, { output, executionId });
    evaluateOutgoing(ctx, nodeId, executionId, path, 'success', { output }, pass);
    ctx.deps.onStatusChange(ctx);
  } catch (error) {
    throw asFatal(ctx, error);
  } finally {
    releaseOnce();
  }
}

type Unit = { key: string; kind: 'node'; nodeId: string } | { key: string; kind: 'loop'; loop: CompiledLoop };

/**
 * 跑一个区域的一遍。`carry` 是上一轮闩节点的产出（只在循环第 i>0 轮有）。
 * 返回时 `pass` 里是本遍所有判定过的边（含子循环交回的）。
 */
export async function runRegion(
  ctx: RunContext, loop: CompiledLoop | null, path: IterationPath, pass: PassDecisions,
  carry: { nodeId: string; output?: string; error?: string; executionId: string | null } | null,
): Promise<void> {
  const regionNodes = new Set(loop ? loop.bodyNodeIds.filter((id) => ctx.active.has(id)) : ctx.active);
  const childLoops = ctx.graph.loops.filter((candidate) => candidate.parentLoopId === (loop?.id ?? null)
    && candidate.bodyNodeIds.some((id) => regionNodes.has(id)) && regionNodes.has(candidate.headerNodeId));
  const childOf = new Map<string, CompiledLoop>();
  for (const child of childLoops) for (const id of child.bodyNodeIds) childOf.set(id, child);

  if (loop) {
    for (const id of regionNodes) {
      ctx.outputs.delete(id);
      ctx.nodeStatus.set(id, 'queued');
    }
    for (const edge of ctx.graph.edges) {
      if (!edge.data.orchestration.feedback && regionNodes.has(edge.source) && regionNodes.has(edge.target)) ctx.latest.delete(edge.id);
    }
    for (const child of childLoops) ctx.latest.delete(child.feedbackEdgeId);
    if (carry) ctx.outputs.set(carry.nodeId, { output: carry.output, error: carry.error, executionId: carry.executionId });
  }

  const units: Unit[] = [
    ...[...regionNodes].filter((id) => !childOf.has(id)).map((nodeId) => ({ key: `n:${nodeId}`, kind: 'node' as const, nodeId })),
    ...childLoops.map((child) => ({ key: `l:${child.id}`, kind: 'loop' as const, loop: child })),
  ];
  const loopResults = new Map<string, PassDecisions>();
  const settled = new Set<string>();

  const lookup = (edge: WorkflowEdge): DecisionStatus | undefined => {
    if (ctx.options.boundaryEdgeIds.has(edge.id) && !ctx.active.has(edge.source)) return ctx.latest.get(edge.id)?.status;
    const child = childOf.get(edge.source);
    if (child) return loopResults.get(child.id)?.get(edge.id);
    return pass.get(edge.id);
  };
  const joinEdges = (nodeId: string, excludeBody?: Set<string>) => ctx.forwardIn.get(nodeId)!.filter((edge) => {
    if (!ctx.active.has(edge.source)) return ctx.options.boundaryEdgeIds.has(edge.id);
    return regionNodes.has(edge.source) && !(excludeBody?.has(edge.source));
  });
  // 「清空并重跑」的起点：历史判定不参与它的汇合（它是被显式点名要跑的），
  // 但一起被拉进来重跑的上游仍要等——否则它会拿着旧的上游上下文抢跑。
  const forJoin = (nodeId: string, edges: WorkflowEdge[]) => (ctx.options.clearStartNodeIds.has(nodeId)
    ? edges.filter((edge) => ctx.active.has(edge.source))
    : edges);
  const readiness = (unit: Unit): JoinState => {
    if (unit.kind === 'node') {
      const node = ctx.nodeById.get(unit.nodeId)!;
      return decideJoin(node.data.orchestration.join, forJoin(unit.nodeId, joinEdges(unit.nodeId)).map(lookup));
    }
    const header = ctx.nodeById.get(unit.loop.headerNodeId)!;
    return decideJoin(header.data.orchestration.join, forJoin(header.id, joinEdges(header.id, new Set(unit.loop.bodyNodeIds))).map(lookup));
  };

  const skipUnit = (unit: Unit) => {
    if (unit.kind === 'node') return skipNode(ctx, unit.nodeId, path, pass);
    const result: PassDecisions = new Map();
    for (const id of unit.loop.bodyNodeIds) {
      if (!ctx.active.has(id)) continue;
      skipNode(ctx, id, path, result);
    }
    loopResults.set(unit.loop.id, result);
    for (const [edgeId, status] of result) pass.set(edgeId, status);
  };

  const inflight = new Map<string, Promise<{ key: string; error?: unknown }>>();
  const launch = (unit: Unit) => {
    const work = unit.kind === 'node'
      ? executeNode(ctx, unit.nodeId, path, pass)
      : runLoop(ctx, unit.loop, path).then((result) => {
        loopResults.set(unit.loop.id, result);
        for (const [edgeId, status] of result) pass.set(edgeId, status);
      });
    inflight.set(unit.key, work.then(() => ({ key: unit.key }), (error) => ({ key: unit.key, error })));
  };

  for (;;) {
    let progress = true;
    while (progress) {
      progress = false;
      for (const unit of units) {
        if (settled.has(unit.key) || inflight.has(unit.key)) continue;
        if (readiness(unit) === 'skipped') {
          skipUnit(unit);
          settled.add(unit.key);
          progress = true;
        }
      }
    }
    ctx.checkFatal();
    for (const unit of units) {
      if (settled.has(unit.key) || inflight.has(unit.key)) continue;
      if (readiness(unit) === 'ready') launch(unit);
    }
    if (settled.size === units.length) return;
    if (inflight.size === 0) throw triggerFatal(ctx, fatalFor('internal', ctx, 'workflow contains blocked units'));
    const done = await Promise.race(inflight.values());
    inflight.delete(done.key);
    settled.add(done.key);
    if (done.error !== undefined) {
      const fatal = triggerFatal(ctx, asFatal(ctx, done.error));
      await Promise.allSettled(inflight.values());
      throw fatal;
    }
  }
}

function epochStatusFor(fatal: RunFatal): LoopEpochStatus {
  if (fatal.kind === 'canceled') return 'canceled';
  if (fatal.kind === 'timeout') return 'timed_out';
  if (fatal.kind === 'approval_rejected') return 'approval_rejected';
  return 'failed';
}

export async function runLoop(ctx: RunContext, loop: CompiledLoop, parentPath: IterationPath): Promise<PassDecisions> {
  const feedback = ctx.graph.edges.find((edge) => edge.id === loop.feedbackEdgeId)!;
  ctx.latest.delete(feedback.id);
  let carry: { nodeId: string; output?: string; error?: string; executionId: string | null } | null = null;
  let last: PassDecisions = new Map();
  const { runStore, now } = ctx.deps;

  for (let iteration = 0; iteration < loop.maxIterations; iteration++) {
    const path: IterationPath = { scope: parentPath.scope, steps: [...parentPath.steps, { loopId: loop.id, iteration }] };
    const startedAt = now();
    const failureMark = ctx.failures.length;
    const pass: PassDecisions = new Map();
    try {
      await runRegion(ctx, loop, path, pass, carry);
    } catch (error) {
      const fatal = asFatal(ctx, error);
      try {
        runStore.appendLoopEpoch({
          runId: ctx.runId, workflowId: ctx.run.workflowId, loopId: loop.id, iteration, iterationPath: path,
          status: epochStatusFor(fatal), exitReason: fatal.message, startedAt,
        });
      } catch (epochError) {
        throw triggerFatal(ctx, fatalFor('evidence', ctx, (epochError as Error)?.message));
      }
      throw fatal;
    }

    const newFailures = ctx.failures.slice(failureMark).filter((failure) => !failure.resolved && pathHasPrefix(failure.path, path));
    const failed = newFailures.length > 0;
    const latchStatus = ctx.nodeStatus.get(loop.latchNodeId);
    const outcome: SourceOutcome = failed ? 'failure' : latchStatus === 'skipped' ? 'skipped' : 'success';
    const latch = ctx.outputs.get(loop.latchNodeId);
    let context: DecisionContext = failed ? { error: newFailures[newFailures.length - 1].error } : { output: latch?.output ?? '' };
    if (!failed && needsStructuredOutput([feedback.data.orchestration])) {
      const parsed = parseStructuredOutput(latch?.output ?? '');
      if (parsed.ok) context = { ...context, outputJson: parsed.value };
    }
    let decision = decideEdge(feedback.data.orchestration, outcome, context);
    if (decision.status === 'taken' && iteration + 1 >= loop.maxIterations) {
      decision = { ...decision, status: 'not_taken', reason: 'iteration_limit_reached' };
    }
    ctx.checkFatal();
    persistDecision(ctx, feedback, latch?.executionId ?? null, path, outcome, decision);
    pass.set(feedback.id, decision.status);
    const taken = decision.status === 'taken';
    carry = taken && latch ? { nodeId: loop.latchNodeId, output: latch.output, error: latch.error, executionId: latch.executionId } : null;
    try {
      runStore.appendLoopEpoch({
        runId: ctx.runId, workflowId: ctx.run.workflowId, loopId: loop.id, iteration, iterationPath: path,
        status: failed ? 'failed' : 'completed',
        exitReason: failed ? newFailures[newFailures.length - 1].error : taken ? 'feedback_taken' : decision.reason,
        startedAt,
      });
    } catch (error) {
      throw triggerFatal(ctx, asFatal(ctx, error).kind === 'internal' ? fatalFor('evidence', ctx, (error as Error)?.message) : asFatal(ctx, error));
    }
    ctx.deps.onStatusChange(ctx);
    // 失败且反馈边被走通 = 重试：这一轮的失败算已处理，不计入整次运行的结局。
    if (failed && taken) for (const failure of newFailures) failure.resolved = true;
    last = pass;
    if (!taken) break;
  }
  return last;
}
