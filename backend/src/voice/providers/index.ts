/**
 * 服务商清单：唯一一份。设置页的下拉、服务端的校验、合成与识别的派发都从这里取。
 */
import { createDoubaoStt, createDoubaoTts } from './doubao';
import { createEdgeTts, type EdgeTtsOptions } from './edge';
import { createElevenLabsStt, createElevenLabsTts } from './elevenlabs';
import { createOpenAiCompatibleStt, createOpenAiCompatibleTts } from './openai-compatible';
import type { SttAdapter, TranscribeInput, TranscribeResult, TtsAdapter, VoiceKind } from './types';

export const TTS_PROVIDER_IDS = ['openai', 'custom', 'edge', 'elevenlabs', 'doubao'] as const;
export const STT_PROVIDER_IDS = ['openai', 'custom', 'groq', 'elevenlabs', 'doubao', 'browser'] as const;

export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];
export type SttProviderId = (typeof STT_PROVIDER_IDS)[number];

/** 浏览器识别：音频不上服务端，界面用 Web Speech API；服务端只记录「选了它」。 */
function createBrowserStt(): SttAdapter {
  return {
    id: 'browser',
    requiresKey: false,
    clientOnly: true,
    defaults: {},
    transcribe(): Promise<TranscribeResult> {
      return Promise.reject(Object.assign(new Error('browser STT runs in the client'), { clientOnly: true }));
    },
    async probe() {
      return { ok: true, models: [], errorCode: null, detail: null };
    },
  };
}

export type VoiceAdapters = { tts: Record<string, TtsAdapter>; stt: Record<string, SttAdapter> };

export function createVoiceAdapters(options: { edge?: EdgeTtsOptions } = {}): VoiceAdapters {
  return {
    tts: {
      openai: createOpenAiCompatibleTts('openai'),
      custom: createOpenAiCompatibleTts('custom'),
      edge: createEdgeTts(options.edge),
      elevenlabs: createElevenLabsTts(),
      doubao: createDoubaoTts(),
    },
    stt: {
      openai: createOpenAiCompatibleStt('openai'),
      custom: createOpenAiCompatibleStt('custom'),
      groq: createOpenAiCompatibleStt('groq'),
      elevenlabs: createElevenLabsStt(),
      doubao: createDoubaoStt(),
      browser: createBrowserStt(),
    },
  };
}

export function isProviderId(kind: VoiceKind, provider: unknown): provider is string {
  const ids: readonly string[] = kind === 'tts' ? TTS_PROVIDER_IDS : STT_PROVIDER_IDS;
  return typeof provider === 'string' && ids.includes(provider);
}

export type { TranscribeInput };
export type { AdapterCall, ProbeResult, SttAdapter, SynthesizeInput, SynthesizeResult, TranscribeResult, TtsAdapter, VoiceKind, VoiceProviderOptions } from './types';
