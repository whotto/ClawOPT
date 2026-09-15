/**
 * 导入导出。信封：`{ format: 'clawopt.workflow', version: 1, definition }`。
 *
 * - **导出**按白名单投影，丢掉环境绑定的字段（模型绑定、附件路径）；导出本身也过凭据键扫描。
 * - **导入**两阶段：preview 把规范化后的定义存进数据库（带 TTL 的一次性令牌 + 摘要），
 *   confirm 消费令牌（失败也消费）、复核摘要、把所有节点与边的 id 换成新的，再建工作流。
 *   令牌落库而不是放内存：重启不丢、多进程共享同一个库时也成立。
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

import { AutomationError, WORKFLOW_ERROR } from '../shared/errors';
import { isPlainObject, parseJson } from '../shared/util';
import { canonicalJson } from '../../core/http';
import { compileWorkflow } from './compiler';
import { GraphError, MAX_EDGES, MAX_NODES } from './normalize';
import type { Viewport, WorkflowEdge, WorkflowNode } from './types';

export const WORKFLOW_ENVELOPE_FORMAT = 'clawopt.workflow';
export const WORKFLOW_ENVELOPE_VERSION = 1;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_DEPTH = 20;
export const IMPORT_PREVIEW_TTL_MS = 5 * 60 * 1000;
export const MAX_PENDING_PREVIEWS = 1000;

const CREDENTIAL_KEYS = new Set([
  'token', 'accesstoken', 'refreshtoken', 'apikey', 'password', 'secret', 'clientsecret', 'privatekey',
  'authorization', 'bearer', 'cookie', 'sessionid', 'runid',
]);

export type WorkflowEnvelopeDefinition = { name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; viewport: Viewport | null };
export type WorkflowEnvelope = { format: typeof WORKFLOW_ENVELOPE_FORMAT; version: number; definition: WorkflowEnvelopeDefinition };

const importError = (reason: string, params: Record<string, string | number> = {}) =>
  new AutomationError(400, WORKFLOW_ERROR.importInvalid, reason, { reason, ...params });

/** 深度与凭据键扫描：键名大小写、`-`、`_` 都归一后比对。 */
export function scanDocument(value: unknown, depth = 0, path = '$'): void {
  if (depth > MAX_IMPORT_DEPTH) throw importError('tooDeep', { path });
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanDocument(item, depth + 1, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''))) {
        throw new AutomationError(400, WORKFLOW_ERROR.importCredential, `credential-like key at ${path}.${key}`, { key, path });
      }
      scanDocument(child, depth + 1, `${path}.${key}`);
    }
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw importError('unknownKey', { where, key });
  }
}

function projectNode(node: WorkflowNode) {
  const data: Record<string, unknown> = {
    title: node.data.title,
    agent: node.data.agent,
    input: node.data.input,
    skills: node.data.skills,
    approvalRequired: node.data.approvalRequired,
    orchestration: { join: node.data.orchestration.join },
  };
  return { id: node.id, type: 'agent', position: node.position, data };
}

function projectEdge(edge: WorkflowEdge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    ...(edge.label ? { label: edge.label } : {}),
    data: { orchestration: edge.data.orchestration },
  };
}

export function buildEnvelope(input: { name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; viewport: Viewport | null }): WorkflowEnvelope {
  // 按规范化后的形态投影：库里的定义本应已规范化，这里不信任它，再过一遍。
  const graph = input.nodes.length ? compileWorkflow(input.nodes, input.edges, { requireConnected: false }) : { nodes: [], edges: [] };
  const def = { ...input, nodes: graph.nodes, edges: graph.edges };
  const envelope = {
    format: WORKFLOW_ENVELOPE_FORMAT,
    version: WORKFLOW_ENVELOPE_VERSION,
    definition: {
      name: def.name,
      nodes: def.nodes.map(projectNode),
      edges: def.edges.map(projectEdge),
      viewport: def.viewport,
    },
  } as unknown as WorkflowEnvelope;
  scanDocument(envelope);
  return envelope;
}

function validateViewport(raw: unknown): Viewport | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) throw importError('invalidViewport');
  assertOnlyKeys(raw, ['x', 'y', 'zoom'], 'viewport');
  const { x, y, zoom } = raw;
  if (![x, y, zoom].every((value) => typeof value === 'number' && Number.isFinite(value))) throw importError('invalidViewport');
  return { x: x as number, y: y as number, zoom: zoom as number };
}

/** 信封 → 规范化后的定义。每一层白名单；旧版环境字段（model / attachments）接受后丢弃。 */
export function parseEnvelope(document: unknown): WorkflowEnvelopeDefinition {
  scanDocument(document);
  if (!isPlainObject(document)) throw importError('notAnObject');
  assertOnlyKeys(document, ['format', 'version', 'definition'], 'envelope');
  if (document.format !== WORKFLOW_ENVELOPE_FORMAT) throw importError('wrongFormat');
  if (document.version !== WORKFLOW_ENVELOPE_VERSION) throw importError('wrongVersion');
  const definition = document.definition;
  if (!isPlainObject(definition)) throw importError('definitionRequired');
  assertOnlyKeys(definition, ['name', 'nodes', 'edges', 'viewport'], 'definition');
  const name = typeof definition.name === 'string' ? definition.name.trim() : '';
  if (!name || name.length > 120) throw importError('nameRequired');
  if (!Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) throw importError('nodesEdgesArrays');
  if (definition.nodes.length > MAX_NODES) throw importError('tooManyNodes', { max: MAX_NODES });
  if (definition.edges.length > MAX_EDGES) throw importError('tooManyEdges', { max: MAX_EDGES });

  const nodes = definition.nodes.map((raw) => {
    if (!isPlainObject(raw)) throw importError('invalidNode');
    assertOnlyKeys(raw, ['id', 'type', 'position', 'data'], 'node');
    if (raw.type !== 'agent') throw importError('invalidNodeType');
    if (!isPlainObject(raw.position) || typeof raw.position.x !== 'number' || typeof raw.position.y !== 'number'
      || !Number.isFinite(raw.position.x) || !Number.isFinite(raw.position.y)) throw importError('invalidPosition');
    assertOnlyKeys(raw.position, ['x', 'y'], 'position');
    if (!isPlainObject(raw.data)) throw importError('invalidNode');
    assertOnlyKeys(raw.data, ['title', 'agent', 'input', 'skills', 'approvalRequired', 'orchestration', 'model', 'attachments'], 'nodeData');
    const { model: _model, attachments: _attachments, ...data } = raw.data;
    return { ...raw, data };
  });
  const edges = definition.edges.map((raw) => {
    if (!isPlainObject(raw)) throw importError('invalidEdge');
    assertOnlyKeys(raw, ['id', 'source', 'target', 'sourceHandle', 'targetHandle', 'label', 'data'], 'edge');
    return raw;
  });

  try {
    const graph = compileWorkflow(nodes, edges, { requireConnected: true });
    return { name, nodes: graph.nodes, edges: graph.edges, viewport: validateViewport(definition.viewport) };
  } catch (error) {
    if (error instanceof GraphError) throw importError(error.reason, error.params);
    throw error;
  }
}

export function parseImportText(text: unknown): WorkflowEnvelopeDefinition {
  if (typeof text !== 'string') throw importError('documentRequired');
  if (Buffer.byteLength(text, 'utf-8') > MAX_IMPORT_BYTES) {
    throw new AutomationError(400, WORKFLOW_ERROR.importTooLarge, 'document exceeds 1 MiB', { max: MAX_IMPORT_BYTES });
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw importError('invalidJson');
  }
  return parseEnvelope(document);
}

export function digestDefinition(definition: WorkflowEnvelopeDefinition): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}

/** 节点与边的 id 全换新，边重新指向；可选把 OpenClaw Agent 引用按映射改名（.clawpack 装包时用）。 */
export function remapDefinitionIds(definition: WorkflowEnvelopeDefinition, agentIdMap: Record<string, string> = {}): WorkflowEnvelopeDefinition {
  const nodeIds = new Map(definition.nodes.map((node) => [node.id, `n-${randomUUID()}`]));
  const nodes = definition.nodes.map((node) => ({
    ...node,
    id: nodeIds.get(node.id)!,
    data: {
      ...node.data,
      agent: node.data.agent.kind === 'openclaw' && agentIdMap[node.data.agent.id]
        ? { ...node.data.agent, id: agentIdMap[node.data.agent.id] }
        : node.data.agent,
    },
  }));
  const edges = definition.edges.map((edge) => ({
    ...edge,
    id: `e-${randomUUID()}`,
    source: nodeIds.get(edge.source)!,
    target: nodeIds.get(edge.target)!,
  }));
  const graph = compileWorkflow(nodes, edges, { requireConnected: true });
  return { ...definition, nodes: graph.nodes, edges: graph.edges };
}

export function createImportPreviewStore(db: Database.Database, now: () => number = Date.now) {
  return {
    create(definition: WorkflowEnvelopeDefinition) {
      const at = now();
      const token = randomBytes(24).toString('base64url');
      const digest = digestDefinition(definition);
      const expiresAt = at + IMPORT_PREVIEW_TTL_MS;
      db.transaction(() => {
        db.prepare('DELETE FROM workflow_import_previews WHERE expires_at <= ?').run(at);
        const count = (db.prepare('SELECT COUNT(*) AS n FROM workflow_import_previews').get() as { n: number }).n;
        if (count >= MAX_PENDING_PREVIEWS) {
          db.prepare(`DELETE FROM workflow_import_previews WHERE token IN
            (SELECT token FROM workflow_import_previews ORDER BY created_at ASC LIMIT ?)`).run(count - MAX_PENDING_PREVIEWS + 1);
        }
        db.prepare('INSERT INTO workflow_import_previews (token, digest, definition_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(token, digest, JSON.stringify(definition), expiresAt, at);
      })();
      return { token, digest, expiresAt, summary: { name: definition.name, nodes: definition.nodes.length, edges: definition.edges.length } };
    },

    /** 一次性：取出即删除，不论之后成败。过期、不存在、摘要不符都是 409。 */
    consume(token: unknown): WorkflowEnvelopeDefinition {
      if (typeof token !== 'string' || !token) throw new AutomationError(409, WORKFLOW_ERROR.importTokenInvalid, 'token required');
      const row = db.transaction(() => {
        const found = db.prepare('SELECT * FROM workflow_import_previews WHERE token = ?').get(token) as any;
        db.prepare('DELETE FROM workflow_import_previews WHERE token = ?').run(token);
        return found;
      })();
      if (!row) throw new AutomationError(409, WORKFLOW_ERROR.importTokenInvalid, 'unknown token');
      if (row.expires_at <= now()) throw new AutomationError(409, WORKFLOW_ERROR.importTokenInvalid, 'token expired');
      const definition = parseJson<WorkflowEnvelopeDefinition | null>(row.definition_json, null);
      if (!definition || digestDefinition(definition) !== row.digest) {
        throw new AutomationError(409, WORKFLOW_ERROR.importTokenInvalid, 'digest mismatch');
      }
      return definition;
    },

    cancel(token: unknown): boolean {
      if (typeof token !== 'string') return false;
      return db.prepare('DELETE FROM workflow_import_previews WHERE token = ?').run(token).changes > 0;
    },
  };
}

export type ImportPreviewStore = ReturnType<typeof createImportPreviewStore>;
