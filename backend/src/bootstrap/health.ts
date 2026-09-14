/**
 * 存活 / 就绪 / 健康三个端点。
 *
 * - `GET /livez`：进程还能处理 HTTP 就是 200，不碰任何依赖。给 systemd / 反代判断「要不要重启」。
 * - `GET /readyz`：启动装配完成（数据库已打开）**并且**已经在监听之前一律 503。
 *   给反代与部署脚本判断「能不能把流量切过来」——在 listen 回调之前放流量，
 *   请求会撞上还没跑完的启动步骤。
 * - `GET /health`：拆分前就有的端点，形状保持不变。
 *
 * 三者都注册在鉴权闸门之前，因此天然公开；`/livez` 与 `/readyz` 同时登记进
 * `AUTH_PUBLIC_PATHS`，让「这两条是有意公开的」这件事在白名单里也看得见。
 */
import type { RouteApp } from '../core/http';

export type ReadinessState = {
  dbReady: boolean;
  listening: boolean;
};

export function createReadiness() {
  const state: ReadinessState = { dbReady: false, listening: false };
  return {
    markDbReady() {
      state.dbReady = true;
    },
    markListening() {
      state.listening = true;
    },
    snapshot(): ReadinessState {
      return { ...state };
    },
    isReady() {
      return state.dbReady && state.listening;
    },
  };
}

export type Readiness = ReturnType<typeof createReadiness>;

export type HealthRoutesDeps = {
  readiness: Readiness;
  connections: Map<string, unknown>;
};

export function registerHealthRoutes(app: RouteApp, ctx: HealthRoutesDeps): void {
  const { readiness, connections } = ctx;

  app.get('/livez', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/readyz', (_req, res) => {
    const checks = readiness.snapshot();
    res.status(readiness.isReady() ? 200 : 503).json({
      status: readiness.isReady() ? 'ready' : 'starting',
      checks,
    });
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      connections: connections.size,
    });
  });
}
