// 画布图的纯逻辑：存盘前校验（服务端编译器的镜像，同一套 reason 码）、存盘投影、边的标签与新建规则。
// 服务端才是权威（`backend/src/automation/workflow/compiler.ts`）；这里只是让用户在点保存之前就看到同一句话。

import type { EdgeOrchestration, WfEdge, WfNode, WorkflowNodeData } from './types';

export type GraphIssue = { reason: string; params?: Record<string, string | number> };

const isFeedback = (edge: WfEdge) => Boolean(edge.data.orchestration.feedback);

function reach(from: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set([from]);
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

/** 非反馈边构成的图里，从 target 能不能走回 source（加上这条边会不会成环）。 */
export function wouldCloseForwardCycle(edges: WfEdge[], source: string, target: string): boolean {
  if (source === target) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (isFeedback(edge)) continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source)!.push(edge.target);
  }
  return reach(target, adjacency).has(source);
}

/** 新建连线：默认 success 路由；会闭合前向环的自动标成反馈边（maxIterations 3）。 */
export function makeEdge(edges: WfEdge[], source: string, target: string, sourceHandle?: string | null, targetHandle?: string | null): WfEdge {
  let id = `${source}-${target}`;
  let n = 2;
  while (edges.some((edge) => edge.id === id)) id = `${source}-${target}-${n++}`;
  const orchestration: EdgeOrchestration = wouldCloseForwardCycle(edges, source, target)
    ? { route: 'success', feedback: { maxIterations: 3 } }
    : { route: 'success' };
  return { id, source, target, sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null, data: { orchestration } };
}

export function formatConditionValue(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
}

/** 画布标签：`route · subject operator value`，截到 72 字。 */
export function edgeLabel(orchestration: EdgeOrchestration, translateRoute: (route: string) => string = (route) => route): string {
  const parts = [translateRoute(orchestration.route)];
  if (orchestration.condition) {
    const { path, operator, value } = orchestration.condition;
    parts.push([path, operator, operator === 'exists' || operator === 'not_exists' ? '' : formatConditionValue(value)].filter(Boolean).join(' '));
  }
  if (orchestration.feedback) parts.push(`↺ ${orchestration.feedback.maxIterations}`);
  const label = parts.join(' · ');
  return label.length > 72 ? `${label.slice(0, 71)}…` : label;
}

export function defaultNodeData(agent: WorkflowNodeData['agent'], title: string): WorkflowNodeData {
  return { title, agent, input: '', skills: [], attachments: [], approvalRequired: false, orchestration: { join: 'all' } };
}

/** 存盘投影：只留服务端白名单里的键（React Flow 的 selected / measured / dragging 等一律去掉）。 */
export function toSavePayload(nodes: WfNode[], edges: WfEdge[]) {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: 'agent' as const,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      data: {
        title: node.data.title,
        agent: node.data.agent,
        input: node.data.input,
        skills: node.data.skills,
        attachments: node.data.attachments,
        approvalRequired: node.data.approvalRequired,
        orchestration: { join: node.data.orchestration.join },
        ...(node.data.model ? { model: node.data.model } : {}),
      },
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
      data: { orchestration: edge.data.orchestration },
    })),
  };
}

type LoopInfo = { id: string; body: Set<string> };

/** 反馈边的循环校验（与服务端同判据）：前向可达、单入口（支配）、id 不重复、层状嵌套。 */
function validateLoops(nodes: WfNode[], edges: WfEdge[]): GraphIssue | null {
  const ids = nodes.map((node) => node.id);
  const forward = edges.filter((edge) => !isFeedback(edge));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const inn = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of forward) {
    out.get(edge.source)?.push(edge.target);
    inn.get(edge.target)?.push(edge.source);
  }
  // 拓扑序（无环已在前面判过）
  const indegree = new Map(ids.map((id) => [id, inn.get(id)!.length]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const dominators = new Map<string, Set<string>>();
  for (const id of order) {
    const preds = inn.get(id)!;
    if (!preds.length) {
      dominators.set(id, new Set([id]));
      continue;
    }
    let set = new Set(dominators.get(preds[0])!);
    for (const pred of preds.slice(1)) set = new Set([...set].filter((value) => dominators.get(pred)!.has(value)));
    set.add(id);
    dominators.set(id, set);
  }
  const loops: LoopInfo[] = [];
  for (const edge of edges.filter(isFeedback)) {
    const header = edge.target;
    const latch = edge.source;
    let body: Set<string>;
    if (header === latch) body = new Set([header]);
    else {
      if (!reach(header, out).has(latch)) return { reason: 'loopNoForwardPath', params: { edgeId: edge.id } };
      if (!dominators.get(latch)?.has(header)) return { reason: 'loopNotSingleEntry', params: { edgeId: edge.id } };
      const fromHeader = reach(header, out);
      body = new Set(ids.filter((id) => fromHeader.has(id) && reach(id, out).has(latch)));
    }
    const id = edge.data.orchestration.feedback?.loopId ?? `loop:${edge.id}`;
    if (loops.some((loop) => loop.id === id)) return { reason: 'duplicateLoopId', params: { loopId: id } };
    loops.push({ id, body });
  }
  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      const shared = [...loops[i].body].filter((id) => loops[j].body.has(id)).length;
      if (!shared) continue;
      if (shared === loops[i].body.size && shared === loops[j].body.size) return { reason: 'loopIdenticalScope', params: { a: loops[i].id, b: loops[j].id } };
      if (shared !== loops[i].body.size && shared !== loops[j].body.size) return { reason: 'loopPartialOverlap', params: { a: loops[i].id, b: loops[j].id } };
    }
  }
  return null;
}

/** 保存前校验，第一条失败即返回（与服务端 reason 码一致，前端按同一套文案显示）。 */
export function validateForSave(nodes: WfNode[], edges: WfEdge[]): GraphIssue | null {
  if (!nodes.length) return { reason: 'noNodes' };
  for (const node of nodes) {
    if (!node.data.title.trim()) return { reason: 'titleRequired', params: { id: node.id } };
    if (!node.data.agent?.id) return { reason: 'agentRequired', params: { id: node.id } };
    if (!node.data.input.trim()) return { reason: 'inputRequired', params: { id: node.id } };
  }
  const ids = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) return { reason: 'edgeEndpointMissing', params: { id: edge.id } };
    if (edge.source === edge.target && edge.sourceHandle && edge.sourceHandle === edge.targetHandle) return { reason: 'invalidHandle', params: { edgeId: edge.id } };
    const condition = edge.data.orchestration.condition;
    if (condition && (!condition.path.trim() || condition.path.split('.').some((segment) => !segment || ['__proto__', 'prototype', 'constructor'].includes(segment)))) {
      return { reason: 'invalidConditionPath', params: { edgeId: edge.id } };
    }
  }
  if (nodes.length > 1) {
    const adjacency = new Map<string, string[]>([...ids].map((id) => [id, []]));
    for (const edge of edges) {
      if (edge.source === edge.target) continue;
      adjacency.get(edge.source)!.push(edge.target);
      adjacency.get(edge.target)!.push(edge.source);
    }
    for (const node of nodes) if (!adjacency.get(node.id)!.length) return { reason: 'orphanNode', params: { id: node.id } };
    if (reach(nodes[0].id, adjacency).size !== nodes.length) return { reason: 'graphDisconnected' };
  }
  for (const edge of edges) {
    if (!isFeedback(edge) && wouldCloseForwardCycle(edges.filter((other) => other !== edge), edge.source, edge.target)) return { reason: 'forwardCycle' };
  }
  return validateLoops(nodes, edges);
}

/** 静态执行上界（与服务端同算法），运行前在预算弹窗里提示。 */
export function staticBound(nodes: WfNode[], edges: WfEdge[]): number {
  const out = new Map<string, string[]>();
  for (const edge of edges) if (!isFeedback(edge)) (out.get(edge.source) ?? out.set(edge.source, []).get(edge.source)!).push(edge.target);
  const loops = edges.filter(isFeedback).map((edge) => {
    const header = edge.target;
    const latch = edge.source;
    if (header === latch) return { body: new Set([header]), max: edge.data.orchestration.feedback!.maxIterations };
    const fromHeader = reach(header, out);
    return { body: new Set(nodes.map((n) => n.id).filter((id) => fromHeader.has(id) && reach(id, out).has(latch))), max: edge.data.orchestration.feedback!.maxIterations };
  });
  return nodes.reduce((sum, node) => sum + loops.reduce((product, loop) => (loop.body.has(node.id) ? product * loop.max : product), 1), 0);
}

/** 下一个可用的节点 id：agent-1、agent-2…… */
export function nextNodeId(nodes: WfNode[]): string {
  let n = nodes.length + 1;
  while (nodes.some((node) => node.id === `agent-${n}`)) n += 1;
  return `agent-${n}`;
}
