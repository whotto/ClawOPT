/**
 * 外部运行时的授权：伪 Agent id `ext:<运行时>`（core/auth/agent-ids.ts）。真组装的应用、登录开启、库里真用户。
 *
 * 场景：member 只被授权 `ext:claude-code`。
 * - 外部运行时单聊 s-claude（Claude Code）/ s-codex（Codex）；OpenClaw 单聊 s-main（main，未授权）；
 * - 群 g-ext（外部成员 Claude Code「CC」+ Codex「CX」）/ g-codex（只有 Codex）；
 * - 工作流 wf-claude（Claude Code 节点）/ wf-mixed（Claude Code + Codex 两个节点）。
 *
 * 矩阵：
 * - 单聊：列表只见 s-claude；history / active-run / 发消息对 s-codex 403，s-claude 真的能跑一轮（适配器换成脚本化替身，不起进程）；
 *   建 / 改 / 删外部运行时会话是管理员的；
 * - 群：看得见 g-ext（至少一个外部成员授权），g-codex 403；在 g-ext 里 @CX 不叫起、回 groups.mentionNotPermitted；
 * - `/ws`：session / agent / room 主题同一判据；
 * - 工作流：只见全部节点都授权的 wf-claude；
 * - 运行时平台：`GET /api/runtime/member-runtimes` 登录可读；其余 `/api/runtime/*` 在登记表里全部 adminOnly，member 真打 403；
 * - 能力清单：授权外部运行时不增加任何界面入口（入口只看角色），`agentIds` 原样回 `ext:claude-code`。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { AUTH_COOKIE_NAME, capabilitiesForRole } from '../src/core/auth';
import { startAppHarness, type AppHarness } from './helpers/app-harness';
import { scriptedAdapter } from './helpers/scripted-adapter';

let h: AppHarness;
const previousFakeRunner = process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER;
const tokens: Record<'admin' | 'member', string> = { admin: '', member: '' };
const wf = { claude: '', mixed: '' };
const woken: string[] = [];
const claude = scriptedAdapter({ id: 'claude-code', onStart: (run) => setTimeout(() => {
  run.emit({ type: 'response.output_text.delta', item_id: 'm1', delta: 'hello from claude' });
  run.finish({ kind: 'completed', outputText: 'hello from claude' });
}, 5) });

beforeAll(async () => {
  process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER = '1';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h = await startAppHarness({ attachRealtime: true });
  const { ctx } = h;
  const admin = ctx.userStore.create({ username: 'admin2', password: 'admin-pass-1234', role: 'admin' });
  const member = ctx.userStore.create({ username: 'member', password: 'member-pass-1234', role: 'member' });
  ctx.userStore.update(member.id, { agentIds: ['ext:claude-code'] });
  tokens.admin = ctx.authStore.issue('web', admin.id).token;
  tokens.member = ctx.authStore.issue('web', member.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });

  ctx.sessionManager.createSession({ id: 's-main', name: 'Main', agentId: 'main' });
  ctx.sessionManager.createSession({ id: 's-claude', name: 'Claude', agentId: 's-claude', external_runtime: 'claude-code', external_config: '{"mode":"global"}', external_session_id: '11111111-1111-4111-8111-111111111111' });
  ctx.sessionManager.createSession({ id: 's-codex', name: 'Codex', agentId: 's-codex', external_runtime: 'codex', external_config: '{"mode":"global"}', external_session_id: '22222222-2222-4222-8222-222222222222' });
  // 单聊的适配器换成脚本化替身：只验授权与协调器链路，不起真 CLI。
  ctx.runtimePlatform.createAdapter = (runtime: string) => (runtime === 'claude-code' ? claude.adapter : null);

  ctx.db.saveGroupChat({ id: 'g-ext', name: 'Ext' });
  ctx.db.saveGroupMember({ id: 'gm-cc', group_id: 'g-ext', agent_id: 'cc', display_name: 'CC', runtime: 'claude-code', position: 0 });
  ctx.db.saveGroupMember({ id: 'gm-cx', group_id: 'g-ext', agent_id: 'cx', display_name: 'CX', runtime: 'codex', position: 1 });
  ctx.db.saveGroupChat({ id: 'g-codex', name: 'Codex only' });
  ctx.db.saveGroupMember({ id: 'gm-cx2', group_id: 'g-codex', agent_id: 'cx', display_name: 'CX', runtime: 'codex', position: 0 });
  // 工作流节点的协调器会话行：agent_id 是带后缀的 `ext:<运行时>:workflow`，判定前归一。
  ctx.db.ensureRunSession({ sessionKey: 'workflow:node-claude', surface: 'workflow', runtime: 'claude-code', agentId: 'ext:claude-code:workflow' });
  ctx.db.ensureRunSession({ sessionKey: 'workflow:node-codex', surface: 'workflow', runtime: 'codex', agentId: 'ext:codex:workflow' });
  const engine = ctx.rooms.groupChatEngine;
  // 编排器按队列调引擎的 executeTurn：换成记录调用的替身（不起真 CLI）。
  engine.executeTurn = async (input: any) => { woken.push(input.member.agent_id); return { status: 'completed', messageId: null, text: '' }; };

  const node = (id: string, runtime: string) => ({ id, type: 'agent', position: { x: 0, y: 0 }, data: { title: id, agent: { kind: 'external', id: runtime, runtime }, input: '[fake:output done]' } });
  wf.claude = ctx.automation.workflows.create({ name: 'wf-claude', nodes: [node('n1', 'claude-code')], edges: [] }).id;
  wf.mixed = ctx.automation.workflows.create({
    name: 'wf-mixed',
    nodes: [node('n1', 'claude-code'), node('n2', 'codex')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', data: { orchestration: { route: 'success' } } }],
  }).id;
});

afterAll(async () => {
  await h?.close();
  vi.restoreAllMocks();
  if (previousFakeRunner === undefined) delete process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER;
  else process.env.CLAWOPT_WORKFLOW_FAKE_RUNNER = previousFakeRunner;
});

const api = (token: string, path: string, init: RequestInit = {}) => fetch(`${h.baseUrl}${path}`, {
  ...init,
  headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const json = async (response: Response) => response.json() as Promise<any>;

async function topicVerdicts(token: string, topics: string[]): Promise<Record<string, string>> {
  const socket = new WebSocket(`${h.baseUrl.replace('http', 'ws')}/ws`, { headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } });
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });
  const verdicts: Record<string, string> = {};
  let seq = 0;
  for (const topic of topics) {
    const requestId = ++seq;
    const reply = await new Promise<any>((resolve) => {
      const onMessage = (data: WebSocket.RawData) => {
        const message = JSON.parse(String(data));
        if (message.requestId === requestId) { socket.off('message', onMessage); resolve(message); }
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ type: 'subscribe', topic, requestId }));
    });
    verdicts[topic] = reply.type === 'subscribed' ? 'ok' : reply.code;
  }
  socket.close();
  return verdicts;
}

describe('外部运行时单聊按 ext:<运行时> 授权', () => {
  it('会话列表：member 只见授权运行时的单聊；admin 全部', async () => {
    expect((await json(await api(tokens.member, '/api/sessions'))).map((s: any) => s.id)).toEqual(['s-claude']);
    expect((await json(await api(tokens.admin, '/api/sessions'))).map((s: any) => s.id)).toEqual(expect.arrayContaining(['s-claude', 's-codex', 's-main']));
  });

  it('Codex 单聊的取 / 发一律 403；建改删会话是管理员的', async () => {
    for (const [path, init] of [
      ['/api/history/s-codex', {}],
      ['/api/chat/s-codex/active-run', {}],
      ['/api/chat', { method: 'POST', body: JSON.stringify({ sessionId: 's-codex', message: 'hi' }) }],
      ['/api/sessions/s-codex', { method: 'PUT', body: JSON.stringify({ name: 'x' }) }],
      ['/api/sessions/s-claude', { method: 'PUT', body: JSON.stringify({ name: 'x' }) }],
      ['/api/sessions', { method: 'POST', body: JSON.stringify({ id: 'cc-new', name: 'CC', externalRuntime: 'claude-code' }) }],
    ] as Array<[string, RequestInit]>) {
      expect((await api(tokens.member, path, init)).status, path).toBe(403);
    }
    expect(h.ctx.db.getMessages('s-codex', 10)).toEqual([]);
  });

  it('Claude Code 单聊：member 能发消息并跑完一轮（经协调器，适配器是替身）', async () => {
    expect((await api(tokens.member, '/api/history/s-claude')).status).toBe(200);
    const response = await api(tokens.member, '/api/chat', { method: 'POST', body: JSON.stringify({ sessionId: 's-claude', message: 'hello' }) });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('hello from claude');
    expect(claude.runs).toHaveLength(1);
    const history = await json(await api(tokens.member, '/api/history/s-claude'));
    expect(JSON.stringify(history)).toContain('hello from claude');
  });

  it('群：看得见含授权外部成员的群；@ 未授权的外部成员不叫起并提示；只有未授权成员的群 403', async () => {
    const groups = await json(await api(tokens.member, '/api/groups'));
    expect(groups.groups.map((g: any) => g.id)).toEqual(['g-ext']);
    expect((await api(tokens.member, '/api/groups/g-codex/messages')).status).toBe(403);
    const sent = await json(await api(tokens.member, '/api/groups/g-ext/messages', { method: 'POST', body: JSON.stringify({ content: '@CX 看看' }) }));
    expect(sent.notice).toMatchObject({ messageCode: 'groups.mentionNotPermitted', agentNames: ['CX'] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(woken).toEqual([]);
    await api(tokens.member, '/api/groups/g-ext/messages', { method: 'POST', body: JSON.stringify({ content: '@CC 看看' }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(woken).toEqual(['cc']);
    // 改群结构要求每个成员都授权
    expect((await api(tokens.member, '/api/groups/g-ext', { method: 'DELETE' })).status).toBe(403);
  });

  it('/ws 主题同一判据', async () => {
    expect(await topicVerdicts(tokens.member, [
      'session:s-claude', 'session:s-codex', 'agent:s-claude', 'agent:s-codex',
      'agent:ext:claude-code:cc', 'agent:ext:codex:cx', 'room:g-ext', 'room:g-codex', 'session:room:g-codex:member:gm-cx2',
      'session:workflow:node-claude', 'session:workflow:node-codex',
    ])).toEqual({
      'session:workflow:node-claude': 'ok',
      'session:workflow:node-codex': 'realtime.topicForbidden',
      'session:s-claude': 'ok',
      'session:s-codex': 'realtime.topicForbidden',
      'agent:s-claude': 'ok',
      'agent:s-codex': 'realtime.topicForbidden',
      'agent:ext:claude-code:cc': 'ok',
      'agent:ext:codex:cx': 'realtime.topicForbidden',
      'room:g-ext': 'ok',
      'room:g-codex': 'realtime.topicForbidden',
      'session:room:g-codex:member:gm-cx2': 'realtime.topicForbidden',
    });
  });

  it('工作流：外部运行时节点按 ext:<运行时> 算授权，每个节点都授权才可见', async () => {
    const list = await json(await api(tokens.member, '/api/workflows'));
    expect(list.workflows.map((item: any) => item.id)).toEqual([wf.claude]);
    expect((await api(tokens.member, `/api/workflows/${wf.mixed}`)).status).toBe(403);
    expect((await api(tokens.member, `/api/workflows/${wf.claude}`)).status).toBe(200);
  });
});

describe('运行时平台接口在多用户下', () => {
  it('member-runtimes 登录可读；其余 /api/runtime/* 在登记表里全部 adminOnly，member 真打 403；代理公开路由只认令牌', async () => {
    expect((await api(tokens.member, '/api/runtime/member-runtimes')).status).toBe(200);
    const { buildApp } = await import('../src/bootstrap/app');
    const records = buildApp(h.ctx).routes.list().filter((record: any) => record.kind === 'route' && record.path.startsWith('/api/runtime/'));
    const label = (record: any) => `${record.method.toUpperCase()} ${record.path}`;
    expect(records.length).toBeGreaterThan(20);
    expect(records.filter((record: any) => !record.adminOnly).map(label)).toEqual(['GET /api/runtime/member-runtimes']);
    const leaks: string[] = [];
    for (const record of records.filter((item: any) => item.adminOnly)) {
      const path = record.path.replace(/:[A-Za-z0-9_]+/g, 'x');
      const response = await api(tokens.member, path, { method: record.method.toUpperCase(), ...(record.method === 'get' ? {} : { body: '{}' }) });
      if (response.status !== 403) leaks.push(`${label(record)} -> ${response.status}`);
    }
    expect(leaks).toEqual([]);
    // 代理：登录 cookie 不是令牌，照样 404 / 401（不因为是已登录用户就放行）。
    expect((await api(tokens.admin, '/api/runtime-proxy/anthropic/unknown/v1/models')).status).toBe(404);
  });

  it('能力清单：授权外部运行时不增加界面入口；agentIds 原样回伪 Agent id', async () => {
    const me = await json(await api(tokens.member, '/api/auth/me'));
    expect(me.user.agentIds).toEqual(['ext:claude-code']);
    expect(me.user.capabilities).toEqual(capabilitiesForRole('member'));
    expect(me.user.capabilities).not.toContain('settings.runtimes');
  });
});
