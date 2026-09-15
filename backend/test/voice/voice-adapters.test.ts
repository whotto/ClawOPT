/**
 * 语音服务商适配器：对着本机假上游逐个核对请求形状（地址、认证头名、请求体 / multipart）与响应解析、错误映射。
 * 假上游在 127.0.0.1，所以每个调用都显式带 `allowPrivateNetwork`——这正是唯一的放宽口子（见 voice-policy 用例）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createVoiceHttpClient } from '../../src/voice';
import { VoiceError } from '../../src/voice/errors';
import { createDoubaoStt, createDoubaoTts } from '../../src/voice/providers/doubao';
import { createElevenLabsStt, createElevenLabsTts } from '../../src/voice/providers/elevenlabs';
import { createOpenAiCompatibleStt, createOpenAiCompatibleTts } from '../../src/voice/providers/openai-compatible';
import { parseMultipart, startFakeUpstream } from './helpers';

const http = createVoiceHttpClient();
const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0xfb, 0x90]);
let upstream: Awaited<ReturnType<typeof startFakeUpstream>> | null = null;
afterEach(async () => {
  await upstream?.close();
  upstream = null;
});

const call = (baseUrl: string, apiKey: string | null, extra: Record<string, unknown> = {}) => ({
  options: { baseUrl, allowPrivateNetwork: true, ...extra },
  apiKey,
  http,
});

describe('OpenAI 兼容', () => {
  it('TTS：POST /audio/speech，Bearer 认证，JSON 里 model / input / voice / speed / response_format', async () => {
    upstream = await startFakeUpstream(() => ({ headers: { 'content-type': 'audio/mpeg' }, body: AUDIO }));
    const result = await createOpenAiCompatibleTts('custom').synthesize(call(`${upstream.baseUrl}/v1`, 'sk-test-openai-key-123', { model: 'tts-x', voice: 'nova', speed: 1.25 }), { text: '你好' });
    expect(result).toEqual({ audio: AUDIO, contentType: 'audio/mpeg' });
    const [request] = upstream.requests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/audio/speech');
    expect(request.headers.authorization).toBe('Bearer sk-test-openai-key-123');
    expect(JSON.parse(request.body.toString())).toEqual({ model: 'tts-x', input: '你好', voice: 'nova', speed: 1.25, response_format: 'mp3' });
  });

  it('TTS：自建端点可以不带 key；OpenAI 官方没有 key 直接 voice.keyMissing，不发请求', async () => {
    upstream = await startFakeUpstream(() => ({ body: AUDIO }));
    await createOpenAiCompatibleTts('custom').synthesize(call(upstream.baseUrl, null), { text: 'hi' });
    expect(upstream.requests[0].headers.authorization).toBeUndefined();
    await expect(createOpenAiCompatibleTts('openai').synthesize(call(upstream.baseUrl, null), { text: 'hi' })).rejects.toMatchObject({ errorCode: 'voice.keyMissing' });
    expect(upstream.requests).toHaveLength(1);
  });

  it('STT：POST /audio/transcriptions，multipart 带 model / language / 文件（原样字节、按类型定扩展名）', async () => {
    upstream = await startFakeUpstream(() => ({ body: { text: ' 转写结果 ', duration: 1.5 } }));
    const result = await createOpenAiCompatibleStt('custom').transcribe(call(upstream.baseUrl, 'sk-stt-key-abcdef'), { audio: AUDIO, mimeType: 'audio/webm', language: 'zh' });
    expect(result).toEqual({ text: '转写结果', durationMs: 1500 });
    const [request] = upstream.requests;
    expect(request.url).toBe('/audio/transcriptions');
    expect(request.headers.authorization).toBe('Bearer sk-stt-key-abcdef');
    const form = parseMultipart(request.body, request.headers['content-type']);
    expect(form.fields).toMatchObject({ model: 'whisper-1', language: 'zh', response_format: 'json' });
    expect(form.files.file.filename).toBe('speech.webm');
    expect(form.files.file.contentType).toBe('audio/webm');
    expect(form.files.file.data.equals(AUDIO)).toBe(true);
  });

  it('Groq：Whisper 兼容，缺省模型 whisper-large-v3-turbo、缺省地址是 Groq 官方', () => {
    const adapter = createOpenAiCompatibleStt('groq');
    expect(adapter.defaults).toEqual({ baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' });
    expect(adapter.requiresKey).toBe(true);
  });

  it('错误映射：401 → voice.upstreamAuthFailed、429 → voice.upstreamRateLimited；细节里的 key 被抹掉', async () => {
    const key = 'sk-leaky-secret-key-0001';
    upstream = await startFakeUpstream((request) => (request.url.includes('speech')
      ? { status: 401, body: { error: { message: `Incorrect API key provided: ${key}` } } }
      : { status: 429, body: { error: 'slow down' } }));
    const auth = await createOpenAiCompatibleTts('custom').synthesize(call(upstream.baseUrl, key), { text: 'x' }).catch((error) => error);
    expect(auth).toBeInstanceOf(VoiceError);
    expect(auth.errorCode).toBe('voice.upstreamAuthFailed');
    expect(auth.detail).not.toContain(key);
    const limited = await createOpenAiCompatibleStt('custom').transcribe(call(upstream.baseUrl, key), { audio: AUDIO, mimeType: 'audio/wav' }).catch((error) => error);
    expect(limited.errorCode).toBe('voice.upstreamRateLimited');
  });

  it('探测：GET /models，按种类把像 TTS / STT 的模型排前面', async () => {
    upstream = await startFakeUpstream(() => ({ body: { data: [{ id: 'gpt-4o' }, { id: 'whisper-1' }, { id: 'tts-1' }, { id: 'gpt-4o-mini-transcribe' }] } }));
    const tts = await createOpenAiCompatibleTts('custom').probe(call(upstream.baseUrl, 'k-probe-000'));
    expect(tts).toMatchObject({ ok: true, errorCode: null });
    expect(tts.models[0]).toBe('tts-1');
    const stt = await createOpenAiCompatibleStt('custom').probe(call(upstream.baseUrl, 'k-probe-000'));
    expect(stt.models.slice(0, 2)).toEqual(['whisper-1', 'gpt-4o-mini-transcribe']);
    expect(upstream.requests.every((request) => request.url === '/models' && request.method === 'GET')).toBe(true);
  });
});

describe('ElevenLabs', () => {
  it('TTS：xi-api-key 头、路径带 voice id、output_format 查询参数、JSON model_id / voice_settings.speed', async () => {
    upstream = await startFakeUpstream(() => ({ body: AUDIO }));
    const result = await createElevenLabsTts().synthesize(call(upstream.baseUrl, 'xi-key-123456', { voice: 'voice/1', model: 'eleven_turbo_v2_5' }), { text: 'hello', speed: 1.1 });
    expect(result.contentType).toBe('audio/mpeg');
    const [request] = upstream.requests;
    expect(request.url).toBe('/v1/text-to-speech/voice%2F1?output_format=mp3_44100_128');
    expect(request.headers['xi-api-key']).toBe('xi-key-123456');
    expect(request.headers.authorization).toBeUndefined();
    expect(JSON.parse(request.body.toString())).toEqual({ text: 'hello', model_id: 'eleven_turbo_v2_5', voice_settings: { speed: 1.1 } });
  });

  it('STT：POST /v1/speech-to-text，multipart model_id + file', async () => {
    upstream = await startFakeUpstream(() => ({ body: { text: 'scribed', language_code: 'en' } }));
    const result = await createElevenLabsStt().transcribe(call(upstream.baseUrl, 'xi-key-abcdef'), { audio: AUDIO, mimeType: 'audio/ogg' });
    expect(result.text).toBe('scribed');
    const [request] = upstream.requests;
    expect(request.url).toBe('/v1/speech-to-text');
    expect(request.headers['xi-api-key']).toBe('xi-key-abcdef');
    const form = parseMultipart(request.body, request.headers['content-type']);
    expect(form.fields.model_id).toBe('scribe_v1');
    expect(form.files.file.filename).toBe('speech.ogg');
  });

  it('没有 key：voice.keyMissing，不发请求', async () => {
    upstream = await startFakeUpstream(() => ({ body: AUDIO }));
    await expect(createElevenLabsTts().synthesize(call(upstream.baseUrl, null), { text: 'x' })).rejects.toMatchObject({ errorCode: 'voice.keyMissing' });
    expect(upstream.requests).toHaveLength(0);
  });
});

describe('豆包 / 火山引擎', () => {
  it('TTS：Authorization: Bearer;<令牌>（分号），请求体 app / audio / request，code 3000 的 base64 音频解码', async () => {
    upstream = await startFakeUpstream(() => ({ body: { code: 3000, message: 'Success', data: AUDIO.toString('base64') } }));
    const result = await createDoubaoTts().synthesize(call(upstream.baseUrl, 'volc-token-xyz', { appId: 'app-1', cluster: 'volcano_tts', voice: 'zh_female_x' }), { text: '播报', speed: 1.2 });
    expect(result.audio.equals(AUDIO)).toBe(true);
    const [request] = upstream.requests;
    expect(request.url).toBe('/api/v1/tts');
    expect(request.headers.authorization).toBe('Bearer;volc-token-xyz');
    const body = JSON.parse(request.body.toString());
    expect(body.app).toEqual({ appid: 'app-1', token: 'access_token', cluster: 'volcano_tts' });
    expect(body.audio).toEqual({ voice_type: 'zh_female_x', encoding: 'mp3', speed_ratio: 1.2 });
    expect(body.request).toMatchObject({ text: '播报', text_type: 'plain', operation: 'query' });
    // 令牌只在头里，不进请求体。
    expect(request.body.toString()).not.toContain('volc-token-xyz');
  });

  it('TTS：业务码不是 3000 → 失败（3001 = 鉴权），没有 appId → voice.appIdRequired', async () => {
    upstream = await startFakeUpstream(() => ({ body: { code: 3001, message: 'invalid token volc-token-xyz' } }));
    const error = await createDoubaoTts().synthesize(call(upstream.baseUrl, 'volc-token-xyz', { appId: 'a' }), { text: 'x' }).catch((caught) => caught);
    expect(error.errorCode).toBe('voice.upstreamAuthFailed');
    expect(error.detail).not.toContain('volc-token-xyz');
    await expect(createDoubaoTts().synthesize(call(upstream.baseUrl, 'volc-token-xyz'), { text: 'x' })).rejects.toMatchObject({ errorCode: 'voice.appIdRequired' });
  });

  it('STT：极速版头 X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id / X-Api-Sequence，音频 base64，状态码头判成败', async () => {
    let status = '20000000';
    upstream = await startFakeUpstream(() => ({ headers: { 'x-api-status-code': status, 'content-type': 'application/json' }, body: { result: { text: '识别文本' }, audio_info: { duration: 2300 } } }));
    const adapter = createDoubaoStt();
    const result = await adapter.transcribe(call(upstream.baseUrl, 'volc-access-key', { appId: 'app-9' }), { audio: AUDIO, mimeType: 'audio/wav' });
    expect(result).toEqual({ text: '识别文本', durationMs: 2300 });
    const [request] = upstream.requests;
    expect(request.url).toBe('/api/v3/auc/bigmodel/recognize/flash');
    expect(request.headers).toMatchObject({ 'x-api-app-key': 'app-9', 'x-api-access-key': 'volc-access-key', 'x-api-resource-id': 'volc.bigasr.auc_turbo', 'x-api-sequence': '-1' });
    expect(JSON.parse(request.body.toString()).audio.data).toBe(AUDIO.toString('base64'));
    status = '20000003';
    await expect(adapter.transcribe(call(upstream.baseUrl, 'volc-access-key', { appId: 'app-9' }), { audio: AUDIO, mimeType: 'audio/wav' })).rejects.toMatchObject({ errorCode: 'voice.noSpeech' });
  });
});
