/**
 * 进程入口的全部动作：建上下文 → 跑拆分前就有的启动步骤 → 组装应用 → 监听。
 * 顺序与拆分前 index.ts 自上而下执行的副作用顺序一致。
 *
 * P0 新增的只有三件：就绪状态（`/readyz`）、优雅停机注册表、启动一次性任务（目前零个）。
 */
import { createServer } from 'http';

import { consumeBrowserWarmupRequest } from '../control';
import { startupTasksStatePath } from '../core/paths';
import { buildApp } from './app';
import { createAppContext } from './context';
import { createReadiness } from './health';
import { attachRealtimeServer } from './realtime';
import { createShutdownRegistry } from './shutdown';
import { runStartupSteps } from './startup-steps';
import { runStartupTasks, STARTUP_TASKS } from './startup-tasks';

export async function startServer() {
  const readiness = createReadiness();
  const shutdown = createShutdownRegistry();
  shutdown.installSignalHandlers();

  const ctx = createAppContext();
  // 代理目标的加密恢复文件：重启前登记过、还在用的 CLI 配置里的令牌继续有效。
  const restoredProxyTargets = ctx.providerProxy.restore();
  if (restoredProxyTargets > 0) console.log(`[RuntimeProxy] restored ${restoredProxyTargets} proxy target(s)`);
  // 运行时管理器：预热 PATH、自动升级调度（60 秒一拍）与运行时目录定期清扫；群或成员已不在的远程令牌删掉。
  ctx.runtimePlatform.start();
  try {
    ctx.runtimePlatform.remoteSecrets.prune((groupId, agentId) => ctx.db.getGroupMembers(groupId).some((member) => member.agent_id === agentId));
  } catch (error) {
    console.warn(`[RuntimePlatform] remote member token prune skipped: ${(error as NodeJS.ErrnoException)?.code ?? 'Error'}`);
  }
  readiness.markDbReady();
  runStartupSteps(ctx);
  ctx.preview.detectLibreOffice();
  // 拒跑或失败只记日志（任务 id + errorCode），不阻止服务起来：没跑的任务下次启动再试。
  await runStartupTasks({ tasks: STARTUP_TASKS, statePath: startupTasksStatePath });

  const { app, routes } = buildApp(ctx, { readiness });
  const server = createServer(app);
  const realtimeServer = attachRealtimeServer(server, ctx);

  shutdown.register({
    name: 'openclaw-gateway-connections',
    close: () => {
      for (const [sessionId, client] of ctx.connections) {
        ctx.connections.delete(sessionId);
        client.disconnect();
      }
    },
  });
  shutdown.register({
    name: 'http-server',
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // 空闲的 keep-alive 连接立刻断；SSE 这类活跃长连接留给超时后的 forceClose。
      server.closeIdleConnections();
    }),
    forceClose: () => server.closeAllConnections(),
  });
  shutdown.register({
    name: 'realtime-websocket',
    close: () => realtimeServer.close(),
  });
  shutdown.register({
    name: 'runtime-platform',
    close: () => ctx.runtimePlatform.stop(),
  });
  shutdown.register({
    name: 'run-coordinator',
    // 逆序关闭，所以它最先关：先把正在跑的运行按「停机」中止（外部 Agent 子进程整组收掉、
    // 待决审批按拒绝收尾、SSE 流收到终帧后结束），HTTP 才关得干净；
    // 网关连接最后关——中止 OpenClaw 运行还要用它。
    close: () => ctx.runCoordinator.shutdown(),
  });

  // Start server
  const PORT = Number(process.env.PORT) || 3100;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ClawOPT backend listening on http://0.0.0.0:${PORT}`);
    readiness.markListening();
    ctx.imageGeneration.scheduleOpenClawImageProviderCacheRefresh('startup');
    if (consumeBrowserWarmupRequest()) {
      console.log('[BrowserWarmup] Scheduling deferred browser warmup after restart.');
      void ctx.browser.scheduleDeferredBrowserWarmup();
    }
    if (ctx.appUpdate.buildUpdateStatusResponse().status === 'restarting') {
      console.log('[UpdateRestart] Resuming persisted restart flow after service restart.');
      void ctx.appUpdate.resumePersistedUpdateRestartFlow();
    }
  });

  return { ctx, app, server, routes, readiness, shutdown };
}
