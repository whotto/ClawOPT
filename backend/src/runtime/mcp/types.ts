/**
 * 托管 MCP 注入的对外形状。适配器按这里的签名编码。
 */

export interface ManagedMcpServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * 这一次运行是谁（P6：ClawOPT 作为 MCP 服务时按运行签发范围令牌）。适配器从协调器的运行上下文里取，
 * 注入器原样交给托管服务的提供者；没有它（旧调用方、测试）时托管服务按「无运行上下文」处理——不签发令牌。
 */
export interface McpRunContext {
  runId: string;
  /** 协调器会话键（单聊会话 id、`room:<群>:member:<成员>`、`workflow:<会话>`……）。 */
  sessionKey: string;
  agentId: string;
  runtime: string;
  /** 运行时 home 的归属（群成员带 groupId，工作流节点带 workflowId）。 */
  owner?: { kind: string; [key: string]: unknown };
}

export interface McpInjector {
  /**
   * 合并 ClawOPT 托管的 MCP（目前为空，钩子留着）与用户的 MCP，并做**每次运行前的健康隔离**：
   * 用户的每个服务并行探测（连接 + tools/list，每个 5 秒），坏的从这一次运行的副本里剔除。
   * 隔离步骤自己出错时**放行**（fail-open）：宁可带着一个可能坏的 MCP 启动，也不因为探测器的 bug 让运行起不来。
   */
  resolveForRun(opts: { runtime: string; userServers: ManagedMcpServer[]; run?: McpRunContext }): Promise<{ servers: ManagedMcpServer[]; excluded: { name: string; reason: string }[] }>;
}

/** 界面与原生文件之间的一行（带启用状态与是否托管）。 */
export interface McpServerEntry extends ManagedMcpServer {
  enabled: boolean;
  managed: boolean;
}

export interface McpProbeResult {
  ok: boolean;
  tools: Array<{ name: string; description?: string; input_schema?: unknown }>;
  /** 已脱敏。 */
  error: string | null;
}

/** 托管条目的环境变量标记：用户文件里带它的条目一律当托管条目剥掉重生成。 */
export const CLAWOPT_MANAGED_MCP_ENV = 'CLAWOPT_MANAGED_MCP';
/** 托管条目的名字前缀。 */
export const CLAWOPT_MANAGED_MCP_PREFIX = 'clawopt-';

export function isManagedMcpServer(server: { name: string; env?: Record<string, string> }): boolean {
  return server.name.startsWith(CLAWOPT_MANAGED_MCP_PREFIX) || server.env?.[CLAWOPT_MANAGED_MCP_ENV] === '1';
}
