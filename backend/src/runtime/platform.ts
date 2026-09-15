/**
 * 外部运行时共用底座的组装：运行时管理器、MCP 注入、远程成员令牌存储、适配器登记与依赖。
 * bootstrap 只调这一个工厂，路由与群聊引擎从返回的对象上取。
 */
import type { CommandExecutor } from './adapters/claude-code';
import { runtimeAdapterRegistry, type RuntimeAdapterDeps, type RuntimeAdapterRegistry, type RuntimeRunRequest } from './adapter-registry';
import { registerBuiltinAdapters } from './builtin-adapters';
import type { AgentRuntimeAdapter } from './contract';
import { createRuntimeManager, type LocalRuntimeManager, type RuntimeHomeOwner, type RuntimeManagerOptions } from './manager';
import { createMcpInjector } from './mcp';
import type { McpInjector } from './mcp';
import type { ProviderProxy } from './proxy';
import { RemoteMemberSecretStore } from './remote-openclaw';

export interface RuntimePlatformOptions extends Omit<RuntimeManagerOptions, 'dataDir'> {
  dataDir: string;
  proxy: ProviderProxy;
  registry?: RuntimeAdapterRegistry;
}

export interface RuntimePlatform {
  manager: LocalRuntimeManager;
  mcp: McpInjector;
  proxy: ProviderProxy;
  remoteSecrets: RemoteMemberSecretStore;
  registry: RuntimeAdapterRegistry;
  /** 按运行时 id 造适配器；没登记过返回 null（调用方按「不支持的运行时」失败）。 */
  createAdapter(runtime: string, options?: { executor?: CommandExecutor }): AgentRuntimeAdapter<RuntimeRunRequest> | null;
  /** 归属被删：回收运行时目录（远程成员令牌随定期清扫删除）。 */
  releaseOwner(owner: Partial<RuntimeHomeOwner> & { kind: RuntimeHomeOwner['kind'] }): void;
  start(): void;
  stop(): void;
}

export function createRuntimePlatform(options: RuntimePlatformOptions): RuntimePlatform {
  const registry = options.registry ?? runtimeAdapterRegistry;
  registerBuiltinAdapters(registry);
  const manager = createRuntimeManager(options);
  const unsubscribe = registry.subscribe((entry) => manager.register(entry.descriptor));
  const mcp = createMcpInjector({ childEnv: () => manager.childEnv({}), managedServers: () => [] });
  const remoteSecrets = new RemoteMemberSecretStore(options.dataDir);

  const deps = (executor?: CommandExecutor): RuntimeAdapterDeps => ({
    manager,
    proxy: options.proxy,
    mcp,
    homes: manager.homes,
    executor,
    remoteOpenClawSecrets: remoteSecrets,
  });

  return {
    manager,
    mcp,
    proxy: options.proxy,
    remoteSecrets,
    registry,
    createAdapter(runtime, adapterOptions = {}) {
      const entry = registry.get(runtime);
      return entry ? entry.factory(deps(adapterOptions.executor)) : null;
    },
    releaseOwner(owner) {
      try {
        manager.homes.releaseOwner(owner);
      } catch (error) {
        console.warn(`[RuntimePlatform] runtime home cleanup failed: ${(error as NodeJS.ErrnoException)?.code ?? 'Error'}`);
      }
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
