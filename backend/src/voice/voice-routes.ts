import type { AuthMiddleware } from '../core/auth';
import type { RouteApp } from '../core/http';
import type { VoiceService } from './voice-service';

export type VoiceRoutesDeps = {
  auth: AuthMiddleware;
  voice: VoiceService;
};

/** 语音：状态 / 合成 / 识别登录即可；服务商配置、密钥、探测只给管理员。 */
export function registerVoiceRoutes(app: RouteApp, ctx: VoiceRoutesDeps): void {
  const { voice } = ctx;
  app.get('/api/voice/status', (_req, res) => {
    res.json({ success: true, ...voice.status() });
  });
  app.get('/api/voice/settings', ctx.auth.requireAdminAuth, (_req, res) => {
    res.json({ success: true, ...voice.status() });
  });
}
