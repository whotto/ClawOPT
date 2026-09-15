/**
 * ClawOPT 作为 MCP 服务（P6，spec 07 §2.37 / §3.4、spec 08 §6.S 超越版）。
 *
 * ## 与参考实现的差别（它的缺陷，我们的守卫）
 *
 * | 参考实现 | 这里 |
 * |---|---|
 * | `api` 工具集 = 用运行用户（单用户安装里就是 super-admin）的 JWT 代理整个 `/api` | 没有路径代理：显式的操作白名单（`operations.ts`），`api` 只有几条只读 |
 * | 凭据回落链：环境令牌 → 每用户 1 小时模型运行 JWT → **主令牌文件** | 每次运行签发范围令牌：绑定运行、TTL、运行结束即吊销；**不认登录会话、没有主令牌** |
 * | 只校验 OpenAPI 必填字段 | 每个操作都按令牌范围过数据面同一份 ACL（`createResourceAccess`） |
 *
 * ## 令牌落在哪
 *
 * 令牌只交给这一次运行的 MCP 子进程：随托管服务条目的 `env` 写进**运行时 home 里的运行副本 MCP 配置**
 * （如 Claude Code 的 `<数据目录>/runtime/claude-code/<哈希>/mcp.json`，经 runtime-fs 以 0600 原子写）。
 * 这份文件在运行结束后还在，但令牌已按 `chat.run.*` 终态吊销、并且有 TTL 上限——留在盘上的是一张废票。
 * 库里只存令牌的 sha256。
 *
 * ## 委派（chat_run）
 *
 * 委派的执行在自动化模块（`automation.delegateTurn`，与工作流节点同一条协调器路径），bootstrap 注入；没接时 `chat_run` 回 409
 * `mcpServer.operationDisabled`。范围与深度限制在这里：目标必须在管理员给这个运行时配置的委派名单里、不能是自己；
 * 委派出来的会话键在提交前登记，给它签的令牌里没有 `chat_run`（深度 1）。
 */
import path from 'path';

import { accessAgentId, createResourceAccess, type RequestIdentity, type ResourceLookup } from '../core/auth';
import type { DB } from '../core/db';
import type { EventBus } from '../core/events';
import { appRepoRoot } from '../core/paths';
import type { Automation } from '../automation';
import type { MemoryService } from '../memory';
import { CLAWOPT_MANAGED_MCP_ENV, CLAWOPT_MANAGED_MCP_PREFIX, type ManagedMcpServer, type McpRunContext, type RunCoordinator, type RuntimePlatform } from '../runtime';
import { buildMemoryHostContext, captureEvidence } from './memory-context';
import {
  MCP_OPERATION_BY_NAME,
  McpOperationError,
  operationsForToolsets,
  type DelegateTurn,
  type DelegateTurnHost,
  type McpAutomationPort,
  type McpDbPort,
  type OperationContext,
} from './operations';
import { createMcpSettingsStore, McpSettingsError, MCP_TOOLSETS, type McpRuntimeSettings } from './settings-store';
import { createMcpTokenStore, MCP_TOKEN_DEFAULT_TTL_MS, type McpAuditOutcome, type McpSurface, type McpTokenRecord, type McpTokenScope } from './token-store';

/** 托管服务条目的名字：`clawopt-` 前缀 + env 标记，两道所有权标记（`runtime/mcp/types.ts` 的 isManagedMcpServer）。 */
export const CLAWOPT_MCP_SERVER_NAME = `${CLAWOPT_MANAGED_MCP_PREFIX}tools`;
export const CLAWOPT_MCP_BIN = path.join(appRepoRoot, 'backend', 'bin', 'clawopt-mcp');
export const RUN_END_EVENT_TYPES = ['chat.run.completed', 'chat.run.failed', 'chat.run.aborted'];

export type McpServerServiceDeps = {
  db: DB;
  /** 与数据面授权同一份查询口：范围判定复用 `createResourceAccess`，身份换成令牌范围。 */
  resourceLookup: ResourceLookup;
  runCoordinator: RunCoordinator;
  automation: Automation;
  memory: MemoryService;
  events: EventBus;
  runtimePlatform: RuntimePlatform;
  /** MCP 子进程回连 ClawOPT 的地址（本机回环）。 */
  publicBaseUrl: () => string;
  /** 委派一轮（见文件头）；不给则 chat_run 不可用。 */
  delegateTurn?: DelegateTurnHost;
  /** 以下只给测试注入。 */
  now?: () => number;
  ttlMs?: number;
  nodePath?: string;
  binPath?: string;
};

export type BridgeRequest = {
  remoteAddress: string | undefined;
  authorization: string | undefined;
  /**
   * 请求带了转发头（X-Forwarded-For / Forwarded / X-Real-IP）。本机反向代理转进来的外部请求 TCP 对端也是回环，
   * 只看对端地址挡不住；MCP 子进程直连本机端口，从不带这些头。有就拒（纵深防御，主闸门仍是范围令牌）。
   */
  forwarded?: boolean;
};

export type BridgeResponse = { status: number; body: Record<string, unknown> };

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK.has(address) || /^::ffff:127\./.test(address) || /^127\./.test(address);
}

function bearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

/** 从运行上下文推表面与范围坐标（归属优先，其次会话键形状）。 */
export function surfaceForRun(run: McpRunContext): { surface: McpSurface; roomId: string | null; workflowIds: string[] } {
  const owner = run.owner ?? { kind: '' };
  if (owner.kind === 'room-member' && typeof owner.groupId === 'string') return { surface: 'group-chat', roomId: owner.groupId, workflowIds: [] };
  if (owner.kind === 'workflow-node' && typeof owner.workflowId === 'string') {
    return owner.workflowId === 'kanban' ? { surface: 'kanban', roomId: null, workflowIds: [] } : { surface: 'workflow', roomId: null, workflowIds: [owner.workflowId] };
  }
  if (owner.kind === 'session') return { surface: 'single-chat', roomId: null, workflowIds: [] };
  const room = /^room:(.+):member:[^:]+$/.exec(run.sessionKey);
  if (room) return { surface: 'group-chat', roomId: room[1], workflowIds: [] };
  if (run.sessionKey.startsWith('workflow:')) return { surface: 'workflow', roomId: null, workflowIds: [] };
  return { surface: 'other', roomId: null, workflowIds: [] };
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown; errorCode?: unknown })?.code ?? (error as { errorCode?: unknown })?.errorCode;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : 'mcpServer.operationFailed';
};

export function createMcpServerService(deps: McpServerServiceDeps) {
  const now = deps.now ?? Date.now;
  const sql = deps.db.connection();
  const tokens = createMcpTokenStore(sql, { now });
  const settingsStore = createMcpSettingsStore(sql, { now });
  const dbPort = deps.db as unknown as McpDbPort;
  const automationPort = deps.automation as unknown as McpAutomationPort;
  /** 委派出来的运行的会话键：给它们签的令牌里没有 chat_run。 */
  const delegatedSessionKeys = new Set<string>();

  const unsubscribe = deps.events.subscribe('mcp-server:revoke-on-run-end', (event) => {
    const runId = (event.payload as { runId?: unknown })?.runId;
    if (typeof runId === 'string' && runId) tokens.revokeRun(runId, event.type);
  }, { types: RUN_END_EVENT_TYPES });

  const delegateTurn: DelegateTurn | null = deps.delegateTurn
    ? async (input) => deps.delegateTurn!({ ...input, markDelegated: (sessionKey) => { delegatedSessionKeys.add(sessionKey); } })
    : null;

  function runtimeIds(): Array<{ id: string; name: string; kind: string }> {
    return deps.runtimePlatform.registry.list().map((entry) => ({ id: entry.descriptor.id, name: entry.descriptor.name, kind: entry.descriptor.kind ?? 'cli' }));
  }

  function scopeFor(run: McpRunContext, settings: McpRuntimeSettings): { scope: McpTokenScope; surface: McpSurface } {
    const { surface, roomId, workflowIds } = surfaceForRun(run);
    // 单聊按会话行推授权 id（外部运行时单聊是 `ext:<运行时>`）；其余按运行的 Agent 归一。
    const fromSession = surface === 'single-chat' ? deps.resourceLookup.chatSessionAgentId(run.sessionKey) : null;
    const agentId = accessAgentId(fromSession ?? run.agentId);
    return {
      surface,
      scope: {
        agentIds: [agentId],
        sessionKeys: [run.sessionKey],
        workflowIds,
        roomId,
        delegateAgents: settings.delegateAgents,
        delegated: delegatedSessionKeys.has(run.sessionKey),
      },
    };
  }

  /** 运行时平台的托管 MCP 提供者：按运行签发令牌并给出要注入的服务。没有运行上下文、没开、没选工具集 → 不注入。 */
  function managedServersFor(runtime: string, run?: McpRunContext): ManagedMcpServer[] {
    if (!run) return [];
    const settings = settingsStore.get(runtime);
    if (!settings.enabled || settings.toolsets.length === 0) return [];
    const { scope, surface } = scopeFor(run, settings);
    let operations = operationsForToolsets(settings.toolsets);
    if (scope.delegated || scope.delegateAgents.length === 0) operations = operations.filter((name) => name !== 'chat_run');
    const evidenceIds = captureEvidence(dbPort, { sessionKey: run.sessionKey, surface, roomId: scope.roomId }).map((message) => message.id);
    const { token } = tokens.mint({
      runId: run.runId,
      sessionKey: run.sessionKey,
      agentId: run.agentId,
      runtime,
      surface,
      scope,
      operations,
      evidenceIds,
      ttlMs: deps.ttlMs ?? MCP_TOKEN_DEFAULT_TTL_MS,
    });
    return [{
      name: CLAWOPT_MCP_SERVER_NAME,
      transport: 'stdio',
      command: deps.nodePath ?? process.execPath,
      args: [deps.binPath ?? CLAWOPT_MCP_BIN],
      env: {
        CLAWOPT_MCP_URL: deps.publicBaseUrl(),
        CLAWOPT_MCP_TOKEN: token,
        CLAWOPT_MCP_TOOLSETS: settings.toolsets.join(','),
        [CLAWOPT_MANAGED_MCP_ENV]: '1',
      },
    }];
  }

  function identityFor(record: McpTokenRecord): RequestIdentity {
    return { userId: null, username: `mcp:${record.id}`, role: 'member', implicit: false, mustChangePassword: false };
  }

  function accessFor(record: McpTokenRecord) {
    const allowed = new Set(record.scope.agentIds.map(accessAgentId));
    return createResourceAccess({ canAccessAgent: (_identity, agentId) => allowed.has(accessAgentId(agentId)), lookup: deps.resourceLookup });
  }

  type Authenticated = { ok: true; record: McpTokenRecord } | { ok: false; response: BridgeResponse };

  function authenticate(request: BridgeRequest, operation: string): Authenticated {
    if (!isLoopbackAddress(request.remoteAddress) || request.forwarded === true) {
      tokens.audit({ record: null, operation, outcome: 'invalid', detail: request.forwarded ? 'forwarded request' : 'non-loopback source' });
      return { ok: false, response: { status: 403, body: { success: false, errorCode: 'mcpServer.loopbackOnly' } } };
    }
    const verdict = tokens.verify(bearer(request.authorization));
    if (!verdict.ok) {
      tokens.audit({ record: verdict.record, operation, outcome: verdict.outcome });
      const code = verdict.outcome === 'expired' ? 'mcpServer.tokenExpired' : verdict.outcome === 'revoked' ? 'mcpServer.tokenRevoked' : 'mcpServer.tokenInvalid';
      return { ok: false, response: { status: 401, body: { success: false, errorCode: code } } };
    }
    return { ok: true, record: verdict.record };
  }

  function listTools(request: BridgeRequest): BridgeResponse {
    const auth = authenticate(request, 'tools/list');
    if (!auth.ok) return auth.response;
    const tools = auth.record.operations
      .map((name) => MCP_OPERATION_BY_NAME.get(name))
      .filter((operation): operation is NonNullable<typeof operation> => Boolean(operation))
      .map((operation) => ({ name: operation.name, description: operation.description, inputSchema: operation.inputSchema, toolset: operation.toolset }));
    return { status: 200, body: { success: true, tools } };
  }

  async function call(request: BridgeRequest, operationRaw: unknown, argsRaw: unknown): Promise<BridgeResponse> {
    const operation = typeof operationRaw === 'string' ? operationRaw.slice(0, 80) : '';
    const auth = authenticate(request, operation || '(none)');
    if (!auth.ok) return auth.response;
    const { record } = auth;
    const audit = (outcome: McpAuditOutcome, detail?: string) => tokens.audit({ record, operation: operation || '(none)', outcome, detail });
    const definition = MCP_OPERATION_BY_NAME.get(operation);
    // 表里没有的名字：没有通用代理可以落。令牌里没有的操作：同样拒。
    if (!definition || !record.operations.includes(operation)) {
      audit('denied_operation');
      return { status: 403, body: { success: false, errorCode: 'mcpServer.operationNotAllowed' } };
    }
    const args = argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw) ? argsRaw as Record<string, unknown> : {};
    const ctx: OperationContext = {
      record,
      identity: identityFor(record),
      access: accessFor(record),
      db: dbPort,
      automation: automationPort,
      memory: deps.memory,
      memoryContext: (tokenRecord, profileId) => buildMemoryHostContext(tokenRecord, profileId, dbPort),
      memberRuntimes: runtimeIds,
      delegateTurn,
    };
    try {
      const result = await definition.handler(ctx, args);
      audit('allowed');
      return { status: 200, body: { success: true, result: result ?? null } };
    } catch (error) {
      if (error instanceof McpOperationError) {
        audit(error.outcome === 'failed' ? 'failed' : error.outcome, error.code);
        return { status: error.status, body: { success: false, errorCode: error.code } };
      }
      const status = Number((error as { status?: unknown })?.status);
      const code = errorCode(error);
      audit('failed', code);
      // 记忆服务 / 自动化的结构化错误原样带码回去，让模型看得懂；未知错误不带原文。
      return { status: Number.isInteger(status) && status >= 400 && status < 600 ? status : 400, body: { success: false, errorCode: code, message: code === 'mcpServer.operationFailed' ? null : (error as Error)?.message?.slice(0, 300) ?? null } };
    }
  }

  function settings() {
    const runtimes = runtimeIds().map((runtime) => ({ ...runtime, ...settingsStore.get(runtime.id) }));
    const agentOptions = [
      ...new Set([
        ...dbPort.getSessions().map((session) => accessAgentId(session.external_runtime ? `ext:${session.external_runtime}` : session.agentId)),
        ...runtimeIds().map((runtime) => `ext:${runtime.id}`),
      ]),
    ].sort();
    return { runtimes, toolsets: [...MCP_TOOLSETS], operations: [...MCP_OPERATION_BY_NAME.values()].map((operation) => ({ name: operation.name, toolset: operation.toolset })), agentOptions, delegationAvailable: Boolean(delegateTurn) };
  }

  function saveRuntime(runtime: string, body: unknown): McpRuntimeSettings {
    if (!runtimeIds().some((entry) => entry.id === runtime)) throw new McpSettingsError('mcpServer.runtimeUnknown');
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return settingsStore.save(runtime, { enabled: input.enabled, toolsets: input.toolsets, delegateAgents: input.delegateAgents });
  }

  const publicToken = (record: McpTokenRecord) => ({
    id: record.id,
    runId: record.runId,
    sessionKey: record.sessionKey,
    agentId: record.agentId,
    runtime: record.runtime,
    surface: record.surface,
    scope: record.scope,
    operations: record.operations,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  });

  return {
    managedServersFor,
    listTools,
    call,
    settings,
    saveRuntime,
    activeTokens: () => tokens.listActive().map(publicToken),
    revokeToken: (id: string) => tokens.revokeId(id, 'admin'),
    audit: (limit?: number) => tokens.listAudit(limit),
    stop(): void {
      unsubscribe();
      tokens.revokeAll('shutdown');
    },
  };
}

export type McpServerService = ReturnType<typeof createMcpServerService>;
