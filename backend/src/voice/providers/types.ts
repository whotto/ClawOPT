/**
 * TTS / STT 服务商适配器的统一契约。适配器只做「请求形状 ↔ 统一结果」的翻译，
 * 出站策略在 `http.ts`，密钥在设置存储里解封后按调用传入，适配器不持有、不记日志。
 */
import type { VoiceHttpClient } from '../http';

export type VoiceKind = 'tts' | 'stt';

/** 服务商的非密钥配置（界面可见、可回显）。 */
export type VoiceProviderOptions = {
  baseUrl?: string;
  model?: string;
  voice?: string;
  /** 0.5–2.0。 */
  speed?: number;
  /** TTS 输出格式（mp3 / wav / opus…），缺省 mp3。 */
  format?: string;
  language?: string;
  /** 豆包 / 火山引擎：应用 id（不是密钥）。 */
  appId?: string;
  /** 豆包 TTS：集群（volcano_tts 等）。 */
  cluster?: string;
  /** 豆包 STT：资源 id。 */
  resourceId?: string;
  /** 显式标成本地 / 受信任局域网端点：唯一放行内网地址的口子。 */
  allowPrivateNetwork?: boolean;
};

export type AdapterCall = {
  options: VoiceProviderOptions;
  apiKey: string | null;
  http: VoiceHttpClient;
  signal?: AbortSignal;
};

export type SynthesizeInput = { text: string; voice?: string; speed?: number; format?: string };
export type SynthesizeResult = { audio: Buffer; contentType: string };

export type TranscribeInput = { audio: Buffer; mimeType: string; language?: string };
export type TranscribeResult = { text: string; durationMs: number | null };

export type ProbeResult = { ok: boolean; models: string[]; errorCode: string | null; detail: string | null };

export interface TtsAdapter {
  id: string;
  requiresKey: boolean;
  defaults: VoiceProviderOptions;
  synthesize(call: AdapterCall, input: SynthesizeInput): Promise<SynthesizeResult>;
  probe(call: AdapterCall): Promise<ProbeResult>;
}

export interface SttAdapter {
  id: string;
  requiresKey: boolean;
  defaults: VoiceProviderOptions;
  /** 浏览器识别：服务端不转写，只记录选择。 */
  clientOnly?: boolean;
  transcribe(call: AdapterCall, input: TranscribeInput): Promise<TranscribeResult>;
  probe(call: AdapterCall): Promise<ProbeResult>;
}
