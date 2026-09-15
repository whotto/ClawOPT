/**
 * 数据面按「用户 ↔ Agent」授权（P5a 模型 × P1a 实时通道）：真组装的应用、登录开启、库里真用户。
 *
 * 场景：Agent `main` 授权给 member，`other` 不授权。
 * - 单聊会话 s-main（main）/ s-other（other）；
 * - 群 g-main（成员含 main）/ g-other（只有 other）；
 * - 工作流 wf-main（main 节点）/ wf-other（other 节点）/ wf-external（Claude Code 节点）。
 *
 * 矩阵：super_admin / admin 全部可见；member 只见授权 Agent 的会话、含授权 Agent 的群、授权 Agent 的活动主题；
 * 被停用的用户与被吊销的会话在升级时就 401。HTTP（列表、按 id 取、SSE 流、停止、改删消息）与 WS 同一判据。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
const previousFakeRunner = process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER;
const workflows = { main: '', other: '', external: '' };
const tokens: Record<'owner' | 'admin' | 'member', string> = { owner: '', admin: '', member: '' };
let memberId = 0;

beforeAll(async () => {
  // 工作流用确定性假 Runner：这里只验授权，不起进程、不连网关。
  process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER = '1';
  h = await startAppHarness({ attachRealtime: true });
  const { ctx } = h;
  const owner = ctx.userStore.create({ username: 'owner', password: 'owner-pass-1234', role: 'super_admin' });
  const admin = ctx.userStore.create({ username: 'admin2', password: 'admin-pass-1234', role: 'admin' });
  const member = ctx.userStore.create({ username: 'member', password: 'member-pass-1234', role: 'member' });
  ctx.userStore.update(member.id, { agentIds: ['main'] });
  memberId = member.id;
  tokens.owner = ctx.authStore.issue('web', owner.id).token;
  tokens.admin = ctx.authStore.issue('web', admin.id).token;
  tokens.member = ctx.authStore.issue('web', member.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });

  ctx.sessionManager.createSession({ id: 's-main', name: 'Main', agentId: 'main' });
  ctx.sessionManager.createSession({ id: 's-other', name: 'Other', agentId: 'other' });
  ctx.db.saveGroupChat({ id: 'g-main', name: 'G main' });
  ctx.db.saveGroupMember({ id: 'gm-main', group_id: 'g-main', agent_id: 'main', display_name: 'Main', position: 0 });
  ctx.db.saveGroupMember({ id: 'gm-other-in-main', group_id: 'g-main', agent_id: 'other', display_name: 'Other', position: 1 });
  ctx.db.saveGroupChat({ id: 'g-other', name: 'G other' });
  ctx.db.saveGroupMember({ id: 'gm-other', group_id: 'g-other', agent_id: 'other', display_name: 'Other', position: 0 });

  const workflowNode = (agent: Record<string, string>, input = '[fake:output done]') => ({
    id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'N1', agent, input, approvalRequired: true },
  });
  const createWorkflow = (name: string, agent: Record<string, string>) => ctx.automation.workflows.create({ name, nodes: [workflowNode(agent)], edges: [] }).id;
  workflows.main = createWorkflow('wf-main', { kind: 'openclaw', id: 'main' });
  workflows.other = createWorkflow('wf-other', { kind: 'openclaw', id: 'other' });
  workflows.external = createWorkflow('wf-external', { kind: 'external', id: 'claude-code', runtime: 'claude-code' });
});

afterAll(async () => {
  await h?.close();
  if (previousFakeRunner === undefined) delete process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER;
  else process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER = previousFakeRunner;
});

const api = (token: string, path: string, init: RequestInit = {}) => fetch(`${h.baseUrl}${path}`, {
  ...init,
  headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
});

type WsClient = { socket: WebSocket; messages: any[]; request: (message: Record<string, unknown>) => Promise<any>; closed: Promise<number> };

let requestSeq = 0;
function connectWs(token: string | null): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${h.baseUrl.replace('http', 'ws')}/ws`, token ? { headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } } : {});
    const messages: any[] = [];
    const waiters: Array<{ requestId: number; resolve: (m: any) => void }> = [];
    const closed = new Promise<number>((r) => socket.on('close', (code) => r(code)));
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      messages.push(message);
      const waiter = waiters.find((item) => item.requestId === message.requestId);
      if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
    });
    socket.on('error', reject);
    socket.on('open', () => resolve({
      socket,
      messages,
      closed,
      request: (message) => new Promise((res) => {
        const requestId = ++requestSeq;
        waiters.push({ requestId, resolve: res });
        socket.send(JSON.stringify({ ...message, requestId }));
      }),
    }));
  });
}

async function topicVerdicts(token: string, topics: string[]): Promise<Record<string, string>> {
  const client = await connectWs(token);
  const verdicts: Record<string, string> = {};
  for (const topic of topics) {
    const reply = await client.request({ type: 'subscribe', topic });
    verdicts[topic] = reply.type === 'subscribed' ? 'ok' : reply.code;
  }
  client.socket.close();
  return verdicts;
}

const TOPICS = ['session:s-main', 'session:s-other', 'room:g-main', 'room:g-other', 'agent:main', 'agent:other'];

describe('/ws 主题授权按用户 ↔ Agent', () => {
  it('匿名升级 401', async () => {
    await expect(connectWs(null)).rejects.toThrow('401');
  });

  it('super_admin 与 admin 全部可订阅', async () => {
    const all = Object.fromEntries(TOPICS.map((topic) => [topic, 'ok']));
    expect(await topicVerdicts(tokens.owner, TOPICS)).toEqual(all);
    expect(await topicVerdicts(tokens.admin, TOPICS)).toEqual(all);
  });

  it('member：只有授权 Agent 的会话、含授权 Agent 的群、授权 Agent 的活动主题', async () => {
    expect(await topicVerdicts(tokens.member, TOPICS)).toEqual({
      'session:s-main': 'ok',
      'session:s-other': 'realtime.topicForbidden',
      'room:g-main': 'ok',
      'room:g-other': 'realtime.topicForbidden',
      'agent:main': 'ok',
      'agent:other': 'realtime.topicForbidden',
    });
  });

  it('member 不能答复别人会话里的审批', async () => {
    const client = await connectWs(tokens.member);
    const reply = await client.request({ type: 'interaction.respond', sessionKey: 's-other', id: 'ap-x', choice: 'once' });
    expect(reply).toMatchObject({ type: 'result', result: { handled: false, error: 'forbidden' } });
    client.socket.close();
  });

  it('被停用的用户升级即 401；已连上的在心跳复查时断开', async () => {
    const disabled = h.ctx.userStore.create({ username: 'gone', password: 'gone-pass-1234', role: 'member' });
    const token = h.ctx.authStore.issue('web', disabled.id).token;
    const client = await connectWs(token);
    h.ctx.userStore.update(disabled.id, { status: 'disabled' });
    await expect(connectWs(token)).rejects.toThrow('401');
    client.socket.close();
    expect(h.ctx.auth.authenticateHeaders({ cookie: `${AUTH_COOKIE_NAME}=${token}` })).toBeNull();
  });

  it('被吊销的会话升级即 401', async () => {
    const token = h.ctx.authStore.issue('web', memberId).token;
    await (await connectWs(token)).socket.close();
    h.ctx.authStore.revoke(token);
    await expect(connectWs(token)).rejects.toThrow('401');
  });
});

describe('工作流实时：workflow:<id> 主题与 SSE 兜底、待办中心', () => {
  const workflowTopics = () => [`workflow:${workflows.main}`, `workflow:${workflows.other}`, `workflow:${workflows.external}`, 'workflow:missing', 'approvals:workflows'];

  it('admin 全部可订阅；member 只有全部节点 Agent 都授权的工作流（外部运行时节点不可见）', async () => {
    expect(await topicVerdicts(tokens.admin, workflowTopics())).toEqual({
      [`workflow:${workflows.main}`]: 'ok',
      [`workflow:${workflows.other}`]: 'ok',
      [`workflow:${workflows.external}`]: 'ok',
      'workflow:missing': 'realtime.topicForbidden',
      'approvals:workflows': 'ok',
    });
    expect(await topicVerdicts(tokens.member, workflowTopics())).toEqual({
      [`workflow:${workflows.main}`]: 'ok',
      [`workflow:${workflows.other}`]: 'realtime.topicForbidden',
      [`workflow:${workflows.external}`]: 'realtime.topicForbidden',
      'workflow:missing': 'realtime.topicForbidden',
      'approvals:workflows': 'ok',
    });
  });

  it('SSE 兜底同一判据：member 打不开没授权的工作流状态流（404），授权的照常', async () => {
    const denied = await api(tokens.member, `/api/workflows/${workflows.other}/events`);
    expect(denied.status).toBe(404);
    const controller = new AbortController();
    const allowed = await api(tokens.member, `/api/workflows/${workflows.main}/events`, { signal: controller.signal });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });

  it('运行起来：订阅者收到快照与 workflow.status；待审批提醒到达；待办列表按用户过滤', async () => {
    const member = await connectWs(tokens.member);
    const subscribed = await member.request({ type: 'subscribe', topic: `workflow:${workflows.main}`, resume: true });
    expect(subscribed).toMatchObject({ type: 'subscribed', snapshot: { workflow: { status: null } } });
    await member.request({ type: 'subscribe', topic: 'approvals:workflows' });

    const started = await api(tokens.admin, `/api/workflows/${workflows.main}/run`, { method: 'POST', body: '{}' });
    expect(started.status).toBe(202);
    const startedOther = await api(tokens.admin, `/api/workflows/${workflows.other}/run`, { method: 'POST', body: '{}' });
    expect(startedOther.status).toBe(202);
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await until(() => h.ctx.automation.engine.pendingApprovals().length === 2);
    await until(() => member.messages.some((m) => m.topic === 'approvals:workflows') && member.messages.some((m) => m.topic === `workflow:${workflows.main}` && m.event === 'workflow.status'));

    expect(member.messages.some((m) => m.type === 'event' && m.topic === `workflow:${workflows.main}` && m.event === 'workflow.status')).toBe(true);
    expect(member.messages.some((m) => m.type === 'event' && m.topic === `workflow:${workflows.other}`)).toBe(false);
    expect(member.messages.some((m) => m.type === 'event' && m.topic === 'approvals:workflows' && m.event === 'workflow.approvals.changed')).toBe(true);
    expect(member.messages.filter((m) => m.type === 'event' && m.topic === 'approvals:workflows').every((m) => JSON.stringify(m.payload) === '{}')).toBe(true);

    const adminList = await (await api(tokens.admin, '/api/workflows/pending-approvals')).json() as any;
    const memberList = await (await api(tokens.member, '/api/workflows/pending-approvals')).json() as any;
    expect(adminList.approvals.map((item: any) => item.workflowId).sort()).toEqual([workflows.main, workflows.other].sort());
    expect(memberList.approvals.map((item: any) => item.workflowId)).toEqual([workflows.main]);
    member.socket.close();

    for (const id of [workflows.main, workflows.other]) {
      const [pending] = h.ctx.automation.engine.pendingApprovals().filter((item: any) => item.workflowId === id);
      h.ctx.automation.engine.resolveApproval(id, pending.runId, pending.nodeId, { approved: false, executionId: pending.executionId });
      await h.ctx.automation.engine.waitForRun(pending.runId);
    }
  });
});

describe('HTTP 数据面：会话 / 单聊 / 群按用户 ↔ Agent 过滤', () => {
  const status = async (token: string, path: string, init: RequestInit = {}) => {
    const controller = new AbortController();
    const response = await api(token, path, { ...init, signal: controller.signal });
    const code = response.status;
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() as any : null;
    controller.abort();
    return { code, body };
  };
  const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

  it('会话列表（侧栏与 Agents 页共用）：member 只见授权 Agent 的会话；admin 全部', async () => {
    const member = await status(tokens.member, '/api/sessions');
    const admin = await status(tokens.admin, '/api/sessions');
    expect(member.code).toBe(200);
    expect(member.body.map((session: any) => session.id)).toContain('s-main');
    expect(member.body.map((session: any) => session.id)).not.toContain('s-other');
    expect(new Set(member.body.map((session: any) => session.agentId))).toEqual(new Set(['main']));
    expect(admin.body.map((session: any) => session.id)).toEqual(expect.arrayContaining(['s-main', 's-other']));
  });

  it('会话活动（完成提醒的轮询兜底）：member 只见授权 Agent 的会话；结束标记与运行计数照实回', async () => {
    h.ctx.db.ensureRunSession({ sessionKey: 's-other', surface: 'chat', runtime: 'openclaw', agentId: 'other' });
    h.ctx.db.markRunSessionEnded('s-other', 'complete');
    h.ctx.db.ensureRunSession({ sessionKey: 's-main', surface: 'chat', runtime: 'openclaw', agentId: 'main' });
    h.ctx.db.markRunSessionEnded('s-main', 'abort');
    const member = await status(tokens.member, '/api/sessions/activity');
    const admin = await status(tokens.admin, '/api/sessions/activity');
    expect(member.code).toBe(200);
    const memberIds = member.body.activity.map((row: any) => row.sessionId);
    expect(memberIds).toContain('s-main');
    expect(memberIds).not.toContain('s-other');
    expect(member.body.activity.find((row: any) => row.sessionId === 's-main')).toMatchObject({ running: false, runCount: 1, endReason: 'abort' });
    expect(admin.body.activity.map((row: any) => row.sessionId)).toEqual(expect.arrayContaining(['s-main', 's-other']));
  });

  it('member 取 / 流 / 停 / 发 / 改别人的会话一律 403，自己的照常；不留下任何写入', async () => {
    const otherMessage = Number(h.ctx.db.saveMessage({ session_key: 's-other', role: 'user', content: 'secret' }));
    const mineMessage = Number(h.ctx.db.saveMessage({ session_key: 's-main', role: 'user', content: 'mine' }));
    const denied: Array<[string, RequestInit?]> = [
      ['/api/history/s-other'],
      ['/api/history/s-other/search?q=secret'],
      ['/api/chat/s-other/active-run'],
      ['/api/chat/attach/s-other'],
      // P1b 运行控制：状态快照、会话实时通道、取消排队、立即插入
      ['/api/chat/s-other/state'],
      ['/api/chat/s-other/context-usage'],
      ['/api/chat/s-other/tool-calls?messageIds=1'],
      ['/api/chat/s-other/tool-calls/1'],
      ['/api/chat/s-other/task-plans?messageIds=1'],
      ['/api/chat/s-other/events'],
      ['/api/chat/s-other/queue/q-1', { method: 'DELETE' }],
      ['/api/chat/s-other/queue/q-1/insert', { method: 'POST' }],
      // P1b 会话组织：挪分类、置顶、归档、改标题、导出按会话判；分叉与批量删除是管理员的
      ['/api/sessions/s-other/category', { method: 'PUT', body: JSON.stringify({ categoryId: null }) }],
      ['/api/sessions/s-other/archive', { method: 'PUT', body: JSON.stringify({ archived: true }) }],
      ['/api/sessions/s-other/pin', { method: 'PUT', body: JSON.stringify({ pinned: true }) }],
      ['/api/sessions/s-other/title', { method: 'PUT', body: JSON.stringify({ title: 'x' }) }],
      ['/api/sessions/s-other/export?format=json'],
      ['/api/sessions/s-main/fork', post({})],
      ['/api/sessions/batch-delete', post({ ids: ['s-main'] })],
      ['/api/sessions/s-other/configs'],
      ['/api/sessions/s-other/workspace-changes?messageIds=1'],
      ['/api/sessions/s-other/workspace-changes/wc-other/files/1'],
      ['/api/sessions/s-other/reset', { method: 'POST' }],
      ['/api/chat', post({ sessionId: 's-other', message: 'hi' })],
      ['/api/chat/regenerate', post({ sessionId: 's-other', message: 'hi', parentId: otherMessage })],
      ['/api/chat/stop', post({ sessionId: 's-other' })],
      ['/api/chat/silent', post({ sessionId: 's-other', message: 'hi' })],
      [`/api/messages/${otherMessage}`, { method: 'PUT', body: JSON.stringify({ content: 'tampered' }) }],
      [`/api/messages/${otherMessage}`, { method: 'DELETE' }],
      ['/api/sessions/reorder', post({ ids: ['s-main', 's-other'] })],
      // 建 / 改 / 删会话会装配或撤销 Agent：控制面，member 一律不行（自己的也不行）
      ['/api/sessions', post({ id: 'member-made', name: 'x' })],
      ['/api/sessions/s-main', { method: 'PUT', body: JSON.stringify({ name: 'renamed' }) }],
      ['/api/sessions/s-main', { method: 'DELETE' }],
    ];
    const results = await Promise.all(denied.map(async ([path, init]) => `${init?.method ?? 'GET'} ${path} ${(await status(tokens.member, path, init)).code}`));
    expect(results).toEqual(denied.map(([path, init]) => `${init?.method ?? 'GET'} ${path} 403`));
    expect(h.ctx.db.getMessages('s-other').map((row: any) => row.content)).toEqual(['secret']);
    expect(h.ctx.db.getSession('s-main')?.name).toBe('Main');

    expect((await status(tokens.member, '/api/history/s-main')).code).toBe(200);
    expect((await status(tokens.member, '/api/chat/s-main/active-run')).code).toBe(200);
    expect((await status(tokens.member, '/api/chat/s-main/state')).code).toBe(200);
    const organization = await status(tokens.member, '/api/session-organization');
    expect(Object.keys(organization.body.sessions)).toContain('s-main');
    expect(Object.keys(organization.body.sessions)).not.toContain('s-other');
    expect((await status(tokens.member, '/api/chat/s-main/queue/q-missing', { method: 'DELETE' })).code).toBe(404);
    // 工作区改动（P1b）：自己会话的摘要照常；拿自己会话的路径读别人会话的变更集按不存在（404），不串会话
    h.ctx.db.workspaceRunChanges.save({
      id: 'wc-other', sessionKey: 's-other', surface: 'chat', runId: 'r', runMarker: 'm', assistantMessageId: String(otherMessage), mode: 'scan',
      fileCount: 1, additions: 1, deletions: 0, patchBytes: 3, truncated: false, createdAt: Date.now(),
      files: [{ path: 'secret.txt', oldPath: null, changeType: 'added', additions: 1, deletions: 0, oldSize: null, newSize: 2, patch: '+s\n', patchBytes: 3, truncated: false, binary: false }],
    });
    const otherFileId = h.ctx.db.workspaceRunChanges.listForMessages('s-other', [String(otherMessage)])[0].files[0].id;
    expect((await status(tokens.member, `/api/sessions/s-main/workspace-changes?messageIds=${otherMessage}`)).body.changes).toEqual([]);
    expect((await status(tokens.member, `/api/sessions/s-main/workspace-changes/wc-other/files/${otherFileId}`)).code).toBe(404);
    expect((await status(tokens.member, `/api/sessions/s-other/workspace-changes/wc-other/files/${otherFileId}`)).code).toBe(403);
    expect((await status(tokens.admin, `/api/sessions/s-other/workspace-changes/wc-other/files/${otherFileId}`)).body.file.patch).toBe('+s\n');
    expect((await status(tokens.member, `/api/messages/${mineMessage}`, { method: 'PUT', body: JSON.stringify({ content: 'edited' }) })).code).toBe(200);

    // admin 不受影响
    expect((await status(tokens.admin, '/api/history/s-other')).code).toBe(200);
    expect((await status(tokens.admin, '/api/chat/s-other/active-run')).code).toBe(200);
    expect((await status(tokens.admin, '/api/history/s-other/search?q=secret')).code).toBe(200);
  });

  it('Ctrl/Cmd+K 搜索（/api/search/chat）：member 只搜得到授权 Agent 的会话，看不见的不占 limit；最近会话同样过滤', async () => {
    h.ctx.db.saveMessage({ session_key: 's-main', role: 'user', content: 'quasar rollout plan' });
    for (let i = 0; i < 3; i += 1) h.ctx.db.saveMessage({ session_key: 's-other', role: 'user', content: `quasar rollout secret ${i}` });
    const member = await status(tokens.member, '/api/search/chat?q=quasar&limit=1');
    expect(member.code).toBe(200);
    expect(member.body.results.map((r: any) => r.sessionId)).toEqual(['s-main']);
    expect((await status(tokens.member, '/api/search/chat?q=Other')).body.results).toEqual([]);
    const recent = await status(tokens.member, '/api/search/chat?q=');
    expect(recent.body.mode).toBe('recent');
    expect(recent.body.results.map((r: any) => r.sessionId)).not.toContain('s-other');
    const admin = await status(tokens.admin, '/api/search/chat?q=quasar');
    expect(admin.body.results.map((r: any) => r.sessionId).sort()).toEqual(['s-main', 's-other']);
    expect((await fetch(`${h.baseUrl}/api/search/chat?q=quasar`)).status).toBe(401);
  });

  it('群：member 只见含授权 Agent 的群；看不见的群取 / 流 / 发 / 停 403；改结构要求群里每个 Agent 都授权', async () => {
    const memberGroups = await status(tokens.member, '/api/groups');
    expect(memberGroups.body.groups.map((group: any) => group.id)).toEqual(['g-main']);
    const adminGroups = await status(tokens.admin, '/api/groups');
    expect(adminGroups.body.groups.map((group: any) => group.id).sort()).toEqual(['g-main', 'g-other']);

    const otherGroupMessage = h.ctx.db.saveGroupMessage({ group_id: 'g-other', sender_type: 'user', content: 'other group' });
    const denied: Array<[string, RequestInit?]> = [
      ['/api/groups/g-other/messages'],
      ['/api/groups/g-other/messages/search?q=other'],
      ['/api/groups/g-other/active-run'],
      ['/api/groups/g-other/events'],
      ['/api/groups/g-other/messages', post({ content: 'hi' })],
      ['/api/groups/g-other/stop', { method: 'POST' }],
      [`/api/groups/g-other/messages/${otherGroupMessage}`, { method: 'DELETE' }],
      ['/api/groups/g-other/messages/regenerate', post({ msgId: otherGroupMessage })],
      // g-main 里还有 other：看得见，但不能改结构
      ['/api/groups/g-main', { method: 'PUT', body: JSON.stringify({ name: 'renamed' }) }],
      ['/api/groups/g-main', { method: 'DELETE' }],
      ['/api/groups/g-main/reset', { method: 'POST' }],
      ['/api/groups', post({ id: 'member-group', name: 'mg', members: [{ agentId: 'other' }] })],
      ['/api/groups/reorder', post({ ids: ['g-main', 'g-other'] })],
    ];
    const results = await Promise.all(denied.map(async ([path, init]) => `${init?.method ?? 'GET'} ${path} ${(await status(tokens.member, path, init)).code}`));
    expect(results).toEqual(denied.map(([path, init]) => `${init?.method ?? 'GET'} ${path} 403`));
    expect(h.ctx.db.getGroupChat('g-main')?.name).toBe('G main');
    expect(h.ctx.db.getGroupMessages('g-other').map((row: any) => row.content)).toEqual(['other group']);

    expect((await status(tokens.member, '/api/groups/g-main/messages')).code).toBe(200);
    // 借自己看得见的群删别的群的消息：按群收窄，404（admin 同样 404）
    expect((await status(tokens.member, `/api/groups/g-main/messages/${otherGroupMessage}`, { method: 'DELETE' })).code).toBe(404);
    expect((await status(tokens.admin, `/api/groups/g-main/messages/${otherGroupMessage}`, { method: 'DELETE' })).code).toBe(404);
    expect(h.ctx.db.getGroupMessages('g-other')).toHaveLength(1);

    // member 能建只含自己 Agent 的群；admin 可取任意群
    const created = await status(tokens.member, '/api/groups', post({ id: 'member-group', name: 'mg', members: [{ agentId: 'main' }] }));
    expect(created.code).toBe(200);
    expect((await status(tokens.admin, '/api/groups/g-other/messages')).code).toBe(200);
  });
});
