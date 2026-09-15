/**
 * 自动化 HTTP 接口按「用户 ↔ Agent」授权：真组装的应用、登录开启、库里真用户、确定性假 Runner。
 *
 * 场景：member 被授权 `main` 与外部运行时伪 Agent `ext:codex`，外加一个带后缀的 `ext:claude-code:workflow`——
 * 用来证明外部运行时只按归一形状 `ext:<运行时>` 授权，带后缀的 id 写进清单也不授权 Claude Code。
 * - 工作流 wf-main（main 节点）/ wf-other（other 节点）/ wf-external（Claude Code 节点）/ wf-codex（Codex 节点）；
 * - 看板任务 t-main（main）/ t-other（other）/ t-ext（Claude Code 负责）/ t-codex（Codex 负责）/ t-none（无负责人）。
 *
 * 矩阵（admin 及以上全部可做）：
 * - 工作流：列表过滤；读 / 导出 / 运行 / 停止 / 重跑 / 审批 / 证据与转录 / 定时与钩子的读按工作流判（403 auth.agentForbidden）；
 *   建改删工作流、批量删、导入、改运行设置、删运行、定时与钩子的建改删与轮换密钥是管理员的（403 auth.forbidden）；
 * - 看板：任务列表与看板计数过滤；详情 / 评论 / complete / block / dispatch 按负责 Agent 判；看板管理、建改任务、批量、链接、其余动作是管理员的；
 * - 出站 Webhook：事件类型清单登录可读，其余整组管理员。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/bootstrap';
import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { createStubContext } from './helpers/stub-context';
import { DEFAULT_BOARD_ID } from '../src/automation/kanban/kanban-store';
import { startAppHarness, waitUntil, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
const previousFakeRunner = process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER;
const wf = { main: '', other: '', external: '', codex: '' };
const task = { main: '', mainReady: '', other: '', ext: '', codex: '', none: '' };
const tokens: Record<'owner' | 'admin' | 'member', string> = { owner: '', admin: '', member: '' };
/** 实时中枢上发出的主题（这个套件不挂 WS，没有任何订阅者）。 */
const realtimeTopics: string[] = [];

beforeAll(async () => {
  process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER = '1';
  // 管理员闸门拒绝时 Express 错误处理会打一整段栈：这里的拒绝都是预期内的。
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h = await startAppHarness();
  const { ctx } = h;
  ctx.realtime.listen('test:topics', (event: { topic: string }) => realtimeTopics.push(event.topic));
  const owner = ctx.userStore.create({ username: 'owner', password: 'owner-pass-1234', role: 'super_admin' });
  const admin = ctx.userStore.create({ username: 'admin2', password: 'admin-pass-1234', role: 'admin' });
  const member = ctx.userStore.create({ username: 'member', password: 'member-pass-1234', role: 'member' });
  ctx.userStore.update(member.id, { agentIds: ['main', 'ext:codex', 'ext:claude-code:workflow'] });
  tokens.owner = ctx.authStore.issue('web', owner.id).token;
  tokens.admin = ctx.authStore.issue('web', admin.id).token;
  tokens.member = ctx.authStore.issue('web', member.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });

  ctx.sessionManager.createSession({ id: 's-main', name: 'Main', agentId: 'main' });
  ctx.sessionManager.createSession({ id: 's-other', name: 'Other', agentId: 'other' });

  const node = (agent: Record<string, string>) => ({
    id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'N1', agent, input: '[fake:output done]', approvalRequired: true },
  });
  const createWorkflow = (name: string, agent: Record<string, string>) => ctx.automation.workflows.create({ name, nodes: [node(agent)], edges: [] }).id;
  wf.main = createWorkflow('wf-main', { kind: 'openclaw', id: 'main' });
  wf.other = createWorkflow('wf-other', { kind: 'openclaw', id: 'other' });
  wf.external = createWorkflow('wf-external', { kind: 'external', id: 'claude-code', runtime: 'claude-code' });
  wf.codex = createWorkflow('wf-codex', { kind: 'external', id: 'codex', runtime: 'codex' });

  const createTask = (title: string, assignee: Record<string, string> | null, status = 'ready') =>
    ctx.automation.kanban.createTask(DEFAULT_BOARD_ID, { title, assignee, status }).id;
  task.main = createTask('t-main', { kind: 'openclaw', id: 'main' });
  task.mainReady = createTask('t-main-dispatch', { kind: 'openclaw', id: 'main' });
  task.other = createTask('t-other', { kind: 'openclaw', id: 'other' });
  task.ext = createTask('t-ext', { kind: 'external', id: 'claude-code' });
  task.codex = createTask('t-codex', { kind: 'external', id: 'codex' });
  task.none = createTask('t-none', null);
});

afterAll(async () => {
  await h?.close();
  if (previousFakeRunner === undefined) delete process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER;
  else process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER = previousFakeRunner;
});

type Call = [method: string, path: string, body?: unknown];

async function call(token: string, [method, path, body]: Call): Promise<{ code: number; body: any }> {
  const response = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  return { code: response.status, body: json };
}

/** 逐条打，回「方法 路径 → 状态 messageCode」，失败时一眼看出是哪一条。 */
async function verdicts(token: string, calls: Call[]): Promise<string[]> {
  const out: string[] = [];
  for (const item of calls) {
    const { code, body } = await call(token, item);
    out.push(`${item[0]} ${item[1]} → ${code} ${body?.messageCode ?? body?.errorCode ?? ''}`.trim());
  }
  return out;
}
const expectAll = (calls: Call[], code: number, messageCode: string) => calls.map(([method, path]) => `${method} ${path} → ${code} ${messageCode}`);

describe('工作流', () => {
  const readAndRun = (id: string): Call[] => [
    ['GET', `/api/workflows/${id}`],
    ['GET', `/api/workflows/${id}/export`],
    ['POST', `/api/workflows/${id}/run`, {}],
    ['GET', `/api/workflows/${id}/runs`],
    ['GET', `/api/workflows/${id}/runs/r1`],
    ['GET', `/api/workflows/${id}/runs/r1/transcript?executionId=e1`],
    ['POST', `/api/workflows/${id}/runs/r1/stop`],
    ['POST', `/api/workflows/${id}/runs/r1/nodes/n1/approval`, { approved: true }],
    ['POST', `/api/workflows/${id}/runs/r1/rerun-from-node`, { node_id: 'n1' }],
    ['GET', `/api/workflows/${id}/schedules`],
    ['GET', `/api/workflows/${id}/schedules/sc1/events`],
    ['GET', `/api/workflows/${id}/hooks`],
  ];
  const adminOnly = (id: string): Call[] => [
    ['POST', '/api/workflows', { name: 'member-made', nodes: [], edges: [] }],
    ['POST', '/api/workflows/batch-delete', { ids: [id] }],
    ['POST', '/api/workflows/import/preview', { document: '{}' }],
    ['POST', '/api/workflows/import/confirm', { token: 'x' }],
    ['POST', '/api/workflows/import/cancel', { token: 'x' }],
    ['PUT', '/api/workflows/settings', { max_concurrent_nodes: 1 }],
    ['PATCH', `/api/workflows/${id}`, { name: 'renamed' }],
    ['DELETE', `/api/workflows/${id}`],
    ['DELETE', `/api/workflows/${id}/runs/r1`],
    ['POST', `/api/workflows/${id}/schedules`, { cron: '0 * * * *' }],
    ['PATCH', `/api/workflows/${id}/schedules/sc1`, { enabled: false }],
    ['DELETE', `/api/workflows/${id}/schedules/sc1`],
    ['POST', `/api/workflows/${id}/hooks`, { name: 'h' }],
    ['PATCH', `/api/workflows/${id}/hooks/hk1`, { enabled: false }],
    ['POST', `/api/workflows/${id}/hooks/hk1/rotate-secret`],
    ['DELETE', `/api/workflows/${id}/hooks/hk1`],
  ];

  it('列表与节点名册：member 只见全部节点都授权的工作流、只列自己的 Agent（外部运行时按 ext:<运行时>）；admin 全部', async () => {
    const member = await call(tokens.member, ['GET', '/api/workflows']);
    expect(member.body.workflows.map((item: any) => item.id).sort()).toEqual([wf.main, wf.codex].sort());
    const admin = await call(tokens.admin, ['GET', '/api/workflows']);
    expect(admin.body.workflows.map((item: any) => item.id).sort()).toEqual([wf.main, wf.other, wf.external, wf.codex].sort());

    const memberAgents = await call(tokens.member, ['GET', '/api/workflows/agents']);
    expect(memberAgents.body.agents.map((entry: any) => `${entry.ref.kind}:${entry.ref.id}`)).toEqual(['openclaw:main', 'external:codex']);
    const adminAgents = await call(tokens.admin, ['GET', '/api/workflows/agents']);
    expect(adminAgents.body.agents.map((entry: any) => `${entry.ref.kind}:${entry.ref.id}`)).toEqual(expect.arrayContaining(['openclaw:main', 'openclaw:other', 'external:claude-code']));
  });

  it('member 读 / 运行 / 审批含未授权 Agent 或未授权外部运行时节点的工作流一律 403 auth.agentForbidden，不留运行行', async () => {
    for (const id of [wf.other, wf.external, 'missing']) {
      const calls = readAndRun(id);
      expect(await verdicts(tokens.member, calls)).toEqual(expectAll(calls, 403, 'auth.agentForbidden'));
    }
    expect(h.ctx.automation.runStore.listRuns(wf.other, 10)).toEqual([]);
    expect(h.ctx.automation.runStore.listRuns(wf.external, 10)).toEqual([]);
  });

  it('建改删 / 导入 / 设置 / 删运行 / 定时与钩子的写：member 一律 403 auth.forbidden（自己的工作流也不行）', async () => {
    const calls = adminOnly(wf.main);
    expect(await verdicts(tokens.member, calls)).toEqual(expectAll(calls, 403, 'auth.forbidden'));
    expect(h.ctx.automation.workflows.get(wf.main).name).toBe('wf-main');
    expect(h.ctx.automation.workflows.list()).toHaveLength(4);
  });

  it('member 对授权外部运行时节点的工作流可读（节点按 ext:<运行时> 算授权）', async () => {
    expect((await call(tokens.member, ['GET', `/api/workflows/${wf.codex}`])).code).toBe(200);
    expect((await call(tokens.member, ['GET', `/api/workflows/${wf.codex}/runs`])).code).toBe(200);
  });

  it('member 对自己的工作流：读、运行、审批、看证据照常', async () => {
    expect((await call(tokens.member, ['GET', `/api/workflows/${wf.main}`])).code).toBe(200);
    expect((await call(tokens.member, ['GET', `/api/workflows/${wf.main}/export`])).code).toBe(200);
    expect((await call(tokens.member, ['GET', `/api/workflows/${wf.main}/schedules`])).code).toBe(200);
    expect((await call(tokens.member, ['GET', `/api/workflows/${wf.main}/hooks`])).code).toBe(200);
    const started = await call(tokens.member, ['POST', `/api/workflows/${wf.main}/run`, {}]);
    expect(started.code).toBe(202);
    const runId = started.body.run.id;
    await waitUntil(() => h.ctx.automation.engine.pendingApprovals().some((item: any) => item.runId === runId));
    const [pending] = h.ctx.automation.engine.pendingApprovals().filter((item: any) => item.runId === runId);
    const approved = await call(tokens.member, ['POST', `/api/workflows/${wf.main}/runs/${runId}/nodes/${pending.nodeId}/approval`, { approved: true, executionId: pending.executionId }]);
    expect(approved.code).toBe(200);
    await h.ctx.automation.engine.waitForRun(runId);
    // 装配接线：没有 WS 订阅者时状态广播不计算、不发 workflow:<id>（待审批提醒照发）。
    expect(realtimeTopics.filter((topic) => topic.startsWith('workflow:'))).toEqual([]);
    expect(realtimeTopics).toContain('approvals:workflows');
    expect((await call(tokens.member, ['GET', `/api/workflows/${wf.main}/runs/${runId}`])).code).toBe(200);
    // 删运行是管理员的
    expect((await call(tokens.member, ['DELETE', `/api/workflows/${wf.main}/runs/${runId}`])).code).toBe(403);
    expect((await call(tokens.admin, ['DELETE', `/api/workflows/${wf.main}/runs/${runId}`])).code).toBe(200);
  });

  it('admin 不受影响：读别人的工作流 200，不存在的工作流 404', async () => {
    expect((await call(tokens.admin, ['GET', `/api/workflows/${wf.other}`])).code).toBe(200);
    expect((await call(tokens.admin, ['GET', `/api/workflows/${wf.external}/runs`])).code).toBe(200);
    expect((await call(tokens.admin, ['GET', '/api/workflows/missing'])).code).toBe(404);
    const patched = await call(tokens.owner, ['PATCH', `/api/workflows/${wf.other}`, { name: 'wf-other' }]);
    expect(patched.code).toBe(200);
  });
});

describe('看板', () => {
  it('任务列表与看板计数：member 只见负责 Agent 授权给自己的任务（无负责人 / 未授权外部运行时负责人不见）', async () => {
    const tasks = await call(tokens.member, ['GET', `/api/kanban/boards/${DEFAULT_BOARD_ID}/tasks`]);
    expect(tasks.body.tasks.map((item: any) => item.title).sort()).toEqual(['t-codex', 't-main', 't-main-dispatch']);
    const boards = await call(tokens.member, ['GET', '/api/kanban/boards']);
    expect(boards.body.boards.find((board: any) => board.id === DEFAULT_BOARD_ID)).toMatchObject({ total: 3, counts: { ready: 3 } });
    expect((await call(tokens.member, ['GET', `/api/kanban/tasks/${task.codex}`])).code).toBe(200);

    const adminTasks = await call(tokens.admin, ['GET', `/api/kanban/boards/${DEFAULT_BOARD_ID}/tasks`]);
    expect(adminTasks.body.tasks).toHaveLength(6);
    const adminBoards = await call(tokens.admin, ['GET', '/api/kanban/boards']);
    expect(adminBoards.body.boards.find((board: any) => board.id === DEFAULT_BOARD_ID).total).toBe(6);
  });

  it('member 对别人的任务：详情 / 评论 / 动作一律 403 auth.agentForbidden，任务不变', async () => {
    for (const id of [task.other, task.ext, task.none, 'missing']) {
      const calls: Call[] = [
        ['GET', `/api/kanban/tasks/${id}`],
        ['POST', `/api/kanban/tasks/${id}/comments`, { body: 'hi' }],
        ['POST', `/api/kanban/tasks/${id}/actions`, { action: 'complete' }],
        ['POST', `/api/kanban/tasks/${id}/actions`, { action: 'block', reason: 'x' }],
        ['POST', `/api/kanban/tasks/${id}/actions`, { action: 'dispatch' }],
      ];
      expect(await verdicts(tokens.member, calls)).toEqual(expectAll(calls, 403, 'auth.agentForbidden'));
    }
    expect(h.ctx.automation.kanban.getTask(task.other).status).toBe('ready');
    expect(h.ctx.automation.kanban.detail(task.other).comments).toEqual([]);
  });

  it('看板管理、建改任务、批量、链接、其余动作：member 一律 403 auth.forbidden（自己的任务也不行）', async () => {
    const calls: Call[] = [
      ['POST', '/api/kanban/boards', { name: 'member board' }],
      ['PATCH', `/api/kanban/boards/${DEFAULT_BOARD_ID}`, { name: 'renamed' }],
      ['POST', `/api/kanban/boards/${DEFAULT_BOARD_ID}/tasks`, { title: 'new', assignee: { kind: 'openclaw', id: 'main' } }],
      ['PATCH', `/api/kanban/tasks/${task.main}`, { assignee: { kind: 'openclaw', id: 'other' } }],
      ['POST', '/api/kanban/tasks/bulk', { ids: [task.main], archive: true }],
      ['POST', '/api/kanban/links', { parent_id: task.main, child_id: task.mainReady }],
      ['DELETE', '/api/kanban/links', { parent_id: task.main, child_id: task.mainReady }],
      ['POST', `/api/kanban/tasks/${task.main}/actions`, { action: 'move', status: 'todo' }],
      ['POST', `/api/kanban/tasks/${task.main}/actions`, { action: 'archive' }],
      ['POST', `/api/kanban/tasks/${task.main}/actions`, { action: 'reclaim' }],
      ['POST', `/api/kanban/tasks/${task.main}/actions`, { action: 'unblock' }],
    ];
    expect(await verdicts(tokens.member, calls)).toEqual(expectAll(calls, 403, 'auth.forbidden'));
    expect(h.ctx.automation.kanban.getTask(task.main)).toMatchObject({ status: 'ready', assignee: { id: 'main' } });
    expect(h.ctx.automation.kanban.listBoards()).toHaveLength(1);
  });

  it('member 对自己的任务：看详情、评论（署自己的名）、阻塞、完成、派活', async () => {
    expect((await call(tokens.member, ['GET', `/api/kanban/tasks/${task.main}`])).code).toBe(200);
    const comment = await call(tokens.member, ['POST', `/api/kanban/tasks/${task.main}/comments`, { body: 'on it', author: 'admin2' }]);
    expect(comment.code).toBe(201);
    expect(comment.body.comment.author).toBe('member');
    expect((await call(tokens.member, ['POST', `/api/kanban/tasks/${task.main}/actions`, { action: 'block', reason: 'waiting' }])).body.task.status).toBe('blocked');
    expect((await call(tokens.member, ['POST', `/api/kanban/tasks/${task.main}/actions`, { action: 'complete', summary: 'ok' }])).body.task.status).toBe('done');
    const dispatched = await call(tokens.member, ['POST', `/api/kanban/tasks/${task.mainReady}/actions`, { action: 'dispatch' }]);
    expect(dispatched.code).toBe(200);
    await h.ctx.automation.kanban.waitForDispatch(task.mainReady);

    // admin 可以对任意任务做任意动作
    expect((await call(tokens.admin, ['POST', `/api/kanban/tasks/${task.other}/actions`, { action: 'move', status: 'todo' }])).code).toBe(200);
    expect((await call(tokens.admin, ['GET', '/api/kanban/tasks/missing'])).code).toBe(404);
  });
});

describe('出站 Webhook', () => {
  const calls: Call[] = [
    ['GET', '/api/webhooks/endpoints'],
    ['POST', '/api/webhooks/endpoints', { url: 'https://example.com/hook', events: ['workflow.run.completed'] }],
    ['PATCH', '/api/webhooks/endpoints/ep1', { enabled: false }],
    ['DELETE', '/api/webhooks/endpoints/ep1'],
    ['POST', '/api/webhooks/endpoints/ep1/test'],
    ['GET', '/api/webhooks/endpoints/ep1/deliveries'],
    ['GET', '/api/webhooks/local-test-target'],
    ['GET', '/api/webhooks/local-test-events'],
    ['DELETE', '/api/webhooks/local-test-events'],
  ];

  it('member：除事件类型清单外一律 403 auth.forbidden；admin 照常', async () => {
    expect(await verdicts(tokens.member, calls)).toEqual(expectAll(calls, 403, 'auth.forbidden'));
    expect((await call(tokens.member, ['GET', '/api/webhooks/event-types'])).code).toBe(200);
    expect((await call(tokens.admin, ['GET', '/api/webhooks/endpoints'])).code).toBe(200);
    expect((await call(tokens.admin, ['GET', '/api/webhooks/local-test-events'])).code).toBe(200);
  });
});

describe('登记表：自动化的写路由要么是管理员闸门，要么在「按资源判」清单里', () => {
  /** member 可写、由处理器内按资源判的路由。改这份清单 = 改授权面，上面的矩阵要跟着加行。 */
  const MEMBER_RESOURCE_SCOPED = new Set([
    'POST /api/workflows/:id/run',
    'POST /api/workflows/:id/runs/:runId/stop',
    'POST /api/workflows/:id/runs/:runId/nodes/:nodeId/approval',
    'POST /api/workflows/:id/runs/:runId/rerun-from-node',
    'POST /api/kanban/tasks/:taskId/actions',
    'POST /api/kanban/tasks/:taskId/comments',
  ]);

  it('新增自动化写路由忘了挂闸门会红', () => {
    const records = buildApp(createStubContext()).routes.list();
    const mutations = records.filter((record) => record.kind === 'route' && record.module === 'automation' && record.method !== 'get' && !record.public);
    expect(mutations.length).toBeGreaterThan(30);
    const unguarded = mutations
      .map((record) => `${record.method.toUpperCase()} ${record.path}`)
      .filter((label, index) => !mutations[index].adminOnly && !MEMBER_RESOURCE_SCOPED.has(label));
    expect(unguarded).toEqual([]);
  });
});
