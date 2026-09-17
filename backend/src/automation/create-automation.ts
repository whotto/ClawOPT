/**
 * 自动化模块的装配：一个库连接、一套仓储、一个 Runner、一个事件总线出口。
 *
 * Runner 接缝在这里：`CLAWOPT_WORKFLOW_FAKE_RUNNER=1` 用确定性假 Runner，否则用
 * `createCoordinatorRunner`（节点作为运行协调器里的 `workflow` 表面会话运行）。
 */
import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';

import type { SessionManager } from '../collab/sessions';
import type { DB } from '../core/db';
import type { EventBus } from '../core/events';
import { resolveServablePath } from '../core/files';
import { uploadDir, workflowWorkspacesDir } from '../core/paths';
import type { RealtimeHub } from '../core/realtime';
import type { GatewayConnections, OpenClawClient } from '../openclaw';
import { resolveBinaryOnPath, type AgentRuntimeAdapter, type OpenClawChatRunRequest, type RunCoordinator, type RuntimePlatform } from '../runtime';
import { createKanbanService } from './kanban/kanban-service';
import { createKanbanStore } from './kanban/kanban-store';
import { createInboundHooks } from './hooks/inbound-hooks';
import type { AttachmentResolver, WorkflowAgentRef, WorkflowAgentRunner } from './ports';
import { createAgentDirectory } from './runner/agent-directory';
import { createCoordinatorRunner, workflowAgentId, workflowSessionKey } from './runner/coordinator-runner';
import { createFakeRunner } from './runner/fake-runner';
import { createScheduleService } from './schedules/schedule-service';
import { ensureAutomationSchema } from './shared/schema';
import { createAutomationSettings } from './shared/settings';
import { createWebhookService } from './webhooks/webhook-service';
import { createWebhookStore } from './webhooks/webhook-store';
import { createDefinitionStore } from './workflow/definition-store';
import { createWorkflowEngine } from './workflow/engine';
import { mediaTypeForName } from './workflow/prompt';
import { createImportPreviewStore, parseEnvelope, remapDefinitionIds, type WorkflowEnvelope } from './workflow/portability';
import { AutomationError } from './shared/errors';
import { createRunStore } from './workflow/run-store';
import { createStatusHub } from './workflow/status-hub';
import { createWorkflowService } from './workflow/workflow-service';

export type AutomationDeps = {
  db: DB;
  sessionManager: SessionManager;
  agentProvisioner: { getWorkspacePath(agentId: string): string };
  gatewayConnections: GatewayConnections;
  connections: Map<string, OpenClawClient>;
  runCoordinator: RunCoordinator;
  openclawAdapter: AgentRuntimeAdapter<OpenClawChatRunRequest>;
  /** 外部运行时：适配器登记处（节点名册与 Runner 共用）、管理器（本机检测）、运行时目录回收。 */
  runtimePlatform: Pick<RuntimePlatform, 'createAdapter' | 'registry' | 'manager' | 'releaseOwner'>;
  events: EventBus;
  /** 实时中枢：工作流状态流走 `workflow:<id>` 主题。 */
  realtime: Pick<RealtimeHub, 'publish' | 'hasSubscribers'>;
  /** 测试注入；缺省按环境变量选择。 */
  runner?: WorkflowAgentRunner;
  fakeRunner?: boolean;
};

export function isFakeRunnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAWOPT_WORKFLOW_FAKE_RUNNER === '1';
}

export function createAutomation(deps: AutomationDeps) {
  const connection = deps.db.connection();
  ensureAutomationSchema(connection);
  const fakeRunner = deps.fakeRunner ?? isFakeRunnerEnabled();

  const settings = createAutomationSettings(connection);
  const defs = createDefinitionStore(connection);
  const runStore = createRunStore(connection);
  const hub = createStatusHub(runStore, {
    publish: (topic, type, payload) => { deps.realtime.publish({ topic, type, payload }); },
    hasSubscribers: (topic) => deps.realtime.hasSubscribers(topic),
  });
  const directory = createAgentDirectory({
    sessionManager: deps.sessionManager,
    workspacePathFor: (agentId) => deps.agentProvisioner.getWorkspacePath(agentId),
    runtimes: {
      list: () => deps.runtimePlatform.registry.list()
        .filter((entry) => (entry.descriptor.kind ?? 'cli') !== 'remote')
        .map((entry) => ({
          id: entry.descriptor.id,
          name: entry.descriptor.name,
          modes: entry.capabilities?.proxyMode ?? [],
          approvals: Boolean(entry.capabilities?.approvals),
        })),
      // 管理器检测过就信它（扩充 PATH）；还没检测过（刚启动）先沿当前 PATH 找命令，名册接口会刷新缓存。
      installed: (id) => {
        const cached = deps.runtimePlatform.manager.cachedStatus(id);
        if (cached) return cached.installed;
        const command = deps.runtimePlatform.registry.get(id)?.descriptor.command;
        return Boolean(command && resolveBinaryOnPath(command));
      },
      refresh: async () => {
        await Promise.all(deps.runtimePlatform.registry.list().map((entry) => deps.runtimePlatform.manager.status(entry.descriptor.id).catch(() => null)));
      },
    },
    fakeRunner,
  });
  const runner = deps.runner ?? (fakeRunner ? createFakeRunner() : createCoordinatorRunner(deps));

  const resolveAttachment: AttachmentResolver = (url) => {
    const name = url.startsWith('/uploads/') ? url.slice('/uploads/'.length) : '';
    if (!name || name.includes('/') || name.includes('\\')) return null;
    const row = deps.db.getFileByStoredName(name) as { stored_path?: string; original_name?: string } | undefined;
    const candidate = row?.stored_path ?? path.join(uploadDir, name);
    const verdict = resolveServablePath(candidate);
    if (!verdict.ok) return null;
    const displayName = row?.original_name || name;
    return { path: verdict.realPath, mediaType: mediaTypeForName(displayName).mediaType, name: displayName };
  };

  const publishEvent = (type: string, payload: Record<string, unknown>) => {
    deps.events.publish(type, payload);
  };

  const engine = createWorkflowEngine({
    defs,
    runStore,
    runner,
    directory,
    resolveAttachment,
    publishEvent,
    settings,
    hub,
    resolveWorkspace: (workflowId, configured) => {
      const dir = configured ?? path.join(workflowWorkspacesDir, workflowId);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  });
  const schedules = createScheduleService({ db: connection, defs, engine });
  const hooks = createInboundHooks({ db: connection, defs, engine });
  const workflows = createWorkflowService({
    defs,
    engine,
    hub,
    previews: createImportPreviewStore(connection),
    cascade: {
      deleteSchedulesForWorkflow: schedules.deleteForWorkflow,
      deleteHooksForWorkflow: hooks.deleteForWorkflow,
      releaseRuntimeHomes: (workflowId) => deps.runtimePlatform?.releaseOwner({ kind: 'workflow-node', workflowId }),
    },
  });

  const webhookStore = createWebhookStore(connection);
  const receiverSecret = () => {
    const existing = settings.read('webhooks.receiverSecret');
    if (existing) return existing;
    const created = randomBytes(32).toString('hex');
    settings.write('webhooks.receiverSecret', created);
    return created;
  };
  const webhooks = createWebhookService({
    store: webhookStore,
    receiverSecret,
    backendPort: () => Number(process.env.PORT) || 3100,
  });

  const kanbanStore = createKanbanStore(connection);
  const kanban = createKanbanService({
    store: kanbanStore,
    runner,
    directory,
    defaultWorkspace: (taskId) => path.join(workflowWorkspacesDir, 'kanban', taskId),
  });

  let detachWebhooks: (() => void) | null = null;

  /**
   * `.clawpack` 附带工作流：导出走同一个信封投影（丢模型与附件、扫凭据键），
   * 导入走同一个严格校验 + id 重映射，并把 OpenClaw Agent 引用按装包时的改名映射过去。
   * 只建定义，不运行、不带定时与钩子——「导入不执行任何东西」这道闸门对工作流同样成立。
   */
  const packBundles = {
    exportEnvelopes(ids: string[]): WorkflowEnvelope[] {
      return ids.map((id) => workflows.exportEnvelope(id));
    },
    summarize(envelopes: unknown[]): Array<{ name: string; nodes: number; edges: number; valid: boolean; errorCode?: string }> {
      return envelopes.map((envelope) => {
        try {
          const parsed = parseEnvelope(envelope);
          return { name: parsed.name, nodes: parsed.nodes.length, edges: parsed.edges.length, valid: true };
        } catch (error) {
          const name = String((envelope as { definition?: { name?: unknown } })?.definition?.name ?? '').slice(0, 120);
          return { name, nodes: 0, edges: 0, valid: false, errorCode: error instanceof AutomationError ? error.code : 'workflows.importInvalid' };
        }
      });
    },
    importEnvelopes(envelopes: unknown[], agentIdMap: Record<string, string>) {
      const results: Array<{ name: string; status: 'created' | 'failed'; workflowId?: string; errorCode?: string }> = [];
      for (const envelope of envelopes) {
        try {
          const remapped = remapDefinitionIds(parseEnvelope(envelope), agentIdMap);
          const created = defs.create({ name: remapped.name, workspace: null, nodes: remapped.nodes, edges: remapped.edges, viewport: remapped.viewport });
          results.push({ name: created.name, status: 'created', workflowId: created.id });
        } catch (error) {
          results.push({ name: String((envelope as any)?.definition?.name ?? ''), status: 'failed', errorCode: error instanceof AutomationError ? error.code : 'workflows.importInvalid' });
        }
      }
      return results;
    },
  };

  /**
   * 节点会话的转录：协调器通用表里的会话行、工具调用（成组落库，按顺序）与用量。
   * 假 Runner 与没有提交成功的节点没有会话行，返回 null。
   */
  const nodeSession = (sessionId: string | null) => {
    if (!sessionId) return null;
    const sessionKey = workflowSessionKey(sessionId);
    const row = deps.db.getRunSession(sessionKey);
    if (!row) return null;
    return {
      sessionKey,
      topic: `session:${sessionKey}`,
      surface: row.surface,
      runtime: row.runtime,
      agentId: row.agent_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      endReason: row.end_reason,
      toolCalls: deps.db.listRunToolCalls(sessionKey).map((call) => ({
        callId: call.call_id,
        name: call.name,
        arguments: call.arguments,
        output: call.output,
        status: call.status,
        startedAt: call.started_at,
        completedAt: call.completed_at,
      })),
      usage: deps.db.listSessionUsage(sessionKey).map((usage) => ({
        model: usage.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_tokens,
        cacheWriteTokens: usage.cache_write_tokens,
        costUsd: usage.cost_usd,
      })),
    };
  };

  /** 工作流用到的全部 Agent（授权判据：member 要全部都有权）。工作流不存在返回 null。 */
  const workflowAgentIds = (workflowId: string): string[] | null => {
    const def = defs.get(workflowId);
    if (!def) return null;
    return [...new Set(def.nodes.map((item) => workflowAgentId(item.data.agent)))];
  };

  /** 运行时目录定期清扫的判据：工作流节点还在（看板派活是 `kanban` / 任务 id，任务不删只归档，按空闲回收）。 */
  const runtimeHomeOwnerExists = (workflowId: string, nodeId: string): boolean => (
    workflowId === 'kanban' ? Boolean(kanbanStore.getTask(nodeId)) : Boolean(defs.get(workflowId)?.nodes.some((node) => node.id === nodeId))
  );

  /**
   * P6：ClawOPT MCP 服务的 `chat_run`（把一轮委派给管理员允许的 Agent / 运行时，等它答完）。
   * 与工作流节点同一条执行路径：协调器 `workflow` 表面的真实会话（不进聊天列表），无人值守一律拒绝工具权限询问。
   * 运行时 home 归属 `{mcp-delegate, 会话}`：工作流表里没有这个 id，定期清扫按孤儿回收。
   */
  async function delegateTurn(input: { agentRef: WorkflowAgentRef; prompt: string; timeoutMs: number; onSessionKey?: (sessionKey: string) => void }) {
    const availability = directory.availability(input.agentRef);
    if (!availability.available) return { ok: false, output: '', error: availability.reason };
    const sessionId = randomUUID();
    input.onSessionKey?.(workflowSessionKey(sessionId));
    const controller = new AbortController();
    const workspace = path.join(workflowWorkspacesDir, 'mcp-delegate');
    fs.mkdirSync(workspace, { recursive: true });
    const result = await runner.runAndWait({
      sessionId,
      agentRef: input.agentRef,
      input: [{ type: 'text', text: input.prompt }],
      workspace,
      timeoutMs: input.timeoutMs,
      autoApprove: 'deny',
      signal: controller.signal,
      owner: { workflowId: 'mcp-delegate', nodeId: sessionId },
    });
    return { ok: result.ok, output: result.output, error: result.error };
  }

  return {
    delegateTurn,
    /** 「让某个 Agent 跑一轮并等它结束」的执行端口（P3：群摘要选 Agent 作为摘要模型时复用它，不另写一份）。 */
    agentRunner: runner,
    nodeSession,
    workflowAgentIds,
    runtimeHomeOwnerExists,
    packBundles,
    fakeRunner,
    settings,
    directory,
    runStore,
    hub,
    engine,
    workflows,
    schedules,
    hooks,
    webhooks,
    kanban,

    /** 启动顺序：先按失败收尾上次没跑完的运行（fail closed），再开定时与 outbox。 */
    start(): void {
      const { recovered } = engine.recoverOnBoot();
      if (recovered.length) console.warn(`[Workflow] ${recovered.length} run(s) marked failed after restart`);
      const kanbanRecovered = kanbanStore.recoverRunning();
      if (kanbanRecovered) console.warn(`[Kanban] ${kanbanRecovered} dispatch run(s) marked failed after restart`);
      detachWebhooks = webhooks.attach(deps.events);
      webhooks.start();
      schedules.start();
    },

    async stop(): Promise<void> {
      await schedules.stop();
      detachWebhooks?.();
      await webhooks.stop();
    },
  };
}

export type Automation = ReturnType<typeof createAutomation>;
