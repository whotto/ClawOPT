import Database from 'better-sqlite3';

import { ensureAutomationSchema } from '../../src/automation/shared/schema';
import { createAutomationSettings } from '../../src/automation/shared/settings';
import { createDefinitionStore } from '../../src/automation/workflow/definition-store';
import { createRunStore } from '../../src/automation/workflow/run-store';
import { createStatusHub } from '../../src/automation/workflow/status-hub';
import { createWorkflowEngine } from '../../src/automation/workflow/engine';
import { createScriptedRunner, currentTaskOf, type ScriptedHandler } from '../../src/automation/runner/fake-runner';
import type { AgentDirectory, AgentRunRequest } from '../../src/automation/ports';

export function memoryDb() {
  const db = new Database(':memory:');
  ensureAutomationSchema(db);
  return db;
}

export type NodeSpec = {
  id: string;
  input?: string;
  join?: 'all' | 'any';
  approval?: boolean;
  skills?: string[];
  agent?: string;
};

export function node(spec: NodeSpec | string) {
  const s = typeof spec === 'string' ? { id: spec } : spec;
  return {
    id: s.id,
    type: 'agent',
    position: { x: 0, y: 0 },
    data: {
      title: s.id.toUpperCase(),
      agent: { kind: 'openclaw', id: s.agent ?? 'main' },
      input: s.input ?? `task ${s.id}`,
      ...(s.join ? { orchestration: { join: s.join } } : {}),
      ...(s.approval ? { approvalRequired: true } : {}),
      ...(s.skills ? { skills: s.skills } : {}),
    },
  };
}

export function edge(source: string, target: string, orchestration: Record<string, unknown> = {}, id?: string) {
  return { id: id ?? `${source}-${target}`, source, target, data: { orchestration: { route: 'success', ...orchestration } } };
}

export function directory(overrides: Partial<AgentDirectory> = {}): AgentDirectory {
  return {
    list: () => [],
    availability: () => ({ available: true }),
    readSkill: (_ref, name) => (name === 'known' ? '# known skill' : null),
    listSkills: () => ['known'],
    ...overrides,
  };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 默认行为：按任务文本里的 `out:xxx` / `fail` 指令给结果。 */
export const defaultHandler: ScriptedHandler = (req: AgentRunRequest) => {
  const task = currentTaskOf(req);
  if (task.includes('fail')) return { ok: false, output: '', error: `failed ${task}`, sessionId: req.sessionId };
  const out = /out:(.*)$/s.exec(task);
  return { ok: true, output: out ? out[1] : `done ${task}`, sessionId: req.sessionId };
};

export function setupEngine(options: { handler?: ScriptedHandler; directory?: AgentDirectory; concurrency?: number; now?: () => number; publish?: (topic: string, type: string, payload: unknown) => void } = {}) {
  const db = memoryDb();
  const defs = createDefinitionStore(db);
  const runStore = createRunStore(db);
  const hub = createStatusHub(runStore, { publish: options.publish });
  const settings = createAutomationSettings(db, () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: null }));
  if (options.concurrency) settings.setConfiguredConcurrency(options.concurrency);
  const runner = createScriptedRunner(options.handler ?? defaultHandler);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const engine = createWorkflowEngine({
    defs,
    runStore,
    runner,
    directory: options.directory ?? directory(),
    resolveAttachment: (url) => (url === '/uploads/ok.png' ? { path: '/tmp/ok.png', mediaType: 'image/png', name: 'ok.png' } : null),
    publishEvent: (type, payload) => events.push({ type, payload }),
    settings,
    hub,
    resolveWorkspace: () => '/tmp',
    now: options.now,
  });

  function create(nodes: unknown[], edges: unknown[] = []) {
    return defs.create({ name: 'wf', workspace: null, nodes: nodes as any, edges: edges as any, viewport: null });
  }

  async function run(nodes: unknown[], edges: unknown[] = [], startOptions: Parameters<typeof engine.startRun>[1] = {}) {
    const def = create(nodes, edges);
    const started = await engine.startRun(def.id, startOptions);
    await engine.waitForRun(started.id);
    return { def, run: runStore.getRun(started.id)!, evidence: runStore.evidence(started.id) };
  }

  return { db, defs, runStore, hub, settings, runner, engine, events, create, run };
}

export function statusesByNode(evidence: { nodeExecutions: Array<{ nodeId: string; status: string }> }) {
  const out: Record<string, string[]> = {};
  for (const exec of evidence.nodeExecutions) (out[exec.nodeId] ??= []).push(exec.status);
  return out;
}

export function edgeStatuses(evidence: { edgeEvaluations: Array<{ edgeId: string; status: string }> }) {
  return evidence.edgeEvaluations.map((row) => `${row.edgeId}:${row.status}`);
}
