/**
 * ElevenLabs：认证头 `xi-api-key`。
 * - TTS `POST {base}/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`，JSON `{text, model_id, voice_settings:{speed}}`；
 * - STT `POST {base}/v1/speech-to-text`，multipart `model_id` + `file`，回 `{text, language_code}`；
 * - 探测 `GET {base}/v1/models`。
 */
import { VoiceError } from '../errors';
import { encodeMultipart } from '../http';
import { assertOk, clampSpeed, fileExtensionForMime, joinUrl, probeModelsEndpoint, requireBaseUrl, requireKey } from './common';
import type { SttAdapter, TtsAdapter } from './types';

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

export function createElevenLabsTts(): TtsAdapter {
  const defaults = { baseUrl: ELEVENLABS_BASE_URL, model: 'eleven_multilingual_v2', voice: '21m00Tcm4TlvDq8ikWAM', speed: 1, format: 'mp3' };
  return {
    id: 'elevenlabs',
    requiresKey: true,
    defaults,
    async synthesize(call, input) {
      const key = requireKey(call);
      const voice = input.voice || call.options.voice || defaults.voice;
      const url = `${joinUrl(requireBaseUrl(call, defaults.baseUrl), `v1/text-to-speech/${encodeURIComponent(voice)}`)}?output_format=mp3_44100_128`;
      const response = await call.http({
        url,
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: input.text,
          model_id: call.options.model || defaults.model,
          voice_settings: { speed: clampSpeed(input.speed ?? call.options.speed, 1) },
        }),
        allowPrivateNetwork: call.options.allowPrivateNetwork,
        signal: call.signal,
      });
      assertOk(response, call);
      if (!response.body.length) throw new VoiceError('voice.upstreamEmptyAudio', 502);
      return { audio: response.body, contentType: 'audio/mpeg' };
    },
    probe(call) {
      return probeModelsEndpoint(call, joinUrl(requireBaseUrl(call, defaults.baseUrl), 'v1/models'), call.apiKey ? { 'xi-api-key': call.apiKey } : {}, 'tts');
    },
  };
}

export function createElevenLabsStt(): SttAdapter {
  const defaults = { baseUrl: ELEVENLABS_BASE_URL, model: 'scribe_v1' };
  return {
    id: 'elevenlabs',
    requiresKey: true,
    defaults,
    async transcribe(call, input) {
      const key = requireKey(call);
      const started = Date.now();
      const form = encodeMultipart(
        { model_id: call.options.model || defaults.model, language_code: input.language || call.options.language || undefined },
        { field: 'file', filename: `speech.${fileExtensionForMime(input.mimeType)}`, contentType: input.mimeType || 'application/octet-stream', data: input.audio },
      );
      const response = await call.http({
        url: joinUrl(requireBaseUrl(call, defaults.baseUrl), 'v1/speech-to-text'),
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': form.contentType, accept: 'application/json' },
        body: form.body,
        allowPrivateNetwork: call.options.allowPrivateNetwork,
        signal: call.signal,
      });
      assertOk(response, call);
      const body = response.json();
      if (!body || typeof body.text !== 'string') throw new VoiceError('voice.upstreamBadResponse', 502, 'missing text');
      return { text: body.text.trim(), durationMs: Date.now() - started };
    },
    probe(call) {
      return probeModelsEndpoint(call, joinUrl(requireBaseUrl(call, defaults.baseUrl), 'v1/models'), call.apiKey ? { 'xi-api-key': call.apiKey } : {}, 'stt');
    },
  };
}
