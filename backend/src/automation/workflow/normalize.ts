/**
 * 严格规范化：未知键拒绝，显式给出的非法值拒绝，**不静默改成默认值**。
 * 缺省才取默认。存盘、运行、导入三处共用这一份，前端的保存校验是它的镜像而不是替代。
 */
import { isPlainObject } from '../shared/util';
import {
  CONDITION_OPERATORS,
  ROUTES,
  type ConditionOperator,
  type EdgeOrchestration,
  type Route,
  type WorkflowAttachment,
  type WorkflowEdge,
  type WorkflowNode,
} from './types';

export class GraphError extends Error {
  readonly reason: string;
  readonly params: Record<string, string | number>;

  constructor(reason: string, params: Record<string, string | number> = {}) {
    super(`${reason}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ''}`);
    this.name = 'GraphError';
    this.reason = reason;
    this.params = params;
  }
}

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SKILL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UPLOAD_URL_PATTERN = /^\/uploads\/[^/\\\0]{1,255}$/;
export const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
export const MAX_NODES = 500;
export const MAX_EDGES = 2000;

const NODE_KEYS = new Set(['id', 'type', 'position', 'width', 'height', 'data']);
const NODE_DATA_KEYS = new Set(['title', 'agent', 'input', 'skills', 'attachments', 'approvalRequired', 'orchestration', 'model']);
const AGENT_KEYS = new Set(['kind', 'id', 'runtime', 'mode']);
const EDGE_KEYS = new Set(['id', 'source', 'target', 'sourceHandle', 'targetHandle', 'label', 'data']);
const ORCHESTRATION_KEYS = new Set(['route', 'condition', 'feedback']);
const CONDITION_KEYS = new Set(['path', 'operator', 'value']);
const FEEDBACK_KEYS = new Set(['maxIterations', 'loopId']);

function assertKeys(value: Record<string, unknown>, allowed: Set<string>, where: string, id: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new GraphError('unknownKey', { where, key, id });
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeAttachment(raw: unknown, nodeId: string): WorkflowAttachment {
  if (!isPlainObject(raw)) throw new GraphError('invalidAttachment', { nodeId });
  assertKeys(raw, new Set(['name', 'url', 'mimeType']), 'attachment', nodeId);
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!UPLOAD_URL_PATTERN.test(url) || url.includes('..')) throw new GraphError('invalidAttachment', { nodeId });
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 255) : url.slice('/uploads/'.length);
  const out: WorkflowAttachment = { name, url };
  if (raw.mimeType !== undefined) {
    if (typeof raw.mimeType !== 'string') throw new GraphError('invalidAttachment', { nodeId });
    out.mimeType = raw.mimeType.slice(0, 120);
  }
  return out;
}

export function normalizeNode(raw: unknown): WorkflowNode {
  if (!isPlainObject(raw)) throw new GraphError('nodeNotObject');
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_PATTERN.test(id)) throw new GraphError('invalidNodeId', { id: String(raw.id ?? '') });
  assertKeys(raw, NODE_KEYS, 'node', id);
  if (raw.type !== undefined && raw.type !== 'agent') throw new GraphError('invalidNodeType', { id });

  let position = { x: 0, y: 0 };
  if (raw.position !== undefined) {
    if (!isPlainObject(raw.position) || !finite(raw.position.x) || !finite(raw.position.y)) {
      throw new GraphError('invalidPosition', { id });
    }
    position = { x: raw.position.x, y: raw.position.y };
  }

  const data = raw.data;
  if (!isPlainObject(data)) throw new GraphError('nodeDataRequired', { id });
  assertKeys(data, NODE_DATA_KEYS, 'nodeData', id);

  const agentRaw = data.agent;
  if (!isPlainObject(agentRaw)) throw new GraphError('agentRequired', { id });
  assertKeys(agentRaw, AGENT_KEYS, 'agent', id);
  if (agentRaw.kind !== 'openclaw' && agentRaw.kind !== 'external') throw new GraphError('invalidAgentKind', { id });
  const agentId = typeof agentRaw.id === 'string' ? agentRaw.id.trim() : '';
  if (!ID_PATTERN.test(agentId)) throw new GraphError('agentRequired', { id });
  if (agentRaw.runtime !== undefined && (typeof agentRaw.runtime !== 'string' || !ID_PATTERN.test(agentRaw.runtime))) {
    throw new GraphError('invalidAgentKind', { id });
  }
  if (agentRaw.mode !== undefined && (agentRaw.kind !== 'external' || (agentRaw.mode !== 'global' && agentRaw.mode !== 'scoped'))) {
    throw new GraphError('invalidAgentKind', { id });
  }

  if (data.title !== undefined && typeof data.title !== 'string') throw new GraphError('invalidTitle', { id });
  if (data.input !== undefined && typeof data.input !== 'string') throw new GraphError('invalidInput', { id });
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 200) : id;
  const input = typeof data.input === 'string' ? data.input : '';
  if (input.length > 100_000) throw new GraphError('invalidInput', { id });

  let skills: string[] = [];
  if (data.skills !== undefined) {
    if (!Array.isArray(data.skills)) throw new GraphError('invalidSkills', { id });
    skills = [];
    for (const skill of data.skills) {
      if (typeof skill !== 'string' || !SKILL_PATTERN.test(skill.trim())) throw new GraphError('invalidSkills', { id });
      if (!skills.includes(skill.trim())) skills.push(skill.trim());
    }
  }

  let attachments: WorkflowAttachment[] = [];
  if (data.attachments !== undefined) {
    if (!Array.isArray(data.attachments) || data.attachments.length > 20) throw new GraphError('invalidAttachment', { nodeId: id });
    attachments = data.attachments.map((item) => normalizeAttachment(item, id));
  }

  if (data.approvalRequired !== undefined && typeof data.approvalRequired !== 'boolean') {
    throw new GraphError('invalidApproval', { id });
  }

  let join: 'all' | 'any' = 'all';
  if (data.orchestration !== undefined) {
    if (!isPlainObject(data.orchestration)) throw new GraphError('invalidJoin', { id });
    assertKeys(data.orchestration, new Set(['join']), 'nodeOrchestration', id);
    if (data.orchestration.join !== undefined) {
      if (data.orchestration.join !== 'all' && data.orchestration.join !== 'any') throw new GraphError('invalidJoin', { id });
      join = data.orchestration.join;
    }
  }

  const node: WorkflowNode = {
    id,
    type: 'agent',
    position,
    data: {
      title,
      agent: {
        kind: agentRaw.kind,
        id: agentId,
        ...(typeof agentRaw.runtime === 'string' ? { runtime: agentRaw.runtime } : {}),
        ...(agentRaw.mode === 'scoped' ? { mode: 'scoped' as const } : {}),
      },
      input,
      skills,
      attachments,
      approvalRequired: data.approvalRequired === true,
      orchestration: { join },
    },
  };
  if (data.model !== undefined) {
    if (typeof data.model !== 'string' || data.model.length > 200) throw new GraphError('invalidModel', { id });
    if (data.model.trim()) node.data.model = data.model.trim();
  }
  if (raw.width !== undefined) {
    if (!finite(raw.width) || raw.width <= 0) throw new GraphError('invalidSize', { id });
    node.width = raw.width;
  }
  if (raw.height !== undefined) {
    if (!finite(raw.height) || raw.height <= 0) throw new GraphError('invalidSize', { id });
    node.height = raw.height;
  }
  return node;
}

export function normalizeOrchestration(raw: unknown, edgeId: string): EdgeOrchestration {
  if (raw === undefined) return { route: 'success' };
  if (!isPlainObject(raw)) throw new GraphError('invalidOrchestration', { edgeId });
  assertKeys(raw, ORCHESTRATION_KEYS, 'orchestration', edgeId);
  const route = raw.route === undefined ? 'success' : raw.route;
  if (!ROUTES.includes(route as Route)) throw new GraphError('invalidRoute', { edgeId });
  const out: EdgeOrchestration = { route: route as Route };

  if (raw.condition !== undefined) {
    const condition = raw.condition;
    if (!isPlainObject(condition)) throw new GraphError('invalidCondition', { edgeId });
    assertKeys(condition, CONDITION_KEYS, 'condition', edgeId);
    const path = typeof condition.path === 'string' ? condition.path.trim() : '';
    const segments = path.split('.');
    if (!path || segments.some((segment) => !segment || FORBIDDEN_PATH_SEGMENTS.has(segment))) {
      throw new GraphError('invalidConditionPath', { edgeId });
    }
    if (!CONDITION_OPERATORS.includes(condition.operator as ConditionOperator)) {
      throw new GraphError('invalidConditionOperator', { edgeId });
    }
    const operator = condition.operator as ConditionOperator;
    const needsValue = operator !== 'exists' && operator !== 'not_exists';
    if (needsValue && !Object.prototype.hasOwnProperty.call(condition, 'value')) {
      throw new GraphError('conditionValueRequired', { edgeId });
    }
    out.condition = needsValue ? { path, operator, value: condition.value } : { path, operator };
  }

  if (raw.feedback !== undefined && raw.feedback !== false) {
    if (raw.feedback === true) {
      out.feedback = { maxIterations: 3 };
    } else {
      const feedback = raw.feedback;
      if (!isPlainObject(feedback)) throw new GraphError('invalidFeedback', { edgeId });
      assertKeys(feedback, FEEDBACK_KEYS, 'feedback', edgeId);
      const max = feedback.maxIterations === undefined ? 3 : feedback.maxIterations;
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 100) {
        throw new GraphError('invalidMaxIterations', { edgeId });
      }
      out.feedback = { maxIterations: max };
      if (feedback.loopId !== undefined) {
        if (typeof feedback.loopId !== 'string' || !ID_PATTERN.test(feedback.loopId)) throw new GraphError('invalidLoopId', { edgeId });
        out.feedback.loopId = feedback.loopId;
      }
    }
  }
  return out;
}

export function normalizeEdge(raw: unknown): WorkflowEdge {
  if (!isPlainObject(raw)) throw new GraphError('edgeNotObject');
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  const target = typeof raw.target === 'string' ? raw.target.trim() : '';
  if (!source || !target) throw new GraphError('edgeEndpointsRequired', { id: String(raw.id ?? '') });
  const explicitId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const id = explicitId || `${source}->${target}`;
  if (id.length > 300) throw new GraphError('invalidEdgeId', { id: id.slice(0, 60) });
  assertKeys(raw, EDGE_KEYS, 'edge', id);
  let orchestrationRaw: unknown;
  if (raw.data !== undefined) {
    if (!isPlainObject(raw.data)) throw new GraphError('invalidOrchestration', { edgeId: id });
    assertKeys(raw.data, new Set(['orchestration']), 'edgeData', id);
    orchestrationRaw = raw.data.orchestration;
  }
  const edge: WorkflowEdge = { id, source, target, data: { orchestration: normalizeOrchestration(orchestrationRaw, id) } };
  for (const handle of ['sourceHandle', 'targetHandle'] as const) {
    const value = raw[handle];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > 40) throw new GraphError('invalidHandle', { edgeId: id });
    edge[handle] = value;
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string') throw new GraphError('invalidLabel', { edgeId: id });
    edge.label = raw.label.slice(0, 120);
  }
  return edge;
}
