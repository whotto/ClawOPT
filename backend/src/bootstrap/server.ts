/**
 * 进程入口的全部动作：建上下文 → 跑拆分前就有的启动步骤 → 组装应用 → 监听。
 * 顺序与拆分前 index.ts 自上而下执行的副作用顺序一致。
 *
 * P0 新增的只有三件：就绪状态（`/readyz`）、优雅停机注册表、启动一次性任务。
 */
import { createServer } from 'http';

import { consumeBrowserWarmupRequest } from '../control';
import { startupTasksStatePath } from '../core/paths';
import { buildApp } from './app';
import { createAppContext } from './context';
import { createReadiness } from './health';
import { createShutdownRegistry } from './shutdown';
import { runStartupSteps } from './startup-steps';
import { buildStartupTasks, runStartupTasks } from './startup-tasks';

export async function startServer() {
  const readiness = createReadiness();
  const shutdown = createShutdownRegistry();
  shutdown.installSignalHandlers();

  const ctx = createAppContext();
  readiness.markDbReady();
  runStartupSteps(ctx);
  ctx.preview.detectLibreOffice();
  // 拒跑或失败只记日志（任务 id + errorCode），不阻止服务起来：没跑的任务下次启动再试。
  await runStartupTasks({ tasks: buildStartupTasks(ctx), statePath: startupTasksStatePath });

  // 自动化：先按失败收尾上次没跑完的工作流运行（fail closed），再开定时计划与 Webhook outbox。
  // 必须在监听之前——不能让前端先看到一个「还在跑」、其实已经没人执行的运行。
  ctx.automation.start();
  const { app, routes } = buildApp(ctx, { readiness });
  const server = createServer(app);

  shutdown.register({
    name: 'openclaw-gateway-connections',
    close: () => {
      for (const [sessionId, client] of ctx.connections) {
        ctx.connections.delete(sessionId);
        client.disconnect();
      }
    },
  });
  shutdown.register({ name: 'write-gate-watchers', close: () => ctx.writeGate.stop() });
  shutdown.register({
    name: 'automation',
    close: () => ctx.automation.stop(),
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

  // Start server
  const PORT = Number(process.env.PORT) || 3100;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ClawOPT backend listening on http://0.0.0.0:${PORT}`);
    readiness.markListening();
    ctx.imageGeneration.scheduleOpenClawImageProviderCacheRefresh('startup');
    // 写入审批：给已开启的 Agent 恢复文件监听（解析不到工作区的只记日志，不影响启动）。
    void ctx.writeGate.start();
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
