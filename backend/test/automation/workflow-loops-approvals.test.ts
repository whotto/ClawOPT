/**
 * 循环（反馈重跑、上限、失败重试、嵌套、出口不提前放行）与审批闸门（按执行 id、每轮重批、拒绝）。
 */
import { describe, expect, it } from 'vitest';

import { currentTaskOf } from '../../src/automation/runner/fake-runner';
import { edge, node, setupEngine, statusesByNode, waitFor } from './helpers';

const promptOf = (req: any) => req.input[0].text as string;

describe('反馈循环', () => {
  it('条件满足就回到 header 再跑一轮，latch 的产出作为上一轮结果注入 header', async () => {
    let reviews = 0;
    const t = setupEngine({
      handler: (req) => {
        const task = currentTaskOf(req);
        if (task === 'review') {
          reviews += 1;
          return { ok: true, output: JSON.stringify({ decision: reviews < 3 ? 'RETRY' : 'DONE' }), sessionId: req.sessionId };
        }
        return { ok: true, output: `draft ${task}`, sessionId: req.sessionId };
      },
    });
    const nodes = [node({ id: 'write', input: 'write' }), node({ id: 'review', input: 'review' }), node({ id: 'publish', input: 'publish' })];
    const edges = [
      edge('write', 'review'),
      edge('review', 'write', { feedback: { maxIterations: 5, loopId: 'polish' }, condition: { path: 'outputJson.decision', operator: 'equals', value: 'RETRY' } }),
      edge('review', 'publish', { condition: { path: 'outputJson.decision', operator: 'equals', value: 'DONE' } }),
    ];
    const { run, evidence } = await t.run(nodes, edges);
    expect(run.status).toBe('completed');
    expect(statusesByNode(evidence)).toEqual({ write: ['completed', 'completed', 'completed'], review: ['completed', 'completed', 'completed'], publish: ['completed'] });
    expect(evidence.nodeExecutions.map((row) => row.executionId)).toContain('write@polish:2');
    expect(evidence.loopEpochs.map((row) => [row.iteration, row.status, row.exitReason])).toEqual([
      [0, 'completed', 'feedback_taken'], [1, 'completed', 'feedback_taken'], [2, 'completed', 'condition_not_matched'],
    ]);
    const secondWrite = t.runner.calls.filter((call) => currentTaskOf(call) === 'write')[1];
    expect(promptOf(secondWrite)).toContain('[Upstream: REVIEW]\n{"decision":"RETRY"}');
    expect(promptOf(t.runner.calls.filter((call) => currentTaskOf(call) === 'write')[0])).not.toContain('[Upstream: REVIEW]');
  });

  it('到达 maxIterations：反馈判为 iteration_limit_reached，运行正常完成', async () => {
    const t = setupEngine();
    const { run, evidence } = await t.run([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a', { feedback: { maxIterations: 3 } })]);
    expect(run.status).toBe('completed');
    expect(statusesByNode(evidence).a).toHaveLength(3);
    const feedbackEvals = evidence.edgeEvaluations.filter((row) => row.edgeId === 'b-a');
    expect(feedbackEvals.map((row) => [row.status, row.reason])).toEqual([['taken', null], ['taken', null], ['not_taken', 'iteration_limit_reached']]);
  });

  it('失败重试：failure 路由的反馈边把失败的一轮变成重试，最终成功则运行 completed', async () => {
    let attempts = 0;
    const t = setupEngine({
      handler: (req) => {
        attempts += 1;
        return attempts < 3
          ? { ok: false, output: '', error: `flaky ${attempts}`, sessionId: req.sessionId }
          : { ok: true, output: 'stable', sessionId: req.sessionId };
      },
    });
    const { run, evidence } = await t.run([node('job')], [edge('job', 'job', { route: 'failure', feedback: { maxIterations: 4 } })]);
    expect(run.status).toBe('completed');
    expect(statusesByNode(evidence).job).toEqual(['failed', 'failed', 'completed']);
    expect(evidence.loopEpochs.map((row) => row.status)).toEqual(['failed', 'failed', 'completed']);
  });

  it('失败重试到最后一轮仍失败 → failed', async () => {
    const t = setupEngine();
    const { run, evidence } = await t.run([node({ id: 'job', input: 'fail' })], [edge('job', 'job', { route: 'failure', feedback: { maxIterations: 2 } })]);
    expect(run.status).toBe('failed');
    expect(statusesByNode(evidence).job).toEqual(['failed', 'failed']);
    expect(evidence.edgeEvaluations.at(-1)).toMatchObject({ status: 'not_taken', reason: 'iteration_limit_reached' });
  });

  it('循环出口：循环没跑完之前，下游不会被早轮次的出口判定提前放行', async () => {
    const order: string[] = [];
    const t = setupEngine({ handler: (req) => { order.push(currentTaskOf(req)); return { ok: true, output: 'x', sessionId: req.sessionId }; } });
    const nodes = [node({ id: 'h', input: 'h' }), node({ id: 'l', input: 'l' }), node({ id: 'after', input: 'after' })];
    await t.run(nodes, [edge('h', 'l'), edge('l', 'after'), edge('l', 'h', { feedback: { maxIterations: 3 } })]);
    expect(order).toEqual(['h', 'l', 'h', 'l', 'h', 'l', 'after']);
  });

  it('嵌套循环：内层每个外层轮次都从第 0 轮重新开始，执行 id 带完整路径', async () => {
    const t = setupEngine();
    const nodes = [node('o'), node('i'), node('end')];
    const edges = [edge('o', 'i'), edge('i', 'end'), edge('i', 'i', { feedback: { maxIterations: 2, loopId: 'inner' } }), edge('end', 'o', { feedback: { maxIterations: 2, loopId: 'outer' } })];
    const { run, evidence } = await t.run(nodes, edges);
    expect(run.status).toBe('completed');
    expect(evidence.nodeExecutions.filter((row) => row.nodeId === 'i').map((row) => row.executionId)).toEqual([
      'i@outer:0/inner:0', 'i@outer:0/inner:1', 'i@outer:1/inner:0', 'i@outer:1/inner:1',
    ]);
    expect(t.runner.calls).toHaveLength(8);
  });

  it('运行输入覆盖只作用于所有轮次都为 0 的开始节点', async () => {
    const t = setupEngine();
    await t.run([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a', { feedback: { maxIterations: 2 } })], { input: 'first' });
    expect(t.runner.calls.map(currentTaskOf)).toEqual(['first', 'task b', 'task a', 'task b']);
  });
});

describe('审批闸门', () => {
  it('节点跑完进入 pending_approval；批准后下游继续', async () => {
    const t = setupEngine();
    const def = t.create([node({ id: 'a', approval: true }), node('b')], [edge('a', 'b')]);
    const run = await t.engine.startRun(def.id);
    await waitFor(() => t.engine.pendingApprovals().length === 1);
    expect(t.hub.get(def.id)!.pendingApprovals).toEqual([{ nodeId: 'a', executionId: 'a' }]);
    expect(t.runStore.getExecution(run.id, 'a')!.status).toBe('pending_approval');
    expect(t.runner.calls).toHaveLength(1);
    expect(t.events.map((event) => event.type)).toContain('workflow.node.approval_requested');
    t.engine.resolveApproval(def.id, run.id, 'a', { approved: true });
    await t.engine.waitForRun(run.id);
    expect(t.runStore.getRun(run.id)!.status).toBe('completed');
    expect(t.runner.calls).toHaveLength(2);
  });

  it('拒绝 → 执行 approval_rejected，运行 failed，下游不跑', async () => {
    const t = setupEngine();
    const def = t.create([node({ id: 'a', approval: true }), node('b')], [edge('a', 'b')]);
    const run = await t.engine.startRun(def.id);
    await waitFor(() => t.engine.pendingApprovals().length === 1);
    t.engine.resolveApproval(def.id, run.id, 'a', { approved: false });
    await t.engine.waitForRun(run.id);
    const final = t.runStore.getRun(run.id)!;
    expect(final).toMatchObject({ status: 'failed', errorCode: 'workflows.approvalRejected', error: 'Node A approval rejected' });
    expect(t.runStore.getExecution(run.id, 'a')!.status).toBe('approval_rejected');
    expect(t.runner.calls).toHaveLength(1);
  });

  it('没有挂起的审批 → 409', async () => {
    const t = setupEngine();
    const { run, def } = await t.run([node('a')]);
    expect(() => t.engine.resolveApproval(def.id, run.id, 'a', { approved: true })).toThrow(expect.objectContaining({ status: 409, code: 'workflows.noPendingApproval' }));
  });

  it('循环里每一轮都要重新审批，审批按执行 id 区分', async () => {
    const t = setupEngine();
    const def = t.create([node({ id: 'a', approval: true })], [edge('a', 'a', { feedback: { maxIterations: 2 } })]);
    const run = await t.engine.startRun(def.id);
    await waitFor(() => t.engine.pendingApprovals().length === 1);
    expect(t.engine.pendingApprovals()[0].executionId).toBe('a@loop:a-a:0');
    expect(() => t.engine.resolveApproval(def.id, run.id, 'a', { approved: true, executionId: 'a@loop:a-a:1' })).toThrow(expect.objectContaining({ status: 409 }));
    t.engine.resolveApproval(def.id, run.id, 'a', { approved: true, executionId: 'a@loop:a-a:0' });
    await waitFor(() => t.engine.pendingApprovals()[0]?.executionId === 'a@loop:a-a:1');
    t.engine.resolveApproval(def.id, run.id, 'a', { approved: true });
    await t.engine.waitForRun(run.id);
    expect(t.runStore.getRun(run.id)!.status).toBe('completed');
  });

  it('循环里审批被拒：写一条 approval_rejected 的循环轮次', async () => {
    const t = setupEngine();
    const def = t.create([node({ id: 'a', approval: true })], [edge('a', 'a', { feedback: { maxIterations: 2 } })]);
    const run = await t.engine.startRun(def.id);
    await waitFor(() => t.engine.pendingApprovals().length === 1);
    t.engine.resolveApproval(def.id, run.id, 'a', { approved: false });
    await t.engine.waitForRun(run.id);
    expect(t.runStore.evidence(run.id).loopEpochs.map((row) => row.status)).toEqual(['approval_rejected']);
  });

  it('并行的两个审批：一个被拒，另一个挂起的审批随之收尾，运行不会卡住', async () => {
    const t = setupEngine({ concurrency: 2 });
    const def = t.create([node({ id: 'a', approval: true }), node({ id: 'b', approval: true }), node({ id: 'c', join: 'all' })], [edge('a', 'c'), edge('b', 'c')]);
    const run = await t.engine.startRun(def.id);
    await waitFor(() => t.engine.pendingApprovals().length === 2);
    t.engine.resolveApproval(def.id, run.id, 'a', { approved: false });
    await t.engine.waitForRun(run.id);
    expect(t.runStore.getRun(run.id)!.status).toBe('failed');
    expect(t.runStore.getExecution(run.id, 'b')!.status).toBe('canceled');
  });
});
