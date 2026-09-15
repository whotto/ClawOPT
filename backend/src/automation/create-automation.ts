/**
 * 自动化模块的装配：一个库连接、一套仓储、一个 Runner、一个事件总线出口。
 *
 * ★ Runner 接缝在这里：`CLAWOPT_WORKFLOW_FAKE_RUNNER=1` 用确定性假 Runner，否则用
 * `createExistingPathRunner`（走现有 OpenClaw 网关与外部运行时执行器）。运行协调器落地后，
 * 把 `runner` 换成协调器提供的实现即可。
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

import type { SessionManager } from '../collab/sessions';
import type { DB } from '../core/db';
import type { EventBus } from '../core/events';
import { resolveServablePath } from '../core/files';
import { uploadDir, workflowWorkspacesDir } from '../core/paths';
import type { GatewayConnections } from '../openclaw';
import { createKanbanService } from './kanban/kanban-service';
import { createKanbanStore } from './kanban/kanban-store';
import { createInboundHooks } from './hooks/inbound-hooks';
import type { AttachmentResolver, WorkflowAgentRunner } from './ports';
import { createAgentDirectory } from './runner/agent-directory';
import { createExistingPathRunner } from './runner/existing-path-runner';
import { createFakeRunner } from './runner/fake-runner';
import { createScheduleService } from './schedules/schedule-service';
import { ensureAutomationSchema } from './shared/schema';
import { createAutomationSettings } from './shared/settings';
import { createWebhookService } from './webhooks/webhook-service';
import { createWebhookStore } from './webhooks/webhook-store';
import { createDefinitionStore } from './workflow/definition-store';
import { createWorkflowEngine } from './workflow/engine';
import { mediaTypeForName } from './workflow/prompt';
import { createImportPreviewStore } from './workflow/portability';
import { createRunStore } from './workflow/run-store';
import { createStatusHub } from './workflow/status-hub';
import { createWorkflowService } from './workflow/workflow-service';

export type AutomationDeps = {
  db: DB;
  sessionManager: SessionManager;
  agentProvisioner: { getWorkspacePath(agentId: string): string };
  gatewayConnections: GatewayConnections;
  events: EventBus;
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
  const hub = createStatusHub(runStore);
  const directory = createAgentDirectory({
    sessionManager: deps.sessionManager,
    workspacePathFor: (agentId) => deps.agentProvisioner.getWorkspacePath(agentId),
    fakeRunner,
  });
  const runner = deps.runner ?? (fakeRunner ? createFakeRunner() : createExistingPathRunner({ gatewayConnections: deps.gatewayConnections }));

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
    cascade: { deleteSchedulesForWorkflow: schedules.deleteForWorkflow, deleteHooksForWorkflow: hooks.deleteForWorkflow },
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

  return {
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
