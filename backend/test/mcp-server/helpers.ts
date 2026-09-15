/**
 * MCP 服务用例的替身：内存 SQLite（真令牌表）、真事件总线，库 / 自动化 / 记忆服务按端口形状给假的。
 *
 * 世界：
 * - 会话 `s-mine`（Agent `alpha`）、`s-other`（Agent `beta`）、外部运行时单聊 `s-ext`（claude-code）；
 * - 群 `g1`（alpha + beta），协调器会话键 `room:g1:member:m1`；
 * - 工作流 `wf-alpha`（节点全是 alpha）、`wf-beta`（节点有 beta）；
 * - 看板任务 `t-alpha`（负责人 alpha）、`t-beta`（负责人 beta）。
 */
import Database from 'better-sqlite3';

import { EventBus } from '../../src/core/events';
import { createMcpServerService, type McpServerServiceDeps } from '../../src/mcp-server';
import type { McpRunContext } from '../../src/runtime';

export type Clock = { now: number };

export function createWorld(overrides: Partial<McpServerServiceDeps> = {}, clock: Clock = { now: 1_000_000 }) {
  const sqlite = new Database(':memory:');
  const events = new EventBus();
  const sessions = [
    { id: 's-mine', name: 'Mine', agentId: 'alpha', external_runtime: null, updated_at: 1 },
    { id: 's-other', name: 'Other', agentId: 'beta', external_runtime: null, updated_at: 2 },
    { id: 's-ext', name: 'Claude', agentId: 'claude-code', external_runtime: 'claude-code', updated_at: 3 },
  ];
  const chat: Record<string, Array<{ id: number; role: string; content: string }>> = {
    's-mine': [{ id: 1, role: 'user', content: 'remember that I prefer tea' }, { id: 2, role: 'assistant', content: 'ok' }],
    's-other': [{ id: 3, role: 'user', content: 'secret of beta' }],
  };
  const groupMessages = [{ id: 10, group_id: 'g1', sender_type: 'user', content: 'team uses pnpm, remember it' }, { id: 11, group_id: 'g1', sender_type: 'agent', content: 'noted' }];
  const kanbanTasks = [
    { id: 't-alpha', title: 'A', status: 'todo', assignee: { kind: 'openclaw', id: 'alpha' } },
    { id: 't-beta', title: 'B', status: 'todo', assignee: { kind: 'openclaw', id: 'beta' } },
  ];
  const calls = {
    comments: [] as Array<{ id: string; body: Record<string, unknown> }>,
    acts: [] as Array<{ id: string; action: string }>,
    starts: [] as string[],
    memory: [] as Array<{ method: string; ctx: any; input: any }>,
  };
  const db = {
    connection: () => sqlite,
    getSessions: () => sessions,
    getMessagesPage: (key: string) => ({ rows: chat[key] ?? [] }),
    getGroupMessagesPage: (groupId: string) => ({ rows: groupMessages.filter((row) => row.group_id === groupId) }),
    getRecentGroupMessages: (groupId: string) => groupMessages.filter((row) => row.group_id === groupId),
  };
  const resourceLookup = {
    chatSessionAgentId: (id: string) => {
      const session = sessions.find((entry) => entry.id === id);
      return session ? (session.external_runtime ? `ext:${session.external_runtime}` : session.agentId) : null;
    },
    roomAgentIds: (id: string) => (id === 'g1' ? ['alpha', 'beta'] : null),
    runSessionAgentId: (key: string) => (key.startsWith('workflow:alpha') ? 'alpha' : key.startsWith('workflow:beta') ? 'beta' : null),
    uploadSessionKey: () => null,
  };
  const workflows = [{ id: 'wf-alpha', name: 'Alpha flow', agents: ['alpha'] }, { id: 'wf-beta', name: 'Beta flow', agents: ['alpha', 'beta'] }];
  const automation = {
    workflowAgentIds: (id: string) => workflows.find((workflow) => workflow.id === id)?.agents ?? null,
    workflows: { list: () => workflows.map(({ id, name }) => ({ id, name })), get: (id: string) => workflows.find((workflow) => workflow.id === id) },
    engine: { startRun: async (id: string) => { calls.starts.push(id); return { id: `run-${id}`, status: 'running' }; } },
    runStore: { listRuns: (id: string) => [{ id: `run-${id}`, workflowId: id, snapshotNodes: [], snapshotEdges: [] }], getRun: (runId: string) => ({ id: runId, workflowId: runId.replace(/^run-/, '') }) },
    kanban: {
      listBoards: () => [{ id: 'default', name: 'Default' }],
      listTasks: () => kanbanTasks,
      getTask: (id: string) => kanbanTasks.find((task) => task.id === id) ?? null,
      detail: (id: string) => ({ task: kanbanTasks.find((task) => task.id === id), comments: [] }),
      comment: (id: string, body: Record<string, unknown>) => { calls.comments.push({ id, body }); return { id: 'c1', ...body }; },
      act: (id: string, action: string) => { calls.acts.push({ id, action }); return { id, status: action }; },
    },
  };
  const memory = {
    search: async (ctx: any, input: any) => { calls.memory.push({ method: 'search', ctx, input }); return { exact: [], relevant: [], omitted: [] }; },
    get: async (ctx: any, input: any) => { calls.memory.push({ method: 'get', ctx, input }); return null; },
    write: async (ctx: any, input: any) => { calls.memory.push({ method: 'write', ctx, input }); return { done: true, results: [], note: 'saved' }; },
    forget: async (ctx: any, input: any) => { calls.memory.push({ method: 'forget', ctx, input }); return { done: true, deleted: 0 }; },
  };
  const runtimePlatform = { registry: { list: () => [{ descriptor: { id: 'claude-code', name: 'Claude Code' } }, { descriptor: { id: 'codex', name: 'Codex' } }] } };
  const service = createMcpServerService({
    db: db as any,
    resourceLookup,
    runCoordinator: {} as any,
    automation: automation as any,
    memory: memory as any,
    events,
    runtimePlatform: runtimePlatform as any,
    publicBaseUrl: () => 'http://127.0.0.1:3999',
    now: () => clock.now,
    nodePath: '/usr/bin/node',
    binPath: '/opt/clawopt/backend/bin/clawopt-mcp',
    ...overrides,
  });
  return { service, sqlite, events, calls, clock, kanbanTasks };
}

export const singleChatRun = (over: Partial<McpRunContext> = {}): McpRunContext => ({ runId: 'run-1', sessionKey: 's-mine', agentId: 'alpha', runtime: 'claude-code', owner: { kind: 'session', sessionId: 's-mine' }, ...over });

/** 开启运行时、签发令牌，返回令牌与带它的调用函数。 */
export function issue(world: ReturnType<typeof createWorld>, run: McpRunContext = singleChatRun(), settings: { toolsets?: string[]; delegateAgents?: string[] } = {}) {
  world.service.saveRuntime(run.runtime, { enabled: true, toolsets: settings.toolsets ?? ['use', 'memory', 'api'], delegateAgents: settings.delegateAgents ?? [] });
  const [server] = world.service.managedServersFor(run.runtime, run);
  const token = server.env!.CLAWOPT_MCP_TOKEN;
  const call = (operation: string, args: Record<string, unknown> = {}, remoteAddress = '127.0.0.1') =>
    world.service.call({ remoteAddress, authorization: `Bearer ${token}` }, operation, args);
  return { token, server, call };
}
