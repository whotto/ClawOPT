import { VoiceError, sanitizeVoiceDetail } from '../errors';
import type { VoiceHttpResponse } from '../http';
import type { AdapterCall, ProbeResult } from './types';

export function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

export function requireBaseUrl(call: AdapterCall, fallback?: string): string {
  const base = (call.options.baseUrl || fallback || '').trim();
  if (!base) throw new VoiceError('voice.baseUrlRequired', 400);
  return base;
}

export function requireKey(call: AdapterCall): string {
  if (!call.apiKey) throw new VoiceError('voice.keyMissing', 400);
  return call.apiKey;
}

/** 非 2xx → `voice.upstreamAuthFailed`（401/403）/ `voice.upstreamRateLimited`（429）/ `voice.upstreamFailed`，细节脱敏。 */
export function assertOk(response: VoiceHttpResponse, call: AdapterCall): void {
  if (response.status >= 200 && response.status < 300) return;
  const detail = `HTTP ${response.status}: ${sanitizeVoiceDetail(response.text(), [call.apiKey])}`;
  if (response.status === 401 || response.status === 403) throw new VoiceError('voice.upstreamAuthFailed', 502, detail);
  if (response.status === 429) throw new VoiceError('voice.upstreamRateLimited', 502, detail);
  throw new VoiceError('voice.upstreamFailed', 502, detail);
}

export function clampSpeed(value: unknown, fallback = 1): number {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return fallback;
  return Math.min(2, Math.max(0.5, speed));
}

export function contentTypeForFormat(format: string | undefined): string {
  switch ((format || 'mp3').toLowerCase()) {
    case 'wav': return 'audio/wav';
    case 'opus': return 'audio/ogg';
    case 'aac': return 'audio/aac';
    case 'flac': return 'audio/flac';
    case 'pcm': return 'audio/pcm';
    default: return 'audio/mpeg';
  }
}

export function fileExtensionForMime(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('flac')) return 'flac';
  return 'webm';
}

/**
 * 从 `/models` 的 id 里挑可能的 TTS / STT 模型排前面（界面给候选，不替用户决定）。
 */
export function rankModels(ids: string[], kind: 'tts' | 'stt'): string[] {
  const pattern = kind === 'tts' ? /(tts|speech|voice|audio)/i : /(whisper|transcri|asr|stt|scribe|speech|audio)/i;
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  return [...unique.filter((id) => pattern.test(id)), ...unique.filter((id) => !pattern.test(id))].slice(0, 50);
}

export async function probeModelsEndpoint(call: AdapterCall, url: string, headers: Record<string, string>, kind: 'tts' | 'stt'): Promise<ProbeResult> {
  try {
    const response = await call.http({ url, headers, allowPrivateNetwork: call.options.allowPrivateNetwork, timeoutMs: 15_000, maxResponseBytes: 4 * 1024 * 1024, signal: call.signal });
    assertOk(response, call);
    const body = response.json();
    const list: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
    const ids = list.map((entry: any) => (typeof entry === 'string' ? entry : entry?.id ?? entry?.model_id ?? entry?.name)).filter((id): id is string => typeof id === 'string');
    return { ok: true, models: rankModels(ids, kind), errorCode: null, detail: null };
  } catch (error) {
    return probeFailure(error);
  }
}

export function probeFailure(error: unknown): ProbeResult {
  if (error instanceof VoiceError) return { ok: false, models: [], errorCode: error.errorCode, detail: error.detail };
  return { ok: false, models: [], errorCode: 'voice.upstreamFailed', detail: sanitizeVoiceDetail((error as Error)?.name ?? 'Error') };
}
