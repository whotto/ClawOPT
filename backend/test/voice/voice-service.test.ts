/**
 * 语音服务与路由：key 只写不读（封存、不回显、空串不修改）、输入上限、限流、管理员闸门、本地 STT 不随包。
 */
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthMiddleware } from '../../src/core/auth';
import { createVoiceHttpClient, createVoiceService, registerVoiceRoutes, VOICE_MAX_AUDIO_BYTES, type VoiceService } from '../../src/voice';
import { startFakeUpstream } from './helpers';

const SECRET = 'sk-voice-secret-never-echo-9f8e7d';
const hostCapabilities = async () => ({ gates: { localStt: { allowed: false, reason: 'host.localSttNotIncluded' } } }) as any;

let dir = '';
let sql: Database.Database;
let service: VoiceService;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-voice-'));
  sql = new Database(':memory:');
  service = createVoiceService({ db: { connection: () => sql } as any, dataDir: dir, hostCapabilities, http: createVoiceHttpClient(), rateLimitPerMinute: 3 });
});

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  sql.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function configureCustomTts(baseUrl: string, apiKey: string | undefined = SECRET) {
  service.saveProvider('tts', 'custom', { options: { baseUrl, allowPrivateNetwork: true, voice: 'alloy' }, apiKey });
  service.saveConfig({ ttsProvider: 'custom' });
}

describe('key 只写不读', () => {
  it('设置视图只报 hasApiKey，任何地方都不回 key；库里与密钥文件里都没有明文', async () => {
    await configureCustomTts('http://127.0.0.1:9/v1');
    const view = await service.settings();
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.tts.find((entry) => entry.id === 'custom')).toMatchObject({ hasApiKey: true, options: { baseUrl: 'http://127.0.0.1:9/v1', voice: 'alloy', allowPrivateNetwork: true } });
    expect(JSON.stringify(await service.status())).not.toContain(SECRET);
    const rows = sql.prepare('SELECT * FROM voice_providers').all();
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    const keyFile = path.join(dir, 'voice', 'secret.key');
    expect(fs.statSync(keyFile).mode & 0o077).toBe(0);
    expect(fs.readFileSync(keyFile, 'utf-8')).not.toContain(SECRET);
  });

  it('空串 = 不修改；显式清除才清掉；换服务商行解不开（AAD 绑定坐标）', async () => {
    const upstream = await startFakeUpstream(() => ({ body: Buffer.from('ID3') }));
    closers.push(upstream.close);
    await configureCustomTts(upstream.baseUrl);
    service.saveProvider('tts', 'custom', { options: { baseUrl: upstream.baseUrl, allowPrivateNetwork: true }, apiKey: '' });
    await service.synthesize('user:1', { text: 'hi' });
    expect(upstream.requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);

    // 把封存的 key 挪到另一个服务商的行下：解不开，当作没有 key。
    const sealed = (sql.prepare("SELECT sealed_key FROM voice_providers WHERE kind='tts' AND provider='custom'").get() as { sealed_key: string }).sealed_key;
    sql.prepare("INSERT INTO voice_providers (kind, provider, options, sealed_key, updated_at) VALUES ('tts', 'openai', '{}', ?, 0)").run(sealed);
    await service.probe({ kind: 'tts', provider: 'openai', options: { baseUrl: upstream.baseUrl, allowPrivateNetwork: true } });
    expect(upstream.requests.at(-1)?.url).toBe('/models');
    expect(upstream.requests.at(-1)?.headers.authorization).toBeUndefined();

    service.clearKey('tts', 'custom');
    expect((await service.settings()).tts.find((entry) => entry.id === 'custom')?.hasApiKey).toBe(false);
    await service.synthesize('user:1', { text: 'again' });
    expect(upstream.requests.at(-1)?.headers.authorization).toBeUndefined();
  });

  it('探测用表单里的新 key 或已存的 key，结果里不回 key', async () => {
    const upstream = await startFakeUpstream((request) => (request.headers.authorization === `Bearer ${SECRET}` ? { body: { data: [{ id: 'tts-1' }] } } : { status: 401, body: { error: 'bad' } }));
    closers.push(upstream.close);
    await configureCustomTts(upstream.baseUrl);
    const stored = await service.probe({ kind: 'tts', provider: 'custom' });
    expect(stored).toMatchObject({ ok: true, models: ['tts-1'] });
    const wrong = await service.probe({ kind: 'tts', provider: 'custom', apiKey: 'sk-typed-in-form-000' });
    expect(wrong.errorCode).toBe('voice.upstreamAuthFailed');
    expect(JSON.stringify(wrong)).not.toContain('sk-typed-in-form-000');
  });
});

describe('输入与限流', () => {
  it('没配置 → voice.notConfigured；文本为空 / 超 5000 字拒绝，不发请求', async () => {
    await expect(service.synthesize('user:1', { text: 'hi' })).rejects.toMatchObject({ errorCode: 'voice.notConfigured', status: 409 });
    const upstream = await startFakeUpstream(() => ({ body: Buffer.from('ID3') }));
    closers.push(upstream.close);
    await configureCustomTts(upstream.baseUrl);
    await expect(service.synthesize('user:1', { text: '   ' })).rejects.toMatchObject({ errorCode: 'voice.textRequired' });
    await expect(service.synthesize('user:1', { text: 'x'.repeat(5001) })).rejects.toMatchObject({ errorCode: 'voice.textTooLong', status: 413 });
    expect(upstream.requests).toHaveLength(0);
  });

  it('音频：空、超 25 MB、不是音频类型都拒绝；浏览器识别不走服务端', async () => {
    service.saveProvider('stt', 'custom', { options: { baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true } });
    service.saveConfig({ sttProvider: 'custom' });
    await expect(service.transcribe('u', { audio: Buffer.alloc(0), mimeType: 'audio/webm' })).rejects.toMatchObject({ errorCode: 'voice.audioEmpty' });
    await expect(service.transcribe('u', { audio: Buffer.alloc(VOICE_MAX_AUDIO_BYTES + 1), mimeType: 'audio/webm' })).rejects.toMatchObject({ errorCode: 'voice.audioTooLarge', status: 413 });
    await expect(service.transcribe('u', { audio: Buffer.from('x'), mimeType: 'text/html' })).rejects.toMatchObject({ errorCode: 'voice.audioTypeUnsupported' });
    service.saveConfig({ sttProvider: 'browser' });
    expect((await service.status()).stt).toMatchObject({ configured: true, clientOnly: true });
    await expect(service.transcribe('u', { audio: Buffer.from('x'), mimeType: 'audio/webm' })).rejects.toMatchObject({ errorCode: 'voice.clientOnlyProvider' });
  });

  it('每用户每分钟限流（按用户分开计）', async () => {
    const upstream = await startFakeUpstream(() => ({ body: Buffer.from('ID3') }));
    closers.push(upstream.close);
    await configureCustomTts(upstream.baseUrl);
    for (let index = 0; index < 3; index += 1) await service.synthesize('user:1', { text: `n${index}` });
    await expect(service.synthesize('user:1', { text: 'over' })).rejects.toMatchObject({ errorCode: 'voice.rateLimited', status: 429 });
    await service.synthesize('user:2', { text: 'other user' });
    expect(upstream.requests).toHaveLength(4);
  });

  it('本地离线识别：主机能力闸门说「不随包」', async () => {
    expect((await service.status()).localStt).toEqual({ available: false, reasonCode: 'host.localSttNotIncluded' });
  });
});

describe('路由闸门', () => {
  const MEMBER = 'member-token';
  const ADMIN = 'admin-token';
  let baseUrl = '';

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const users: Record<number, any> = {
      1: { id: 1, username: 'adm', role: 'admin', status: 'active', mustChangePassword: false },
      2: { id: 2, username: 'mem', role: 'member', status: 'active', mustChangePassword: false },
    };
    const auth = createAuthMiddleware({
      configManager: { getConfig: () => ({ loginEnabled: true }) },
      authStore: { resolve: (token: string) => (token === ADMIN ? { userId: 1 } : token === MEMBER ? { userId: 2 } : null) },
      userStore: { count: () => 2, get: (id: number) => users[id] ?? null, firstActiveSuperAdmin: () => null, hasAgent: () => false },
    } as any);
    const app = express();
    app.use(express.json());
    app.use('/api', auth.requireSessionAuth);
    registerVoiceRoutes(app, { auth, voice: service });
    app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json(error.payload ?? {}));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  });

  const request = (method: string, url: string, token: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'X-ClawOPT-Auth-Token': token, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

  it('member：写设置、存 key、清 key、探测、读管理视图一律 403；状态可读', async () => {
    const denied = [
      await request('GET', '/api/voice/settings', MEMBER),
      await request('PUT', '/api/voice/settings', MEMBER, { ttsProvider: 'custom' }),
      await request('PUT', '/api/voice/providers/tts/custom', MEMBER, { options: {}, apiKey: 'sk-member-attempt' }),
      await request('DELETE', '/api/voice/providers/tts/custom/key', MEMBER),
      await request('POST', '/api/voice/probe', MEMBER, { kind: 'tts', provider: 'custom' }),
    ];
    expect(denied.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    expect((await service.settings()).tts.find((entry) => entry.id === 'custom')?.hasApiKey).toBe(false);
    expect((await request('GET', '/api/voice/status', MEMBER)).status).toBe(200);
  });

  it('admin 存 key：响应与之后的 GET 都不含 key；member 能合成（输入区用）', async () => {
    const upstream = await startFakeUpstream(() => ({ headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from('ID3-audio') }));
    closers.push(upstream.close);
    const saved = await request('PUT', '/api/voice/providers/tts/custom', ADMIN, { options: { baseUrl: upstream.baseUrl, allowPrivateNetwork: true }, apiKey: SECRET });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(SECRET);
    expect(await (await request('GET', '/api/voice/settings', ADMIN)).text()).not.toContain(SECRET);
    await request('PUT', '/api/voice/settings', ADMIN, { ttsProvider: 'custom' });
    const audio = await request('POST', '/api/voice/synthesize', MEMBER, { text: 'hello' });
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await audio.arrayBuffer()).toString()).toBe('ID3-audio');
  });

  it('识别：原始音频请求体，超过 25 MB 回 413 结构化错误；正常转写回文本', async () => {
    const upstream = await startFakeUpstream(() => ({ body: { text: 'recognized words' } }));
    closers.push(upstream.close);
    service.saveProvider('stt', 'custom', { options: { baseUrl: upstream.baseUrl, allowPrivateNetwork: true } });
    service.saveConfig({ sttProvider: 'custom' });
    const ok = await request('POST', '/api/voice/transcribe?language=en', MEMBER, Buffer.from('RIFFxxxxWAVE'), { 'content-type': 'audio/wav' });
    expect(await ok.json()).toMatchObject({ success: true, text: 'recognized words' });
    const big = await request('POST', '/api/voice/transcribe', MEMBER, Buffer.alloc(VOICE_MAX_AUDIO_BYTES + 10), { 'content-type': 'audio/wav' });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ errorCode: 'voice.audioTooLarge' });
    expect(upstream.requests).toHaveLength(1);
  });
});
