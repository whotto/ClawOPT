/**
 * 数据面按「用户 ↔ Agent」授权（P5a 模型 × P1a 实时通道）：真组装的应用、登录开启、库里真用户。
 *
 * 场景：Agent `main` 授权给 member，`other` 不授权。
 * - 单聊会话 s-main（main）/ s-other（other）；
 * - 群 g-main（成员含 main）/ g-other（只有 other）；
 * - 工作流 wf-main（main 节点）/ wf-other（other 节点）/ wf-external（Claude Code 节点）。
 *
 * 矩阵：super_admin / admin 全部可见；member 只见授权 Agent 的会话、含授权 Agent 的群、授权 Agent 的活动主题；
 * 被停用的用户与被吊销的会话在升级时就 401。
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
