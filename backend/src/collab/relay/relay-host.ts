/**
 * relay 的 host 侧：WebSocket 接入（配对票据 / connector 凭据）、远程成员的运行时适配器、远程工作区令牌。
 *
 * ## 适配器（执行器可替换的那个接口）
 *
 * 远程成员（`group_members.runtime = 'relay'`）的运行照样经运行协调器：会话行、中止宽限、审批注册表、工具调用落库都在协调器里；
 * 这个适配器只把 `run.request` 发出去、把 target 回来的 `agent.events` 翻译成规范事件。
 * 审批 / 澄清的 id 在 host 侧重新分配（`relay:<runId>:<n>`），答复时再换回 target 的 id——target 伪造不了 host 注册表里的请求。
 * 深度、链、发起人都由 host 的编排器按它派发的那一跳签发，target 回传的任何字段都不参与路由。
 *
 * ## 结局判定
 *
 * 只有 target 发来的 `run.failed` 是权威失败；连接断开、事件校验失败、中止没有确认、接受超时 → `failed` + `relay.outcomeUnknown`。
 *
 * ## 远程工作区令牌
 *
 * 每跳一枚：32 字节随机 base64url，只存 SHA-256；有效期 = 房间总预算（上限 4 小时），跑完即吊销并等进行中的写入排空再算 diff；
 * 全局 ≤1000 枚，每枚 ≤200 次请求（超出即吊销）。路径规则与群工作区编辑器同一套（相对路径、realpath 在根内、敏感名字拒绝、SHA-256 并发）。
 */
import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';

import type { DB, GroupMemberRow } from '../../core/db';
import {
  RELAY_OUTCOME_UNKNOWN_CODE,
  RELAY_RUNTIME_ID,
  WorkspaceFiles,
  type RoomCollab,
  type RoomPolicy,
} from '../rooms';
import {
  defineCapabilities,
  NATIVE_ONLY_SOURCE_OF_TRUTH,
  type AdapterRunContext,
  type AdapterRunHandle,
  type AdapterRunOutcome,
  type AgentRuntimeAdapter,
  type ApprovalDecision,
  type RuntimeRunRequest,
} from '../../runtime';
import { RelayChannel, RelayChannelClosedError, RelayRequestError } from './channel';
import type { HostPairingStore, PairingRequester } from './host-pairing-store';
import {
  parseDescriptor,
  RELAY_ACCEPT_TIMEOUT_MS,
  RELAY_HEADERS,
  RELAY_HOST_CAPABILITIES,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_PROMPT_CHARS,
  RELAY_PROTOCOL_VERSION,
  RELAY_WS_PATH,
  RelayProtocolError,
  validateEventBatch,
  type RelayDescriptor,
} from './protocol';

export const RELAY_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: false,
  approvals: true,
  clarify: true,
  hostCompression: false,
  nativeCompact: false,
  backgroundDelegation: false,
  images: false,
  mcpInjection: false,
  proxyMode: ['global', 'scoped'],
});

export const RELAY_INTERRUPT_ACK_MS = 5000;
export const RELAY_REVOKE_CLOSE_DELAY_MS = 250;
const GRANT_MAX_ACTIVE = 1000;
export const GRANT_MAX_REQUESTS = 200;
const GRANT_MAX_TTL_MS = 4 * 3600_000;

type ActiveRelayRun = {
  runId: string;
  nextSeq: number;
  approvals: Map<string, string>;
  clarifies: Map<string, string>;
  counter: number;
  finish: (outcome: AdapterRunOutcome) => void;
  context: AdapterRunContext<RuntimeRunRequest>;
  interrupting: boolean;
};

type HostConnection = {
  connectorId: string;
  groupId: string;
  memberId: string;
  channel: RelayChannel;
  run: ActiveRelayRun | null;
};

export type WorkspaceGrant = {
  tokenHash: string;
  groupId: string;
  memberId: string;
  files: WorkspaceFiles;
  workspacePath: string;
  expiresAt: number;
  requests: number;
  revoked: boolean;
};

export type RelayHostDeps = {
  db: DB;
  pairings: HostPairingStore;
  collab: RoomCollab;
  /** 引擎的消息事件出口（远程 Agent 上传文件自动发附件消息用）。 */
  emitMessage: (payload: Record<string, unknown>) => void;
  isHostAllowed: (req: IncomingMessage) => boolean;
  now?: () => number;
  log?: (message: string) => void;
};

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value ?? '').toString().trim();
}

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} Relay Rejected\r\nConnection: close\r\nx-clawopt-relay-error: ${code}\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // 已断开。
  }
  socket.destroy();
}

export function createRelayHost(deps: RelayHostDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_FRAME_BYTES });
  const connections = new Map<string, HostConnection>();
  const grants = new Map<string, WorkspaceGrant>();

  // ------------------------------------------------------------ 接入

  function nameTaken(groupId: string, name: string): boolean {
    const lower = name.trim().toLowerCase();
    return deps.collab.members(groupId).some((member) => member.display_name.trim().toLowerCase() === lower);
  }

  function createRemoteMember(groupId: string, descriptor: RelayDescriptor, owner: PairingRequester): GroupMemberRow {
    const agentId = `remote_${crypto.randomUUID()}`;
    const id = `gm_${groupId}_${agentId}`;
    const position = deps.db.getGroupMembers(groupId).reduce((max, member) => Math.max(max, member.position ?? 0), -1) + 1;
    deps.db.saveGroupMember({
      id, group_id: groupId, agent_id: agentId, display_name: descriptor.name, role_description: descriptor.description, position,
      runtime: RELAY_RUNTIME_ID, external_config: JSON.stringify({ remoteRuntime: descriptor.runtime, mode: descriptor.mode, model: descriptor.model }),
    });
    deps.db.connection().prepare('UPDATE group_members SET owner_kind = ?, owner_user_id = ?, owner_guest_id = ? WHERE id = ?')
      .run(owner.kind, owner.kind === 'user' ? owner.userId : null, owner.kind === 'guest' ? owner.guestId : null, id);
    return deps.db.getGroupMembers(groupId).find((member) => member.id === id)!;
  }

  function attachConnectorToMember(memberId: string, connectorId: string): void {
    const member = deps.db.connection().prepare('SELECT external_config FROM group_members WHERE id = ?').get(memberId) as { external_config: string | null } | undefined;
    const config = member?.external_config ? JSON.parse(member.external_config) : {};
    deps.db.connection().prepare('UPDATE group_members SET connector_id = ?, external_config = ? WHERE id = ?').run(connectorId, JSON.stringify({ ...config, connectorId }), memberId);
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== RELAY_WS_PATH) return false;
    try {
      if (!deps.isHostAllowed(req)) {
        rejectUpgrade(socket, 403, 'relay.hostNotAllowed');
        return true;
      }
      if (headerValue(req, RELAY_HEADERS.protocol) !== String(RELAY_PROTOCOL_VERSION)) {
        rejectUpgrade(socket, 426, 'relay.protocolVersion');
        return true;
      }
      const origin = headerValue(req, RELAY_HEADERS.origin);
      const requestId = headerValue(req, RELAY_HEADERS.request);
      const ticket = headerValue(req, RELAY_HEADERS.ticket);
      const connectorId = headerValue(req, RELAY_HEADERS.connector);
      const authorization = headerValue(req, 'authorization');
      const credential = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';

      let ready: { connectorId: string; groupId: string; memberId: string; credential?: string; descriptor: RelayDescriptor };
      if (requestId && ticket) {
        const pairing = deps.pairings.claimTicket(requestId, ticket, origin);
        try {
          const descriptor = parseDescriptor(JSON.parse(pairing.descriptor_json ?? 'null'));
          if (nameTaken(pairing.group_id, descriptor.name)) throw new RelayProtocolError('relay.nameConflict');
          const policy = deps.collab.policies.get(pairing.group_id);
          if (!policy?.allowGuestAgents) throw new RelayProtocolError('relay.guestAgentsDisabled');
          const owner: PairingRequester = pairing.requester_kind === 'user'
            ? { kind: 'user', userId: pairing.requester_user_id, name: pairing.requester_name }
            : { kind: 'guest', guestId: pairing.requester_guest_id ?? '', name: pairing.requester_name };
          const member = createRemoteMember(pairing.group_id, descriptor, owner);
          const connector = deps.pairings.createConnector({ groupId: pairing.group_id, memberId: member.id, owner, targetOrigin: origin, descriptor, hostBaseUrl: pairing.host_base_url });
          attachConnectorToMember(member.id, connector.id);
          deps.pairings.completePairing(requestId, member.id, connector.id);
          ready = { connectorId: connector.id, groupId: pairing.group_id, memberId: member.id, credential: connector.credential, descriptor };
          deps.collab.publish(pairing.group_id, { type: 'agents', data: { changed: true } });
          deps.collab.publish(pairing.group_id, { type: 'pairing', data: { changed: true } });
        } catch (error) {
          deps.pairings.releaseTicket(requestId, (error as Error).message);
          throw error;
        }
      } else if (connectorId && credential) {
        const connector = deps.pairings.verifyConnector(connectorId, credential, origin);
        const member = deps.db.getGroupMembers(connector.group_id).find((row) => row.id === connector.member_id);
        if (!member || member.runtime !== RELAY_RUNTIME_ID || (member as GroupMemberRow & { connector_id?: string }).connector_id !== connector.id) {
          throw new RelayProtocolError('relay.registrationMissing');
        }
        ready = { connectorId: connector.id, groupId: connector.group_id, memberId: member.id, descriptor: parseDescriptor(JSON.parse(connector.descriptor_json)) };
      } else {
        throw new RelayProtocolError('relay.credentialInvalid');
      }

      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, ready));
    } catch (error) {
      const code = error instanceof RelayProtocolError ? error.code : 'relay.handshakeFailed';
      rejectUpgrade(socket, code === 'relay.pairingTicketInvalid' || code === 'relay.credentialInvalid' || code === 'relay.registrationMissing' ? 401 : 403, code);
    }
    return true;
  }

  function accept(ws: WebSocket, ready: { connectorId: string; groupId: string; memberId: string; credential?: string; descriptor: RelayDescriptor }): void {
    const previous = connections.get(ready.connectorId);
    if (previous) {
      failRun(previous, 'replaced by a newer connection');
      previous.channel.close(4000, 'replaced');
    }
    const channel = new RelayChannel(ws, log);
    const connection: HostConnection = { connectorId: ready.connectorId, groupId: ready.groupId, memberId: ready.memberId, channel, run: null };
    connections.set(ready.connectorId, connection);
    deps.pairings.markSeen(ready.connectorId);
    const group = deps.db.getGroupChat(ready.groupId);

    channel.onRequest('agent.events', (data) => handleEvents(connection, data));
    channel.onRequest('run.completed', (data) => handleTerminal(connection, data, true));
    channel.onRequest('run.failed', (data) => handleTerminal(connection, data, false));
    channel.onRequest('connector.revoke', () => {
      revokeConnector(ready.connectorId, 'revoked by target');
      return { revoked: true };
    });
    channel.onClose(() => {
      if (connections.get(ready.connectorId) === connection) connections.delete(ready.connectorId);
      failRun(connection, 'relay connection closed');
      deps.collab.publish(ready.groupId, { type: 'agents', data: { changed: true } });
    });

    channel.emit('relay.ready', {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      capabilities: RELAY_HOST_CAPABILITIES,
      connectorId: ready.connectorId,
      ...(ready.credential ? { credential: ready.credential } : {}),
      roomId: ready.groupId,
      roomName: group?.name ?? ready.groupId,
      descriptor: ready.descriptor,
    });
    deps.collab.publish(ready.groupId, { type: 'agents', data: { changed: true } });
  }

  // ------------------------------------------------------------ 运行

  function failRun(connection: HostConnection, reason: string): void {
    const run = connection.run;
    if (!run) return;
    connection.run = null;
    run.finish({ kind: 'failed', error: reason, code: RELAY_OUTCOME_UNKNOWN_CODE });
  }

  function handleEvents(connection: HostConnection, data: unknown): { ok: true } {
    const run = connection.run;
    if (!run) throw new RelayProtocolError('relay.staleRun');
    let events;
    try {
      events = validateEventBatch(data, { runId: run.runId, nextSeq: run.nextSeq });
    } catch (error) {
      // 事件不可信：这一跳按「结局未知」收尾，并让 target 停下。
      void connection.channel.request('run.interrupt', { runId: run.runId, reason: 'invalid events' }, RELAY_INTERRUPT_ACK_MS).catch(() => undefined);
      failRun(connection, `invalid relay events: ${(error as Error).message}`);
      throw error;
    }
    run.nextSeq += events.length;
    const emit = run.context.emit.bind(run.context);
    for (const event of events) {
      const d = event.data;
      switch (event.type) {
        case 'text.delta':
          emit({ channel: 'native', event: { type: 'response.output_text.delta', item_id: `relay:${run.runId}:text`, delta: String(d.text) } });
          break;
        case 'reasoning.delta':
          emit({ channel: 'native', event: { type: 'response.reasoning.delta', item_id: `relay:${run.runId}:reasoning`, delta: String(d.text) } });
          break;
        case 'tool.started':
          emit({ channel: 'native', event: { type: 'response.output_item.added', item: { type: 'function_call', id: `relay:${d.callId}`, call_id: String(d.callId), name: String(d.name), arguments: String(d.arguments) } } });
          break;
        case 'tool.completed':
          emit({ channel: 'native', event: { type: 'response.output_item.done', item: { type: 'function_call_output', id: `relay:${d.callId}:out`, call_id: String(d.callId), output: String(d.output), status: d.status === 'failed' ? 'failed' : 'completed' } } });
          break;
        case 'approval.requested': {
          run.counter += 1;
          const hostId = `relay:${run.runId}:a${run.counter}`;
          run.approvals.set(hostId, String(d.approvalId));
          emit({ channel: 'native', event: { type: 'approval.requested', request: {
            approvalId: hostId, agentId: run.context.agentId, title: String(d.title), description: String(d.description) || undefined,
            command: String(d.command) || undefined, choices: d.choices as Array<'once' | 'session' | 'always' | 'deny'>, timeoutMs: Number(d.timeoutMs),
          } } });
          break;
        }
        case 'clarify.requested': {
          run.counter += 1;
          const hostId = `relay:${run.runId}:c${run.counter}`;
          run.clarifies.set(hostId, String(d.clarifyId));
          emit({ channel: 'native', event: { type: 'clarify.requested', request: { clarifyId: hostId, agentId: run.context.agentId, question: String(d.question), choices: d.choices as string[] | null, timeoutMs: Number(d.timeoutMs) } } });
          break;
        }
        case 'interaction.resolved':
          break;
      }
    }
    return { ok: true };
  }

  function handleTerminal(connection: HostConnection, data: unknown, completed: boolean): { ok: true } {
    const run = connection.run;
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (!run || record.runId !== run.runId) throw new RelayProtocolError('relay.staleRun');
    connection.run = null;
    if (completed) {
      run.finish({ kind: 'completed', outputText: typeof record.outputText === 'string' ? record.outputText.slice(0, RELAY_MAX_PROMPT_CHARS) : undefined });
    } else if (record.interrupted === true && run.interrupting) {
      run.finish({ kind: 'aborted', reason: 'user_stop', synced: true, phase: 'running' });
    } else {
      run.finish({ kind: 'failed', error: typeof record.error === 'string' ? record.error.slice(0, 2000) : 'remote run failed', code: 'relay.remoteRunFailed' });
    }
    return { ok: true };
  }

  const adapter: AgentRuntimeAdapter<RuntimeRunRequest> = {
    id: RELAY_RUNTIME_ID,
    capabilities: RELAY_CAPABILITIES,
    sourceOfTruth: NATIVE_ONLY_SOURCE_OF_TRUTH,
    start(context): AdapterRunHandle {
      let resolveDone!: (outcome: AdapterRunOutcome) => void;
      const done = new Promise<AdapterRunOutcome>((resolve) => { resolveDone = resolve; });
      let phase: 'preparing' | 'running' | 'finished' = 'preparing';
      let settled = false;
      const finish = (outcome: AdapterRunOutcome) => {
        if (settled) return;
        settled = true;
        phase = 'finished';
        resolveDone(outcome);
      };
      const config = context.request.runtimeConfig ?? {};
      const connectorId = typeof config.connectorId === 'string' ? config.connectorId : '';
      const connection = connections.get(connectorId);
      const run: ActiveRelayRun = { runId: context.runId, nextSeq: 1, approvals: new Map(), clarifies: new Map(), counter: 0, finish, context, interrupting: false };

      if (!connection || !connection.channel.isOpen) {
        finish({ kind: 'failed', error: 'remote agent is offline', code: 'relay.offline' });
      } else if (connection.run) {
        finish({ kind: 'failed', error: 'remote agent is busy', code: 'relay.busy' });
      } else if (context.request.prompt.length > RELAY_MAX_PROMPT_CHARS) {
        finish({ kind: 'failed', error: 'prompt exceeds relay limit', code: 'relay.runInvalid' });
      } else {
        connection.run = run;
        const grant = config.relayWorkspaceGrant && typeof config.relayWorkspaceGrant === 'object' ? config.relayWorkspaceGrant as { baseUrl?: string; token?: string } : null;
        const group = deps.db.getGroupChat(connection.groupId);
        connection.channel.request('run.request', {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          runId: context.runId,
          room: { id: connection.groupId, name: group?.name ?? connection.groupId },
          prompt: context.request.prompt,
          workspaceApi: grant?.baseUrl && grant.token ? { baseUrl: grant.baseUrl, token: grant.token, access: 'read-write' } : null,
        }, RELAY_ACCEPT_TIMEOUT_MS).then((reply) => {
          if (!(reply as { accepted?: boolean })?.accepted) throw new RelayRequestError('relay.runRejected');
          phase = 'running';
        }).catch((error) => {
          if (connection.run === run) connection.run = null;
          if (error instanceof RelayRequestError && error.code !== 'relay.ackTimeout') {
            // target 明确拒绝（忙、请求不合法）：权威失败。
            finish({ kind: 'failed', error: error.message, code: error.code });
          } else {
            finish({ kind: 'failed', error: error instanceof RelayChannelClosedError ? 'relay connection closed before acceptance' : 'relay accept timeout', code: RELAY_OUTCOME_UNKNOWN_CODE });
          }
        });
      }

      return {
        done,
        status: () => ({ phase, nativeRunId: context.runId }),
        async interrupt(reason) {
          if (settled || !connection || connection.run !== run) return { synced: true };
          run.interrupting = true;
          try {
            await connection.channel.request('run.interrupt', { runId: run.runId, reason }, RELAY_INTERRUPT_ACK_MS);
          } catch {
            // 中止没有确认：远端可能还在跑。按结局未知收尾（不自动重跑）。
            if (connection.run === run) connection.run = null;
            finish({ kind: 'failed', error: 'remote interrupt was not acknowledged', code: RELAY_OUTCOME_UNKNOWN_CODE });
            return { synced: false };
          }
          return { synced: true };
        },
        resolveApproval(approvalId: string, decision: ApprovalDecision) {
          const remote = run.approvals.get(approvalId);
          if (!remote || !connection) return false;
          run.approvals.delete(approvalId);
          void connection.channel.request('approval.respond', { runId: run.runId, approvalId: remote, choice: decision }, RELAY_INTERRUPT_ACK_MS).catch(() => undefined);
          return true;
        },
        resolveClarify(clarifyId: string, response: string) {
          const remote = run.clarifies.get(clarifyId);
          if (!remote || !connection) return false;
          run.clarifies.delete(clarifyId);
          void connection.channel.request('clarify.respond', { runId: run.runId, clarifyId: remote, text: response }, RELAY_INTERRUPT_ACK_MS).catch(() => undefined);
          return true;
        },
      };
    },
  };

  // ------------------------------------------------------------ connector 管理

  function revokeConnector(connectorId: string, reason: string): boolean {
    const row = deps.pairings.revokeConnector(connectorId, reason);
    const connection = connections.get(connectorId);
    if (connection) {
      try {
        connection.channel.emit('connector.revoked', { connectorId, reason });
      } catch {
        // 已断开。
      }
      setTimeout(() => connection.channel.close(4001, 'revoked'), RELAY_REVOKE_CLOSE_DELAY_MS).unref?.();
    }
    if (row) deps.collab.publish(row.group_id, { type: 'agents', data: { changed: true } });
    return !!row;
  }

  function isConnectorOnline(connectorId: string): boolean {
    return connections.get(connectorId)?.channel.isOpen === true;
  }

  // ------------------------------------------------------------ 远程工作区令牌

  function issueWorkspaceGrant(input: { groupId: string; member: GroupMemberRow; policy: RoomPolicy; workspacePath: string }) {
    const connectorId = (input.member as GroupMemberRow & { connector_id?: string }).connector_id;
    const connector = connectorId ? deps.pairings.getConnector(connectorId) : null;
    if (!connector || !connector.host_base_url) return null;
    for (const [hash, grant] of grants) if (grant.expiresAt < now() || grant.revoked) grants.delete(hash);
    if (grants.size >= GRANT_MAX_ACTIVE) {
      log('[Relay] workspace grant limit reached');
      return null;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const grant: WorkspaceGrant = {
      tokenHash, groupId: input.groupId, memberId: input.member.id, workspacePath: input.workspacePath,
      files: new WorkspaceFiles(() => input.workspacePath), expiresAt: now() + Math.min(GRANT_MAX_TTL_MS, input.policy.runTotalBudgetSec * 1000), requests: 0, revoked: false,
    };
    grants.set(tokenHash, grant);
    return {
      baseUrl: `${connector.host_base_url.replace(/\/+$/, '')}/api/room-relay/workspace`,
      token,
      revoke: async () => {
        grant.revoked = true;
        grants.delete(tokenHash);
        await grant.files.drain();
      },
    };
  }

  /** 按 Bearer 令牌找令牌（常数时间：按哈希查表）；过期、吊销、请求数超限都返回 null（超限顺手吊销）。 */
  function authorizeGrant(authorization: string | undefined): WorkspaceGrant | null {
    const header = String(authorization ?? '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    const grant = grants.get(crypto.createHash('sha256').update(token).digest('hex'));
    if (!grant || grant.revoked || grant.expiresAt < now()) return null;
    grant.requests += 1;
    if (grant.requests > GRANT_MAX_REQUESTS) {
      grant.revoked = true;
      grants.delete(grant.tokenHash);
      return null;
    }
    return grant;
  }

  /** 远程 Agent 经令牌上传的二进制：落进群附件并以这个成员的名义发一条附件消息（它不用再发一遍）。 */
  function publishUpload(grant: WorkspaceGrant, relativePath: string, absolutePath: string): void {
    const member = deps.collab.members(grant.groupId).find((row) => row.id === grant.memberId);
    if (!member) return;
    const name = relativePath.split('/').pop() || 'file';
    const attachment = deps.collab.attachments.publishFromWorkspace({ groupId: grant.groupId, memberId: member.id, absolutePath, name });
    const content = `${relativePath}\n\n${attachment.kind === 'image' ? '!' : ''}[${attachment.name}](${attachment.url})`;
    const senderId = `ext:${RELAY_RUNTIME_ID}:${member.agent_id}`;
    const parentId = deps.db.getLatestGroupMessageId(grant.groupId);
    const createdAt = new Date().toISOString();
    const messageId = deps.db.saveGroupMessage({ group_id: grant.groupId, parent_id: parentId, sender_type: 'agent', sender_id: senderId, sender_name: member.display_name, content, created_at: createdAt });
    deps.collab.messages.writeMeta(messageId, { senderMemberId: member.id, messageKind: 'attachment', attachments: [attachment], originator: { kind: 'system' } });
    deps.emitMessage({ groupId: grant.groupId, id: messageId, parent_id: parentId, sender_type: 'agent', sender_id: senderId, sender_name: member.display_name, content, created_at: createdAt, attachments: [attachment] });
  }

  function close(): void {
    for (const connection of connections.values()) connection.channel.close(1001, 'server shutdown');
    connections.clear();
    wss.close();
  }

  return {
    handleUpgrade,
    adapter,
    nameTaken,
    revokeConnector,
    isConnectorOnline,
    issueWorkspaceGrant,
    authorizeGrant,
    publishUpload,
    connectionCount: () => connections.size,
    close,
  };
}

export type RelayHost = ReturnType<typeof createRelayHost>;
