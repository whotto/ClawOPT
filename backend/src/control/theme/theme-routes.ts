import { getRequestIdentity, type AuthMiddleware } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import { controlHandler } from '../shared/control-http';
import type { ThemeService } from './theme-service';

export type ThemeRoutesDeps = {
  auth: AuthMiddleware;
  theme: ThemeService;
};

/** 主题按用户存：改的是自己，登录即可。 */
export function registerThemeRoutes(app: RouteApp, ctx: ThemeRoutesDeps): void {
  const { theme } = ctx;
  app.get('/api/theme', controlHandler(async (req, res) => {
    res.json({ success: true, theme: theme.get(String(getRequestIdentity(req).userId ?? 'implicit')) });
  }));
}
