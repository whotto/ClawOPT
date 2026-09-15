import express from 'express';

import { getRequestIdentity, type AuthMiddleware } from '../../core/auth';
import type { RouteApp } from '../../core/http';
import { controlHandler } from '../shared/control-http';
import { THEME_BACKGROUND_MAX_BYTES, themeUserKey, type ThemeService } from './theme-service';

export type ThemeRoutesDeps = {
  auth: AuthMiddleware;
  theme: ThemeService;
};

/**
 * 主题按用户存，改的只是自己的：登录即可（不在控制面管理员闸门的清单里）。
 * 背景图上传用原始请求体（只在这一条路由上解析，上限比魔数判定的上限多 1 字节，超限回 413 而不是解析器的 500）。
 */
export function registerThemeRoutes(app: RouteApp, ctx: ThemeRoutesDeps): void {
  const { theme } = ctx;
  const userKey = (req: express.Request) => themeUserKey(getRequestIdentity(req));
  const rawBackground = express.raw({ type: () => true, limit: THEME_BACKGROUND_MAX_BYTES + 1 });

  app.get('/api/theme', controlHandler(async (req, res) => {
    res.json({ success: true, theme: theme.get(userKey(req)) });
  }));

  app.put('/api/theme', controlHandler(async (req, res) => {
    res.json({ success: true, theme: theme.save(userKey(req), req.body) });
  }));

  app.delete('/api/theme', controlHandler(async (req, res) => {
    res.json({ success: true, theme: theme.reset(userKey(req)) });
  }));

  app.put('/api/theme/background', (req, res, next) => {
    rawBackground(req, res, (error?: unknown) => {
      if (error) {
        const tooLarge = (error as { type?: string }).type === 'entity.too.large';
        res.status(tooLarge ? 413 : 400).json({ success: false, errorCode: tooLarge ? 'theme.backgroundTooLarge' : 'theme.backgroundInvalid' });
        return;
      }
      next();
    });
  }, controlHandler(async (req, res) => {
    res.json({ success: true, theme: theme.setBackground(userKey(req), req.body) });
  }));

  app.get('/api/theme/background', controlHandler(async (req, res) => {
    const background = theme.readBackground(userKey(req));
    if (!background) {
      res.status(404).json({ success: false, errorCode: 'theme.backgroundNotFound' });
      return;
    }
    // 类型来自上传时的魔数判定；nosniff 让浏览器不再自己猜。私有、按版本号缓存。
    res.setHeader('Content-Type', background.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('ETag', `"${background.revision}"`);
    res.end(background.data);
  }));

  app.delete('/api/theme/background', controlHandler(async (req, res) => {
    res.json({ success: true, theme: theme.removeBackground(userKey(req)) });
  }));
}
