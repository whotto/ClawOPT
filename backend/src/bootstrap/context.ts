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

import { AuthStore, createAuthMiddleware, hashPassword, isHashedPassword } from '../core/auth';
import { ConfigManager } from '../core/config';
import { DB } from '../core/db';
import { uploadDir } from '../core/paths';
import { createGatewayConnections, createGatewayService, type OpenClawClient } from '../openclaw';
import {
  AgentProvisioner,
  createAgentSettings,
  createAppUpdateService,
  createBrowserService,
  createImageGenerationService,
  createOpenClawUpdateService,
  createPackService,
} from '../control';
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

export function createAppContext() {
  fs.mkdirSync(uploadDir, { recursive: true });

  // Initialize managers
  const db = new DB();
  const configManager = new ConfigManager();
  const sessionManager = new SessionManager(db);
  /** 会话令牌存储：随机、可过期、可吊销。 */
  const authStore = new AuthStore(db);

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

  const base = { db, configManager, sessionManager, authStore, agentProvisioner, connections };

  const uploads = createUploadService(base);
  const gatewayService = createGatewayService(base);
  const browser = createBrowserService({ gatewayService });
  const appUpdate = createAppUpdateService({ browser, gatewayService });
  const imageGeneration = createImageGenerationService(base);
  const openclawUpdate = createOpenClawUpdateService({ imageGeneration, gatewayService });
  const agentSettings = createAgentSettings(base);
  const gatewayConnections = createGatewayConnections(base);
  const sessionRuntime = createSessionRuntime({ ...base, gatewayConnections });
  const chatMessages = createChatMessages({ sessionRuntime });
  const roomMessages = createRoomMessages(base);
  const preview = createPreviewService(base);
  const directChat = createDirectChatService({ ...base, sessionRuntime });
  const roomRuntime = createRoomRuntime({ ...base, sessionRuntime, gatewayConnections });
  const rooms = createRoomEngine({ ...base, roomRuntime, agentSettings, imageGeneration, gatewayConnections });
  const roomReconciliation = createRoomReconciliation({ ...base, rooms, roomRuntime, agentSettings, gatewayConnections });
  const auth = createAuthMiddleware(base);
  const packs = createPackService({ ...base, agentSettings });
  const chatRuns = createChatRuns(base);
  const chatLifecycle = createChatLifecycle({ ...base, chatRuns, sessionRuntime, gatewayConnections });
  const chatCommands = createChatCommands({ ...base, gatewayConnections });

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
    packs,
    chatRuns,
    chatLifecycle,
    chatCommands,
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
