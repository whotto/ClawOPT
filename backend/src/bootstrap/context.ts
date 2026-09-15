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
import path from 'path';

import { AuthStore, chatSessionAccessAgentId, createAuthMiddleware, createResourceAccess, groupMemberAccessAgentId, hashPassword, isHashedPassword, LoginLockStore, UserStore, type ResourceLookup } from '../core/auth';
import { ConfigManager } from '../core/config';
import { DB } from '../core/db';
import { sharedFileStore } from '../core/files';
import { EventBus } from '../core/events';
import { RealtimeHub } from '../core/realtime';
import { clawoptDataDir, uploadDir } from '../core/paths';
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
  createJourneyService,
  createPerformanceService,
  createThemeService,
} from '../control';
import { createOpenClawRuntimeAdapter, createProviderProxy, createRuntimePlatform, defaultRuntimeDataDir, RunCoordinator } from '../runtime';
import { createFileManagerService, createPreviewService, createTerminalService, createUploadService } from '../workspace';
import { createMemoryService } from '../memory';
import { createMcpServerService } from '../mcp-server';
import { createVoiceService } from '../voice';
import { createScopedProviderResolver } from './scoped-provider-resolver';
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

  /** 本地模型代理（P2）：scoped 模式下外部 CLI 只拿代理令牌，上游 key 留在服务端。 */
  const providerProxy = createProviderProxy({
    publicBaseUrl: () => `http://127.0.0.1:${Number(process.env.PORT) || 3100}`,
    dataDir: defaultRuntimeDataDir(),
  });

  /**
   * 外部运行时底座（P2）：运行时管理器（安装 / 升级锁 / PATH 发现 / 运行时目录回收）、MCP 注入、
   * 适配器登记、远程 OpenClaw 成员令牌。忙闲判据与卸载后停运行都接到协调器。
   */
  const runtimePlatform = createRuntimePlatform({
    dataDir: defaultRuntimeDataDir(),
    proxy: providerProxy,
    // scoped 的上游：成员 / 会话配置里只有模型 id，地址与 key 在服务端从 ClawOPT 的模型配置取，只交给代理。
    resolveScopedProvider: createScopedProviderResolver(agentProvisioner),
    isRuntimeBusy: (runtime) => runCoordinator.activeRuns().some((run) => run.runtime === runtime),
    stopRuntimeRuns: async (runtime) => {
      await Promise.all(runCoordinator.activeRuns()
        .filter((run) => run.runtime === runtime)
        .map((run) => runCoordinator.abort(run.sessionKey, 'user_stop')));
    },
  });
  // 运行时目录定期清扫的判据：归属还在，而且还在用这个运行时（成员换了运行时，旧运行时的目录算孤儿）。
  runtimePlatform.manager.homeOwnerExists = (owner, runtime) => {
    if (owner.kind === 'session') return Boolean(db.getSession(owner.sessionId));
    if (owner.kind === 'room-member') {
      return db.getGroupMembers(owner.groupId).some((member) => member.id === owner.memberId && member.runtime === runtime);
    }
    // 工作流节点 / 看板派活：自动化在下面才装配，清扫在运行期才调，这里按引用取。
    return automation.runtimeHomeOwnerExists(owner.workflowId, owner.nodeId);
  };

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
    providerProxy,
    runtimePlatform,
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
  const resourceLookup: ResourceLookup = {
    // 判定用的 Agent id：外部运行时单聊与外部群成员是 `ext:<运行时>`（可授权的伪 Agent，见 core/auth/agent-ids.ts）。
    chatSessionAgentId: (sessionId) => {
      const session = db.getSession(sessionId);
      return session ? chatSessionAccessAgentId(session) : null;
    },
    roomAgentIds: (groupId) => (db.getGroupChat(groupId) ? db.getGroupMembers(groupId).map(groupMemberAccessAgentId) : null),
    runSessionAgentId: (sessionKey) => db.getRunSession(sessionKey)?.agent_id ?? null,
    uploadSessionKey: (storedName) => (db.getFileByStoredName(storedName)?.session_key as string | undefined) || null,
  };
  const access = createResourceAccess({ canAccessAgent: auth.canAccessAgent, lookup: resourceLookup });
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

  // ---- P6 工作区与外围：终端、文件管理器、语音、记忆 sidecar、ClawOPT 作为 MCP 服务、成长轨迹、主题、性能 ----
  const hostCapabilities = () => runtimePlatform.manager.hostCapabilities();
  /** 记忆服务是独立的 SQLite 文件（sidecar）：与主库分开备份与恢复，坏了不拖累会话数据。 */
  const memory = createMemoryService({ dbPath: path.join(clawoptDataDir, 'memory', 'memory.sqlite') });
  const mcpServer = createMcpServerService({
    db,
    resourceLookup,
    runCoordinator,
    automation,
    memory,
    events,
    runtimePlatform,
    publicBaseUrl: () => `http://127.0.0.1:${Number(process.env.PORT) || 3100}`,
    // chat_run：与工作流节点同一条协调器路径。`ext:<运行时>` 走外部运行时（global 模式），其余是 OpenClaw Agent。
    delegateTurn: ({ agentId, prompt, markDelegated }) => automation.delegateTurn({
      agentRef: agentId.startsWith('ext:')
        ? { kind: 'external', id: agentId.slice('ext:'.length).split(':')[0], runtime: agentId.slice('ext:'.length).split(':')[0], mode: 'global' }
        : { kind: 'openclaw', id: agentId },
      prompt,
      timeoutMs: 10 * 60 * 1000,
      onSessionKey: markDelegated,
    }),
  });
  // 托管 MCP：外部运行时每次运行前按运行上下文签发范围令牌并注入（运行时平台的钩子，P2 起一直为空）。
  runtimePlatform.setManagedMcpServers((runtime, run) => mcpServer.managedServersFor(runtime, run));
  const terminal = createTerminalService({ db, hostCapabilities });
  const fileManager = createFileManagerService({
    db,
    access,
    hostCapabilities,
    listAgentWorkspaces: async () => {
      const agents = await engineRoster.list().catch(() => []);
      return agents.map((agent) => ({ agentId: agent.id, workspace: agent.workspace ?? agentProvisioner.getWorkspacePath(agent.id) }));
    },
  });
  const voice = createVoiceService({ db, dataDir: clawoptDataDir, hostCapabilities });
  const journey = createJourneyService({ engineRoster, agentProvisioner, writeGate, memory });
  const theme = createThemeService({ db });
  const performance = createPerformanceService({ runCoordinator, runtimePlatform, automation });

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
    resourceLookup,
    memory,
    mcpServer,
    terminal,
    fileManager,
    voice,
    journey,
    theme,
    performance,
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
