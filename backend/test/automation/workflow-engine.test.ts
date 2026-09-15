/**
 * 引擎行为：DAG 调度、条件分支、汇合与跳过传播、失败与 completed_with_failures、预检与准入、
 * 并发上限、结构化输出、附件内容块、证据全序。
 */
import { describe, expect, it } from 'vitest';

import { currentTaskOf } from '../../src/automation/runner/fake-runner';
import { edge, node, setupEngine, statusesByNode } from './helpers';

const promptOf = (req: any) => req.input[0].text as string;

describe('DAG 调度', () => {
  it('线性图跑完：completed，上游结果按边顺序注入提示词', async () => {
    const t = setupEngine();
    const { run, evidence } = await t.run([node('a'), node('b'), node({ id: 'c', join: 'all' })], [edge('a', 'c'), edge('b', 'c')]);
    expect(run.status).toBe('completed');
    const cPrompt = promptOf(t.runner.calls.find((call) => currentTaskOf(call) === 'task c'));
    expect(cPrompt.indexOf('[Upstream: A]')).toBeGreaterThan(0);
    expect(cPrompt.indexOf('[Upstream: A]')).toBeLessThan(cPrompt.indexOf('[Upstream: B]'));
    expect(cPrompt).toContain('[Current task]\ntask c');
    expect(statusesByNode(evidence)).toEqual({ a: ['completed'], b: ['completed'], c: ['completed'] });
  });

  it('运行输入只覆盖开始节点的任务', async () => {
    const t = setupEngine();
    await t.run([node('a'), node('b')], [edge('a', 'b')], { input: 'override' });
    expect(t.runner.calls.map(currentTaskOf)).toEqual(['override', 'task b']);
  });

  it('条件分支：命中的一支执行，另一支跳过且不建会话', async () => {
    const t = setupEngine();
    const nodes = [node({ id: 'judge', input: 'out:{"decision":"PASS"}' }), node('pass'), node('block')];
    const edges = [
      edge('judge', 'pass', { condition: { path: 'outputJson.decision', operator: 'equals', value: 'PASS' } }),
      edge('judge', 'block', { condition: { path: 'outputJson.decision', operator: 'equals', value: 'BLOCKED' } }),
    ];
    const { run, evidence } = await t.run(nodes, edges);
    expect(run.status).toBe('completed');
    expect(statusesByNode(evidence)).toEqual({ judge: ['completed'], pass: ['completed'] });
    const blockEval = evidence.edgeEvaluations.find((row) => row.edgeId === 'judge-block')!;
    expect(blockEval).toMatchObject({ status: 'not_taken', reason: 'condition_not_matched', conditionEvaluation: { actual: 'PASS' } });
  });

  it('跳过传播：all 汇合被跳过，并继续向下传播 skipped', async () => {
    const t = setupEngine();
    const nodes = [node({ id: 'a', input: 'out:no' }), node('b'), node({ id: 'c', join: 'all' }), node('d')];
    const edges = [edge('a', 'b', { condition: { path: 'output', operator: 'equals', value: 'yes' } }), edge('a', 'c'), edge('b', 'c'), edge('c', 'd')];
    const { run, evidence } = await t.run(nodes, edges);
    expect(run.status).toBe('completed');
    expect(Object.keys(statusesByNode(evidence))).toEqual(['a']);
    expect(evidence.edgeEvaluations.find((row) => row.edgeId === 'c-d')).toMatchObject({ status: 'not_taken', sourceOutcome: 'skipped' });
    expect(t.hub.get(run.workflowId)!.nodeStatuses).toMatchObject({ b: 'skipped', c: 'skipped', d: 'skipped' });
  });

  it('any 汇合：一条入边走通即启动，不等仍在跑的其他来源', async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const order: string[] = [];
    const t = setupEngine({
      concurrency: 4,
      handler: async (req) => {
        const task = currentTaskOf(req);
        if (task === 'task slow') await slowGate;
        order.push(task);
        if (task === 'task join') releaseSlow();
        return { ok: true, output: task, sessionId: req.sessionId };
      },
    });
    const { run } = await t.run([node('fast'), node('slow'), node({ id: 'join', join: 'any' })], [edge('fast', 'join'), edge('slow', 'join')]);
    expect(run.status).toBe('completed');
    expect(order.indexOf('task join')).toBeLessThan(order.indexOf('task slow'));
  });

  it('any 汇合：全部来源都 not_taken 才跳过', async () => {
    const t = setupEngine();
    const nodes = [node('a'), node('b'), node({ id: 'j', join: 'any' })];
    const never = { condition: { path: 'output', operator: 'equals', value: 'never' } };
    const { evidence } = await t.run(nodes, [edge('a', 'j', never), edge('b', 'j', never)]);
    expect(statusesByNode(evidence).j).toBeUndefined();
  });

  it('并发上限生效：同时在跑的节点数不超过设置值', async () => {
    let active = 0;
    let peak = 0;
    const t = setupEngine({
      concurrency: 2,
      handler: async (req) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { ok: true, output: 'x', sessionId: req.sessionId };
      },
    });
    const { run } = await t.run([node('a'), node('b'), node('c'), node('d'), node({ id: 'z', join: 'all' })],
      [edge('a', 'z'), edge('b', 'z'), edge('c', 'z'), edge('d', 'z')]);
    expect(run.status).toBe('completed');
    expect(run.maxConcurrency).toBe(2);
    expect(peak).toBe(2);
  });

  it('附件变成图片内容块；上游附件不继承', async () => {
    const t = setupEngine();
    const a = node('a');
    (a.data as any).attachments = [{ name: 'ok.png', url: '/uploads/ok.png' }];
    await t.run([a, node('b')], [edge('a', 'b')]);
    expect(t.runner.calls[0].input[1]).toEqual({ type: 'image', path: '/tmp/ok.png', mediaType: 'image/png', name: 'ok.png' });
    expect(t.runner.calls[1].input).toHaveLength(1);
  });

  it('证据三表共用一个严格递增的序号', async () => {
    const t = setupEngine();
    const { evidence } = await t.run([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c'), edge('c', 'b', { feedback: { maxIterations: 2 } })]);
    const seqs = [
      ...evidence.nodeExecutions.map((row) => row.sequence),
      ...evidence.edgeEvaluations.map((row) => row.sequence),
      ...evidence.loopEpochs.map((row) => row.sequence),
    ].sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('失败与终态', () => {
  it('未被接住的失败 → failed，下游跳过', async () => {
    const t = setupEngine();
    const { run, evidence } = await t.run([node({ id: 'a', input: 'fail' }), node('b')], [edge('a', 'b')]);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Node A failed: failed fail');
    expect(run.errorCode).toBe('workflows.nodeFailed');
    expect(statusesByNode(evidence)).toEqual({ a: ['failed'] });
  });

  it('失败被 failure 路由接住 → completed_with_failures，失败分支拿到错误上下文', async () => {
    const t = setupEngine();
    const nodes = [node({ id: 'a', input: 'fail' }), node('ok'), node('recover')];
    const { run, evidence } = await t.run(nodes, [edge('a', 'ok'), edge('a', 'recover', { route: 'failure' })]);
    expect(run.status).toBe('completed_with_failures');
    expect(run.errorCode).toBe('workflows.completedWithFailures');
    expect(statusesByNode(evidence)).toEqual({ a: ['failed'], recover: ['completed'] });
    expect(promptOf(t.runner.calls[1])).toContain('[Upstream: A (failed)]\nfailed fail');
  });

  it('always 路由同样算接住', async () => {
    const t = setupEngine();
    const { run } = await t.run([node({ id: 'a', input: 'fail' }), node('cleanup')], [edge('a', 'cleanup', { route: 'always' })]);
    expect(run.status).toBe('completed_with_failures');
  });

  it('一个失败被接住、另一个没被接住 → failed', async () => {
    const t = setupEngine();
    const nodes = [node({ id: 'a', input: 'fail a' }), node({ id: 'b', input: 'fail b' }), node('r')];
    const { run } = await t.run(nodes, [edge('a', 'r', { route: 'failure' }), edge('b', 'r', { route: 'success' })]);
    expect(run.status).toBe('failed');
  });

  it('被接住的失败不取消并行的兄弟节点', async () => {
    const t = setupEngine({ concurrency: 4 });
    const nodes = [node('root'), node({ id: 'x', input: 'fail' }), node('y'), node('h')];
    const { evidence } = await t.run(nodes, [edge('root', 'x'), edge('root', 'y'), edge('x', 'h', { route: 'failure' })]);
    expect(statusesByNode(evidence)).toEqual({ root: ['completed'], x: ['failed'], y: ['completed'], h: ['completed'] });
  });

  it('技能内容注入提示词', async () => {
    const t = setupEngine();
    await t.run([node({ id: 'a', skills: ['known'] })]);
    expect(promptOf(t.runner.calls[0])).toContain('[Workflow selected skills]\n\n[Skill: known]\n# known skill');
  });
});

describe('准入与预检（任何拒绝都不写运行行）', () => {
  it('静态上界超过 1000 → 400，数据库里没有运行记录', async () => {
    const t = setupEngine();
    const nodes = [node('h'), node('ih'), node('il'), node('l')];
    const edges = [edge('h', 'ih'), edge('ih', 'il'), edge('il', 'l'),
      edge('il', 'ih', { feedback: { maxIterations: 40, loopId: 'inner' } }), edge('l', 'h', { feedback: { maxIterations: 20, loopId: 'outer' } })];
    const def = t.create(nodes, edges);
    await expect(t.engine.startRun(def.id)).rejects.toMatchObject({ status: 400, code: 'workflows.staticBudgetExceeded', params: { bound: 1640 } });
    expect(t.runStore.listRuns(def.id, 10)).toEqual([]);
    expect(t.runner.calls).toHaveLength(0);
  });

  it('Agent 不可用 → 409，不写运行行', async () => {
    const t = setupEngine({ directory: { list: () => [], availability: () => ({ available: false, reason: 'binary missing' }), readSkill: () => null, listSkills: () => [] } });
    const def = t.create([node('a')]);
    await expect(t.engine.startRun(def.id)).rejects.toMatchObject({ status: 409, code: 'workflows.agentUnavailable' });
    expect(t.runStore.listRuns(def.id, 10)).toEqual([]);
  });

  it('技能缺失 → 409；附件不可服务 → 409', async () => {
    const t = setupEngine();
    const def = t.create([node({ id: 'a', skills: ['missing'] })]);
    await expect(t.engine.startRun(def.id)).rejects.toMatchObject({ status: 409, code: 'workflows.skillMissing' });
    const withFile = node('b');
    (withFile.data as any).attachments = [{ name: 'gone.pdf', url: '/uploads/gone.pdf' }];
    const def2 = t.create([withFile]);
    await expect(t.engine.startRun(def2.id)).rejects.toMatchObject({ status: 409, code: 'workflows.attachmentMissing' });
  });

  it('同一工作流并发两次启动：一个 202 受理，另一个 409', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const t = setupEngine({ handler: async (req) => { await gate; return { ok: true, output: 'x', sessionId: req.sessionId }; } });
    const def = t.create([node('a')]);
    const results = await Promise.allSettled([t.engine.startRun(def.id), t.engine.startRun(def.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'workflows.alreadyRunning' } });
    release();
    const run = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
    await t.engine.waitForRun(run.id);
  });

  it('非法图 → 400 invalidGraph 并带 reason', async () => {
    const t = setupEngine();
    const def = t.create([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]);
    await expect(t.engine.startRun(def.id)).rejects.toMatchObject({ status: 400, code: 'workflows.invalidGraph', params: { reason: 'forwardCycle' } });
  });

  it('timeout_ms 越界 → 400', async () => {
    const t = setupEngine();
    const def = t.create([node('a')]);
    await expect(t.engine.startRun(def.id, { timeoutMs: 999 })).rejects.toMatchObject({ status: 400 });
    await expect(t.engine.startRun(def.id, { timeoutMs: 86_400_001 })).rejects.toMatchObject({ status: 400 });
  });

  it('受理即持久：startRun 返回时运行行已存在且为 running，并发出 started 事件', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const t = setupEngine({ handler: async (req) => { await gate; return { ok: true, output: 'x', sessionId: req.sessionId }; } });
    const def = t.create([node('a')]);
    const run = await t.engine.startRun(def.id);
    expect(t.runStore.getRun(run.id)!.status).toBe('running');
    expect(t.events.map((event) => event.type)).toContain('workflow.run.started');
    release();
    await t.engine.waitForRun(run.id);
    expect(t.events.map((event) => event.type)).toContain('workflow.run.completed');
  });
});

describe('低内存主机', () => {
  it('探测到低内存时并发强制为 1，配置值保留', async () => {
    const { createAutomationSettings } = await import('../../src/automation/shared/settings');
    const { memoryDb } = await import('./helpers');
    const settings = createAutomationSettings(memoryDb(), () => ({ totalBytes: 1.9 * 1024 ** 3, availableBytes: null }));
    settings.setConfiguredConcurrency(4);
    expect(settings.effectiveConcurrency()).toMatchObject({ configured: 4, effective: 1, lowMemory: true });
    const linux = createAutomationSettings(memoryDb(), () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 200 * 1024 ** 2 }));
    expect(linux.effectiveConcurrency()).toMatchObject({ effective: 1, lowMemory: true });
    const roomy = createAutomationSettings(memoryDb(), () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }));
    expect(roomy.effectiveConcurrency()).toMatchObject({ effective: 2, lowMemory: false });
  });
});

