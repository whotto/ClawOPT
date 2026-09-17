/**
 * 豆包 / 火山引擎语音（openspeech）：
 * - TTS（HTTP 非流式）`POST {base}/api/v1/tts`，认证头 `Authorization: Bearer;<access token>`（分号是协议原样），
 *   请求体 `{app:{appid, token, cluster}, user:{uid}, audio:{voice_type, encoding, speed_ratio}, request:{reqid, text, text_type, operation:'query'}}`，
 *   成功 `code === 3000`，`data` 是 base64 音频；
 * - STT（大模型录音文件极速版）`POST {base}/api/v3/auc/bigmodel/recognize/flash`，头 `X-Api-App-Key` / `X-Api-Access-Key` /
 *   `X-Api-Resource-Id` / `X-Api-Request-Id` / `X-Api-Sequence: -1`，请求体 `{user:{uid}, audio:{data: base64}, request:{model_name:'bigmodel'}}`，
 *   响应头 `X-Api-Status-Code: 20000000` 为成功，`result.text` 是文本、`audio_info.duration` 毫秒。
 * 访问令牌是密钥；appid / cluster / 资源 id 不是。没有 /models：探测用一次极短的合成（TTS）或只校验必填项（STT）。
 */
import { randomUUID } from 'crypto';

import { VoiceError, sanitizeVoiceDetail } from '../errors';
import { assertOk, clampSpeed, contentTypeForFormat, joinUrl, probeFailure, requireBaseUrl, requireKey } from './common';
import type { AdapterCall, SttAdapter, TtsAdapter } from './types';

export const DOUBAO_BASE_URL = 'https://openspeech.bytedance.com';

function requireAppId(call: AdapterCall): string {
  const appId = (call.options.appId || '').trim();
  if (!appId) throw new VoiceError('voice.appIdRequired', 400);
  return appId;
}

export function createDoubaoTts(): TtsAdapter {
  const defaults = { baseUrl: DOUBAO_BASE_URL, voice: 'zh_female_wanwanxiaohe_moon_bigtts', cluster: 'volcano_tts', speed: 1, format: 'mp3' };
  const synthesize: TtsAdapter['synthesize'] = async (call, input) => {
    const token = requireKey(call);
    const appId = requireAppId(call);
    const format = input.format || call.options.format || 'mp3';
    const response = await call.http({
      url: joinUrl(requireBaseUrl(call, defaults.baseUrl), 'api/v1/tts'),
      method: 'POST',
      headers: { authorization: `Bearer;${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        app: { appid: appId, token: 'access_token', cluster: call.options.cluster || defaults.cluster },
        user: { uid: 'clawopt' },
        audio: { voice_type: input.voice || call.options.voice || defaults.voice, encoding: format, speed_ratio: clampSpeed(input.speed ?? call.options.speed) },
        request: { reqid: randomUUID(), text: input.text, text_type: 'plain', operation: 'query' },
      }),
      allowPrivateNetwork: call.options.allowPrivateNetwork,
      signal: call.signal,
    });
    assertOk(response, call);
    const body = response.json();
    if (!body || body.code !== 3000 || typeof body.data !== 'string') {
      const detail = sanitizeVoiceDetail(`code ${body?.code ?? '?'}: ${body?.message ?? response.text()}`, [call.apiKey]);
      throw new VoiceError(body?.code === 3001 || body?.code === 3003 ? 'voice.upstreamAuthFailed' : 'voice.upstreamFailed', 502, detail);
    }
    const audio = Buffer.from(body.data, 'base64');
    if (!audio.length) throw new VoiceError('voice.upstreamEmptyAudio', 502);
    return { audio, contentType: contentTypeForFormat(format) };
  };
  return {
    id: 'doubao',
    requiresKey: true,
    defaults,
    synthesize,
    async probe(call) {
      try {
        await synthesize(call, { text: 'ok' });
        return { ok: true, models: [], errorCode: null, detail: null };
      } catch (error) {
        return probeFailure(error);
      }
    },
  };
}

export function createDoubaoStt(): SttAdapter {
  const defaults = { baseUrl: DOUBAO_BASE_URL, resourceId: 'volc.bigasr.auc_turbo' };
  return {
    id: 'doubao',
    requiresKey: true,
    defaults,
    async transcribe(call, input) {
      const token = requireKey(call);
      const appId = requireAppId(call);
      const requestId = randomUUID();
      const response = await call.http({
        url: joinUrl(requireBaseUrl(call, defaults.baseUrl), 'api/v3/auc/bigmodel/recognize/flash'),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-app-key': appId,
          'x-api-access-key': token,
          'x-api-resource-id': call.options.resourceId || defaults.resourceId,
          'x-api-request-id': requestId,
          'x-api-sequence': '-1',
        },
        body: JSON.stringify({ user: { uid: 'clawopt' }, audio: { data: input.audio.toString('base64') }, request: { model_name: 'bigmodel' } }),
        allowPrivateNetwork: call.options.allowPrivateNetwork,
        signal: call.signal,
      });
      assertOk(response, call);
      const status = response.headers['x-api-status-code'];
      const body = response.json();
      if (status && status !== '20000000') {
        const detail = sanitizeVoiceDetail(`status ${status}: ${response.headers['x-api-message'] ?? ''}`, [call.apiKey]);
        // 20000003 = 静音 / 没有有效语音。
        if (status === '20000003') throw new VoiceError('voice.noSpeech', 400, detail);
        throw new VoiceError(status.startsWith('4501') ? 'voice.upstreamAuthFailed' : 'voice.upstreamFailed', 502, detail);
      }
      const text = body?.result?.text;
      if (typeof text !== 'string') throw new VoiceError('voice.upstreamBadResponse', 502, 'missing result.text');
      const duration = Number(body?.audio_info?.duration);
      return { text: text.trim(), durationMs: Number.isFinite(duration) ? duration : null };
    },
    async probe(call) {
      try {
        requireKey(call);
        requireAppId(call);
        requireBaseUrl(call, defaults.baseUrl);
        return { ok: true, models: [], errorCode: null, detail: null };
      } catch (error) {
        return probeFailure(error);
      }
    },
  };
}
