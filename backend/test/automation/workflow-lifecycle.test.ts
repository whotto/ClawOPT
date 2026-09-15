/**
 * 生命周期：绝对截止时间、停止与迟到完成、仓储层终态粘滞、重启恢复、从节点重跑（保留 / 清空）、增量推送。
 */
import { describe, expect, it } from 'vitest';

import { currentTaskOf } from '../../src/automation/runner/fake-runner';
import { createRunStore, TerminalRunError } from '../../src/automation/workflow/run-store';
import { edge, memoryDb, node, setupEngine, statusesByNode, waitFor } from './helpers';

const promptOf = (req: any) => req.input[0].text as string;

describe('运行预算（绝对截止时间）', () => {
  it('到期：运行 failed 且消息确定，节点执行被收尾，剩余预算随节点递减', async () => {
    const t = setupEngine({
      handler: async (req) => {
        if (currentTaskOf(req) === 'task slow') await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { ok: true, output: 'x', sessionId: req.sessionId };
      },
    });
    const { run, evidence } = await t.run([node('a'), node('slow')], [edge('a', 'slow')], { timeoutMs: 1_000 });
    expect(run).toMatchObject({ status: 'failed', error: 'workflow run timed out after 1000ms', errorCode: 'workflows.runTimedOut' });
    const slow = evidence.nodeExecutions.find((row) => row.nodeId === 'slow')!;
    expect(slow.status).toBe('failed');
    const a = evidence.nodeExecutions.find((row) => row.nodeId === 'a')!;
    expect(a.remainingTimeoutMsAtStart).toBeLessThanOrEqual(1_000);
    expect(slow.remainingTimeoutMsAtStart!).toBeLessThanOrEqual(a.remainingTimeoutMsAtStart!);
    expect(t.runner.calls[1].timeoutMs).toBeLessThanOrEqual(1_000);
  }, 10_000);

  it('等审批时到期：挂起的审批一并收尾', async () => {
    const t = setupEngine();
    const { run, evidence } = await t.run([node({ id: 'a', approval: true })], [], { timeoutMs: 1_000 });
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('workflows.runTimedOut');
    expect(evidence.nodeExecutions[0].status).toBe('failed');
  }, 10_000);
});

describe('停止', () => {
  it('停止：先落库 canceled，再中止 Agent；迟到的成功被丢弃，不派发下游', async () => {
    let finishLate!: () => void;
    const late = new Promise<void>((resolve) => { finishLate = resolve; });
    const t = setupEngine({
      handler: async (req) => {
        if (currentTaskOf(req) === 'task a') await late; // 故意无视中止信号
        return { ok: true, output: 'late', sessionId: req.sessionId };
      },
    });
    // 用一个不响应 abort 的 runner 模拟「中止没打断子进程」
    const originalRun = t.runner.runAndWait.bind(t.runner);
    (t.runner as any).runAndWait = async (req: any) => originalRun({ ...req, signal: new AbortController().signal });
    const def = t.create([node('a'), node('b')], [edge('a', 'b')]);
    const run = await t.engine.startRun(def.id);
    await waitFor(() => t.runner.calls.length === 1);
    const stopped = t.engine.stopRun(def.id, run.id);
    expect(stopped).toMatchObject({ status: 'canceled', error: 'Workflow run canceled by user' });
    expect(t.runner.aborted).toHaveLength(1);
    const seqAtStop = t.runStore.getRun(run.id)!.evidenceSeq;
    finishLate();
    await t.engine.waitForRun(run.id);
    expect(t.runStore.getRun(run.id)!.status).toBe('canceled');
    expect(t.runStore.getExecution(run.id, 'a')!.status).toBe('canceled');
    expect(t.runStore.getRun(run.id)!.evidenceSeq).toBe(seqAtStop);
    expect(t.runner.calls).toHaveLength(1);
    expect(t.events.map((event) => event.type)).toContain('workflow.run.canceled');
  });

  it('停止已终态的运行：原样返回', async () => {
    const t = setupEngine();
    const { run, def } = await t.run([node('a')]);
    expect(t.engine.stopRun(def.id, run.id).status).toBe('completed');
  });
});

describe('仓储层终态粘滞', () => {
  function seedRun() {
    const db = memoryDb();
    const store = createRunStore(db);
    const run = store.createRun({
      workflowId: 'wf', workspace: null, status: 'running', startNodeIds: ['a'], input: null, inputStartNodeIds: ['a'],
      snapshotNodes: [], snapshotEdges: [], compiledLoops: [], requestedTimeoutMs: null, deadlineAt: null, maxConcurrency: 1,
      triggerSource: 'manual', scheduledAt: null, startedAt: Date.now(),
    });
    return { store, run };
  }
  const anEdge = { id: 'a-b', source: 'a', target: 'b', data: { orchestration: { route: 'success' as const } } };

  it('终态之后改状态无效', () => {
    const { store, run } = seedRun();
    expect(store.setRunStatus(run.id, 'canceled')).toBe(true);
    expect(store.setRunStatus(run.id, 'completed')).toBe(false);
    expect(store.getRun(run.id)!.status).toBe('canceled');
  });

  it('终态运行上不许追加边判定与节点执行', () => {
    const { store, run } = seedRun();
    store.setRunStatus(run.id, 'failed');
    expect(() => store.appendEdgeEvaluation({ runId: run.id, workflowId: 'wf', edge: anEdge, sourceExecutionId: null, iterationPath: { scope: null, steps: [] }, sourceOutcome: 'success', status: 'taken', reason: null }))
      .toThrow(TerminalRunError);
    expect(() => store.insertExecution({ runId: run.id, workflowId: 'wf', nodeId: 'a', executionId: 'a', iterationPath: { scope: null, steps: [] }, consumedEdgeEvaluationIds: [], sessionId: 's', agentKind: 'openclaw', agentId: 'main', status: 'running', promptText: '', remainingTimeoutMsAtStart: null }))
      .toThrow(TerminalRunError);
  });

  it('节点执行终态之后改不动；运行终态之后也改不动', () => {
    const { store, run } = seedRun();
    store.insertExecution({ runId: run.id, workflowId: 'wf', nodeId: 'a', executionId: 'a', iterationPath: { scope: null, steps: [] }, consumedEdgeEvaluationIds: [], sessionId: 's', agentKind: 'openclaw', agentId: 'main', status: 'running', promptText: '', remainingTimeoutMsAtStart: null });
    expect(store.updateExecution(run.id, 'a', { status: 'canceled' })).toBe(true);
    expect(store.updateExecution(run.id, 'a', { status: 'completed', outputText: 'late' })).toBe(false);
    store.insertExecution({ runId: run.id, workflowId: 'wf', nodeId: 'b', executionId: 'b', iterationPath: { scope: null, steps: [] }, consumedEdgeEvaluationIds: [], sessionId: 's2', agentKind: 'openclaw', agentId: 'main', status: 'running', promptText: '', remainingTimeoutMsAtStart: null });
    store.setRunStatus(run.id, 'canceled');
    expect(store.updateExecution(run.id, 'b', { status: 'completed' })).toBe(false);
    expect(store.getExecution(run.id, 'b')!.status).toBe('running');
  });

  it('收尾型循环轮次在终态运行上允许写；completed 轮次不允许', () => {
    const { store, run } = seedRun();
    store.setRunStatus(run.id, 'canceled');
    const path = { scope: null, steps: [{ loopId: 'l', iteration: 0 }] };
    expect(store.appendLoopEpoch({ runId: run.id, workflowId: 'wf', loopId: 'l', iteration: 0, iterationPath: path, status: 'canceled', exitReason: 'stop', startedAt: 1 }).status).toBe('canceled');
    expect(() => store.appendLoopEpoch({ runId: run.id, workflowId: 'wf', loopId: 'l', iteration: 1, iterationPath: { scope: null, steps: [{ loopId: 'l', iteration: 1 }] }, status: 'completed', exitReason: null, startedAt: 1 }))
      .toThrow(TerminalRunError);
  });

  it('重跑重置带乐观并发：预检之后运行变了就失败', () => {
    const { store, run } = seedRun();
    store.setRunStatus(run.id, 'completed');
    const snapshot = store.getRun(run.id)!;
    expect(store.resetForRerun(run.id, snapshot, { startedAt: snapshot.startedAt + 1, deadlineAt: null, requestedTimeoutMs: null, maxConcurrency: 1, startNodeIds: ['a'] })).toBe(true);
    expect(store.resetForRerun(run.id, snapshot, { startedAt: snapshot.startedAt + 2, deadlineAt: null, requestedTimeoutMs: null, maxConcurrency: 1, startNodeIds: ['a'] })).toBe(false);
  });
});

describe('重启恢复（fail closed）', () => {
  it('活跃运行按失败收尾，活跃执行失败，在跑的循环轮次补一条 failed，存活会话尝试中止', async () => {
    const t = setupEngine();
    const run = t.runStore.createRun({
      workflowId: 'wf', workspace: null, status: 'running', startNodeIds: ['a'], input: null, inputStartNodeIds: ['a'],
      snapshotNodes: [], snapshotEdges: [], compiledLoops: [], requestedTimeoutMs: null, deadlineAt: null, maxConcurrency: 1,
      triggerSource: 'manual', scheduledAt: null, startedAt: Date.now(),
    });
    const path = { scope: null, steps: [{ loopId: 'outer', iteration: 1 }, { loopId: 'inner', iteration: 0 }] };
    t.runStore.insertExecution({ runId: run.id, workflowId: 'wf', nodeId: 'a', executionId: 'a@outer:1/inner:0', iterationPath: path, consumedEdgeEvaluationIds: [], sessionId: 'sess-1', agentKind: 'openclaw', agentId: 'main', status: 'running', promptText: '', remainingTimeoutMsAtStart: null });
    const result = t.engine.recoverOnBoot();
    expect(result.recovered).toEqual([run.id]);
    expect(t.runStore.getRun(run.id)).toMatchObject({ status: 'failed', errorCode: 'workflows.runInterruptedByRestart' });
    const evidence = t.runStore.evidence(run.id);
    expect(evidence.nodeExecutions[0].status).toBe('failed');
    expect(evidence.loopEpochs.map((row) => `${row.loopId}:${row.iteration}:${row.status}`).sort()).toEqual(['inner:0:failed', 'outer:1:failed']);
    expect(t.runner.aborted).toEqual(['sess-1']);
    expect(t.engine.recoverOnBoot().recovered).toEqual([]);
  });
});

describe('从节点重跑', () => {
  function recordingSetup() {
    let counter = 0;
    return setupEngine({
      handler: (req) => {
        counter += 1;
        const task = currentTaskOf(req);
        if (task.includes('fail-once') && counter <= 3) return { ok: false, output: '', error: 'boom', sessionId: req.sessionId };
        return { ok: true, output: `${task} #${counter}`, sessionId: req.sessionId };
      },
    });
  }

  it('保留节点、只跑下游：保留节点不重跑，下游拿到持久化的上游产出', async () => {
    const t = recordingSetup();
    const { run, def } = await t.run([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    const before = t.runStore.getRun(run.id)!;
    await t.engine.rerunFromNode(def.id, run.id, { nodeId: 'a', preserveStartNode: true });
    await t.engine.waitForRun(run.id);
    const after = t.runStore.getRun(run.id)!;
    expect(after.status).toBe('completed');
    expect(after.triggerSource).toBe('rerun');
    expect(after.startedAt).toBeGreaterThan(before.startedAt);
    expect(t.runner.calls.map(currentTaskOf)).toEqual(['task a', 'task b', 'task c', 'task b', 'task c']);
    expect(promptOf(t.runner.calls[3])).toContain('[Upstream: A]\ntask a #1');
    const ids = t.runStore.evidence(run.id).nodeExecutions.map((row) => row.executionId);
    expect(ids.filter((id) => id.startsWith('b@rerun:'))).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('清空节点并重跑：节点本身重跑，并且仍能拿到上游上下文（修正 spec 的缺陷）', async () => {
    const t = recordingSetup();
    const { run, def } = await t.run([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    await t.engine.rerunFromNode(def.id, run.id, { nodeId: 'b', preserveStartNode: false });
    await t.engine.waitForRun(run.id);
    expect(t.runner.calls.map(currentTaskOf)).toEqual(['task a', 'task b', 'task c', 'task b', 'task c']);
    expect(promptOf(t.runner.calls[3])).toContain('[Upstream: A]\ntask a #1');
  });

  it('上游未完成的节点被拉进活跃集一起重跑', async () => {
    const t = setupEngine();
    const { run, def } = await t.run([node({ id: 'a', input: 'fail' }), node('b')], [edge('a', 'b', { route: 'always' })]);
    expect(run.status).toBe('completed_with_failures');
    await t.engine.rerunFromNode(def.id, run.id, { nodeId: 'b', preserveStartNode: false });
    await t.engine.waitForRun(run.id);
    expect(t.runner.calls.map(currentTaskOf)).toEqual(['fail', 'task b', 'fail', 'task b']);
  });

  it('保留模式：节点没完成 → 409；没有走通的出边 → 400', async () => {
    const t = setupEngine();
    const { run, def } = await t.run([node({ id: 'a', input: 'fail' }), node('b')], [edge('a', 'b')]);
    await expect(t.engine.rerunFromNode(def.id, run.id, { nodeId: 'a', preserveStartNode: true })).rejects.toMatchObject({ status: 409, code: 'workflows.rerunNodeNotCompleted' });
    const second = await t.run([node({ id: 'x', input: 'out:no' }), node('y')], [edge('x', 'y', { condition: { path: 'output', operator: 'equals', value: 'yes' } })]);
    await expect(t.engine.rerunFromNode(second.def.id, second.run.id, { nodeId: 'x', preserveStartNode: true })).rejects.toMatchObject({ status: 400, code: 'workflows.rerunNothingToRun' });
  });

  it('运行还活着时不能重跑 → 409', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const t = setupEngine({ handler: async (req) => { await gate; return { ok: true, output: 'x', sessionId: req.sessionId }; } });
    const def = t.create([node('a')]);
    const run = await t.engine.startRun(def.id);
    await expect(t.engine.rerunFromNode(def.id, run.id, { nodeId: 'a', preserveStartNode: false })).rejects.toMatchObject({ status: 409, code: 'workflows.runNotTerminal' });
    release();
    await t.engine.waitForRun(run.id);
  });

  it('重跑用冻结快照，不受之后对定义的修改影响；证据序号接着涨', async () => {
    const t = setupEngine();
    const { run, def } = await t.run([node('a'), node('b')], [edge('a', 'b')]);
    const seq = t.runStore.getRun(run.id)!.evidenceSeq;
    t.defs.update(def.id, { nodes: [node({ id: 'a', input: 'changed' }), node('b')] as any });
    await t.engine.rerunFromNode(def.id, run.id, { nodeId: 'a', preserveStartNode: false });
    await t.engine.waitForRun(run.id);
    expect(currentTaskOf(t.runner.calls[2])).toBe('task a');
    const evidence = t.runStore.evidence(run.id);
    expect(Math.min(...evidence.nodeExecutions.filter((row) => row.executionId.includes('@rerun:')).map((row) => row.sequence))).toBeGreaterThan(seq);
    expect(statusesByNode(evidence).a).toEqual(['completed', 'completed']);
  });

  it('并发的两次重跑只有一个赢', async () => {
    const t = setupEngine();
    const { run, def } = await t.run([node('a')]);
    const results = await Promise.allSettled([
      t.engine.rerunFromNode(def.id, run.id, { nodeId: 'a', preserveStartNode: false }),
      t.engine.rerunFromNode(def.id, run.id, { nodeId: 'a', preserveStartNode: false }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await t.engine.waitForRun(run.id);
  });
});

describe('增量推送', () => {
  it('订阅者先收到状态，再只收到自己没见过的证据行', async () => {
    const t = setupEngine();
    const def = t.create([node('a'), node('b')], [edge('a', 'b')]);
    const messages: any[] = [];
    t.hub.subscribe(def.id, (message) => messages.push(message));
    const run = await t.engine.startRun(def.id);
    await t.engine.waitForRun(run.id);
    const evidenceMessages = messages.filter((message) => message.type === 'evidence');
    expect(evidenceMessages.length).toBeGreaterThan(1);
    for (let i = 1; i < evidenceMessages.length; i++) {
      expect(evidenceMessages[i].sinceSeq).toBe(evidenceMessages[i - 1].seq);
    }
    const allEvals = evidenceMessages.flatMap((message) => message.evidence.edgeEvaluations.map((row: any) => row.id));
    expect(new Set(allEvals).size).toBe(allEvals.length);
    expect(messages.at(-1)).toMatchObject({ type: expect.any(String) });
    expect(messages.filter((message) => message.type === 'status').at(-1).status.status).toBe('completed');
    expect(messages[0].topic).toBe(`workflow:${def.id}`);
  });

  it('断线重连带 since：不重收已有的证据', async () => {
    const t = setupEngine();
    const { run, def } = await t.run([node('a'), node('b')], [edge('a', 'b')]);
    const seq = t.runStore.getRun(run.id)!.evidenceSeq;
    const messages: any[] = [];
    t.hub.subscribe(def.id, (message) => messages.push(message), { runId: run.id, seq });
    expect(messages.map((message) => message.type)).toEqual(['status']);
  });
});
