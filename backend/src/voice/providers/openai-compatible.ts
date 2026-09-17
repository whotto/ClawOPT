/**
 * OpenAI 兼容：TTS `POST {base}/audio/speech`（JSON），STT `POST {base}/audio/transcriptions`（multipart）。
 * 同一份实现覆盖 OpenAI、自建兼容端点与 Groq（Whisper 兼容，只换默认地址与模型）。
 * 认证头 `Authorization: Bearer <key>`；本地端点可以不带 key。
 */
import { VoiceError } from '../errors';
import { encodeMultipart } from '../http';
import { assertOk, clampSpeed, contentTypeForFormat, fileExtensionForMime, joinUrl, probeModelsEndpoint, requireBaseUrl } from './common';
import type { AdapterCall, SttAdapter, TtsAdapter } from './types';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

function authHeaders(call: AdapterCall): Record<string, string> {
  return call.apiKey ? { authorization: `Bearer ${call.apiKey}` } : {};
}

export function createOpenAiCompatibleTts(id: 'openai' | 'custom'): TtsAdapter {
  const defaults = id === 'openai'
    ? { baseUrl: OPENAI_BASE_URL, model: 'gpt-4o-mini-tts', voice: 'alloy', speed: 1, format: 'mp3' }
    : { baseUrl: '', model: 'tts-1', voice: 'alloy', speed: 1, format: 'mp3' };
  return {
    id,
    // 自建兼容端点（本地 TTS 服务）常常不要 key；OpenAI 官方必须要。
    requiresKey: id === 'openai',
    defaults,
    async synthesize(call, input) {
      const base = requireBaseUrl(call, defaults.baseUrl);
      if (id === 'openai' && !call.apiKey) throw new VoiceError('voice.keyMissing', 400);
      const format = input.format || call.options.format || 'mp3';
      const response = await call.http({
        url: joinUrl(base, 'audio/speech'),
        method: 'POST',
        headers: { ...authHeaders(call), 'content-type': 'application/json', accept: 'audio/*' },
        body: JSON.stringify({
          model: call.options.model || defaults.model,
          input: input.text,
          voice: input.voice || call.options.voice || defaults.voice,
          speed: clampSpeed(input.speed ?? call.options.speed),
          response_format: format,
        }),
        allowPrivateNetwork: call.options.allowPrivateNetwork,
        signal: call.signal,
      });
      assertOk(response, call);
      if (!response.body.length) throw new VoiceError('voice.upstreamEmptyAudio', 502);
      const upstreamType = response.headers['content-type'] ?? '';
      return { audio: response.body, contentType: upstreamType.startsWith('audio/') ? upstreamType.split(';')[0] : contentTypeForFormat(format) };
    },
    probe(call) {
      return probeModelsEndpoint(call, joinUrl(requireBaseUrl(call, defaults.baseUrl), 'models'), authHeaders(call), 'tts');
    },
  };
}

export function createOpenAiCompatibleStt(id: 'openai' | 'custom' | 'groq'): SttAdapter {
  const defaults = id === 'openai'
    ? { baseUrl: OPENAI_BASE_URL, model: 'gpt-4o-mini-transcribe' }
    : id === 'groq'
      ? { baseUrl: GROQ_BASE_URL, model: 'whisper-large-v3-turbo' }
      : { baseUrl: '', model: 'whisper-1' };
  return {
    id,
    requiresKey: id !== 'custom',
    defaults,
    async transcribe(call, input) {
      const base = requireBaseUrl(call, defaults.baseUrl);
      if (id !== 'custom' && !call.apiKey) throw new VoiceError('voice.keyMissing', 400);
      const started = Date.now();
      const form = encodeMultipart(
        {
          model: call.options.model || defaults.model,
          language: input.language || call.options.language || undefined,
          response_format: 'json',
        },
        { field: 'file', filename: `speech.${fileExtensionForMime(input.mimeType)}`, contentType: input.mimeType || 'application/octet-stream', data: input.audio },
      );
      const response = await call.http({
        url: joinUrl(base, 'audio/transcriptions'),
        method: 'POST',
        headers: { ...authHeaders(call), 'content-type': form.contentType, accept: 'application/json' },
        body: form.body,
        allowPrivateNetwork: call.options.allowPrivateNetwork,
        signal: call.signal,
      });
      assertOk(response, call);
      const body = response.json();
      if (!body || typeof body.text !== 'string') throw new VoiceError('voice.upstreamBadResponse', 502, 'missing text');
      const durationSeconds = Number(body.duration);
      return { text: body.text.trim(), durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : Date.now() - started };
    },
    probe(call) {
      return probeModelsEndpoint(call, joinUrl(requireBaseUrl(call, defaults.baseUrl), 'models'), authHeaders(call), 'stt');
    },
  };
}
