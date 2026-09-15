/**
 * 工作流定义的业务规则：存盘前编译（非空图必须能编译、必须连通）、工作目录、级联删除、批量删除、导入导出。
 */
import fs from 'fs';
import path from 'path';

import { AutomationError, WORKFLOW_ERROR, notFound } from '../shared/errors';
import { isPlainObject, uniqueStrings } from '../shared/util';
import { compileWorkflow } from './compiler';
import type { DefinitionStore, WorkflowDefinition } from './definition-store';
import { graphErrorToAutomation, type WorkflowEngine } from './engine';
import { buildEnvelope, parseImportText, remapDefinitionIds, type ImportPreviewStore, type WorkflowEnvelope } from './portability';
import type { StatusHub } from './status-hub';
import type { Viewport, WorkflowEdge, WorkflowNode } from './types';

export const MAX_BATCH_DELETE = 200;

export type WorkflowCascade = {
  deleteSchedulesForWorkflow: (workflowId: string) => void;
  deleteHooksForWorkflow: (workflowId: string) => void;
  /** 回收这个工作流里外部运行时节点的运行时目录。 */
  releaseRuntimeHomes?: (workflowId: string) => void;
};

const invalid = (field: string, detail?: string) => new AutomationError(400, WORKFLOW_ERROR.invalidBody, detail ?? field, { field });

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 120) throw invalid('name');
  return name;
}

function parseWorkspace(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw invalid('workspace');
  try {
    if (!fs.statSync(value).isDirectory()) throw invalid('workspace', 'workspace must be an existing directory');
  } catch (error) {
    if (error instanceof AutomationError) throw error;
    throw invalid('workspace', 'workspace must be an existing directory');
  }
  return path.resolve(value);
}

function parseViewport(value: unknown): Viewport | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw invalid('viewport');
  const { x, y, zoom } = value;
  if (![x, y, zoom].every((item) => typeof item === 'number' && Number.isFinite(item))) throw invalid('viewport');
  return { x: x as number, y: y as number, zoom: zoom as number };
}

/** 非空图：编译通过才落盘，存规范化后的形态。空节点 + 非空边拒绝。 */
function parseGraph(nodes: unknown, edges: unknown): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const rawNodes = nodes === undefined ? [] : nodes;
  const rawEdges = edges === undefined ? [] : edges;
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) throw invalid('nodes');
  if (rawNodes.length === 0) {
    if (rawEdges.length) throw invalid('edges', 'edges require nodes');
    return { nodes: [], edges: [] };
  }
  try {
    const graph = compileWorkflow(rawNodes, rawEdges, { requireConnected: true });
    return { nodes: graph.nodes, edges: graph.edges };
  } catch (error) {
    throw graphErrorToAutomation(error);
  }
}

export function createWorkflowService(deps: {
  defs: DefinitionStore;
  engine: WorkflowEngine;
  hub: StatusHub;
  previews: ImportPreviewStore;
  cascade: WorkflowCascade;
}) {
  const { defs, engine, hub, previews } = deps;

  function require(id: string): WorkflowDefinition {
    const def = defs.get(id);
    if (!def) throw notFound(WORKFLOW_ERROR.notFound, id);
    return def;
  }

  async function remove(id: string): Promise<void> {
    require(id);
    deps.cascade.deleteSchedulesForWorkflow(id);
    deps.cascade.deleteHooksForWorkflow(id);
    await engine.deleteWorkflowRuns(id);
    defs.delete(id);
    // 外部运行时节点的运行时目录随工作流回收（归属 {workflow-node, 工作流}）。
    deps.cascade.releaseRuntimeHomes?.(id);
    hub.forget(id);
  }

  return {
    list: () => defs.list(),
    get: require,

    create(body: Record<string, unknown>): WorkflowDefinition {
      const graph = parseGraph(body.nodes, body.edges);
      return defs.create({
        name: parseName(body.name),
        workspace: parseWorkspace(body.workspace),
        nodes: graph.nodes,
        edges: graph.edges,
        viewport: parseViewport(body.viewport),
      });
    },

    update(id: string, body: Record<string, unknown>): WorkflowDefinition {
      const current = require(id);
      const patch: Parameters<DefinitionStore['update']>[1] = {};
      if (body.name !== undefined) patch.name = parseName(body.name);
      if (body.workspace !== undefined) patch.workspace = parseWorkspace(body.workspace);
      if (body.viewport !== undefined) patch.viewport = parseViewport(body.viewport);
      if (body.nodes !== undefined || body.edges !== undefined) {
        const graph = parseGraph(body.nodes ?? current.nodes, body.edges ?? current.edges);
        patch.nodes = graph.nodes;
        patch.edges = graph.edges;
      }
      return defs.update(id, patch)!;
    },

    remove,

    async batchDelete(ids: unknown) {
      const unique = uniqueStrings(ids);
      if (!Array.isArray(ids) || unique.length === 0) throw invalid('ids');
      if (unique.length > MAX_BATCH_DELETE) {
        throw new AutomationError(400, WORKFLOW_ERROR.batchTooLarge, `at most ${MAX_BATCH_DELETE}`, { max: MAX_BATCH_DELETE });
      }
      const result = { deleted: [] as string[], failed: [] as string[], errors: [] as Array<{ id: string; errorCode: string }> };
      for (const id of unique) {
        try {
          await remove(id);
          result.deleted.push(id);
        } catch (error) {
          result.failed.push(id);
          result.errors.push({ id, errorCode: error instanceof AutomationError ? error.code : 'workflows.deleteFailed' });
        }
      }
      return result;
    },

    exportEnvelope(id: string): WorkflowEnvelope {
      return buildEnvelope(require(id));
    },

    previewImport(document: unknown) {
      return previews.create(parseImportText(document));
    },

    confirmImport(token: unknown): WorkflowDefinition {
      const definition = previews.consume(token);
      let remapped;
      try {
        remapped = remapDefinitionIds(definition);
      } catch (error) {
        throw new AutomationError(409, WORKFLOW_ERROR.importTokenInvalid, (error as Error)?.message);
      }
      return defs.create({ name: remapped.name, workspace: null, nodes: remapped.nodes, edges: remapped.edges, viewport: remapped.viewport });
    },

    cancelImport: (token: unknown) => previews.cancel(token),
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
