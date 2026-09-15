import {
  type AuthMiddleware,
  type AuthStore,
  getRequestIdentity,
  MIGRATED_SUPER_ADMIN_USERNAME,
  sendUserStoreError,
  type UserStore,
  validateNewPassword,
} from '../../core/auth';
import type { ConfigManager } from '../../core/config';
import { buildStructuredApiError, type RouteApp } from '../../core/http';

export type SettingsRoutesDeps = {
  authStore: AuthStore;
  configManager: ConfigManager;
  userStore: UserStore;
  auth: AuthMiddleware;
};

export function registerSettingsRoutes(app: RouteApp, ctx: SettingsRoutesDeps): void {
  const { authStore, configManager, userStore } = ctx;
  const { requireAdminAuth } = ctx.auth;

  app.get('/api/config', (_req, res) => {
    const config = configManager.getConfig();
    res.json({
      gatewayUrl: config.gatewayUrl,
      defaultAgent: config.defaultAgent,
      language: config.language || 'zh-CN',
      // 凭据只报「配没配」，不报值。这个路由无需登录即可访问——一个未鉴权的接口
      // 把登录密码明文吐出来，等于登录页形同虚设。要改凭据走 POST，不需要先读回来。
      hasToken: !!config.token,
      hasPassword: !!config.password,
      // 多用户之后，「设过登录口令」= 至少有一个用户。
      hasLoginPassword: userStore.count() > 0,
      aiName: config.aiName || 'OpenClaw',
      loginEnabled: config.loginEnabled || false,
      allowedHosts: config.allowedHosts || [],
      historyPageRounds: config.historyPageRounds || 30,
      previewConversionTimeoutSeconds: config.previewConversionTimeoutSeconds || 60,
    });
  });

  app.post('/api/config', requireAdminAuth, (req, res) => {
    // 写配置必须鉴权：这个路由能改登录密码、能把 loginEnabled 关掉、能改网关指向。
    // 未开启登录时 requireAdminAuth 直接放行，所以默认部署的行为不变。
    //
    // 凭据字段留空视为「不修改」而不是「清空」。GET 不再回读密钥值，前端表单起手就是
    // 空的；若把空串当清空，用户改个 AI 名字就会顺手把网关口令抹掉。
    const incoming = { ...req.body } as Record<string, unknown>;
    for (const field of ['token', 'password', 'loginPassword']) {
      if (typeof incoming[field] === 'string' && incoming[field] === '') delete incoming[field];
    }

    // 登录口令不再存进配置：没有用户时建出 super_admin `admin`，有用户时改当前用户（登录未开启时改第一个 super_admin）。
    // 改口令即作废该用户的既有会话——否则「改了密码」挡不住已经拿到令牌的人。
    const nextPassword = typeof incoming.loginPassword === 'string' ? incoming.loginPassword : '';
    delete incoming.loginPassword;
    try {
      if (nextPassword) validateNewPassword(nextPassword);
    } catch (error) {
      if (sendUserStoreError(res, error)) return;
      throw error;
    }
    if (incoming.loginEnabled === true && !nextPassword && userStore.count() === 0) {
      return res.status(400).json(buildStructuredApiError('auth.passwordRequiredToEnableLogin'));
    }

    configManager.setConfig(incoming);
    if (nextPassword) {
      if (userStore.count() === 0) {
        userStore.create({ username: MIGRATED_SUPER_ADMIN_USERNAME, password: nextPassword, role: 'super_admin' });
      } else {
        const identity = getRequestIdentity(req);
        const targetId = identity.userId ?? userStore.firstActiveSuperAdmin()?.id ?? null;
        if (targetId !== null) {
          userStore.setPassword(targetId, nextPassword);
          authStore.revokeForUser(targetId);
        }
      }
    }
    if (incoming.loginEnabled === false) {
      authStore.revokeAll();
    }
    res.json({ success: true });
  });

  app.get('/api/sidebar/favorites', (_req, res) => {
    const config = configManager.getConfig();
    res.json({
      success: true,
      favorites: config.sidebarFavorites || {
        agents: [],
        groups: [],
        order: [],
      },
    });
  });

  app.post('/api/sidebar/favorites', (req, res) => {
    configManager.setConfig({
      sidebarFavorites: req.body?.favorites ?? req.body,
    });
    const config = configManager.getConfig();
    res.json({
      success: true,
      favorites: config.sidebarFavorites || {
        agents: [],
        groups: [],
        order: [],
      },
    });
  });
}
