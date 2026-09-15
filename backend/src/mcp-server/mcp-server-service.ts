/**
 * ClawOPT 作为 MCP 服务（P6，spec 07 §2.37 / §3.4、spec 08 §6.S 超越版）：
 * - 每次运行由协调器的运行上下文签发**范围令牌**（TTL、范围 = Agent / 会话 / 工作流、操作白名单），运行结束即吊销，永不回落到用户会话；
 * - 工具集 `use`（会话、委派对话、工作流、看板）、`memory`（记忆工具）、`api`（精选白名单，不是整站代理）；
 * - 经运行时平台的托管 MCP 钩子注入到外部运行时（带托管标记）；管理员按运行时开关。
 *
 * 骨架：实现由 P6 MCP 分支补齐。
 */
import type { ResourceLookup } from '../core/auth';
import type { DB } from '../core/db';
import type { EventBus } from '../core/events';
import type { Automation } from '../automation';
import type { MemoryService } from '../memory';
import type { ManagedMcpServer, McpRunContext, RunCoordinator, RuntimePlatform } from '../runtime';

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
};

export function createMcpServerService(_deps: McpServerServiceDeps) {
  return {
    /** 运行时平台的托管 MCP 提供者：按运行签发令牌并给出要注入的服务。 */
    managedServersFor(_runtime: string, _run?: McpRunContext): ManagedMcpServer[] {
      return [];
    },
    settings(): { runtimes: Array<{ runtime: string; enabled: boolean }> } {
      return { runtimes: [] };
    },
    stop(): void {},
  };
}

export type McpServerService = ReturnType<typeof createMcpServerService>;
