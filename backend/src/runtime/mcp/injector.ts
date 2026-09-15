/**
 * 托管 MCP 注入与每次运行前的健康隔离（spec 04 §2.10）。
 *
 * 一个坏掉的用户 MCP 服务会卡住甚至拖崩 CLI 启动；隔离把它从**这一次运行的副本**里剔除，
 * 用户的全局文件不动。每个服务 5 秒、并行；隔离步骤自己出错一律放行。
 */
import { probeMcpServer } from './probe';
import { isManagedMcpServer, type ManagedMcpServer, type McpInjector, type McpProbeResult } from './types';

export interface McpInjectorOptions {
  /** ClawOPT 托管的 MCP 服务（目前没有，钩子留着：将来 ClawOPT 作为 MCP 服务时从这里注入）。 */
  managedServers?: (runtime: string) => ManagedMcpServer[];
  /** stdio 子进程的环境（运行时管理器的白名单环境）。 */
  childEnv: () => NodeJS.ProcessEnv;
  probe?: (server: ManagedMcpServer, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<McpProbeResult>;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export function createMcpInjector(options: McpInjectorOptions): McpInjector {
  const probe = options.probe ?? probeMcpServer;
  const timeoutMs = options.timeoutMs ?? 5000;
  const log = options.log ?? ((message: string) => console.log(message));

  return {
    async resolveForRun({ runtime, userServers }) {
      const managed = options.managedServers?.(runtime) ?? [];
      const managedNames = new Set(managed.map((server) => server.name));
      // 用户文件里残留的托管条目（旧名字、带标记的）不参与：托管的以这一次生成的为准。
      const candidates = userServers.filter((server) => !isManagedMcpServer(server) && !managedNames.has(server.name));
      const excluded: { name: string; reason: string }[] = [];
      let healthy = candidates;
      try {
        const env = options.childEnv();
        const results = await Promise.all(candidates.map(async (server) => {
          try {
            return await probe(server, env, timeoutMs);
          } catch {
            return { ok: true, tools: [], error: null } as McpProbeResult; // 单个探测器异常：放行
          }
        }));
        healthy = candidates.filter((server, index) => {
          if (results[index].ok) return true;
          excluded.push({ name: server.name, reason: results[index].error ?? 'unhealthy' });
          return false;
        });
        for (const item of excluded) log(`[MCP] ${runtime}: excluded unhealthy server "${item.name}" from this run`);
      } catch (error) {
        log(`[MCP] ${runtime}: isolation step failed, continuing with all servers (${(error as Error)?.name ?? 'Error'})`);
        healthy = candidates;
        excluded.length = 0;
      }
      return { servers: [...managed, ...healthy], excluded };
    },
  };
}
