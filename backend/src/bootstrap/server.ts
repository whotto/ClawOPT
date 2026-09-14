/**
 * 进程入口的全部动作：建上下文 → 跑拆分前就有的启动步骤 → 组装应用 → 监听。
 * 顺序与拆分前 index.ts 自上而下执行的副作用顺序一致。
 */
import { createServer } from 'http';

import { consumeBrowserWarmupRequest } from '../control';
import { buildApp } from './app';
import { createAppContext } from './context';
import { runStartupSteps } from './startup-steps';

export function startServer() {
  const ctx = createAppContext();
  runStartupSteps(ctx);
  ctx.preview.detectLibreOffice();

  const { app, routes } = buildApp(ctx);
  const server = createServer(app);

  // Start server
  const PORT = Number(process.env.PORT) || 3100;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ClawOPT backend listening on http://0.0.0.0:${PORT}`);
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

  return { ctx, app, server, routes };
}
