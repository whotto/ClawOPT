/**
 * 外部运行时共用底座的组装：运行时管理器、MCP 注入、远程成员令牌存储、适配器登记与依赖。
 * bootstrap 只调这一个工厂，路由、群聊引擎与单聊外部运行时从返回的对象上取。
 */
import { runtimeAdapterRegistry, type RuntimeAdapterDeps, type RuntimeAdapterRegistry, type RuntimeRunRequest } from './adapter-registry';
import { createLocalProcessExecutor, type ProcessExecutor } from './adapters/_shared/process';
import type { AdapterLogger, ScopedProviderResolver } from './adapters/_shared/types';
import { registerBuiltinAdapters } from './builtin-adapters';
import type { AgentRuntimeAdapter } from './contract';
import { createRuntimeManager, type LocalRuntimeManager, type RuntimeHomeOwner, type RuntimeManagerOptions } from './manager';
import { readUserMcpServersForRun } from './manager/native-config';
import { createMcpInjector } from './mcp';
import type { ManagedMcpServer, McpInjector, McpRunContext } from './mcp';
import type { ProviderProxy } from './proxy';
import { RemoteMemberSecretStore } from './remote-openclaw';

export interface RuntimePlatformOptions extends Omit<RuntimeManagerOptions, 'dataDir'> {
  dataDir: string;
  proxy: ProviderProxy;
  registry?: RuntimeAdapterRegistry;
  /** 缺省本机子进程执行器。 */
  executor?: ProcessExecutor;
  logger?: AdapterLogger;
  /** scoped 运行没直接带上游时，按成员 / 会话配置解析（bootstrap 注入：读 ClawOPT 的模型配置）。 */
  resolveScopedProvider?: ScopedProviderResolver;
}

export interface RuntimePlatform {
  manager: LocalRuntimeManager;
  mcp: McpInjector;
  proxy: ProviderProxy;
  remoteSecrets: RemoteMemberSecretStore;
  registry: RuntimeAdapterRegistry;
  /** 按运行时 id 取适配器；没登记过返回 null（调用方按「不支持的运行时」失败）。 */
  createAdapter(runtime: string, options?: { executor?: ProcessExecutor }): AgentRuntimeAdapter<RuntimeRunRequest> | null;
  /** 归属被删：回收运行时目录（远程成员令牌随定期清扫删除）。 */
  releaseOwner(owner: Partial<RuntimeHomeOwner> & { kind: RuntimeHomeOwner['kind'] }, options?: { exceptRuntime?: string }): void;
  /**
   * 托管 MCP 服务的提供者（P6：ClawOPT 作为 MCP 服务）。bootstrap 在 MCP 服务装配好之后设一次；
   * 没设时没有托管服务。每次运行前按运行上下文调用。
   */
  setManagedMcpServers(provider: (runtime: string, run?: McpRunContext) => ManagedMcpServer[] | Promise<ManagedMcpServer[]>): void;
  start(): void;
  stop(): void;
}

const CONSOLE_LOGGER: AdapterLogger = {
  info: (message, detail) => console.log(message, detail ?? ''),
  warn: (message, detail) => console.warn(message, detail ?? ''),
};

export function createRuntimePlatform(options: RuntimePlatformOptions): RuntimePlatform {
  const registry = options.registry ?? runtimeAdapterRegistry;
  registerBuiltinAdapters(registry);
  const manager = createRuntimeManager(options);
  const unsubscribe = registry.subscribe((entry) => manager.register(entry.descriptor));
  let managedServersProvider: (runtime: string, run?: McpRunContext) => ManagedMcpServer[] | Promise<ManagedMcpServer[]> = () => [];
  const mcp = createMcpInjector({ childEnv: () => manager.childEnv({}), managedServers: (runtime, run) => managedServersProvider(runtime, run) });
  const remoteSecrets = new RemoteMemberSecretStore(options.dataDir);
  const defaultExecutor = options.executor ?? createLocalProcessExecutor();

  const deps = (executor: ProcessExecutor): RuntimeAdapterDeps => ({
    manager,
    proxy: options.proxy,
    mcp,
    homes: manager.homes,
    executor,
    logger: options.logger ?? CONSOLE_LOGGER,
    resolveScopedProvider: options.resolveScopedProvider,
    userMcpServers: (runtime) => readUserMcpServersForRun(manager.descriptor(runtime), { env: options.env }),
    remoteOpenClawSecrets: remoteSecrets,
  });

  // 适配器本身无状态（每次 start 各管各的运行），默认执行器下每个运行时只造一个。
  const cached = new Map<string, AgentRuntimeAdapter<RuntimeRunRequest>>();

  return {
    manager,
    mcp,
    proxy: options.proxy,
    remoteSecrets,
    registry,
    createAdapter(runtime, adapterOptions = {}) {
      const entry = registry.get(runtime);
      if (!entry) return null;
      if (adapterOptions.executor) return entry.factory(deps(adapterOptions.executor));
      let adapter = cached.get(runtime);
      if (!adapter) {
        adapter = entry.factory(deps(defaultExecutor));
        cached.set(runtime, adapter);
      }
      return adapter;
    },
    releaseOwner(owner, releaseOptions) {
      try {
        manager.homes.releaseOwner(owner, releaseOptions);
      } catch (error) {
        console.warn(`[RuntimePlatform] runtime home cleanup failed: ${(error as NodeJS.ErrnoException)?.code ?? 'Error'}`);
      }
    },
    setManagedMcpServers(provider) {
      managedServersProvider = provider;
    },
    start() {
      manager.start();
    },
    stop() {
      manager.stop();
      unsubscribe();
    },
  };
}
