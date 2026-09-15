/**
 * relay 的 target 侧：把本机的一个 Agent（运行时）接进另一台 ClawOPT 的群。
 *
 * ## 流程
 *
 * 1. 管理员在「远程协作」页粘贴 host 给的配对码，选本机运行时、名字、模式与模型；
 * 2. target 服务端经 `core/net` 出站（协议白名单、解析后地址策略、钉 IP、不跟重定向；内网 host 要打开「受信任局域网」）
 *    向 host `submit` 描述符，然后每 1.2 秒查一次配对状态，直到批准 / 拒绝 / 过期；
 * 3. 批准后用一次性票据连 host 的 WebSocket，收到 `relay.ready` 后逐字段核对描述符回显，把长期凭据**加密落库**（本机密钥 AES-256-GCM）；
 * 4. 之后断线自动重连（1 → 30 秒退避），凭据失效 / connector 被吊销 → 链接标记 revoked，不再重连。
 *
 * ## 执行
 *
 * `run.request` 进来：同一条链接同一时刻只跑一轮（第二轮直接拒 `relay.busy`）；经**本机的运行协调器**跑本机适配器
 * （会话键 `relay:<链接>`，工作目录是本机数据目录下这条链接自己的目录）；事件经 sink 回传（单帧在途、批量协商、脱敏）；
 * host 的审批答复经本机协调器的注册表交给适配器；`run.interrupt` → 本机中止；连接断开 → 本机中止。
 * 本轮带远程工作区令牌且链接允许「远程工作区工具」时，Claude Code 放行 `Bash(curl:*)`（令牌只进 prompt，事件与错误里一律脱敏）。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import type Database from 'better-sqlite3';

import { assertOutboundUrl, pinnedFetch, pinnedLookup, type Resolver } from '../../core/net';
import type { AgentRuntimeAdapter, CanonicalEvent, LocalSecretBox, RunCoordinator, RuntimeRunRequest } from '../../runtime';
import { RelayChannel } from './channel';
import { RelayEventSink } from './event-sink';
import {
  decodePairingCode,
  descriptorsEqual,
  parseDescriptor,
  RELAY_CAPABILITY_BATCH,
  RELAY_HEADERS,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_PROMPT_CHARS,
  RELAY_PROTOCOL_VERSION,
  RELAY_WS_PATH,
  RelayProtocolError,
  redactSecrets,
  type RelayDescriptor,
} from './protocol';

export const TARGET_POLL_INTERVAL_MS = 1200;
export const TARGET_READY_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 10_000;
const RESPONSE_CAP_BYTES = 256 * 1024;
const RECONNECT_MAX_MS = 30_000;
const TERMINAL_HANDSHAKE_ERRORS = new Set(['relay.credentialInvalid', 'relay.registrationMissing', 'relay.pairingTicketInvalid', 'relay.protocolVersion']);

export type LinkStatus = 'pairing' | 'pending_approval' | 'connecting' | 'connected' | 'disconnected' | 'revoked' | 'failed';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS relay_links (
    id TEXT PRIMARY KEY,
    host_url TEXT NOT NULL,
    room_name TEXT NOT NULL DEFAULT '',
    room_id TEXT,
    request_id TEXT NOT NULL,
    pairing_secret_sealed TEXT,
    connector_id TEXT,
    credential_sealed TEXT,
    descriptor_json TEXT NOT NULL,
    local_json TEXT NOT NULL,
    target_origin TEXT NOT NULL,
    trusted_lan INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

type LinkRow = {
  id: string;
  host_url: string;
  room_name: string;
  room_id: string | null;
  request_id: string;
  pairing_secret_sealed: string | null;
  connector_id: string | null;
  credential_sealed: string | null;
  descriptor_json: string;
  local_json: string;
  target_origin: string;
  trusted_lan: number;
  status: LinkStatus;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

type LocalAgent = { runtime: string; mode: 'global' | 'scoped'; model: string; allowWorkspaceTools: boolean };

export type RelayLinkView = {
  id: string;
  hostUrl: string;
  roomName: string;
  roomId: string | null;
  status: LinkStatus;
  connected: boolean;
  lastError: string | null;
  descriptor: RelayDescriptor;
  local: LocalAgent;
  trustedLan: boolean;
  running: boolean;
  createdAt: number;
};

type LinkRuntime = {
  channel: RelayChannel | null;
  socket: WebSocket | null;
  runId: string | null;
  reconnectDelay: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
};

export type RelayTargetDeps = {
  conn: Database.Database;
  runCoordinator: Pick<RunCoordinator, 'submit' | 'abort' | 'respondInteraction'>;
  createAdapter: (runtime: string) => AgentRuntimeAdapter<RuntimeRunRequest> | null;
  secretBox: Pick<LocalSecretBox, 'seal' | 'unseal'>;
  dataDir: string;
  resolver?: Resolver;
  now?: () => number;
  log?: (message: string) => void;
};

export class RelayTargetError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'RelayTargetError';
  }
}

export function createRelayTarget(deps: RelayTargetDeps) {
  const { conn } = deps;
  conn.exec(SCHEMA);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const runtimes = new Map<string, LinkRuntime>();

  const get = (id: string) => (conn.prepare('SELECT * FROM relay_links WHERE id = ?').get(id) as LinkRow | undefined) ?? null;
  const setStatus = (id: string, status: LinkStatus, error: string | null = null) => {
    conn.prepare('UPDATE relay_links SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, error ? error.slice(0, 500) : null, now(), id);
  };
  const runtimeOf = (id: string): LinkRuntime => {
    let state = runtimes.get(id);
    if (!state) {
      state = { channel: null, socket: null, runId: null, reconnectDelay: 1000, reconnectTimer: null, pollTimer: null, stopped: false };
      runtimes.set(id, state);
    }
    return state;
  };
  const aad = (row: Pick<LinkRow, 'id' | 'host_url'>, kind: string) => `relay-link:${row.id}:${row.host_url}:${kind}`;
  const unsealText = (row: LinkRow, value: string | null, kind: string) => (value ? deps.secretBox.unseal(JSON.parse(value), aad(row, kind)) : null);

  function view(row: LinkRow): RelayLinkView {
    const state = runtimes.get(row.id);
    return {
      id: row.id,
      hostUrl: row.host_url,
      roomName: row.room_name,
      roomId: row.room_id,
      status: row.status,
      connected: state?.channel?.isOpen === true,
      lastError: row.last_error,
      descriptor: JSON.parse(row.descriptor_json),
      local: JSON.parse(row.local_json),
      trustedLan: row.trusted_lan === 1,
      running: !!state?.runId,
      createdAt: row.created_at,
    };
  }

  /** 出站 HTTP：地址策略 + 钉 IP + 不跟重定向 + 超时 + 响应上限。 */
  async function hostFetch(row: Pick<LinkRow, 'host_url' | 'trusted_lan'>, pathname: string, init: { method: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; json: any }> {
    const { url, address } = await assertOutboundUrl(`${row.host_url}${pathname}`, { allowPrivateNetwork: row.trusted_lan === 1, resolver: deps.resolver });
    const response = await pinnedFetch(url, address, {
      method: init.method,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) throw new RelayTargetError(502, 'relay.redirectRefused');
    const text = await response.text();
    if (Buffer.byteLength(text) > RESPONSE_CAP_BYTES) throw new RelayTargetError(502, 'relay.responseTooLarge');
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  async function createLink(input: { pairingCode: unknown; runtime: unknown; name: unknown; description?: unknown; mode?: unknown; model?: unknown; trustedLan?: unknown; allowWorkspaceTools?: unknown; targetOrigin: string }): Promise<RelayLinkView> {
    const code = decodePairingCode(String(input.pairingCode ?? ''));
    const descriptor = parseDescriptor({ runtime: input.runtime, name: input.name, description: input.description ?? '', mode: input.mode ?? 'global', model: input.model ?? '' });
    if (!deps.createAdapter(descriptor.runtime)) throw new RelayTargetError(400, 'runtime.unknown', descriptor.runtime);
    const id = crypto.randomUUID();
    const t = now();
    const base = { id, host_url: code.hostUrl };
    const local: LocalAgent = { runtime: descriptor.runtime, mode: descriptor.mode, model: descriptor.model, allowWorkspaceTools: input.allowWorkspaceTools !== false };
    conn.prepare(`INSERT INTO relay_links (id, host_url, room_name, request_id, pairing_secret_sealed, descriptor_json, local_json, target_origin, trusted_lan, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pairing', ?, ?)`).run(
      id, code.hostUrl, code.roomName, code.requestId,
      JSON.stringify(deps.secretBox.seal(JSON.stringify({ secret: code.secret, ticket: code.ticket }), aad(base, 'pairing'))),
      JSON.stringify(descriptor), JSON.stringify(local), input.targetOrigin, input.trustedLan === true ? 1 : 0, t, t,
    );
    const row = get(id)!;
    try {
      const submitted = await hostFetch(row, `/api/relay/v1/pairings/${encodeURIComponent(code.requestId)}/submit`, {
        method: 'POST', headers: { [RELAY_HEADERS.secret]: code.secret }, body: { targetOrigin: input.targetOrigin, descriptor },
      });
      if (submitted.status !== 200) throw new RelayTargetError(submitted.status === 404 ? 404 : 409, String(submitted.json?.errorCode ?? 'relay.submitFailed'));
    } catch (error) {
      const codeText = error instanceof RelayTargetError ? error.code : (error as { errorCode?: string }).errorCode ?? 'relay.hostUnreachable';
      setStatus(id, 'failed', codeText);
      throw error instanceof RelayTargetError ? error : new RelayTargetError(502, codeText, (error as Error).message);
    }
    setStatus(id, 'pending_approval');
    schedulePoll(id);
    return view(get(id)!);
  }

  function pairingSecrets(row: LinkRow): { secret: string; ticket: string } | null {
    const text = unsealText(row, row.pairing_secret_sealed, 'pairing');
    return text ? JSON.parse(text) : null;
  }

  function schedulePoll(id: string): void {
    const state = runtimeOf(id);
    if (state.pollTimer || state.stopped) return;
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null;
      void pollOnce(id);
    }, TARGET_POLL_INTERVAL_MS);
    state.pollTimer.unref?.();
  }

  async function pollOnce(id: string): Promise<void> {
    const row = get(id);
    if (!row || row.status !== 'pending_approval') return;
    const secrets = pairingSecrets(row);
    if (!secrets) {
      setStatus(id, 'failed', 'pairing secrets unavailable');
      return;
    }
    if (now() - row.created_at > 10.5 * 60_000) {
      setStatus(id, 'failed', 'relay.pairingExpired');
      return;
    }
    try {
      const status = await hostFetch(row, `/api/relay/v1/pairings/${encodeURIComponent(row.request_id)}/status`, { method: 'GET', headers: { [RELAY_HEADERS.secret]: secrets.secret } });
      const value = String(status.json?.status ?? '');
      if (value === 'approved') {
        setStatus(id, 'connecting');
        connect(id);
        return;
      }
      if (['rejected', 'expired', 'failed', 'consumed'].includes(value) || status.status === 404) {
        setStatus(id, 'failed', status.json?.reason ?? `relay.pairing${value ? value[0].toUpperCase() + value.slice(1) : 'NotFound'}`);
        return;
      }
    } catch (error) {
      log(`[RelayTarget] pairing status poll failed for ${id}: ${(error as Error).message}`);
    }
    schedulePoll(id);
  }

  function scheduleReconnect(id: string): void {
    const state = runtimeOf(id);
    if (state.stopped || state.reconnectTimer) return;
    const row = get(id);
    if (!row || !row.connector_id || ['revoked', 'failed'].includes(row.status)) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect(id);
    }, state.reconnectDelay);
    state.reconnectTimer.unref?.();
    state.reconnectDelay = Math.min(RECONNECT_MAX_MS, state.reconnectDelay * 2);
  }

  function connect(id: string): void {
    void connectAsync(id).catch((error) => {
      log(`[RelayTarget] connect failed for ${id}: ${(error as Error).message}`);
      const row = get(id);
      if (!row) return;
      const code = (error as { code?: string }).code ?? (error as { errorCode?: string }).errorCode ?? '';
      if (TERMINAL_HANDSHAKE_ERRORS.has(code)) {
        setStatus(id, row.connector_id ? 'revoked' : 'failed', code);
        return;
      }
      setStatus(id, row.connector_id ? 'disconnected' : 'failed', code || (error as Error).message);
      if (row.connector_id) scheduleReconnect(id);
    });
  }

  async function connectAsync(id: string): Promise<void> {
    const row = get(id);
    if (!row) return;
    const state = runtimeOf(id);
    if (state.channel?.isOpen) return;
    const wsUrl = `${row.host_url.replace(/^http/, 'ws')}${RELAY_WS_PATH}`;
    const { url, address } = await assertOutboundUrl(wsUrl, { protocols: ['ws:', 'wss:'], allowPrivateNetwork: row.trusted_lan === 1, resolver: deps.resolver });
    const headers: Record<string, string> = {
      [RELAY_HEADERS.protocol]: String(RELAY_PROTOCOL_VERSION),
      [RELAY_HEADERS.origin]: row.target_origin,
      [RELAY_HEADERS.capabilities]: RELAY_CAPABILITY_BATCH,
    };
    if (row.connector_id) {
      const credential = unsealText(row, row.credential_sealed, 'credential');
      if (!credential) throw new RelayProtocolError('relay.credentialInvalid', 'stored credential unavailable');
      headers[RELAY_HEADERS.connector] = row.connector_id;
      headers.authorization = `Bearer ${credential}`;
    } else {
      const secrets = pairingSecrets(row);
      if (!secrets) throw new RelayProtocolError('relay.pairingTicketInvalid');
      headers[RELAY_HEADERS.request] = row.request_id;
      headers[RELAY_HEADERS.ticket] = secrets.ticket;
    }

    const socket = new WebSocket(url, { headers, lookup: pinnedLookup(address), maxPayload: RELAY_MAX_FRAME_BYTES, handshakeTimeout: HTTP_TIMEOUT_MS, followRedirects: false });
    state.socket = socket;
    // 帧监听必须在握手完成之前挂上：host 接受升级后立刻发 relay.ready，它可能和 101 响应在同一个 TCP 包里到达。
    const channel = new RelayChannel(socket, log);
    const readyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RelayProtocolError('relay.readyTimeout')), HTTP_TIMEOUT_MS + TARGET_READY_TIMEOUT_MS);
      timer.unref?.();
      channel.onEvent('relay.ready', (data) => {
        clearTimeout(timer);
        resolve((data ?? {}) as Record<string, unknown>);
      });
      channel.onClose(() => {
        clearTimeout(timer);
        reject(new RelayProtocolError('relay.closedBeforeReady'));
      });
    });
    readyPromise.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('unexpected-response', (_req, res) => {
        const code = String(res.headers['x-clawopt-relay-error'] ?? `relay.http${res.statusCode}`);
        socket.terminate();
        reject(Object.assign(new RelayProtocolError(code), { code }));
      });
      socket.once('error', (error) => reject(error));
    });
    state.channel = channel;
    const ready = await readyPromise;

    // 回显核对：协议版本、connector id 形状、描述符逐字段相等；首次配对必须带凭据。
    const descriptor = parseDescriptor(ready.descriptor);
    const expected = parseDescriptor(JSON.parse(row.descriptor_json));
    const connectorId = typeof ready.connectorId === 'string' ? ready.connectorId : '';
    if (ready.protocolVersion !== RELAY_PROTOCOL_VERSION || !/^[0-9a-f-]{36}$/.test(connectorId) || !descriptorsEqual(descriptor, expected)
      || (row.connector_id && row.connector_id !== connectorId)) {
      channel.close(1002, 'ready mismatch');
      throw new RelayProtocolError('relay.readyMismatch');
    }
    if (!row.connector_id) {
      const credential = typeof ready.credential === 'string' ? ready.credential : '';
      if (!/^[A-Za-z0-9_-]{40,}$/.test(credential)) {
        channel.close(1002, 'credential missing');
        throw new RelayProtocolError('relay.readyMismatch', 'credential missing');
      }
      conn.prepare('UPDATE relay_links SET connector_id = ?, credential_sealed = ?, pairing_secret_sealed = NULL, room_id = ?, room_name = ?, updated_at = ? WHERE id = ?')
        .run(connectorId, JSON.stringify(deps.secretBox.seal(credential, aad(row, 'credential'))), String(ready.roomId ?? ''), String(ready.roomName ?? row.room_name), now(), id);
    }
    state.reconnectDelay = 1000;
    setStatus(id, 'connected');
    const capabilities = Array.isArray(ready.capabilities) ? ready.capabilities.map(String) : [];
    attachRunHandlers(id, channel, capabilities.includes(RELAY_CAPABILITY_BATCH));
    channel.onEvent('connector.revoked', () => {
      setStatus(id, 'revoked', 'connector revoked by host');
      runtimeOf(id).stopped = true;
    });
    channel.onClose(() => {
      const current = runtimeOf(id);
      if (current.channel === channel) current.channel = null;
      if (current.runId) void deps.runCoordinator.abort(`relay:${id}`, 'user_stop');
      const latest = get(id);
      if (latest && latest.status === 'connected') setStatus(id, 'disconnected');
      if (!current.stopped) scheduleReconnect(id);
    });
  }

  function credentialOf(id: string): string | null {
    const row = get(id);
    return row ? unsealText(row, row.credential_sealed, 'credential') : null;
  }

  function attachRunHandlers(id: string, channel: RelayChannel, batching: boolean): void {
    channel.onRequest('run.request', (data) => {
      const state = runtimeOf(id);
      const row = get(id);
      const request = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      if (!row) throw new RelayProtocolError('relay.linkMissing');
      if (request.protocolVersion !== RELAY_PROTOCOL_VERSION) throw new RelayProtocolError('relay.protocolVersion');
      const runId = typeof request.runId === 'string' && /^[0-9a-f-]{36}$/.test(request.runId) ? request.runId : '';
      const prompt = typeof request.prompt === 'string' ? request.prompt : '';
      if (!runId || !prompt || prompt.length > RELAY_MAX_PROMPT_CHARS) throw new RelayProtocolError('relay.runInvalid');
      if (state.runId) throw new RelayProtocolError('relay.busy');
      const workspaceApi = request.workspaceApi && typeof request.workspaceApi === 'object' ? request.workspaceApi as { baseUrl?: unknown; token?: unknown } : null;
      const grantToken = typeof workspaceApi?.token === 'string' ? workspaceApi.token : null;
      state.runId = runId;
      void executeRun(id, row, channel, { runId, prompt, grantToken, batching }).finally(() => {
        if (runtimeOf(id).runId === runId) runtimeOf(id).runId = null;
      });
      return { accepted: true };
    });
    channel.onRequest('approval.respond', (data) => respond(id, data, 'approvalId'));
    channel.onRequest('clarify.respond', (data) => respond(id, data, 'clarifyId'));
    channel.onRequest('run.interrupt', async (data) => {
      const state = runtimeOf(id);
      const runId = (data as { runId?: unknown })?.runId;
      if (!state.runId || runId !== state.runId) return { interrupted: false };
      void deps.runCoordinator.abort(`relay:${id}`, 'user_stop');
      return { interrupted: true };
    });
  }

  function respond(id: string, data: unknown, idField: 'approvalId' | 'clarifyId') {
    const state = runtimeOf(id);
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (!state.runId || record.runId !== state.runId) throw new RelayProtocolError('relay.staleRun');
    const interactionId = String(record[idField] ?? '');
    const result = deps.runCoordinator.respondInteraction(`relay:${id}`, interactionId, idField === 'approvalId'
      ? { choice: String(record.choice ?? 'deny') }
      : { text: String(record.text ?? '') });
    return { resolved: result.resolved };
  }

  async function executeRun(id: string, row: LinkRow, channel: RelayChannel, input: { runId: string; prompt: string; grantToken: string | null; batching: boolean }): Promise<void> {
    const local: LocalAgent = JSON.parse(row.local_json);
    const descriptor: RelayDescriptor = JSON.parse(row.descriptor_json);
    const secrets = () => [input.grantToken ?? '', credentialOf(id) ?? ''].filter(Boolean);
    let fatal: Error | null = null;
    const sink = new RelayEventSink(channel, input.runId, {
      batching: input.batching,
      secrets,
      onFatal: (error) => {
        fatal = error;
        void deps.runCoordinator.abort(`relay:${id}`, 'user_stop');
        channel.close(1011, 'event sink failure');
      },
    });
    const adapter = deps.createAdapter(local.runtime);
    const reportFailure = async (error: string, interrupted = false) => {
      await channel.request('run.failed', { runId: input.runId, error: redactSecrets(error, secrets()).slice(0, 2000), interrupted }, 10_000).catch(() => undefined);
    };
    if (!adapter) {
      await reportFailure(`runtime.unknown: ${local.runtime}`);
      return;
    }
    const workspace = path.join(deps.dataDir, 'relay', 'workspaces', id);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const request: RuntimeRunRequest = {
      mode: local.mode,
      owner: { kind: 'session', sessionId: `relay-link-${id}` },
      sessionId: crypto.randomUUID(),
      resume: false,
      prompt: input.prompt,
      workspace,
      model: local.mode === 'global' && local.model ? local.model : undefined,
      runtimeConfig: local.mode === 'scoped' ? { model: local.model } : {},
      allowedTools: input.grantToken && local.allowWorkspaceTools && local.runtime === 'claude-code' ? ['Bash(curl:*)'] : undefined,
    };
    const submitted = await deps.runCoordinator.submit({
      sessionKey: `relay:${id}`,
      surface: 'room',
      topics: [`session:relay:${id}`],
      agentId: `ext:${local.runtime}:relay`,
      title: descriptor.name,
      adapter,
      request,
      proxyMode: local.mode,
      workspacePath: workspace,
      projector: () => ({
        onEvent(event: CanonicalEvent) {
          switch (event.type) {
            case 'response.output_text.delta':
              if (event.delta) sink.push('text.delta', { text: event.delta });
              break;
            case 'response.reasoning.delta':
              if (event.delta) sink.push('reasoning.delta', { text: event.delta });
              break;
            case 'response.output_item.added':
              if (event.item.type === 'function_call') sink.push('tool.started', { callId: event.item.call_id, name: event.item.name, arguments: event.item.arguments });
              break;
            case 'response.output_item.done':
              if (event.item.type === 'function_call_output') sink.push('tool.completed', { callId: event.item.call_id, output: event.item.output, status: event.item.status ?? 'completed' });
              break;
            case 'approval.requested':
              sink.push('approval.requested', { approvalId: event.request.approvalId, title: event.request.title, description: event.request.description ?? '', command: event.request.command ?? '', choices: [...event.request.choices], timeoutMs: event.request.timeoutMs });
              break;
            case 'clarify.requested':
              sink.push('clarify.requested', { clarifyId: event.request.clarifyId, question: event.request.question, choices: event.request.choices ? [...event.request.choices] : null, timeoutMs: event.request.timeoutMs });
              break;
            default:
              break;
          }
        },
        finish: (outcome) => ({ output: outcome.kind === 'completed' ? outcome.outputText : undefined }),
      }),
    }, 'reject');
    if (submitted.status !== 'started') {
      await reportFailure('relay.busy');
      return;
    }
    const terminal = await submitted.completion;
    if (fatal) return;
    try {
      await sink.drain();
    } catch {
      return;
    }
    if (terminal.outcome.kind === 'completed') {
      const outputText = terminal.projection.output ?? terminal.outcome.outputText ?? '';
      await channel.request('run.completed', { runId: input.runId, outputText: redactSecrets(outputText, secrets()) }, 10_000).catch(() => undefined);
    } else if (terminal.outcome.kind === 'aborted') {
      await reportFailure('interrupted', true);
    } else {
      await reportFailure(terminal.outcome.error || terminal.outcome.code || 'failed');
    }
  }

  async function deleteLink(id: string): Promise<boolean> {
    const row = get(id);
    if (!row) return false;
    const state = runtimeOf(id);
    state.stopped = true;
    if (state.pollTimer) clearTimeout(state.pollTimer);
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.channel?.isOpen) {
      await state.channel.request('connector.revoke', {}, 2000).catch(() => undefined);
      state.channel.close(1000, 'link deleted');
    } else if (row.status === 'pending_approval') {
      const secrets = pairingSecrets(row);
      if (secrets) await hostFetch(row, `/api/relay/v1/pairings/${encodeURIComponent(row.request_id)}/failure`, { method: 'POST', headers: { [RELAY_HEADERS.secret]: secrets.secret }, body: { reason: 'cancelled by target' } }).catch(() => undefined);
    }
    runtimes.delete(id);
    conn.prepare('DELETE FROM relay_links WHERE id = ?').run(id);
    return true;
  }

  function reconnect(id: string): boolean {
    const row = get(id);
    if (!row || !row.connector_id || row.status === 'revoked') return false;
    const state = runtimeOf(id);
    state.stopped = false;
    state.reconnectDelay = 1000;
    connect(id);
    return true;
  }

  function list(): RelayLinkView[] {
    return (conn.prepare('SELECT * FROM relay_links ORDER BY created_at DESC').all() as LinkRow[]).map(view);
  }

  function start(): void {
    for (const row of conn.prepare("SELECT * FROM relay_links WHERE status NOT IN ('revoked', 'failed')").all() as LinkRow[]) {
      if (row.connector_id) connect(row.id);
      else if (row.status === 'pending_approval') schedulePoll(row.id);
    }
  }

  function stop(): void {
    for (const [id, state] of runtimes) {
      state.stopped = true;
      if (state.pollTimer) clearTimeout(state.pollTimer);
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.channel?.close(1001, 'shutdown');
      state.socket?.terminate();
      runtimes.delete(id);
    }
  }

  /** 运行时目录的归属判定（`relay-link-<id>` 会话）：链接还在就不回收。 */
  function ownsHome(sessionId: string): boolean {
    if (!sessionId.startsWith('relay-link-')) return false;
    return !!get(sessionId.slice('relay-link-'.length));
  }

  return { createLink, deleteLink, reconnect, list, start, stop, ownsHome, get: (id: string) => { const row = get(id); return row ? view(row) : null; } };
}

export type RelayTarget = ReturnType<typeof createRelayTarget>;
