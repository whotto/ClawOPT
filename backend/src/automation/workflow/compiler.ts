/**
 * 图编译：前向图无环（Kahn）→ 支配点 → 单入口自然循环 → 层状嵌套 → 开始节点。
 * 另加服务端的连通性 / 孤立节点判定（spec 里只在前端做，服务端不守等于没守）。
 *
 * 编译是纯函数：同样的输入永远得到同样的循环 id、同样的 body 顺序（按节点数组顺序）。
 */
import { GraphError, MAX_EDGES, MAX_NODES, normalizeEdge, normalizeNode } from './normalize';
import type { CompiledGraph, CompiledLoop, WorkflowEdge, WorkflowNode } from './types';

export const MAX_WORKFLOW_RUN_EXECUTIONS = 1000;

export type CompileOptions = {
  requestedStartNodeIds?: string[];
  /** 存盘与运行都要求连通；只有「空画布草稿」不编译。 */
  requireConnected?: boolean;
};

export function isFeedbackEdge(edge: WorkflowEdge): boolean {
  return Boolean(edge.data.orchestration.feedback);
}

function topoOrder(nodeIds: string[], forwardEdges: WorkflowEdge[]): string[] {
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of forwardEdges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const queue = nodeIds.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id)!) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== nodeIds.length) throw new GraphError('forwardCycle');
  return order;
}

function reachable(from: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of adjacency.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

export function compileWorkflow(rawNodes: unknown, rawEdges: unknown, options: CompileOptions = {}): CompiledGraph {
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) throw new GraphError('nodesEdgesArrays');
  if (rawNodes.length === 0) throw new GraphError('noNodes');
  if (rawNodes.length > MAX_NODES) throw new GraphError('tooManyNodes', { max: MAX_NODES });
  if (rawEdges.length > MAX_EDGES) throw new GraphError('tooManyEdges', { max: MAX_EDGES });

  const nodes: WorkflowNode[] = rawNodes.map(normalizeNode);
  const edges: WorkflowEdge[] = rawEdges.map(normalizeEdge);

  const nodeIds = nodes.map((node) => node.id);
  const nodeSet = new Set<string>();
  for (const id of nodeIds) {
    if (nodeSet.has(id)) throw new GraphError('duplicateNodeId', { id });
    nodeSet.add(id);
  }
  const edgeSet = new Set<string>();
  for (const edge of edges) {
    if (edgeSet.has(edge.id)) throw new GraphError('duplicateEdgeId', { id: edge.id });
    edgeSet.add(edge.id);
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) throw new GraphError('edgeEndpointMissing', { id: edge.id });
  }

  if (options.requireConnected !== false && nodes.length > 1) {
    assertConnected(nodeIds, edges);
  }

  const forward = edges.filter((edge) => !isFeedbackEdge(edge));
  for (const edge of forward) {
    if (edge.source === edge.target) throw new GraphError('forwardCycle');
  }
  const order = topoOrder(nodeIds, forward);

  const forwardOut = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const forwardIn = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of forward) {
    forwardOut.get(edge.source)!.push(edge.target);
    forwardIn.get(edge.target)!.push(edge.source);
  }

  // 支配点：根只支配自己；其余 = 前驱支配集的交集 ∪ {自己}
  const dominators = new Map<string, Set<string>>();
  for (const id of order) {
    const preds = forwardIn.get(id)!;
    if (preds.length === 0) {
      dominators.set(id, new Set([id]));
      continue;
    }
    let intersection = new Set<string>(dominators.get(preds[0])!);
    for (const pred of preds.slice(1)) {
      const predDoms = dominators.get(pred)!;
      intersection = new Set([...intersection].filter((value) => predDoms.has(value)));
    }
    intersection.add(id);
    dominators.set(id, intersection);
  }

  const reachCache = new Map<string, Set<string>>();
  const reachFrom = (id: string) => {
    if (!reachCache.has(id)) reachCache.set(id, reachable(id, forwardOut));
    return reachCache.get(id)!;
  };

  const loops: CompiledLoop[] = [];
  const loopIds = new Set<string>();
  for (const edge of edges.filter(isFeedbackEdge)) {
    const header = edge.target;
    const latch = edge.source;
    let body: string[];
    if (header === latch) {
      body = [header];
    } else {
      if (!reachFrom(header).has(latch)) throw new GraphError('loopNoForwardPath', { edgeId: edge.id });
      if (!dominators.get(latch)!.has(header)) throw new GraphError('loopNotSingleEntry', { edgeId: edge.id });
      const fromHeader = reachFrom(header);
      body = nodeIds.filter((id) => fromHeader.has(id) && reachFrom(id).has(latch));
    }
    const id = edge.data.orchestration.feedback!.loopId ?? `loop:${edge.id}`;
    if (loopIds.has(id)) throw new GraphError('duplicateLoopId', { loopId: id });
    loopIds.add(id);
    loops.push({
      id,
      feedbackEdgeId: edge.id,
      headerNodeId: header,
      latchNodeId: latch,
      bodyNodeIds: body,
      maxIterations: edge.data.orchestration.feedback!.maxIterations,
      parentLoopId: null,
    });
  }

  // 层状嵌套：相交则必须严格包含；完全相同或部分重叠都拒绝。
  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      const a = new Set(loops[i].bodyNodeIds);
      const b = new Set(loops[j].bodyNodeIds);
      const shared = [...a].filter((id) => b.has(id));
      if (!shared.length) continue;
      if (a.size === b.size && shared.length === a.size) {
        throw new GraphError('loopIdenticalScope', { a: loops[i].id, b: loops[j].id });
      }
      const aInB = shared.length === a.size;
      const bInA = shared.length === b.size;
      if (!aInB && !bInA) throw new GraphError('loopPartialOverlap', { a: loops[i].id, b: loops[j].id });
    }
  }
  for (const loop of loops) {
    const body = new Set(loop.bodyNodeIds);
    const parents = loops
      .filter((other) => other !== loop && other.bodyNodeIds.length > body.size && [...body].every((id) => other.bodyNodeIds.includes(id)))
      .sort((x, y) => (x.bodyNodeIds.length - y.bodyNodeIds.length) || x.id.localeCompare(y.id));
    loop.parentLoopId = parents[0]?.id ?? null;
  }

  let startNodeIds: string[];
  const requested = (options.requestedStartNodeIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (requested.length) {
    startNodeIds = [...new Set(requested)];
    for (const id of startNodeIds) {
      if (!nodeSet.has(id)) throw new GraphError('startNodeMissing', { id });
    }
  } else {
    startNodeIds = nodeIds.filter((id) => forwardIn.get(id)!.length === 0);
  }
  if (!startNodeIds.length) throw new GraphError('noStartNodes');

  return { nodes, edges, loops, startNodeIds };
}

/** 多于一个节点时：没有孤立节点，且（把边当无向）只有一个连通分量。 */
export function assertConnected(nodeIds: string[], edges: WorkflowEdge[]): void {
  const adjacency = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  for (const id of nodeIds) {
    if (!adjacency.get(id)!.length) throw new GraphError('orphanNode', { id });
  }
  const seen = reachable(nodeIds[0], adjacency);
  if (seen.size !== nodeIds.length) throw new GraphError('graphDisconnected');
}

/** 沿全部边（含反馈边）从开始节点可达的节点。 */
export function activeNodeIds(graph: Pick<CompiledGraph, 'edges'>, startNodeIds: string[]): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source)!.push(edge.target);
  }
  const seen = new Set<string>();
  for (const start of startNodeIds) {
    for (const id of reachable(start, adjacency)) seen.add(id);
  }
  return seen;
}

/** 静态执行上界 = Σ(活跃节点) Π(包含它的每个循环的 maxIterations)。 */
export function staticExecutionBound(loops: CompiledLoop[], active: Set<string>): number {
  let total = 0;
  for (const id of active) {
    let product = 1;
    for (const loop of loops) {
      if (loop.bodyNodeIds.includes(id)) product *= loop.maxIterations;
    }
    total += product;
  }
  return total;
}
