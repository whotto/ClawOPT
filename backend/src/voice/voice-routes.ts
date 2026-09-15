import express from 'express';

import { getRequestIdentity, type AuthMiddleware } from '../core/auth';
import { buildStructuredApiError, type RouteApp } from '../core/http';
import { VoiceError, sanitizeVoiceDetail } from './errors';
import { VOICE_MAX_AUDIO_BYTES, type VoiceService } from './voice-service';

export type VoiceRoutesDeps = {
  auth: AuthMiddleware;
  voice: VoiceService;
};

function sendVoiceError(res: express.Response, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof VoiceError) {
    res.status(error.status).json(buildStructuredApiError(error.errorCode, error.detail, error.params));
    return;
  }
  console.error(`[Voice] request failed: ${(error as Error)?.name ?? 'Error'}`);
  res.status(500).json(buildStructuredApiError('voice.internalError', sanitizeVoiceDetail((error as Error)?.name)));
}

const handle = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown): express.RequestHandler => (req, res) => {
  Promise.resolve().then(() => fn(req, res)).catch((error) => sendVoiceError(res, error));
};

/** 客户端断开就中止上游请求（合成 / 识别都可能要几秒）。 */
function abortOnClose(req: express.Request, res: express.Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

const userKeyOf = (req: express.Request) => {
  const identity = getRequestIdentity(req);
  return identity.userId === null ? 'implicit' : `user:${identity.userId}`;
};

/**
 * 语音：
 * - 状态 / 合成 / 识别：登录即可（member 在输入区用），带输入上限与每用户限流；
 * - 服务商配置、密钥、探测：管理员（`requireAdminAuth`）。key 只写不读，GET 只报 `hasApiKey`。
 */
export function registerVoiceRoutes(app: RouteApp, ctx: VoiceRoutesDeps): void {
  const { voice } = ctx;
  const admin = ctx.auth.requireAdminAuth;
  // 识别的音频是原始请求体（Content-Type 就是音频类型），只在这一条路由上解析；超限回 413 结构化错误。
  const rawAudio = express.raw({ type: () => true, limit: VOICE_MAX_AUDIO_BYTES });

  app.get('/api/voice/status', handle(async (_req, res) => {
    res.json({ success: true, ...(await voice.status()) });
  }));

  app.get('/api/voice/settings', admin, handle(async (_req, res) => {
    res.json({ success: true, ...(await voice.settings()) });
  }));

  app.put('/api/voice/settings', admin, handle(async (req, res) => {
    voice.saveConfig(req.body);
    res.json({ success: true, ...(await voice.settings()) });
  }));

  app.put('/api/voice/providers/:kind/:provider', admin, handle(async (req, res) => {
    voice.saveProvider(req.params.kind, req.params.provider, req.body);
    res.json({ success: true, ...(await voice.settings()) });
  }));

  app.delete('/api/voice/providers/:kind/:provider/key', admin, handle(async (req, res) => {
    voice.clearKey(req.params.kind, req.params.provider);
    res.json({ success: true, ...(await voice.settings()) });
  }));

  app.post('/api/voice/probe', admin, handle(async (req, res) => {
    res.json({ success: true, result: await voice.probe(req.body) });
  }));

  app.post('/api/voice/synthesize', handle(async (req, res) => {
    const result = await voice.synthesize(userKeyOf(req), req.body, abortOnClose(req, res));
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(result.audio);
  }));

  app.post('/api/voice/transcribe', (req, res, next) => {
    rawAudio(req, res, (error?: unknown) => {
      if (!error) return next();
      const tooLarge = (error as { type?: string }).type === 'entity.too.large';
      sendVoiceError(res, new VoiceError(tooLarge ? 'voice.audioTooLarge' : 'voice.audioEmpty', tooLarge ? 413 : 400, null, tooLarge ? { maxMb: VOICE_MAX_AUDIO_BYTES / 1024 / 1024 } : null));
    });
  }, handle(async (req, res) => {
    const result = await voice.transcribe(userKeyOf(req), {
      audio: req.body,
      mimeType: req.headers['content-type'],
      language: req.query.language,
    }, abortOnClose(req, res));
    res.json({ success: true, ...result });
  }));
}
