/**
 * 运行时适配器登记处：适配器在自己的文件夹里登记（`registerAdapter(descriptor, factory)`），
 * 群聊引擎、单聊外部运行时等表面按 `group_members.runtime` / 会话的运行时 id 取工厂。
 *
 * 规则：
 * - id 与 `group_members.runtime` 同一套取值；重复登记同一个 id 抛错（两个适配器抢一个名字只会静默覆盖）；
 * - 描述符同时交给运行时管理器（安装、PATH 发现、配置页按它渲染）；
 * - 工厂拿到的依赖（管理器、代理、MCP 注入、运行时目录、执行器、日志）由平台组装时统一给，
 *   适配器不自己 new 这些单例。
 */
import type { AgentRuntimeAdapter, RuntimeCapabilities } from './contract';
import type { CodingAgentAdapterDeps, CodingAgentRunRequest } from './adapters/_shared/types';
import type { RuntimeDescriptor } from './manager/types';

export interface RuntimeAdapterDeps extends CodingAgentAdapterDeps {
  /** 远程 OpenClaw 成员的令牌存储（只写不读的密钥，按群与成员加密）。 */
  remoteOpenClawSecrets?: { get(groupId: string, agentId: string): string | null };
}

/**
 * 表面交给适配器的请求：编码类运行时的通用字段（prompt、工作区、续话句柄、模式、归属、成员配置…）。
 * 远程 OpenClaw 只用其中的 prompt / sessionId / runtimeConfig / owner。
 */
export type RuntimeRunRequest = CodingAgentRunRequest;

export type RuntimeAdapterFactory = (deps: RuntimeAdapterDeps) => AgentRuntimeAdapter<RuntimeRunRequest>;

export interface RegisteredRuntimeAdapter {
  descriptor: RuntimeDescriptor;
  factory: RuntimeAdapterFactory;
  /** 不实例化就能回答「这个运行时支持哪些模式、能不能审批」（成员运行时选择器用）。 */
  capabilities?: Readonly<RuntimeCapabilities>;
}

type Listener = (entry: RegisteredRuntimeAdapter) => void;

export class RuntimeAdapterRegistry {
  private readonly entries = new Map<string, RegisteredRuntimeAdapter>();
  private readonly listeners = new Set<Listener>();

  registerAdapter(descriptor: RuntimeDescriptor, factory: RuntimeAdapterFactory, meta: { capabilities?: Readonly<RuntimeCapabilities> } = {}): void {
    if (this.entries.has(descriptor.id)) throw new Error(`runtime adapter "${descriptor.id}" is already registered`);
    const entry = { descriptor, factory, capabilities: meta.capabilities };
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

export function registerAdapter(descriptor: RuntimeDescriptor, factory: RuntimeAdapterFactory, meta?: { capabilities?: Readonly<RuntimeCapabilities> }): void {
  runtimeAdapterRegistry.registerAdapter(descriptor, factory, meta);
}
