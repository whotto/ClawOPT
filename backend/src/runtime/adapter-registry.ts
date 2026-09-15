/**
 * 运行时适配器登记处：适配器在自己的文件夹里 `registerAdapter(descriptor, factory)`，
 * 群聊引擎等表面按 `group_members.runtime` 取工厂，不再写死 `createClaudeCodeRuntimeAdapter`。
 *
 * 规则：
 * - id 与 `group_members.runtime` 同一套取值；重复登记同一个 id 抛错（两个适配器抢一个名字只会静默覆盖）；
 * - 描述符同时交给运行时管理器（安装、PATH 发现、配置页按它渲染）；
 * - 工厂拿到的依赖（管理器、代理、MCP 注入、运行时目录、可注入的执行器）由 bootstrap 统一给，
 *   适配器不自己 new 这些单例。
 */
import type { AgentRuntimeAdapter } from './contract';
import type { CommandExecutor } from './adapters/claude-code';
import type { ExternalRunRequest } from './external-agents/types';
import type { RuntimeDescriptor, RuntimeManager } from './manager/types';
import type { RuntimeHomeOwner } from './manager/runtime-homes';
import type { McpInjector } from './mcp/types';
import type { ProviderProxy } from './proxy/types';

export interface RuntimeAdapterDeps {
  manager: RuntimeManager;
  proxy: ProviderProxy;
  mcp: McpInjector;
  homes: { ensureHome(runtime: string, owner: RuntimeHomeOwner): string };
  /** CLI 类适配器的执行器（群聊用例注入假执行器；缺省为本机子进程）。 */
  executor?: CommandExecutor;
  /** 远程 OpenClaw 成员的令牌存储（只写不读的密钥，按群与成员加密）。 */
  remoteOpenClawSecrets?: { get(groupId: string, agentId: string): string | null };
}

/** 群聊外部成员等表面交给适配器的请求：CLI 通用字段 + 成员配置与归属。 */
export interface RuntimeRunRequest extends ExternalRunRequest {
  /** `group_members.external_config` 解析后的对象（不含密钥：密钥由各自的密钥存储给）。 */
  runtimeConfig?: Record<string, unknown>;
  /** 这次运行属于谁（运行时目录回收、远程成员密钥查找都按它）。 */
  owner?: RuntimeHomeOwner;
}

export type RuntimeAdapterFactory = (deps: RuntimeAdapterDeps) => AgentRuntimeAdapter<RuntimeRunRequest>;

export interface RegisteredRuntimeAdapter {
  descriptor: RuntimeDescriptor;
  factory: RuntimeAdapterFactory;
}

type Listener = (entry: RegisteredRuntimeAdapter) => void;

export class RuntimeAdapterRegistry {
  private readonly entries = new Map<string, RegisteredRuntimeAdapter>();
  private readonly listeners = new Set<Listener>();

  registerAdapter(descriptor: RuntimeDescriptor, factory: RuntimeAdapterFactory): void {
    if (this.entries.has(descriptor.id)) throw new Error(`runtime adapter "${descriptor.id}" is already registered`);
    const entry = { descriptor, factory };
    this.entries.set(descriptor.id, entry);
    for (const listener of [...this.listeners]) listener(entry);
  }

  get(id: string): RegisteredRuntimeAdapter | null {
    return this.entries.get(id) ?? null;
  }

  list(): RegisteredRuntimeAdapter[] {
    return [...this.entries.values()];
  }

  /** 订阅登记（含已登记的）。运行时管理器用它把描述符收进来。 */
  subscribe(listener: Listener): () => void {
    for (const entry of this.entries.values()) listener(entry);
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** 进程级登记处。适配器模块加载时往这里登记。 */
export const runtimeAdapterRegistry = new RuntimeAdapterRegistry();

export function registerAdapter(descriptor: RuntimeDescriptor, factory: RuntimeAdapterFactory): void {
  runtimeAdapterRegistry.registerAdapter(descriptor, factory);
}
