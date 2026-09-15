import type Database from 'better-sqlite3';

import { newId, parseJson } from '../shared/util';
import type { Viewport, WorkflowEdge, WorkflowNode } from './types';

export type WorkflowDefinition = {
  id: string;
  name: string;
  workspace: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: Viewport | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowSummary = Pick<WorkflowDefinition, 'id' | 'name' | 'workspace' | 'createdAt' | 'updatedAt'> & {
  nodeCount: number;
  edgeCount: number;
};

type Row = {
  id: string;
  name: string;
  workspace: string | null;
  nodes_json: string;
  edges_json: string;
  viewport_json: string | null;
  created_at: number;
  updated_at: number;
};

function toDefinition(row: Row): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    workspace: row.workspace,
    nodes: parseJson(row.nodes_json, []),
    edges: parseJson(row.edges_json, []),
    viewport: parseJson(row.viewport_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDefinitionStore(db: Database.Database, now: () => number = Date.now) {
  return {
    list(): WorkflowSummary[] {
      const rows = db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as Row[];
      return rows.map((row) => {
        const def = toDefinition(row);
        return {
          id: def.id,
          name: def.name,
          workspace: def.workspace,
          createdAt: def.createdAt,
          updatedAt: def.updatedAt,
          nodeCount: def.nodes.length,
          edgeCount: def.edges.length,
        };
      });
    },

    get(id: string): WorkflowDefinition | null {
      const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Row | undefined;
      return row ? toDefinition(row) : null;
    },

    create(input: { id?: string; name: string; workspace: string | null; nodes: WorkflowNode[]; edges: WorkflowEdge[]; viewport: Viewport | null }): WorkflowDefinition {
      const id = input.id ?? newId();
      const at = now();
      db.prepare(`INSERT INTO workflows (id, name, workspace, nodes_json, edges_json, viewport_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.name, input.workspace, JSON.stringify(input.nodes), JSON.stringify(input.edges),
        input.viewport ? JSON.stringify(input.viewport) : null, at, at,
      );
      return this.get(id)!;
    },

    update(id: string, patch: Partial<Pick<WorkflowDefinition, 'name' | 'workspace' | 'nodes' | 'edges' | 'viewport'>>): WorkflowDefinition | null {
      const current = this.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      db.prepare(`UPDATE workflows SET name = ?, workspace = ?, nodes_json = ?, edges_json = ?, viewport_json = ?, updated_at = ? WHERE id = ?`).run(
        next.name, next.workspace, JSON.stringify(next.nodes), JSON.stringify(next.edges),
        next.viewport ? JSON.stringify(next.viewport) : null, Math.max(now(), current.updatedAt + 1), id,
      );
      return this.get(id);
    },

    delete(id: string): boolean {
      return db.prepare('DELETE FROM workflows WHERE id = ?').run(id).changes > 0;
    },
  };
}

export type DefinitionStore = ReturnType<typeof createDefinitionStore>;
