/**
 * 进程入口的全部动作：建上下文 → 跑拆分前就有的启动步骤 → 组装应用 → 监听。
 * 顺序与拆分前 index.ts 自上而下执行的副作用顺序一致。
 *
 * P0 新增的只有两件：就绪状态（`/readyz`）与优雅停机注册表。
 */
import { createServer } from 'http';

import { consumeBrowserWarmupRequest } from '../control';
import { buildApp } from './app';
import { createAppContext } from './context';
import { createReadiness } from './health';
import { createShutdownRegistry } from './shutdown';
import { runStartupSteps } from './startup-steps';

export function startServer() {
  const readiness = createReadiness();
  const shutdown = createShutdownRegistry();
  shutdown.installSignalHandlers();

  const ctx = createAppContext();
  readiness.markDbReady();
  runStartupSteps(ctx);
  ctx.preview.detectLibreOffice();

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
