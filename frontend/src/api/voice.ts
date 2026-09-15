import { apiFetch, jsonInit } from './client';

// 语音（P6）：唯一的网络出口。只返回原始 Response；解析与错误本地化在调用方（pages/control/useControlApi.ts 的 readApi）。

const enc = encodeURIComponent;

export type VoiceKind = 'tts' | 'stt';

export type VoiceProviderOptions = {
  baseUrl?: string;
  model?: string;
  voice?: string;
  speed?: number;
  format?: string;
  language?: string;
  appId?: string;
  cluster?: string;
  resourceId?: string;
  allowPrivateNetwork?: boolean;
};

export type VoiceProviderView = {
  id: string;
  requiresKey: boolean;
  clientOnly: boolean;
  defaults: VoiceProviderOptions;
  options: VoiceProviderOptions;
  hasApiKey: boolean;
  configured: boolean;
};

export type VoiceSettingsView = {
  config: { ttsProvider: string | null; sttProvider: string | null; autoReadDefault: boolean };
  tts: VoiceProviderView[];
  stt: VoiceProviderView[];
  limits: { maxTextChars: number; maxAudioBytes: number };
  localStt: { available: boolean; reasonCode: string | null };
};

export type VoiceStatusView = {
  tts: { configured: boolean; provider: string | null };
  stt: { configured: boolean; provider: string | null; clientOnly: boolean; language: string | null };
  autoReadDefault: boolean;
  localStt: { available: boolean; reasonCode: string | null };
};

export type VoiceProbeResult = { ok: boolean; models: string[]; errorCode: string | null; detail: string | null };

export const voiceApi = {
  status: () => apiFetch('/voice/status'),
  settings: () => apiFetch('/voice/settings'),
  saveConfig: (body: Partial<VoiceSettingsView['config']>) => apiFetch('/voice/settings', jsonInit('PUT', body)),
  /** apiKey：空串或不给 = 不修改；清除走 clearKey。 */
  saveProvider: (kind: VoiceKind, provider: string, body: { options: VoiceProviderOptions; apiKey?: string }) =>
    apiFetch(`/voice/providers/${enc(kind)}/${enc(provider)}`, jsonInit('PUT', body)),
  clearKey: (kind: VoiceKind, provider: string) => apiFetch(`/voice/providers/${enc(kind)}/${enc(provider)}/key`, { method: 'DELETE' }),
  probe: (body: { kind: VoiceKind; provider: string; options?: VoiceProviderOptions; apiKey?: string }) => apiFetch('/voice/probe', jsonInit('POST', body)),
  synthesize: (text: string, signal?: AbortSignal) => apiFetch('/voice/synthesize', { ...jsonInit('POST', { text }), signal }),
  transcribe: (audio: Blob, language?: string | null, signal?: AbortSignal) => apiFetch(`/voice/transcribe${language ? `?language=${enc(language)}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': audio.type || 'audio/webm' },
    body: audio,
    signal,
  }),
};
