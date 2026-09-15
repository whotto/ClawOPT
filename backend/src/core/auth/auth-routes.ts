import type { ConfigManager } from '../config';
import type { RouteApp } from '../http';
import {
  isAuthPublicPath,
  type AuthMiddleware,
  clearAuthCookie,
  issueAuthCookie,
  readRequestAuthToken,
} from './auth-middleware';
import { type AuthStore, verifyPassword } from './auth-store';

export type AuthGateDeps = {
  auth: AuthMiddleware;
};

export function registerAuthGate(app: RouteApp, ctx: AuthGateDeps): void {
  const { requireSessionAuth } = ctx.auth;

  app.use('/api', (req, res, next) => {
    const routePath = req.path.startsWith('/') ? `/api${req.path}` : `/api/${req.path}`;
    if (isAuthPublicPath(routePath)) return next();
    return requireSessionAuth(req, res, next);
  });

  // /openclaw 与 /uploads 不在 /api 前缀下，得单独挂——它们出的是工作区文件与
  // 用户上传，正是开了登录之后最不该匿名可取的东西。浏览器加载 <img src="/uploads/...">
  // 是同源请求，cookie 会自动带上，所以加了鉴权也不会打断图片显示。
  app.use('/openclaw', requireSessionAuth);
  app.use('/uploads', requireSessionAuth);
}

export type AuthRoutesDeps = {
  authStore: AuthStore;
  configManager: ConfigManager;
};

export function registerAuthRoutes(app: RouteApp, ctx: AuthRoutesDeps): void {
  const { authStore, configManager } = ctx;

  // Auth endpoints
  app.get('/api/auth/check', (req, res) => {
    const config = configManager.getConfig();
    if (!config.loginEnabled) {
      return res.json({ loginRequired: false });
    }
    // 令牌从 cookie / 头里读，不再走 query——查询串会进访问日志、代理日志和浏览器历史。
    res.json({ loginRequired: !authStore.verify(readRequestAuthToken(req)) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readRequestAuthToken(req);
    if (token) authStore.revoke(token);
    clearAuthCookie(res);
    res.json({ success: true });
  });

  app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;
    const config = configManager.getConfig();

    if (!config.loginEnabled) {
      return res.json({ success: true, token: 'disabled' });
    }

    const stored = config.loginPassword || '123456';
    if (typeof password === 'string' && verifyPassword(password, stored)) {
      // 令牌是随机数、服务端存储、30 天过期、可吊销——不再是口令的哈希。
      const session = authStore.issue('web');
      issueAuthCookie(res, session.token, session.expiresAt - Date.now());
      return res.json({ success: true, token: session.token });
    }

    res.status(401).json({
      success: false,
      errorCode: 'auth.invalidPassword',
      errorParams: null,
      errorDetail: null,
    });
  });
}
