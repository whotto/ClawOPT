/**
 * 应用上下文：拆分前 index.ts 模块作用域里的单例与共享状态，现在都挂在这一个对象上，
 * 由各模块的 `createXxx(ctx)` / `registerXxxRoutes(app, ctx)` 按需取用。
 *
 * 规则：
 * - **单例**（db、configManager、sessionManager、authStore、agentProvisioner、connections）
 *   在这里按拆分前的先后顺序构造，别处不再 `new`；
 * - **应用状态**（更新快照、网关重启快照、浏览器任务、活跃 run……）住在各自服务的闭包里，
 *   只能经服务暴露的函数读写；
 * - **进程级缓存**（openclaw 可执行文件路径、网关探测结果等）是纯记忆化，
 *   留在所属模块的模块作用域——它们不属于任何一次应用实例，也不跨模块共享。
 *
 * 服务之间的依赖是一张有向无环图，下面的构造顺序就是它的拓扑序。
 * 顺序错了 TypeScript 会在 `createXxx({ ...ctx })` 那一行报缺字段。
 */
import fs from 'fs';

import { AuthStore, createAuthMiddleware, createResourceAccess, hashPassword, isHashedPassword, LoginLockStore, UserStore } from '../core/auth';
import { ConfigManager } from '../core/config';
import { DB } from '../core/db';
import { sharedFileStore } from '../core/files';
import { EventBus } from '../core/events';
import { RealtimeHub } from '../core/realtime';
import { uploadDir } from '../core/paths';
import { createGatewayConnections, createGatewayService, createOpenClawCliRunner, type OpenClawClient } from '../openclaw';
import {
  AgentProvisioner,
  createAgentAvatarStore,
  createAgentCloneService,
  createAgentSettings,
  createChannelsService,
  createCronService,
  createEngineRoster,
  createGatewayStatusCache,
  createLogsService,
  createMcpService,
  createModelCatalogStore,
  createModelPrefsStore,
  createPluginsService,
  createProviderAudit,
  createProviderEditor,
  createSkillsService,
  createUsageService,
  createWorkspaceFilesService,
  createWriteGateService,
  createAppUpdateService,
  createBrowserService,
  createImageGenerationService,
  createOpenClawUpdateService,
  createPackService,
} from '../control';
import { createOpenClawRuntimeAdapter, RunCoordinator } from '../runtime';
import { createPreviewService, createUploadService } from '../workspace';
import {
  createChatCommands,
  createChatLifecycle,
  createChatMessages,
  createChatRuns,
  createDirectChatService,
  createSessionRuntime,
  SessionManager,
} from '../collab/sessions';
import {
  createRoomEngine,
  createRoomMessages,
  createRoomReconciliation,
  createRoomRuntime,
} from '../collab/rooms';
import { createAutomation } from '../automation';

export function createAppContext() {
  fs.mkdirSync(uploadDir, { recursive: true });

  // Initialize managers
  const db = new DB();
  const configManager = new ConfigManager();
  const sessionManager = new SessionManager(db);
  /** 会话令牌存储：随机、可过期、可吊销。 */
  const authStore = new AuthStore(db);
  /** 用户 / 角色 / Agent 授权与登录 IP 锁（P5a）。 */
  const userStore = new UserStore(db.connection());
  const loginLocks = new LoginLockStore(db.connection());

  // 迁移：把配置里的明文口令换成 scrypt 哈希。只做一次，之后配置里不再有明文。
  (() => {
    try {
      const current = configManager.getConfig();
      const stored = typeof current.loginPassword === 'string' ? current.loginPassword : '';
      if (stored && !isHashedPassword(stored)) {
        configManager.setConfig({ loginPassword: hashPassword(stored) });
        console.log('[Auth] 已把明文登录口令迁移为 scrypt 哈希');
      }
    } catch (error) {
      console.warn('[Auth] 口令迁移失败，仍按原值校验：', error);
    }
  })();
  const agentProvisioner = new AgentProvisioner();
  const connections = new Map<string, OpenClawClient>();

  /** 实时事件中枢：SSE 与 WebSocket 两条通道都从这里取事件。 */
  const realtime = new RealtimeHub();
  /** 业务事件总线：出站 Webhook 等下游在这里订阅，发布方不直接调下游。 */
  const events = new EventBus();
  /**
   * 运行协调器：所有运行时（OpenClaw 网关、外部 Agent）的运行都经它；适配器只翻译事件。
   * 运行 / 工具 / 审批的业务事件（`chat.run.*` 等）也只在这里发一次，覆盖所有表面。
   */
  const runCoordinator = new RunCoordinator({ hub: realtime, store: db, events });

  /** OpenClaw 网关运行时适配器（单聊）。无状态，整个进程一个。 */
  const openclawAdapter = createOpenClawRuntimeAdapter();

  const base = {
    db,
    configManager,
    sessionManager,
    authStore,
    userStore,
    loginLocks,
    agentProvisioner,
    connections,
    realtime,
    runCoordinator,
    openclawAdapter,
  };

  const gatewayService = createGatewayService(base);
  const browser = createBrowserService({ gatewayService });
  const appUpdate = createAppUpdateService({ browser, gatewayService });
  const imageGeneration = createImageGenerationService(base);
  const openclawUpdate = createOpenClawUpdateService({ imageGeneration, gatewayService });
  const agentSettings = createAgentSettings(base);
  const gatewayConnections = createGatewayConnections(base);
  const automation = createAutomation({ ...base, gatewayConnections, events });
  const sessionRuntime = createSessionRuntime({ ...base, gatewayConnections });
  const chatMessages = createChatMessages({ sessionRuntime });
  const roomMessages = createRoomMessages(base);
  const preview = createPreviewService(base);
  const directChat = createDirectChatService({ ...base, sessionRuntime });
  const roomRuntime = createRoomRuntime({ ...base, sessionRuntime, gatewayConnections });
  const rooms = createRoomEngine({ ...base, roomRuntime, agentSettings, imageGeneration, gatewayConnections });
  const roomReconciliation = createRoomReconciliation({ ...base, rooms, roomRuntime, agentSettings, gatewayConnections });
  const auth = createAuthMiddleware(base);
  /** 数据面资源（会话 / 群 / Agent 活动）的可见性：HTTP 路由与 /ws 主题授权共用。 */
  const access = createResourceAccess({
    canAccessAgent: auth.canAccessAgent,
    lookup: {
      chatSessionAgentId: (sessionId) => db.getSession(sessionId)?.agentId ?? null,
      roomAgentIds: (groupId) => (db.getGroupChat(groupId) ? db.getGroupMembers(groupId).map((member) => member.agent_id) : null),
      runSessionAgentId: (sessionKey) => db.getRunSession(sessionKey)?.agent_id ?? null,
      uploadSessionKey: (storedName) => (db.getFileByStoredName(storedName)?.session_key as string | undefined) || null,
    },
  });
  const uploads = createUploadService({ ...base, access });
  const packs = createPackService({ ...base, agentSettings, workflowPacks: automation.packBundles });
  const chatRuns = createChatRuns();
  const chatLifecycle = createChatLifecycle({ ...base, chatRuns, sessionRuntime, gatewayConnections });
  const chatCommands = createChatCommands({ ...base, gatewayConnections });

  // ---- P5a 控制面：一切引擎侧操作经同一个 CLI 调用口（写操作在进程内串行） ----
  const openclawCli = createOpenClawCliRunner();
  const engineRoster = createEngineRoster({ openclawCli });
  const cron = createCronService({ openclawCli });
  const mcp = createMcpService({ openclawCli });
  const plugins = createPluginsService({ openclawCli });
  const skills = createSkillsService({ openclawCli });
  const channels = createChannelsService({ openclawCli });
  const usage = createUsageService({ openclawCli });
  const logs = createLogsService({ openclawCli });
  const gatewayStatus = createGatewayStatusCache({ openclawCli });
  const writeGate = createWriteGateService({ db, roster: engineRoster, fileStore: sharedFileStore });
  const workspaceFiles = createWorkspaceFilesService({ roster: engineRoster, fileStore: sharedFileStore, writeGate });
  const avatars = createAgentAvatarStore({ db });
  const agentClone = createAgentCloneService({ agentProvisioner, sessionManager, agentSettings, openclawCli, avatars });
  const providerEditor = createProviderEditor();
  const providerAudit = createProviderAudit({ db });
  const modelCatalog = createModelCatalogStore({ db });
  const modelPrefs = createModelPrefsStore({ db });

  return {
    ...base,
    uploads,
    gatewayService,
    browser,
    appUpdate,
    imageGeneration,
    openclawUpdate,
    agentSettings,
    gatewayConnections,
    sessionRuntime,
    chatMessages,
    roomMessages,
    preview,
    directChat,
    roomRuntime,
    rooms,
    roomReconciliation,
    auth,
    access,
    packs,
    chatRuns,
    chatLifecycle,
    chatCommands,
    openclawCli,
    engineRoster,
    cron,
    mcp,
    plugins,
    skills,
    channels,
    usage,
    logs,
    gatewayStatus,
    writeGate,
    workspaceFiles,
    avatars,
    agentClone,
    providerEditor,
    providerAudit,
    modelCatalog,
    modelPrefs,
    events,
    automation,
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
