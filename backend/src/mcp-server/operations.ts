/**
 * MCP 桥的**操作白名单**：每个工具是这张表里显式写出来的一行，映射到一个具体的内部调用。
 *
 * 参考实现的 `api` 工具集是「用运行用户的令牌代理整个 /api」，OpenAPI 校验只查必填字段——
 * 提示注入就能改文件、管用户、换服务商。这里没有路径代理：表里没有的名字一律 403，
 * `api` 工具集只有几条只读操作；用户、服务商、文件、终端、升级这些面根本不在表里。
 *
 * 资源判定全部经 `ResourceAccess`（与数据面 ACL 同一份判据），身份是「令牌范围」：
 * 一个 member 角色的合成身份，`canAccessAgent` 只认范围里的 Agent。
 */
import type { RequestIdentity, ResourceAccess } from '../core/auth';
import { accessAgentId } from '../core/auth';
import type { MemoryHostContext, MemoryService } from '../memory';
import type { McpToolset } from './settings-store';
import type { McpTokenRecord } from './token-store';

export class McpOperationError extends Error {
  constructor(readonly status: number, readonly code: string, readonly outcome: 'denied_scope' | 'denied_operation' | 'failed' = 'failed') {
    super(code);
    this.name = 'McpOperationError';
  }
}

/** 范围外：与数据面同一个意思，不区分「不存在」与「不在范围」。 */
export const scopeDenied = () => new McpOperationError(403, 'mcpServer.outOfScope', 'denied_scope');

type ChatMessageLike = { id?: number; role: string; content: string; agent_name?: string; created_at?: string };
type GroupMessageLike = { id?: number; sender_type: string; sender_name?: string; content: string; created_at?: string };

/** 桥用到的库方法（只列这些，测试替身照这个形状给）。 */
export interface McpDbPort {
  getSessions(): Array<{ id: string; name: string; agentId: string; external_runtime?: string | null; updated_at: number }>;
  getMessagesPage(sessionKey: string, options: { beforeId?: number | null; limit?: number }): { rows: ChatMessageLike[] };
  getGroupMessagesPage(groupId: string, options: { beforeId?: number | null; limit?: number }): { rows: GroupMessageLike[] };
  getRecentGroupMessages(groupId: string, limit?: number): GroupMessageLike[];
}

export interface McpAutomationPort {
  workflowAgentIds(workflowId: string): string[] | null;
  workflows: { list(): Array<{ id: string; name: string; nodeCount?: number; updatedAt?: number }>; get(id: string): unknown };
  engine: { startRun(id: string, options: { input?: string | null; startNodeIds?: string[]; triggerSource?: 'manual' }): Promise<unknown> };
  runStore: { listRuns(workflowId: string, limit: number): Array<Record<string, unknown>>; getRun(runId: string): (Record<string, unknown> & { workflowId?: string }) | null | undefined };
  kanban: {
    listBoards(): Array<{ id: string; name: string }>;
    listTasks(boardId: string, query: Record<string, unknown>): Array<{ id: string; title: string; status: string; assignee: { kind: string; id: string } | null }>;
    getTask(id: string): { id: string; assignee: { kind: string; id: string } | null } | null | undefined;
    detail(id: string): unknown;
    comment(id: string, body: Record<string, unknown>): unknown;
    act(id: string, action: string, body: Record<string, unknown>): unknown;
  };
}

export type DelegateTurn = (input: { agentId: string; prompt: string; callerRunId: string; callerSessionKey: string }) => Promise<{ ok: boolean; output: string; error?: string }>;
/** 宿主侧的委派实现：多一个回调，在运行提交前登记委派会话键（给它签的令牌不含 chat_run）。 */
export type DelegateTurnHost = (input: Parameters<DelegateTurn>[0] & { markDelegated: (sessionKey: string) => void }) => ReturnType<DelegateTurn>;

export type OperationContext = {
  record: McpTokenRecord;
  identity: RequestIdentity;
  access: ResourceAccess;
  db: McpDbPort;
  automation: McpAutomationPort;
  memory: MemoryService;
  memoryContext: (record: McpTokenRecord, profileId: string) => MemoryHostContext;
  memberRuntimes: () => Array<{ id: string; name: string; kind: string }>;
  delegateTurn: DelegateTurn | null;
};

export type McpOperationDef = {
  name: string;
  toolset: McpToolset;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: OperationContext, args: Record<string, unknown>) => unknown | Promise<unknown>;
};

const MAX_TEXT = 4000;
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…[truncated ${text.length - MAX_TEXT} chars]` : text);

function str(args: Record<string, unknown>, key: string, options: { required?: boolean; max?: number } = {}): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new McpOperationError(400, 'mcpServer.invalidArguments');
    return undefined;
  }
  if (typeof value !== 'string' || value.length > (options.max ?? 256)) throw new McpOperationError(400, 'mcpServer.invalidArguments');
  return value;
}

function int(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = Number(args[key]);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

function requireWorkflow(ctx: OperationContext, workflowId: string): void {
  if (!ctx.access.canAccessWorkflow(ctx.identity, ctx.automation.workflowAgentIds(workflowId))) throw scopeDenied();
}

function requireTask(ctx: OperationContext, taskId: string) {
  const task = ctx.automation.kanban.getTask(taskId);
  if (!task || !ctx.access.canAccessKanbanTask(ctx.identity, task.assignee)) throw scopeDenied();
  return task;
}

/** 记忆工具：参数里带 profileId 时必须在范围里；缺省是这次运行自己的 Agent。 */
function memoryContextFor(ctx: OperationContext, args: Record<string, unknown>): { memoryContext: MemoryHostContext; rest: Record<string, unknown> } {
  const { profileId, ...rest } = args;
  const requested = profileId === undefined || profileId === null || profileId === '' ? ctx.record.scope.agentIds[0] : String(profileId);
  if (!requested || !ctx.access.canAccessAgent(ctx.identity, requested)) throw scopeDenied();
  return { memoryContext: ctx.memoryContext(ctx.record, accessAgentId(requested)), rest };
}

export const MCP_OPERATIONS: readonly McpOperationDef[] = [
  // ---- use：会话 ----
  {
    name: 'sessions_list',
    toolset: 'use',
    description: 'List ClawOPT chat sessions visible to this run (its own session and sessions of agents in scope).',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 200 } }),
    handler: (ctx, args) => {
      const limit = int(args, 'limit', 1, 200, 50);
      const sessions = ctx.db.getSessions()
        .filter((session) => ctx.access.canAccessChatSession(ctx.identity, session.id))
        .slice(0, limit)
        .map((session) => ({ id: session.id, name: session.name, agentId: session.agentId, runtime: session.external_runtime ?? 'openclaw', updatedAt: session.updated_at }));
      return { currentSessionKey: ctx.record.sessionKey, sessions };
    },
  },
  {
    name: 'session_read',
    toolset: 'use',
    description: 'Read recent messages of a session in scope (defaults to the current session).',
    inputSchema: obj({ sessionKey: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, beforeId: { type: 'integer' } }),
    handler: (ctx, args) => {
      const sessionKey = str(args, 'sessionKey') ?? ctx.record.sessionKey;
      if (!ctx.access.canAccessRunSession(ctx.identity, sessionKey)) throw scopeDenied();
      const limit = int(args, 'limit', 1, 100, 20);
      const beforeId = Number.isInteger(Number(args.beforeId)) && args.beforeId !== undefined ? Number(args.beforeId) : null;
      const room = /^room:(.+):member:[^:]+$/.exec(sessionKey);
      if (room) {
        const rows = ctx.db.getGroupMessagesPage(room[1], { beforeId, limit }).rows;
        return { sessionKey, messages: rows.map((row) => ({ id: row.id, role: row.sender_type === 'user' ? 'user' : 'assistant', sender: row.sender_name ?? null, content: clip(row.content), createdAt: row.created_at ?? null })) };
      }
      const rows = ctx.db.getMessagesPage(sessionKey, { beforeId, limit }).rows;
      return { sessionKey, messages: rows.map((row) => ({ id: row.id, role: row.role, sender: row.agent_name ?? null, content: clip(row.content), createdAt: row.created_at ?? null })) };
    },
  },
  {
    name: 'chat_run',
    toolset: 'use',
    description: 'Delegate one turn to another agent or runtime that the administrator allowed for delegation, and wait for its reply.',
    inputSchema: obj({ agentId: { type: 'string' }, prompt: { type: 'string' } }, ['agentId', 'prompt']),
    handler: async (ctx, args) => {
      const agentId = str(args, 'agentId', { required: true })!;
      const prompt = str(args, 'prompt', { required: true, max: 20_000 })!;
      const target = accessAgentId(agentId);
      if (!ctx.record.scope.delegateAgents.map(accessAgentId).includes(target)) throw scopeDenied();
      if (target === ctx.record.scope.agentIds[0]) throw scopeDenied();
      if (!ctx.delegateTurn) throw new McpOperationError(409, 'mcpServer.operationDisabled');
      const result = await ctx.delegateTurn({ agentId, prompt, callerRunId: ctx.record.runId, callerSessionKey: ctx.record.sessionKey });
      return { ok: result.ok, output: clip(result.output ?? ''), error: result.error ?? null };
    },
  },
  // ---- use：工作流 ----
  {
    name: 'workflows_list',
    toolset: 'use',
    description: 'List workflows whose every node agent is in scope.',
    inputSchema: obj({}),
    handler: (ctx) => ({
      workflows: ctx.automation.workflows.list()
        .filter((workflow) => ctx.access.canAccessWorkflow(ctx.identity, ctx.automation.workflowAgentIds(workflow.id)))
        .map((workflow) => ({ id: workflow.id, name: workflow.name, nodeCount: workflow.nodeCount ?? null, updatedAt: workflow.updatedAt ?? null })),
    }),
  },
  {
    name: 'workflow_run',
    toolset: 'use',
    description: 'Start a run of a workflow in scope. A workflow cannot start itself from one of its own nodes.',
    inputSchema: obj({ workflowId: { type: 'string' }, input: { type: 'string' } }, ['workflowId']),
    handler: async (ctx, args) => {
      const workflowId = str(args, 'workflowId', { required: true })!;
      requireWorkflow(ctx, workflowId);
      // 节点里再启动自己所在的工作流 = 无界递归。
      if (ctx.record.scope.workflowIds.includes(workflowId)) throw scopeDenied();
      const run = await ctx.automation.engine.startRun(workflowId, { input: str(args, 'input', { max: 20_000 }) ?? null, startNodeIds: [], triggerSource: 'manual' });
      return { run };
    },
  },
  {
    name: 'workflow_status',
    toolset: 'use',
    description: 'Show recent runs of a workflow in scope, or one run by id.',
    inputSchema: obj({ workflowId: { type: 'string' }, runId: { type: 'string' } }, ['workflowId']),
    handler: (ctx, args) => {
      const workflowId = str(args, 'workflowId', { required: true })!;
      requireWorkflow(ctx, workflowId);
      const strip = ({ snapshotNodes: _n, snapshotEdges: _e, ...run }: Record<string, unknown>) => run;
      const runId = str(args, 'runId');
      if (runId) {
        const run = ctx.automation.runStore.getRun(runId);
        if (!run || run.workflowId !== workflowId) throw scopeDenied();
        return { run: strip(run) };
      }
      return { runs: ctx.automation.runStore.listRuns(workflowId, 5).map(strip) };
    },
  },
  // ---- use：看板 ----
  {
    name: 'kanban_tasks_list',
    toolset: 'use',
    description: 'List kanban tasks assigned to agents in scope.',
    inputSchema: obj({ boardId: { type: 'string' } }),
    handler: (ctx, args) => {
      const boardId = str(args, 'boardId');
      const boards = boardId ? ctx.automation.kanban.listBoards().filter((board) => board.id === boardId) : ctx.automation.kanban.listBoards();
      return {
        tasks: boards.flatMap((board) => ctx.automation.kanban.listTasks(board.id, {})
          .filter((task) => ctx.access.canAccessKanbanTask(ctx.identity, task.assignee))
          .map((task) => ({ id: task.id, boardId: board.id, title: task.title, status: task.status, assignee: task.assignee }))),
      };
    },
  },
  {
    name: 'kanban_task_get',
    toolset: 'use',
    description: 'Read a kanban task (with comments and events) assigned to an agent in scope.',
    inputSchema: obj({ taskId: { type: 'string' } }, ['taskId']),
    handler: (ctx, args) => {
      const taskId = str(args, 'taskId', { required: true })!;
      requireTask(ctx, taskId);
      return ctx.automation.kanban.detail(taskId);
    },
  },
  {
    name: 'kanban_task_comment',
    toolset: 'use',
    description: 'Comment on a kanban task in scope. The comment is signed as this agent.',
    inputSchema: obj({ taskId: { type: 'string' }, body: { type: 'string' } }, ['taskId', 'body']),
    handler: (ctx, args) => {
      const taskId = str(args, 'taskId', { required: true })!;
      requireTask(ctx, taskId);
      // 署名只能是这次运行的 Agent，不收参数里的 author。
      return { comment: ctx.automation.kanban.comment(taskId, { body: str(args, 'body', { required: true, max: 20_000 }), author: `agent:${ctx.record.agentId}` }) };
    },
  },
  {
    name: 'kanban_task_complete',
    toolset: 'use',
    description: 'Mark a kanban task in scope as done, with an optional summary.',
    inputSchema: obj({ taskId: { type: 'string' }, summary: { type: 'string' } }, ['taskId']),
    handler: (ctx, args) => {
      const taskId = str(args, 'taskId', { required: true })!;
      requireTask(ctx, taskId);
      return { task: ctx.automation.kanban.act(taskId, 'complete', { summary: str(args, 'summary', { max: 20_000 }) }) };
    },
  },
  {
    name: 'kanban_task_block',
    toolset: 'use',
    description: 'Mark a kanban task in scope as blocked, with a reason.',
    inputSchema: obj({ taskId: { type: 'string' }, reason: { type: 'string' } }, ['taskId']),
    handler: (ctx, args) => {
      const taskId = str(args, 'taskId', { required: true })!;
      requireTask(ctx, taskId);
      return { task: ctx.automation.kanban.act(taskId, 'block', { reason: str(args, 'reason', { max: 20_000 }) }) };
    },
  },
  // ---- memory ----
  {
    name: 'memory_search',
    toolset: 'memory',
    description: 'Search durable memory cards visible to this agent (profile, current room or session). Use all:true to list everything.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, domain: { type: 'string' }, categoryPrefix: { type: 'string' }, types: { type: 'array', items: { type: 'string' } }, kinds: { type: 'array', items: { type: 'string' } }, key: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, entities: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: 50 }, all: { type: 'boolean' } } },
    handler: (ctx, args) => {
      const { memoryContext, rest } = memoryContextFor(ctx, args);
      return ctx.memory.search(memoryContext, rest);
    },
  },
  {
    name: 'memory_get',
    toolset: 'memory',
    description: 'Get one memory card by id.',
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    handler: async (ctx, args) => {
      const { memoryContext } = memoryContextFor(ctx, args);
      const card = await ctx.memory.get(memoryContext, { id: str(args, 'id', { required: true })! });
      return { card };
    },
  },
  {
    name: 'memory_write',
    toolset: 'memory',
    description: 'Create, update, expire or delete memory cards in one atomic batch. The server generates canonical keys; updates need expectedRevision.',
    inputSchema: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object' } } }, required: ['operations'] },
    handler: (ctx, args) => {
      const { memoryContext } = memoryContextFor(ctx, args);
      if (!Array.isArray(args.operations)) throw new McpOperationError(400, 'mcpServer.invalidArguments');
      return ctx.memory.write(memoryContext, { operations: args.operations as never });
    },
  },
  {
    name: 'memory_forget',
    toolset: 'memory',
    description: 'Forget memory cards (requires the user to have asked to forget). Selectors: all, targets, id+revision, or filter.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' }, targets: { type: 'array', items: { type: 'object' } }, id: { type: 'string' }, revision: { type: 'integer' }, filter: { type: 'object' } } },
    handler: (ctx, args) => {
      const { memoryContext, rest } = memoryContextFor(ctx, args);
      return ctx.memory.forget(memoryContext, rest);
    },
  },
  // ---- api：精选只读 ----
  {
    name: 'api_member_runtimes',
    toolset: 'api',
    description: 'Read-only: list the external agent runtimes registered in ClawOPT.',
    inputSchema: obj({}),
    handler: (ctx) => ({ runtimes: ctx.memberRuntimes() }),
  },
  {
    name: 'api_workflow_get',
    toolset: 'api',
    description: 'Read-only: get a workflow definition in scope.',
    inputSchema: obj({ workflowId: { type: 'string' } }, ['workflowId']),
    handler: (ctx, args) => {
      const workflowId = str(args, 'workflowId', { required: true })!;
      requireWorkflow(ctx, workflowId);
      return { workflow: ctx.automation.workflows.get(workflowId) };
    },
  },
  {
    name: 'api_kanban_boards',
    toolset: 'api',
    description: 'Read-only: list kanban boards.',
    inputSchema: obj({}),
    handler: (ctx) => ({ boards: ctx.automation.kanban.listBoards().map((board) => ({ id: board.id, name: board.name })) }),
  },
  {
    name: 'api_scope',
    toolset: 'api',
    description: 'Read-only: describe what this run is allowed to reach (agents, session, room, workflow, delegation targets, operations).',
    inputSchema: obj({}),
    handler: (ctx) => ({
      agentIds: ctx.record.scope.agentIds,
      sessionKey: ctx.record.sessionKey,
      roomId: ctx.record.scope.roomId,
      workflowIds: ctx.record.scope.workflowIds,
      delegateAgents: ctx.record.scope.delegateAgents,
      operations: ctx.record.operations,
      expiresAt: ctx.record.expiresAt,
    }),
  },
];

export const MCP_OPERATION_BY_NAME: ReadonlyMap<string, McpOperationDef> = new Map(MCP_OPERATIONS.map((operation) => [operation.name, operation]));

export function operationsForToolsets(toolsets: readonly McpToolset[]): string[] {
  return MCP_OPERATIONS.filter((operation) => toolsets.includes(operation.toolset)).map((operation) => operation.name);
}
