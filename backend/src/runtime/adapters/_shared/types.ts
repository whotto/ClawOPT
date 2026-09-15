/**
 * 编码类外部运行时（Claude Code / Codex / Pi / Grok / OpenCode / DSH / Hermes）共用的请求与工厂依赖。
 */
import type { ProxyMode } from '../../contract';
import type { RuntimeHomeOwner } from '../../manager/runtime-homes';
import type { RuntimeManager } from '../../manager/types';
import type { ManagedMcpServer, McpInjector } from '../../mcp/types';
import type { ApiMode, ProviderProxy } from '../../proxy/types';
import type { ProcessExecutor } from './process';
import type { RuntimeFs } from './runtime-fs';

/** scoped 模式下 ClawOPT 选定的上游。key 只进代理内存，**永不**进 CLI 配置文件。 */
export interface ScopedProvider {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  apiMode: ApiMode;
  reasoningEffort?: string;
  /** 模型上下文窗口（写进各 CLI 的模型目录 / 自动压缩阈值）；缺省 128000。 */
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type SessionCommand =
  | { kind: 'turn' }
  | { kind: 'compact'; instructions?: string }
  | { kind: 'status' }
  | { kind: 'usage' };

export interface CodingAgentImage {
  path: string;
  mimeType: string;
  /** base64；需要内联图片的协议（Claude stream-json、Pi RPC、Grok JSON prompt、ACP）用。 */
  data?: string;
}

export interface CodingAgentRunRequest {
  /** 缺省 global。协调器提交里的 proxyMode 优先。 */
  mode?: ProxyMode;
  prompt: string;
  workspace: string;
  /**
   * 这次运行属于谁：运行时 home 按它定位（`<数据目录>/runtime/<运行时>/<哈希(归属)>`），归属被删时按它回收；
   * 远程 OpenClaw 成员的令牌也按它找。单聊 `{kind: 'session'}`，群聊 `{kind: 'room-member'}`。
   */
  owner: RuntimeHomeOwner;
  /** 表面给的成员 / 会话配置（不含密钥）：远程 OpenClaw 的网关地址、scoped 的服务商与模型选择等。 */
  runtimeConfig?: Record<string, unknown>;
  /**
   * ClawOPT 这一侧的会话句柄（UUID），由表面生成并持久化（群聊是 external_sessions.session_id）。
   * 允许客户端指定会话 id 的运行时（Claude / Pi / Grok）直接拿它当原生会话 id；
   * 其余运行时在运行时 home 里记「句柄 → 观察到的原生 id」。
   */
  sessionId: string;
  /** 表面认为这个会话可以续（上一轮成功）。最终续不续还要过兼容性判定。 */
  resume: boolean;
  provider?: ScopedProvider;
  /** global 模式可选的模型覆盖。 */
  model?: string;
  reasoningEffort?: string;
  /** 单聊的基础系统提示。 */
  systemPrompt?: string;
  /** 群聊的系统提示：**替换**基础提示。 */
  groupSystemPrompt?: string;
  /** 调用方追加的指令（群成员配置里的 appendSystemPrompt 等）。 */
  instructions?: string;
  userMcpServers?: ManagedMcpServer[];
  images?: CodingAgentImage[];
  command?: SessionCommand;
  /** 仅 Claude Code：沿用群成员配置里的工具白名单 / 成本护栏 / 额外目录。 */
  allowedTools?: string[];
  maxBudgetUsd?: number;
  extraDirs?: string[];
}

export interface AdapterLogger {
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
}

/** scoped 模式下按表面给的选择（`runtimeConfig`）解析出上游：服务商地址、key、协议。key 只进代理内存。 */
export type ScopedProviderResolver = (selection: Record<string, unknown> | undefined, runtime: string) => ScopedProvider | null;

export interface CodingAgentAdapterDeps {
  proxy: ProviderProxy;
  mcp: McpInjector;
  manager: RuntimeManager;
  /** 运行时目录（平台的 RuntimeHomes：带归属标记，删归属 / 定期清扫时回收）。 */
  homes: { ensureHome(runtime: string, owner: RuntimeHomeOwner): string };
  executor: ProcessExecutor;
  logger: AdapterLogger;
  /** 请求里没带 `provider` 的 scoped 运行按成员 / 会话配置解析上游（bootstrap 注入：读 ClawOPT 的模型配置）。 */
  resolveScopedProvider?: ScopedProviderResolver;
  /**
   * scoped 运行副本要合并的用户 MCP 服务（运行时自己的全局 MCP 文件里启用的那些；bootstrap 注入：平台按原生文件表读）。
   * global 模式不调：CLI 自己读用户的全局配置。
   */
  userMcpServers?: (runtime: string) => ManagedMcpServer[];
  /** 以下只为测试注入。 */
  fs?: RuntimeFs;
  homeDir?: string;
  processEnv?: NodeJS.ProcessEnv;
  randomUUID?: () => string;
  now?: () => number;
}
