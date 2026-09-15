/**
 * 组装 Express 应用：中间件与路由的**注册顺序**全在这一个函数里。
 *
 * Express 按注册顺序匹配，顺序本身就是行为：
 * - 注册在 `registerAuthGate` 之前的路由，闸门跑不到，实际公开；
 * - 静态资源中间件在群聊路由之前；
 * - SPA 兜底 `*` 与错误处理必须在最后。
 *
 * 这里的顺序与拆分前 `index.ts` 自上而下的注册顺序逐条一致，
 * 由 `test/route-order.test.ts` 对照签入的清单机械校验。改顺序就是改行为，要改清单。
 */
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import net from 'net';
import path from 'path';

import { registerAuthGate, registerAuthRoutes, AUTH_PUBLIC_PATHS } from '../core/auth';
import { isStructuredRequestError, RouteRegistry } from '../core/http';
import { registerExternalRuntimeRoutes } from '../runtime';
import {
  registerAgentRoutes,
  registerCharacterRoutes,
  registerCommandRoutes,
  registerDiagnosticsRoutes,
  registerGatewayRoutes,
  registerModelRoutes,
  registerPackRoutes,
  registerPresetRoutes,
  registerSettingsRoutes,
  registerUpdateRoutes,
  registerVersionRoutes,
} from '../control';
import { registerFileRoutes, registerUploadRoutes } from '../workspace';
import { registerChatRoutes, registerSessionListRoutes, registerSessionRoutes } from '../collab/sessions';
import { registerRoomRoutes } from '../collab/rooms';
import { registerAutomationRoutes, registerWorkflowRoutes } from '../automation';
import type { AppContext } from './context';
import { createReadiness, registerHealthRoutes, type Readiness } from './health';

/** 前端产物目录。相对 `backend/src/bootstrap`（ts-node）与 `backend/dist/bootstrap`（编译后）同为三级。 */
const FRONTEND_DIST_DIR = path.join(__dirname, '../../../frontend/dist');

export type BuildAppOptions = {
  /** 就绪状态；不给则新建一个（永远未就绪，供 OpenAPI 生成与测试组装用）。 */
  readiness?: Readiness;
};

export function buildApp(ctx: AppContext, options: BuildAppOptions = {}) {
  const readiness = options.readiness ?? createReadiness();
  const app = express();
  const routes = new RouteRegistry(app);
  routes.markAdminGuard(ctx.auth.requireAdminAuth);
  const { configManager } = ctx;

  const bootstrapApp = routes.forModule('bootstrap');

  // Middleware
  bootstrapApp.use(cors());
  // 压缩 JSON / JS / CSS 响应。前端主包 3.4MB 未压缩直出，跨境链路上首屏要十几秒；
  // nginx 只按默认 gzip_types（text/html）压，JS 与 JSON 都漏了。在这里压一遍，
  // 不再依赖前面有没有代理、代理配没配对。SSE 流必须跳过：压缩会把事件攒在缓冲区里，
  // 前端就看不到实时推送了。
  bootstrapApp.use(compression({
    filter: (req, res) => {
      const contentType = String(res.getHeader('Content-Type') || '');
      if (contentType.includes('text/event-stream')) return false;
      if (String(req.headers.accept || '').includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  }));
  // 上限 2MB：工作流定义（最多 500 节点、每个节点可带长任务说明）一次存盘会超过默认的 100KB。
  // `/api/hooks/` 下的公开入口要按**原始字节**验 HMAC 签名，解析时顺手留一份原始请求体。
  bootstrapApp.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      if ((req as express.Request).url?.startsWith('/api/hooks/')) (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }));

  // Host checking middleware for reverse proxies
  bootstrapApp.use((req, res, next) => {
    const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '') as string;
    const hostName = reqHost.split(':')[0]; // get hostname without port

    // Allow local connections and pure IPs
    if (!hostName || hostName === 'localhost' || hostName === '127.0.0.1' || net.isIP(hostName)) {
      return next();
    }

    const config = configManager.getConfig();
    const allowedHosts = config.allowedHosts || [];

    if (!allowedHosts.includes(hostName)) {
      return res.status(403).send(`Blocked request. This host ("${hostName}") is not allowed.`);
    }

    next();
  });

  registerHealthRoutes(bootstrapApp, { readiness, connections: ctx.connections });
  registerVersionRoutes(routes.forModule('control/update'));
  registerExternalRuntimeRoutes(routes.forModule('runtime'));
  registerDiagnosticsRoutes(routes.forModule('control/diagnostics'), ctx);
  registerUpdateRoutes(routes.forModule('control/update'), ctx);
  registerSettingsRoutes(routes.forModule('control/settings'), ctx);

  registerAuthGate(routes.forModule('core/auth'), ctx);
  routes.markProtectedPrefix('/api', AUTH_PUBLIC_PATHS);
  routes.markProtectedPrefix('/openclaw');
  routes.markProtectedPrefix('/uploads');

  registerAuthRoutes(routes.forModule('core/auth'), ctx);
  registerGatewayRoutes(routes.forModule('control/gateway'), ctx);
  registerModelRoutes(routes.forModule('control/models'), ctx);
  registerCharacterRoutes(routes.forModule('control/agents'), ctx);
  registerAgentRoutes(routes.forModule('control/agents'), ctx);
  registerSessionListRoutes(routes.forModule('collab/sessions'), ctx);
  registerPackRoutes(routes.forModule('control/packs'), ctx);
  registerPresetRoutes(routes.forModule('control/presets'), ctx);
  registerSessionRoutes(routes.forModule('collab/sessions'), ctx);
  registerChatRoutes(routes.forModule('collab/sessions'), ctx);
  registerUploadRoutes(routes.forModule('workspace/uploads'), ctx);
  registerCommandRoutes(routes.forModule('control/commands'), ctx);
  registerFileRoutes(routes.forModule('workspace/files'), ctx);
  registerWorkflowRoutes(routes.forModule('automation'), ctx);
  registerAutomationRoutes(routes.forModule('automation'), ctx);

  // Serve hashed static assets with long-lived cache (JS/CSS filenames include content hash)
  bootstrapApp.use('/assets', express.static(path.join(FRONTEND_DIST_DIR, 'assets'), {
    maxAge: '1y',
    immutable: true,
  }));

  // Serve other static files (images, favicon, manifest, etc.) with short cache
  bootstrapApp.use(express.static(FRONTEND_DIST_DIR, {
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      // index.html must NEVER be cached by proxies — always revalidate
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));

  registerRoomRoutes(routes.forModule('collab/rooms'), ctx);

  // Fallback for SPA — also no-cache
  bootstrapApp.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(FRONTEND_DIST_DIR, 'index.html'));
  });

  // Error handling
  bootstrapApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Express error:', err);
    if (isStructuredRequestError(err)) {
      return res.status(err.status).json(err.payload);
    }
    res.status(500).json({ success: false, error: err.message });
  });

  return { app, routes };
}
