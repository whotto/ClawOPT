/**
 * 编译器：前向无环、单入口自然循环、层状嵌套、开始节点、连通性、静态上界；以及严格规范化。
 */
import { describe, expect, it } from 'vitest';

import { activeNodeIds, compileWorkflow, staticExecutionBound } from '../../src/automation/workflow/compiler';
import { GraphError } from '../../src/automation/workflow/normalize';
import { edge, node } from './helpers';

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof GraphError) return error.reason;
    throw error;
  }
  return 'ok';
}

const fb = (max = 3, loopId?: string) => ({ feedback: { maxIterations: max, ...(loopId ? { loopId } : {}) } });

describe('compileWorkflow：图结构', () => {
  it('线性图：开始节点是入度为 0 的节点', () => {
    const graph = compileWorkflow([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    expect(graph.startNodeIds).toEqual(['a']);
    expect(graph.loops).toEqual([]);
  });

  it('多开始节点、分叉与汇合都允许', () => {
    const graph = compileWorkflow([node('a'), node('b'), node('c')], [edge('a', 'c'), edge('b', 'c')]);
    expect(graph.startNodeIds).toEqual(['a', 'b']);
  });

  it('非反馈边构成的环被拒绝', () => {
    expect(reasonOf(() => compileWorkflow([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]))).toBe('forwardCycle');
  });

  it('非反馈自环被拒绝', () => {
    expect(reasonOf(() => compileWorkflow([node('a')], [edge('a', 'a')]))).toBe('forwardCycle');
  });

  it('反馈自环是合法循环，body 只有自己', () => {
    const graph = compileWorkflow([node('a')], [edge('a', 'a', fb(2))]);
    expect(graph.loops).toMatchObject([{ headerNodeId: 'a', latchNodeId: 'a', bodyNodeIds: ['a'], maxIterations: 2 }]);
  });

  it('反馈边：header 前向不可达 latch → loopNoForwardPath', () => {
    const nodes = [node('a'), node('b'), node('c')];
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b'), edge('a', 'c'), edge('c', 'b', fb())]))).toBe('loopNoForwardPath');
  });

  it('反馈边：多入口循环（header 不支配 latch）→ loopNotSingleEntry', () => {
    // s→h→m→l，s→m 绕过 h：h 不支配 l
    const nodes = [node('s'), node('h'), node('m'), node('l')];
    const edges = [edge('s', 'h'), edge('h', 'm'), edge('s', 'm'), edge('m', 'l'), edge('l', 'h', fb())];
    expect(reasonOf(() => compileWorkflow(nodes, edges))).toBe('loopNotSingleEntry');
  });

  it('循环 body = header 可达 ∩ 可达 latch，出口节点不在 body 里', () => {
    const nodes = [node('s'), node('h'), node('x'), node('l'), node('out')];
    const edges = [edge('s', 'h'), edge('h', 'x'), edge('x', 'l'), edge('l', 'out'), edge('l', 'h', fb(4))];
    const graph = compileWorkflow(nodes, edges);
    expect(graph.loops[0]).toMatchObject({ id: 'loop:l-h', headerNodeId: 'h', latchNodeId: 'l', bodyNodeIds: ['h', 'x', 'l'], parentLoopId: null });
  });

  it('嵌套循环：内层 parentLoopId 指向最小外层', () => {
    const nodes = [node('h'), node('ih'), node('il'), node('l')];
    const edges = [edge('h', 'ih'), edge('ih', 'il'), edge('il', 'l'), edge('il', 'ih', fb(2, 'inner')), edge('l', 'h', fb(2, 'outer'))];
    const graph = compileWorkflow(nodes, edges);
    const inner = graph.loops.find((loop) => loop.id === 'inner')!;
    expect(inner.parentLoopId).toBe('outer');
    expect(graph.loops.find((loop) => loop.id === 'outer')!.parentLoopId).toBeNull();
  });

  it('两个循环 body 完全相同 → loopIdenticalScope', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b'), edge('b', 'a', fb(2, 'one')), edge('b', 'a', fb(2, 'two'), 'b-a-2')];
    expect(reasonOf(() => compileWorkflow(nodes, edges))).toBe('loopIdenticalScope');
  });

  it('两个循环部分重叠 → loopPartialOverlap', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('b', 'a', fb(2, 'ab')), edge('c', 'b', fb(2, 'bc'))];
    expect(reasonOf(() => compileWorkflow(nodes, edges))).toBe('loopPartialOverlap');
  });

  it('不相交的两个循环可以共存', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('b', 'a', fb(2, 'x')), edge('d', 'c', fb(2, 'y'))];
    expect(compileWorkflow(nodes, edges).loops.map((loop) => loop.id)).toEqual(['x', 'y']);
  });

  it('重复的 loopId → duplicateLoopId', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('b', 'a', fb(2, 'x')), edge('d', 'c', fb(2, 'x'))];
    expect(reasonOf(() => compileWorkflow(nodes, edges))).toBe('duplicateLoopId');
  });

  it('重复节点 id / 重复边 id / 悬空端点', () => {
    expect(reasonOf(() => compileWorkflow([node('a'), node('a')], []))).toBe('duplicateNodeId');
    expect(reasonOf(() => compileWorkflow([node('a'), node('b')], [edge('a', 'b', {}, 'e'), edge('b', 'a', fb(), 'e')]))).toBe('duplicateEdgeId');
    expect(reasonOf(() => compileWorkflow([node('a'), node('b')], [edge('a', 'b'), edge('a', 'zz')]))).toBe('edgeEndpointMissing');
  });

  it('空图被拒绝', () => {
    expect(reasonOf(() => compileWorkflow([], []))).toBe('noNodes');
  });

  it('服务端强制连通：孤立节点与多个分量都拒绝', () => {
    expect(reasonOf(() => compileWorkflow([node('a'), node('b'), node('c')], [edge('a', 'b')]))).toBe('orphanNode');
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b'), edge('c', 'd')]))).toBe('graphDisconnected');
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b'), edge('c', 'd')], { requireConnected: false }))).toBe('ok');
  });

  it('指定开始节点：去重、必须存在', () => {
    const graph = compileWorkflow([node('a'), node('b')], [edge('a', 'b')], { requestedStartNodeIds: [' b ', 'b'] });
    expect(graph.startNodeIds).toEqual(['b']);
    expect(reasonOf(() => compileWorkflow([node('a'), node('b')], [edge('a', 'b')], { requestedStartNodeIds: ['zz'] }))).toBe('startNodeMissing');
  });

  it('边 id 缺省为 source->target', () => {
    const graph = compileWorkflow([node('a'), node('b')], [{ source: 'a', target: 'b' }]);
    expect(graph.edges[0]).toMatchObject({ id: 'a->b', data: { orchestration: { route: 'success' } } });
  });
});

describe('静态执行上界', () => {
  it('Σ 活跃节点 × Π 所在循环的 maxIterations', () => {
    const nodes = [node('s'), node('h'), node('ih'), node('il'), node('l'), node('out')];
    const edges = [edge('s', 'h'), edge('h', 'ih'), edge('ih', 'il'), edge('il', 'l'), edge('l', 'out'),
      edge('il', 'ih', fb(10, 'inner')), edge('l', 'h', fb(5, 'outer'))];
    const graph = compileWorkflow(nodes, edges);
    const active = activeNodeIds(graph, graph.startNodeIds);
    // s=1, h=5, ih=50, il=50, l=5, out=1
    expect(staticExecutionBound(graph.loops, active)).toBe(112);
  });

  it('只统计从开始节点可达的节点', () => {
    const graph = compileWorkflow([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')], { requestedStartNodeIds: ['b'] });
    expect([...activeNodeIds(graph, graph.startNodeIds)].sort()).toEqual(['b', 'c']);
  });
});

describe('严格规范化', () => {
  it('节点上的未知键被拒绝，不静默丢弃', () => {
    const raw = { ...node('a'), selected: true };
    expect(reasonOf(() => compileWorkflow([raw], []))).toBe('unknownKey');
    const rawData = node('a');
    (rawData.data as any).executionPolicy = 'x';
    expect(reasonOf(() => compileWorkflow([rawData], []))).toBe('unknownKey');
  });

  it('非法 join、非法 approval 类型、非法 agent kind', () => {
    const bad = node('a');
    (bad.data as any).orchestration = { join: 'first' };
    expect(reasonOf(() => compileWorkflow([bad], []))).toBe('invalidJoin');
    const bad2 = node('a');
    (bad2.data as any).approvalRequired = 'yes';
    expect(reasonOf(() => compileWorkflow([bad2], []))).toBe('invalidApproval');
    const bad3 = node('a');
    (bad3.data as any).agent = { kind: 'hermes', id: 'x' };
    expect(reasonOf(() => compileWorkflow([bad3], []))).toBe('invalidAgentKind');
  });

  it('边：未知路由、条件路径禁止段、缺值、未知运算符、非法 maxIterations', () => {
    const nodes = [node('a'), node('b')];
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b', { route: 'maybe' })]))).toBe('invalidRoute');
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b', { condition: { path: 'outputJson.__proto__', operator: 'exists' } })]))).toBe('invalidConditionPath');
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b', { condition: { path: 'output..x', operator: 'exists' } })]))).toBe('invalidConditionPath');
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b', { condition: { path: 'output', operator: 'equals' } })]))).toBe('conditionValueRequired');
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b', { condition: { path: 'output', operator: 'like', value: 1 } })]))).toBe('invalidConditionOperator');
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b'), edge('b', 'a', { feedback: { maxIterations: 101 } })]))).toBe('invalidMaxIterations');
    expect(reasonOf(() => compileWorkflow(nodes, [edge('a', 'b'), edge('b', 'a', { feedback: { maxIterations: 2, extra: 1 } })]))).toBe('unknownKey');
  });

  it('feedback: true 等价于 maxIterations 3', () => {
    const graph = compileWorkflow([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a', { feedback: true })]);
    expect(graph.loops[0].maxIterations).toBe(3);
  });

  it('附件只接受 /uploads/<name>，拒绝穿越与绝对路径', () => {
    const bad = node('a');
    (bad.data as any).attachments = [{ name: 'x', url: '/etc/passwd' }];
    expect(reasonOf(() => compileWorkflow([bad], []))).toBe('invalidAttachment');
    const bad2 = node('a');
    (bad2.data as any).attachments = [{ name: 'x', url: '/uploads/../secret' }];
    expect(reasonOf(() => compileWorkflow([bad2], []))).toBe('invalidAttachment');
  });
});

describe('外部运行时节点的模式', () => {
  const ext = (agent: Record<string, unknown>) => ({ ...node('a'), data: { ...node('a').data, agent } });
  it('scoped 保留、global 缺省不写；OpenClaw 节点或非法值拒绝', () => {
    expect(compileWorkflow([ext({ kind: 'external', id: 'pi', runtime: 'pi', mode: 'scoped' })], []).nodes[0].data.agent).toEqual({ kind: 'external', id: 'pi', runtime: 'pi', mode: 'scoped' });
    expect(compileWorkflow([ext({ kind: 'external', id: 'pi', runtime: 'pi', mode: 'global' })], []).nodes[0].data.agent).toEqual({ kind: 'external', id: 'pi', runtime: 'pi' });
    expect(reasonOf(() => compileWorkflow([ext({ kind: 'openclaw', id: 'main', mode: 'scoped' })], []))).toBe('invalidAgentKind');
    expect(reasonOf(() => compileWorkflow([ext({ kind: 'external', id: 'pi', mode: 'proxy' })], []))).toBe('invalidAgentKind');
  });
});
