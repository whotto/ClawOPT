/**
 * 远程 Agent relay（P3 任务 9）：真组装的 host 应用（真 WebSocket 接入）+ 同进程里一台独立的 target（自己的库、自己的协调器、脚本化适配器）。
 *
 * 全链路：房间开「允许远程 Agent」→ 发起配对拿配对码 → target 提交描述符 → 归属人批准 → target 用一次性票据接入、核对回显、加密存凭据
 * → 群里 @ 远程 Agent → host 经 relay 派发 → target 本机协调器跑 → 事件回传（seq 连续）→ 经远程工作区令牌写文件（SHA-256、自动发附件）
 * → 回复落库 + 工作区 diff 挂在回复上 → 审批 id 在 host 重新分配、答复回到 target → target 掉线 → 结局未知（relay.outcomeUnknown）
 * → 吊销 connector → target 链接 revoked。另有协议 / 票据 / 凭据 / 令牌的负面用例。
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { AUTH_COOKIE_NAME } from '../src/core/auth';
import { RealtimeHub } from '../src/core/realtime';
import { createRelayTarget, type RelayTarget } from '../src/collab/relay/relay-target';
import { decodePairingCode, RELAY_WS_PATH, redactSecrets, validateEventBatch } from '../src/collab/relay/protocol';
import { RunCoordinator } from '../src/runtime/coordinator';
import { LocalSecretBox } from '../src/runtime';
import { MemoryRunStore, scriptedAdapter, type RunControls } from './helpers/scripted-adapter';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let h: AppHarness;
let target: RelayTarget;
let targetDir: string;
let ownerToken = '';
const runs: RunControls[] = [];
let onStart: (controls: RunControls) => void = () => {};

const APPROVAL_CAPS = { boundaryInterrupt: false, nativeResume: false, approvals: true, clarify: true, hostCompression: false, nativeCompact: false, backgroundDelegation: false, images: false, mcpInjection: false, proxyMode: ['global', 'scoped'] } as const;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h = await startAppHarness({ attachRealtime: true });
  const { ctx } = h;
  const owner = ctx.userStore.create({ username: 'owner', password: 'owner-pass-1234', role: 'admin' });
  ownerToken = ctx.authStore.issue('web', owner.id).token;
  ctx.configManager.setConfig({ loginEnabled: true });
  ctx.db.saveGroupChat({ id: 'g-relay', name: '远程协作群' });
  ctx.roomCollab.policies.setOwner('g-relay', owner.id);
  ctx.roomCollab.policies.update('g-relay', { allowGuestAgents: true, allowRemoteWorkspace: true, maxGuestAgentsPerMember: 2 });

  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-relay-target-'));
  const scripted = scriptedAdapter({ id: 'claude-code', capabilities: APPROVAL_CAPS as any, onStart: (controls) => { runs.push(controls); onStart(controls); } });
  target = createRelayTarget({
    conn: new Database(':memory:'),
    runCoordinator: new RunCoordinator({ hub: new RealtimeHub(), store: new MemoryRunStore(), log: () => {} }),
    createAdapter: (runtime) => (runtime === 'claude-code' ? scripted.adapter : null),
    secretBox: new LocalSecretBox(path.join(targetDir, 'key')),
    dataDir: targetDir,
    log: () => {},
  });
});

afterAll(async () => {
  target?.stop();
  await h?.close();
  fs.rmSync(targetDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const api = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}, token = ownerToken) => fetch(`${h.baseUrl}${url}`, {
  ...init,
  headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const json = async (response: Response) => response.json() as Promise<any>;
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met; target link = ${JSON.stringify(linkId ? target.get(linkId) : null)}`);
};
const remoteMember = () => h.ctx.db.getGroupMembers('g-relay').find((member: any) => member.runtime === 'relay');
const lastMessages = (n: number) => h.ctx.db.getRecentGroupMessages('g-relay', n);

let linkId = '';
let pairingCode = '';

describe('配对', () => {
  it('发起 → 提交 → 批准 → 票据接入 → 远程成员在线；配对码只含 host 地址与一次性秘密', async () => {
    const created = await json(await api('/api/groups/g-relay/relay/pairings', { method: 'POST', body: '{}' }));
    pairingCode = created.pairingCode;
    const code = decodePairingCode(pairingCode);
    expect(code).toMatchObject({ hostUrl: h.baseUrl, requestId: created.requestId, roomName: '远程协作群' });

    const link = await target.createLink({ pairingCode, runtime: 'claude-code', name: 'Mac Claude', description: '在 Mac 上跑', mode: 'global', model: 'haiku', trustedLan: true, targetOrigin: 'http://mac.local:3121' });
    linkId = link.id;
    expect(link.status).toBe('pending_approval');
    const pending = await json(await api('/api/groups/g-relay/relay/pairings'));
    expect(pending.pairings[0]).toMatchObject({ status: 'pending', descriptor: { name: 'Mac Claude', runtime: 'claude-code' }, targetOrigin: 'http://mac.local:3121' });
    expect((await api(`/api/groups/g-relay/relay/pairings/${created.requestId}/decision`, { method: 'POST', body: JSON.stringify({ approve: true }) })).status).toBe(200);

    await waitFor(() => target.get(linkId)?.status === 'connected');
    const member = remoteMember();
    expect(member).toMatchObject({ display_name: 'Mac Claude', runtime: 'relay', owner_kind: 'user' });
    expect(h.ctx.relay.host.isConnectorOnline(member.connector_id)).toBe(true);
    // 凭据只存 SHA-256；target 那边加密存。
    const connector = h.ctx.relay.pairings.getConnector(member.connector_id);
    expect(connector.credential_hash).toMatch(/^[0-9a-f]{64}$/);
    // 同一张票据不能再用一次。
    const replay = new WebSocket(`${h.baseUrl.replace('http', 'ws')}${RELAY_WS_PATH}`, { headers: { 'x-clawopt-relay-protocol': '1', 'x-clawopt-relay-origin': 'http://mac.local:3121', 'x-clawopt-relay-request': code.requestId, 'x-clawopt-relay-ticket': code.ticket } });
    const status = await new Promise<number>((resolve) => { replay.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)); replay.on('open', () => resolve(101)); });
    expect(status).toBe(401);
  });

  it('握手的负面用例：协议版本不对 426、错凭据 401、来源不对 401', async () => {
    const member = remoteMember();
    const tryConnect = (headers: Record<string, string>) => new Promise<{ status: number; code: string }>((resolve) => {
      const socket = new WebSocket(`${h.baseUrl.replace('http', 'ws')}${RELAY_WS_PATH}`, { headers });
      socket.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0, code: String(res.headers['x-clawopt-relay-error']) }));
      socket.on('open', () => { socket.close(); resolve({ status: 101, code: '' }); });
    });
    expect(await tryConnect({ 'x-clawopt-relay-protocol': '2', 'x-clawopt-relay-origin': 'http://mac.local:3121' })).toMatchObject({ status: 426, code: 'relay.protocolVersion' });
    expect(await tryConnect({ 'x-clawopt-relay-protocol': '1', 'x-clawopt-relay-origin': 'http://mac.local:3121', 'x-clawopt-relay-connector': member.connector_id, authorization: 'Bearer wrong-credential-value-0000000000000000000' })).toMatchObject({ status: 401, code: 'relay.credentialInvalid' });
  });
});

describe('运行', () => {
  it('群里 @ 远程 Agent：经令牌写文件、回复落库、附件消息、工作区 diff 挂在回复上；令牌不回传、跑完即失效', async () => {
    let grantToken = '';
    onStart = (controls) => {
      void (async () => {
        const prompt: string = controls.context.request.prompt;
        const baseUrl = /POST (\S+)\/actions/.exec(prompt)![1];
        grantToken = /Bearer (\S+)/.exec(prompt)![1];
        controls.emit({ type: 'response.output_text.delta', item_id: 'm', delta: `开始写文件，令牌是 ${grantToken} ` });
        const put = await fetch(`${baseUrl}/file?path=notes/hello.txt`, { method: 'PUT', body: 'hello from mac', headers: { authorization: `Bearer ${grantToken}`, 'content-type': 'application/octet-stream' } });
        const written = await put.json() as any;
        const read = await fetch(`${baseUrl}/actions`, { method: 'POST', body: JSON.stringify({ action: 'read', path: 'notes/hello.txt' }), headers: { authorization: `Bearer ${grantToken}`, 'content-type': 'application/json' } });
        const escaped = await fetch(`${baseUrl}/actions`, { method: 'POST', body: JSON.stringify({ action: 'read', path: '../openclaw.json' }), headers: { authorization: `Bearer ${grantToken}`, 'content-type': 'application/json' } });
        controls.emit({ type: 'response.output_text.delta', item_id: 'm', delta: `写好了 ${written.sha256.slice(0, 8)} 读回 ${(await read.json() as any).content} 越界 ${escaped.status}` });
        controls.finish({ kind: 'completed', outputText: `完成 ${grantToken}` });
      })();
    };
    const sent = await json(await api('/api/groups/g-relay/messages', { method: 'POST', body: JSON.stringify({ content: '@Mac Claude 写一个 hello.txt' }) }));
    expect(sent.queued).toHaveLength(1);
    await waitFor(() => lastMessages(5).some((m: any) => String(m.content).startsWith('完成')));
    const reply = lastMessages(5).find((m: any) => String(m.content).startsWith('完成'));
    expect(reply.content).toBe('完成 [redacted]');
    expect(reply.sender_id).toMatch(/^ext:relay:remote_/);
    const attachment = lastMessages(5).find((m: any) => String(m.content).includes('/uploads/'));
    expect(attachment.content).toContain('notes/hello.txt');
    expect(fs.readFileSync(path.join(h.home, '.openclaw', 'workspace-group-g-relay', 'notes', 'hello.txt'), 'utf8')).toBe('hello from mac');
    const history = await json(await api('/api/groups/g-relay/messages'));
    const decorated = history.messages.find((m: any) => m.id === reply.id);
    expect(decorated.workspace_changes[0].files.map((f: any) => [f.path, f.changeType])).toEqual([['notes/hello.txt', 'added']]);
    // 令牌随这一跳结束失效。
    const after = await fetch(`${h.baseUrl}/api/room-relay/workspace/actions`, { method: 'POST', body: JSON.stringify({ action: 'list', path: '' }), headers: { authorization: `Bearer ${grantToken}`, 'content-type': 'application/json' } });
    expect(after.status).toBe(401);
  });

  it('审批：id 在 host 重新分配，归属人答复后回到 target 的注册表', async () => {
    onStart = (controls) => {
      controls.emit({ type: 'approval.requested', request: { approvalId: 'target-approval-1', agentId: controls.context.agentId, title: 'rm -rf build?', choices: ['once', 'deny'], timeoutMs: 60_000 } });
    };
    await api('/api/groups/g-relay/messages', { method: 'POST', body: JSON.stringify({ content: '@Mac Claude 清理' }) });
    await waitFor(async () => (await json(await api('/api/groups/g-relay/interactions'))).interactions.length === 1);
    const [interaction] = (await json(await api('/api/groups/g-relay/interactions'))).interactions;
    expect(interaction.id).toMatch(/^relay:/);
    expect(interaction.title).toBe('rm -rf build?');
    await api(`/api/groups/g-relay/interactions/${encodeURIComponent(interaction.id)}/respond`, { method: 'POST', body: JSON.stringify({ choice: 'once' }) });
    const run = runs.at(-1)!;
    await waitFor(() => run.approvals.length === 1);
    expect(run.approvals[0]).toEqual({ id: 'target-approval-1', decision: 'once' });
    run.finish({ kind: 'completed', outputText: '清理完成' });
    await waitFor(() => lastMessages(3).some((m: any) => m.content === '清理完成'));
  });

  it('target 在运行中掉线：host 记结局未知（relay.outcomeUnknown），target 重连后恢复在线', async () => {
    const before = runs.length;
    onStart = (controls) => controls.emit({ type: 'response.output_text.delta', item_id: 'm', delta: '做到一半…' });
    await api('/api/groups/g-relay/messages', { method: 'POST', body: JSON.stringify({ content: '@Mac Claude 长任务' }) });
    const member = remoteMember();
    await waitFor(() => runs.length > before && !!h.ctx.runCoordinator.getActiveRun(`room:g-relay:member:${member.id}`));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 模拟 target 进程被杀：直接断开 host 那一侧看到的连接。
    target.stop();
    await waitFor(() => lastMessages(3).some((m: any) => String(m.content).includes('relay.outcomeUnknown')));
    expect(h.ctx.relay.host.isConnectorOnline(member.connector_id)).toBe(false);
    target.start();
    await waitFor(() => h.ctx.relay.host.isConnectorOnline(member.connector_id));
  });

  it('吊销 connector：远程成员移出执行、target 链接 revoked 且不再重连', async () => {
    const member = remoteMember();
    expect((await api(`/api/groups/g-relay/relay/connectors/${member.connector_id}`, { method: 'DELETE' })).status).toBe(200);
    await waitFor(() => target.get(linkId)?.status === 'revoked');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.ctx.relay.host.isConnectorOnline(member.connector_id)).toBe(false);
  });
});

describe('公开入口的处理器鉴权', () => {
  it('配对回调不带 / 带错请求密钥 404；远程工作区不带 / 带错令牌 401', async () => {
    const created = await json(await api('/api/groups/g-relay/relay/pairings', { method: 'POST', body: '{}' }));
    const anon = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${h.baseUrl}${url}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    expect((await anon(`/api/relay/v1/pairings/${created.requestId}/status`)).status).toBe(404);
    expect((await anon(`/api/relay/v1/pairings/${created.requestId}/status`, { headers: { 'x-clawopt-relay-secret': 'wrong' } })).status).toBe(404);
    expect((await anon(`/api/relay/v1/pairings/${created.requestId}/submit`, { method: 'POST', body: JSON.stringify({ targetOrigin: 'http://x:1', descriptor: { runtime: 'claude-code', name: 'X' } }) })).status).toBe(404);
    expect((await anon('/api/room-relay/workspace/actions', { method: 'POST', body: JSON.stringify({ action: 'list', path: '' }) })).status).toBe(401);
    expect((await anon('/api/room-relay/workspace/file?path=a.txt', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });
});

describe('协议判据（纯函数）', () => {
  it('事件批次：runId、seq 严格连续、类型白名单、字段有界', () => {
    expect(validateEventBatch({ runId: 'r', events: [{ seq: 1, type: 'text.delta', data: { text: 'a' } }, { seq: 2, type: 'tool.started', data: { callId: 'c', name: 'Bash' } }] }, { runId: 'r', nextSeq: 1 })).toHaveLength(2);
    expect(() => validateEventBatch({ runId: 'other', events: [{ seq: 1, type: 'text.delta', data: { text: 'a' } }] }, { runId: 'r', nextSeq: 1 })).toThrow(/staleRun/);
    expect(() => validateEventBatch({ runId: 'r', events: [{ seq: 2, type: 'text.delta', data: { text: 'a' } }] }, { runId: 'r', nextSeq: 1 })).toThrow(/eventSequence|expected seq/);
    expect(() => validateEventBatch({ runId: 'r', events: [{ seq: 1, type: 'shell.exec', data: {} }] }, { runId: 'r', nextSeq: 1 })).toThrow(/eventUnsupported|shell/);
    expect(() => validateEventBatch({ runId: 'r', events: [{ seq: 1, type: 'text.delta', data: { text: 'x'.repeat(1_000_001) } }] }, { runId: 'r', nextSeq: 1 })).toThrow(/too long/);
  });

  it('脱敏递归替换秘密', () => {
    expect(redactSecrets({ a: ['token=SECRET-12345678'], b: { c: 'SECRET-12345678' } }, ['SECRET-12345678'])).toEqual({ a: ['token=[redacted]'], b: { c: '[redacted]' } });
  });
});
