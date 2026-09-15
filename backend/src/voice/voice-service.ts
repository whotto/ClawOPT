/**
 * 语音（P6，spec 07 §2.15–§2.19）：TTS / STT 服务商适配层、密钥只写不读、探测过出站策略、本地离线识别按主机能力说明。
 *
 * 分工：
 * - `providers/`：请求形状 ↔ 统一结果的翻译（OpenAI 兼容、Groq、Edge（实验性）、ElevenLabs、豆包 / 火山引擎、浏览器识别）；
 * - `http.ts`：出站（`core/net` 的策略 + 钉 IP + 不跟重定向 + 上限与超时）；
 * - `voice-settings-store.ts`：选中的服务商、非密钥选项、封存的 key；
 * - 这里：输入上限、每用户限流、派发、错误统一成 `voice.*`。
 *
 * 本地离线识别（sherpa-onnx）**不随本版本提供**：模型约 200 MB、原生包 30–60 MB、加载后数百 MB 内存，
 * 与 2 GB 生产主机的定位冲突；主机能力闸门 `localStt` 永远回 `host.localSttNotIncluded`，界面说明原因与替代方案。
 */
import type { DB } from '../core/db';
import type { HostCapabilities } from '../runtime';
import { VoiceError } from './errors';
import { createVoiceHttpClient, type VoiceHttpClient } from './http';
import {
  STT_PROVIDER_IDS,
  TTS_PROVIDER_IDS,
  createVoiceAdapters,
  isProviderId,
  type ProbeResult,
  type SynthesizeResult,
  type TranscribeResult,
  type VoiceAdapters,
  type VoiceKind,
} from './providers';
import { createVoiceSettingsStore, sanitizeProviderOptions } from './voice-settings-store';

export const VOICE_MAX_TEXT_CHARS = 5000;
export const VOICE_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const VOICE_RATE_LIMIT_PER_MINUTE = 30;

export type VoiceServiceDeps = {
  db: DB;
  /** 密钥封存用的数据目录（本机密钥文件 0600 在 `<dataDir>/voice/`）。 */
  dataDir: string;
  hostCapabilities: () => Promise<HostCapabilities>;
  /** 以下只给测试注入。 */
  http?: VoiceHttpClient;
  adapters?: VoiceAdapters;
  now?: () => number;
  rateLimitPerMinute?: number;
};

export type VoiceStatus = {
  tts: { configured: boolean; provider: string | null };
  stt: { configured: boolean; provider: string | null; clientOnly: boolean; language: string | null };
  autoReadDefault: boolean;
  localStt: { available: boolean; reasonCode: string | null };
};

export function createVoiceService(deps: VoiceServiceDeps) {
  const now = deps.now ?? Date.now;
  const http = deps.http ?? createVoiceHttpClient();
  const adapters = deps.adapters ?? createVoiceAdapters();
  const store = createVoiceSettingsStore({ sql: deps.db.connection(), dataDir: deps.dataDir, now });
  const limit = deps.rateLimitPerMinute ?? VOICE_RATE_LIMIT_PER_MINUTE;
  const windows = new Map<string, number[]>();

  function checkRate(userKey: string): void {
    const cutoff = now() - 60_000;
    const hits = (windows.get(userKey) ?? []).filter((at) => at > cutoff);
    if (hits.length >= limit) throw new VoiceError('voice.rateLimited', 429);
    hits.push(now());
    windows.set(userKey, hits);
    if (windows.size > 1000) {
      for (const [key, list] of windows) if (!list.some((at) => at > cutoff)) windows.delete(key);
    }
  }

  function providerConfigured(kind: VoiceKind, provider: string | null): boolean {
    if (!provider) return false;
    const adapter = kind === 'tts' ? adapters.tts[provider] : adapters.stt[provider];
    if (!adapter) return false;
    if ((adapter as { clientOnly?: boolean }).clientOnly) return true;
    const options = { ...adapter.defaults, ...store.readOptions(kind, provider) };
    if (!options.baseUrl && provider !== 'edge') return false;
    if (provider === 'doubao' && !options.appId) return false;
    return !adapter.requiresKey || store.hasKey(kind, provider);
  }

  async function localSttGate(): Promise<{ available: boolean; reasonCode: string | null }> {
    try {
      const gate = (await deps.hostCapabilities()).gates.localStt;
      if (gate) return { available: gate.allowed, reasonCode: gate.reason };
    } catch {
      // 探测失败：按「不随包」说明，不让语音页挂掉。
    }
    return { available: false, reasonCode: 'host.localSttNotIncluded' };
  }

  async function status(): Promise<VoiceStatus> {
    const config = store.readConfig();
    return {
      tts: { configured: providerConfigured('tts', config.ttsProvider), provider: config.ttsProvider },
      stt: {
        configured: providerConfigured('stt', config.sttProvider),
        provider: config.sttProvider,
        clientOnly: config.sttProvider === 'browser',
        language: config.sttProvider ? store.readOptions('stt', config.sttProvider).language ?? null : null,
      },
      autoReadDefault: config.autoReadDefault,
      localStt: await localSttGate(),
    };
  }

  /** 管理面：全部服务商的非密钥选项 + `hasApiKey`，绝不回 key。 */
  async function settings() {
    const describe = (kind: VoiceKind, ids: readonly string[]) => ids.map((id) => {
      const adapter = kind === 'tts' ? adapters.tts[id] : adapters.stt[id];
      return {
        id,
        requiresKey: adapter.requiresKey,
        clientOnly: Boolean((adapter as { clientOnly?: boolean }).clientOnly),
        defaults: adapter.defaults,
        options: store.readOptions(kind, id),
        hasApiKey: store.hasKey(kind, id),
        configured: providerConfigured(kind, id),
      };
    });
    return {
      config: store.readConfig(),
      tts: describe('tts', TTS_PROVIDER_IDS),
      stt: describe('stt', STT_PROVIDER_IDS),
      limits: { maxTextChars: VOICE_MAX_TEXT_CHARS, maxAudioBytes: VOICE_MAX_AUDIO_BYTES },
      localStt: await localSttGate(),
    };
  }

  function requireKind(kind: unknown): VoiceKind {
    if (kind !== 'tts' && kind !== 'stt') throw new VoiceError('voice.invalidKind', 400);
    return kind;
  }

  function requireProvider(kind: VoiceKind, provider: unknown): string {
    if (!isProviderId(kind, provider)) throw new VoiceError('voice.providerUnknown', 400);
    return provider;
  }

  function saveConfig(body: unknown): void {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const patch: { ttsProvider?: string | null; sttProvider?: string | null; autoReadDefault?: boolean } = {};
    if (input.ttsProvider !== undefined) patch.ttsProvider = input.ttsProvider === null || input.ttsProvider === '' ? null : requireProvider('tts', input.ttsProvider);
    if (input.sttProvider !== undefined) patch.sttProvider = input.sttProvider === null || input.sttProvider === '' ? null : requireProvider('stt', input.sttProvider);
    if (input.autoReadDefault !== undefined) {
      if (typeof input.autoReadDefault !== 'boolean') throw new VoiceError('voice.invalidInput', 400);
      patch.autoReadDefault = input.autoReadDefault;
    }
    store.writeConfig(patch);
  }

  function saveProvider(kindRaw: unknown, providerRaw: unknown, body: unknown): void {
    const kind = requireKind(kindRaw);
    const provider = requireProvider(kind, providerRaw);
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new VoiceError('voice.invalidInput', 400);
    store.saveProvider(kind, provider, { options: input.options, apiKey: input.apiKey });
  }

  function clearKey(kindRaw: unknown, providerRaw: unknown): void {
    const kind = requireKind(kindRaw);
    store.clearKey(kind, requireProvider(kind, providerRaw));
  }

  /**
   * 探测：可以带着表单里还没保存的选项与 key 试，也可以用已存的（key 为空串 = 用已存的）。
   * 走同一条出站策略；结果里只有模型候选与脱敏过的错误。
   */
  async function probe(body: unknown): Promise<ProbeResult> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const kind = requireKind(input.kind);
    const provider = requireProvider(kind, input.provider);
    const adapter = kind === 'tts' ? adapters.tts[provider] : adapters.stt[provider];
    const options = { ...adapter.defaults, ...store.readOptions(kind, provider), ...(input.options !== undefined ? sanitizeProviderOptions(input.options) : {}) };
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : store.readKey(kind, provider);
    return adapter.probe({ options, apiKey, http });
  }

  async function synthesize(userKey: string, body: unknown, signal?: AbortSignal): Promise<SynthesizeResult> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) throw new VoiceError('voice.textRequired', 400);
    if (text.length > VOICE_MAX_TEXT_CHARS) throw new VoiceError('voice.textTooLong', 413, null, { max: VOICE_MAX_TEXT_CHARS });
    const provider = store.readConfig().ttsProvider;
    if (!provider || !providerConfigured('tts', provider)) throw new VoiceError('voice.notConfigured', 409, null, { kind: 'tts' });
    checkRate(userKey);
    const adapter = adapters.tts[provider];
    return adapter.synthesize(
      { options: { ...adapter.defaults, ...store.readOptions('tts', provider) }, apiKey: store.readKey('tts', provider), http, signal },
      { text },
    );
  }

  async function transcribe(userKey: string, input: { audio: unknown; mimeType: unknown; language?: unknown }, signal?: AbortSignal): Promise<TranscribeResult> {
    if (!Buffer.isBuffer(input.audio) || input.audio.length === 0) throw new VoiceError('voice.audioEmpty', 400);
    if (input.audio.length > VOICE_MAX_AUDIO_BYTES) throw new VoiceError('voice.audioTooLarge', 413, null, { maxMb: VOICE_MAX_AUDIO_BYTES / 1024 / 1024 });
    const mimeType = typeof input.mimeType === 'string' && /^(audio|video)\/[\w.+-]+/.test(input.mimeType) ? input.mimeType.split(';')[0].trim() : '';
    if (!mimeType) throw new VoiceError('voice.audioTypeUnsupported', 415);
    const provider = store.readConfig().sttProvider;
    if (!provider || !providerConfigured('stt', provider)) throw new VoiceError('voice.notConfigured', 409, null, { kind: 'stt' });
    if (provider === 'browser') throw new VoiceError('voice.clientOnlyProvider', 409);
    checkRate(userKey);
    const adapter = adapters.stt[provider];
    const language = typeof input.language === 'string' && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(input.language) ? input.language : undefined;
    const result = await adapter.transcribe(
      { options: { ...adapter.defaults, ...store.readOptions('stt', provider) }, apiKey: store.readKey('stt', provider), http, signal },
      { audio: input.audio, mimeType, language },
    );
    if (!result.text) throw new VoiceError('voice.noSpeech', 400);
    return result;
  }

  return { status, settings, saveConfig, saveProvider, clearKey, probe, synthesize, transcribe };
}

export type VoiceService = ReturnType<typeof createVoiceService>;
