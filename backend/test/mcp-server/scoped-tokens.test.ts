/**
 * ClawOPT 作为 MCP 服务：每次运行的范围令牌（P6 退出条件「MCP 令牌越权调用被拒」）。
 *
 * 守卫（每条都证过红，记录在 P6 报告）：
 * - 范围外的会话 / 工作流 / 看板任务 / 记忆 profile 一律 403（把范围判定换成 `() => true` 会红）；
 * - 过期令牌 401（去掉过期判定会红）；
 * - 运行结束（chat.run.completed）令牌吊销（去掉订阅会红）；
 * - 令牌白名单外的操作 403，含委派出来的运行没有 chat_run（去掉白名单判定 / 深度判定会红）；
 * - 表里没有的名字（像路径一样的操作）403：没有通用代理；
 * - 只收本机回环；
 * - 没开的运行时、没有运行上下文不签发。
 */
import { describe, expect, it } from 'vitest';

import { CLAWOPT_MANAGED_MCP_ENV, isManagedMcpServer } from '../../src/runtime';
import { MCP_TOKEN_DEFAULT_TTL_MS, hashMcpToken } from '../../src/mcp-server';
import { createWorld, issue, singleChatRun } from './helpers';

describe('签发与注入', () => {
  it('没开的运行时、没有运行上下文、没选工具集：不注入、不签发', () => {
    const world = createWorld();
    expect(world.service.managedServersFor('claude-code', singleChatRun())).toEqual([]);
    world.service.saveRuntime('claude-code', { enabled: true, toolsets: ['use'] });
    expect(world.service.managedServersFor('claude-code', undefined)).toEqual([]);
    world.service.saveRuntime('claude-code', { enabled: true, toolsets: [] });
    expect(world.service.managedServersFor('claude-code', singleChatRun())).toEqual([]);
    expect((world.sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_tokens').get() as { n: number }).n).toBe(0);
  });

  it('托管条目带两道所有权标记、令牌只在 env 里、库里只有哈希', () => {
    const world = createWorld();
    const { server, token } = issue(world);
    expect(server.name.startsWith('clawopt-')).toBe(true);
    expect(server.env?.[CLAWOPT_MANAGED_MCP_ENV]).toBe('1');
    expect(isManagedMcpServer(server)).toBe(true);
    expect(server.command).toBe('/usr/bin/node');
    expect(server.args).toEqual(['/opt/clawopt/backend/bin/clawopt-mcp']);
    expect(JSON.stringify(server.args)).not.toContain(token);
    expect(token.length).toBeGreaterThanOrEqual(40);
    const row = world.sqlite.prepare('SELECT * FROM mcp_tokens').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.token_hash).toBe(hashMcpToken(token));
    expect(row.expires_at).toBe(world.clock.now + MCP_TOKEN_DEFAULT_TTL_MS);
  });

  it('群成员运行：范围带群，外部运行时单聊按 ext:<运行时> 授权', () => {
    const world = createWorld();
    issue(world, singleChatRun({ runId: 'r-g', sessionKey: 'room:g1:member:m1', agentId: 'alpha', owner: { kind: 'room-member', groupId: 'g1', memberId: 'm1' } }));
    issue(world, singleChatRun({ runId: 'r-x', sessionKey: 's-ext', agentId: 'claude-code', owner: { kind: 'session', sessionId: 's-ext' } }));
    const tokens = world.service.activeTokens();
    expect(tokens.find((token) => token.runId === 'r-g')).toMatchObject({ surface: 'group-chat', scope: { roomId: 'g1', agentIds: ['alpha'] } });
    expect(tokens.find((token) => token.runId === 'r-x')).toMatchObject({ surface: 'single-chat', scope: { agentIds: ['ext:claude-code'] } });
    expect(JSON.stringify(tokens)).not.toContain('hash');
  });
});

describe('范围外一律拒绝（与数据面 ACL 同一份判据）', () => {
  it('会话：自己的能读，别人的 403', async () => {
    const world = createWorld();
    const { call } = issue(world);
    expect((await call('session_read', {})).status).toBe(200);
    const denied = await call('session_read', { sessionKey: 's-other' });
    expect(denied).toMatchObject({ status: 403, body: { errorCode: 'mcpServer.outOfScope' } });
    const listed = await call('sessions_list');
    expect((listed.body.result as any).sessions.map((session: any) => session.id)).toEqual(['s-mine']);
  });

  it('工作流：节点里有范围外 Agent 的 403；列表只见范围内的', async () => {
    const world = createWorld();
    const { call } = issue(world);
    expect((await call('workflow_status', { workflowId: 'wf-alpha' })).status).toBe(200);
    expect((await call('workflow_run', { workflowId: 'wf-beta' })).status).toBe(403);
    expect((await call('workflow_status', { workflowId: 'wf-beta' })).status).toBe(403);
    expect(world.calls.starts).toEqual([]);
    const listed = await call('workflows_list');
    expect((listed.body.result as any).workflows.map((workflow: any) => workflow.id)).toEqual(['wf-alpha']);
  });

  it('工作流节点不能启动自己所在的工作流', async () => {
    const world = createWorld();
    const { call } = issue(world, singleChatRun({ runId: 'r-wf', sessionKey: 'workflow:alpha-1', owner: { kind: 'workflow-node', workflowId: 'wf-alpha', nodeId: 'n1' } }));
    expect((await call('workflow_run', { workflowId: 'wf-alpha' })).status).toBe(403);
  });

  it('看板：别人负责的任务读、评论、完成都 403；自己的评论署名是这个 Agent', async () => {
    const world = createWorld();
    const { call } = issue(world);
    for (const operation of ['kanban_task_get', 'kanban_task_comment', 'kanban_task_complete', 'kanban_task_block']) {
      expect((await call(operation, { taskId: 't-beta', body: 'x' })).status, operation).toBe(403);
    }
    expect(world.calls.comments).toEqual([]);
    expect(world.calls.acts).toEqual([]);
    expect((await call('kanban_task_comment', { taskId: 't-alpha', body: 'done soon', author: 'admin' })).status).toBe(200);
    expect(world.calls.comments[0].body.author).toBe('agent:alpha');
  });

  it('记忆：别的 profile 403，服务不被调用；自己的 profile 由宿主给作用域与证据', async () => {
    const world = createWorld();
    const { call } = issue(world);
    for (const operation of ['memory_search', 'memory_get', 'memory_write', 'memory_forget']) {
      expect((await call(operation, { profileId: 'beta', id: 'x', operations: [] })).status, operation).toBe(403);
    }
    expect(world.calls.memory).toEqual([]);
    expect((await call('memory_write', { operations: [{ op: 'create', kind: 'general_preference', title: 't', content: 'c' }] })).status).toBe(200);
    const ctx = world.calls.memory[0].ctx;
    expect(ctx).toMatchObject({ profileId: 'alpha', actor: 'agent:alpha', policy: 'automatic', origin: { host: 'clawopt', namespace: 'single-chat', contextId: 's-mine' }, defaultWriteScope: { type: 'profile', id: 'alpha' } });
    expect(ctx.evidence.map((message: any) => message.id)).toEqual(['chat:1']);
  });

  it('群聊记忆缺省写群 context；证据只有真人消息', async () => {
    const world = createWorld();
    const { call } = issue(world, singleChatRun({ runId: 'r-g', sessionKey: 'room:g1:member:m1', owner: { kind: 'room-member', groupId: 'g1', memberId: 'm1' } }));
    expect((await call('memory_search', { query: 'pnpm' })).status).toBe(200);
    const ctx = world.calls.memory[0].ctx;
    expect(ctx.defaultWriteScope).toEqual({ type: 'context', namespace: 'clawopt.group-chat', id: 'g1' });
    expect(ctx.evidence.map((message: any) => message.id)).toEqual(['group:10']);
    expect(ctx.origin).toEqual({ host: 'clawopt', namespace: 'group-chat', contextId: 'g1' });
  });

  it('工作流节点的记忆策略是 explicit-only', async () => {
    const world = createWorld();
    const { call } = issue(world, singleChatRun({ runId: 'r-wf', sessionKey: 'workflow:alpha-1', owner: { kind: 'workflow-node', workflowId: 'wf-alpha', nodeId: 'n1' } }));
    await call('memory_search', {});
    expect(world.calls.memory[0].ctx.policy).toBe('explicit-only');
  });
});

describe('令牌生命周期', () => {
  it('过期即 401 并记审计', async () => {
    const world = createWorld();
    const { call } = issue(world);
    world.clock.now += MCP_TOKEN_DEFAULT_TTL_MS + 1;
    expect(await call('sessions_list')).toMatchObject({ status: 401, body: { errorCode: 'mcpServer.tokenExpired' } });
    expect(world.service.audit()[0]).toMatchObject({ operation: 'sessions_list', outcome: 'expired' });
  });

  it('运行结束（chat.run.completed）立刻吊销；别的运行的终态不影响', async () => {
    const world = createWorld();
    const { call } = issue(world);
    world.events.publish('chat.run.completed', { runId: 'someone-else' });
    expect((await call('sessions_list')).status).toBe(200);
    world.events.publish('chat.run.completed', { runId: 'run-1' });
    expect(await call('sessions_list')).toMatchObject({ status: 401, body: { errorCode: 'mcpServer.tokenRevoked' } });
  });

  it('failed / aborted 同样吊销；停机全部吊销；管理员可单个吊销', async () => {
    for (const type of ['chat.run.failed', 'chat.run.aborted']) {
      const world = createWorld();
      const { call } = issue(world);
      world.events.publish(type, { runId: 'run-1' });
      expect((await call('sessions_list')).status, type).toBe(401);
    }
    const world = createWorld();
    const first = issue(world);
    const second = issue(world, singleChatRun({ runId: 'run-2' }));
    world.service.revokeToken(world.service.activeTokens().find((token) => token.runId === 'run-2')!.id);
    expect((await second.call('sessions_list')).status).toBe(401);
    expect((await first.call('sessions_list')).status).toBe(200);
    world.service.stop();
    expect((await first.call('sessions_list')).status).toBe(401);
  });

  it('伪造、空、不像令牌的都是 401 invalid', async () => {
    const world = createWorld();
    issue(world);
    for (const authorization of [undefined, 'Bearer ', 'Bearer short', `Bearer ${'x'.repeat(43)}`, 'Basic abc']) {
      expect((await world.service.call({ remoteAddress: '127.0.0.1', authorization }, 'sessions_list', {})).status).toBe(401);
    }
  });
});

describe('操作白名单', () => {
  it('令牌里没有的工具集操作 403；工具清单只列令牌允许的', async () => {
    const world = createWorld();
    const { call, token } = issue(world, singleChatRun(), { toolsets: ['memory'] });
    expect(await call('sessions_list')).toMatchObject({ status: 403, body: { errorCode: 'mcpServer.operationNotAllowed' } });
    const tools = world.service.listTools({ remoteAddress: '127.0.0.1', authorization: `Bearer ${token}` });
    expect((tools.body.tools as any[]).map((tool) => tool.name).sort()).toEqual(['memory_forget', 'memory_get', 'memory_search', 'memory_write']);
    expect(world.service.audit()[0]).toMatchObject({ operation: 'sessions_list', outcome: 'denied_operation' });
  });

  it('没有通用代理：路径形状、未知名字一律 403', async () => {
    const world = createWorld();
    const { call } = issue(world);
    for (const operation of ['api_request', '/api/users', 'GET /api/config', 'users_delete', 'terminal_open', '']) {
      expect((await call(operation, { path: '/api/users', method: 'DELETE' })).status, operation).toBe(403);
    }
  });

  it('没配委派名单：chat_run 不进令牌；委派出来的运行永远没有 chat_run（深度 1）', async () => {
    const world = createWorld();
    const plain = issue(world);
    expect((await plain.call('chat_run', { agentId: 'beta', prompt: 'hi' })).status).toBe(403);
    const withDelegates = issue(world, singleChatRun({ runId: 'run-2', sessionKey: 's-mine' }), { delegateAgents: ['beta'] });
    expect(world.service.activeTokens().find((token) => token.runId === 'run-2')!.operations).toContain('chat_run');
    // 没接委派实现：范围内的目标回 409 operationDisabled，范围外的目标先被范围挡下。
    expect((await withDelegates.call('chat_run', { agentId: 'beta', prompt: 'hi' })).body.errorCode).toBe('mcpServer.operationDisabled');
    expect((await withDelegates.call('chat_run', { agentId: 'gamma', prompt: 'hi' })).status).toBe(403);
  });

  it('委派出来的运行永远没有 chat_run（深度 1）：宿主在提交前登记会话键', async () => {
    const world = createWorld({
      delegateTurn: async ({ markDelegated }) => {
        markDelegated('workflow:delegated-1');
        return { ok: true, output: 'done' };
      },
    });
    const caller = issue(world, singleChatRun(), { delegateAgents: ['beta'] });
    expect((await caller.call('chat_run', { agentId: 'beta', prompt: 'hi' })).status).toBe(200);
    // 委派出来的那一轮（外部运行时）开跑时签发的令牌：不含 chat_run，调用也被拒。
    const child = issue(world, singleChatRun({ runId: 'run-child', sessionKey: 'workflow:delegated-1', agentId: 'beta', owner: { kind: 'workflow-node', workflowId: 'mcp-delegate', nodeId: 'delegated-1' } }), { delegateAgents: ['beta', 'gamma'] });
    expect(world.service.activeTokens().find((token) => token.runId === 'run-child')!.operations).not.toContain('chat_run');
    expect((await child.call('chat_run', { agentId: 'gamma', prompt: 'hi' })).status).toBe(403);
  });

  it('chat_run 接上委派实现后：只委派给名单里的、不能委派给自己', async () => {
    const delegated: string[] = [];
    const world = createWorld({ delegateTurn: async ({ agentId }) => { delegated.push(agentId); return { ok: true, output: 'pong' }; } });
    const { call } = issue(world, singleChatRun(), { delegateAgents: ['beta', 'alpha'] });
    expect((await call('chat_run', { agentId: 'alpha', prompt: 'hi' })).status).toBe(403);
    expect(await call('chat_run', { agentId: 'beta', prompt: 'hi' })).toMatchObject({ status: 200, body: { result: { ok: true, output: 'pong' } } });
    expect(delegated).toEqual(['beta']);
  });
});

describe('来源', () => {
  it('只收本机回环', async () => {
    const world = createWorld();
    const { call, token } = issue(world);
    for (const address of ['10.0.0.5', '192.168.1.2', '::ffff:10.0.0.5']) {
      expect(await call('sessions_list', {}, address)).toMatchObject({ status: 403, body: { errorCode: 'mcpServer.loopbackOnly' } });
    }
    // 对端地址拿不到（套接字已断）与本机反向代理转进来的外部请求（对端是回环、带转发头）同样拒绝。
    expect(await world.service.call({ remoteAddress: undefined, authorization: `Bearer ${token}` }, 'sessions_list', {})).toMatchObject({ status: 403 });
    expect(await world.service.call({ remoteAddress: '127.0.0.1', authorization: `Bearer ${token}`, forwarded: true }, 'sessions_list', {})).toMatchObject({ status: 403, body: { errorCode: 'mcpServer.loopbackOnly' } });
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect((await call('sessions_list', {}, address)).status).toBe(200);
    }
  });

  it('审计记下每次调用的结果，不记参数', async () => {
    const world = createWorld();
    const { call } = issue(world);
    await call('session_read', { sessionKey: 's-other' });
    await call('memory_write', { operations: [{ op: 'create', kind: 'x', title: 'my secret title', content: 'my secret content' }] });
    const audit = world.service.audit();
    expect(audit.map((row) => row.outcome)).toEqual(['allowed', 'denied_scope']);
    expect(JSON.stringify(audit)).not.toContain('my secret');
  });
});
