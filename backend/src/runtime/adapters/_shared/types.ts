/**
 * 编码类外部运行时（Claude Code / Codex / Pi / Grok / OpenCode / DSH / Hermes）共用的请求与工厂依赖。
 */
import type { ProxyMode } from '../../contract';
import type {
  ApiMode,
  ManagedMcpServer,
  McpInjector,
  ProviderProxy,
  RuntimeManager,
} from '../_platform-types';
import type { ConversationScope } from './runtime-home';
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
  /** 运行时 home 按它定位：单聊按会话键，群聊按 (群, 成员)。 */
  conversation: ConversationScope;
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

export interface CodingAgentAdapterDeps {
  proxy: ProviderProxy;
  mcp: McpInjector;
  manager: RuntimeManager;
  executor: ProcessExecutor;
  /** ClawOPT 数据目录的绝对路径。 */
  dataDir: string;
  logger: AdapterLogger;
  /** 以下只为测试注入。 */
  fs?: RuntimeFs;
  homeDir?: string;
  processEnv?: NodeJS.ProcessEnv;
  randomUUID?: () => string;
  now?: () => number;
}
