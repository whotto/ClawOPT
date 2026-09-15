/**
 * Edge 朗读（实验性）的线格式对着本机假 WebSocket 服务核对；出站策略对 HTTP 与 WebSocket 两条路都守着。
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { createVoiceHttpClient } from '../../src/voice';
import { EDGE_TRUSTED_CLIENT_TOKEN, buildEdgeSsml, createEdgeTts, edgeRate, edgeSecMsGec, parseEdgeBinaryFrame } from '../../src/voice/providers/edge';
import { createOpenAiCompatibleTts } from '../../src/voice/providers/openai-compatible';
import { startFakeUpstream } from './helpers';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function audioFrame(payload: Buffer, path = 'audio'): Buffer {
  const header = Buffer.from(`X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:${path}\r\n`, 'utf-8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(header.length, 0);
  return Buffer.concat([length, header, payload]);
}

async function startFakeEdge(onMessages: (messages: string[], url: string) => void) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    const messages: string[] = [];
    socket.on('message', (data) => {
      messages.push(data.toString());
      if (messages.length === 2) {
        onMessages(messages, request.url ?? '');
        socket.send(Buffer.from('X-RequestId:abc\r\nPath:turn.start\r\n\r\n{}'), { binary: false });
        socket.send(audioFrame(Buffer.from('AAAA')), { binary: true });
        socket.send(audioFrame(Buffer.from('meta'), 'audio.metadata'), { binary: true });
        socket.send(audioFrame(Buffer.from('BBBB')), { binary: true });
        socket.send('X-RequestId:abc\r\nPath:turn.end\r\n\r\n{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => { wss.close(); server.close(() => resolve()); }));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/edge/v1`;
}

describe('Edge 朗读（实验性）', () => {
  it('Sec-MS-GEC：5 分钟粒度内不变、跨粒度变化，64 位大写十六进制', () => {
    const base = Date.UTC(2026, 8, 15, 8, 0, 0);
    expect(edgeSecMsGec(base)).toMatch(/^[0-9A-F]{64}$/);
    expect(edgeSecMsGec(base + 299_000)).toBe(edgeSecMsGec(base));
    expect(edgeSecMsGec(base + 300_000)).not.toBe(edgeSecMsGec(base));
  });

  it('SSML 转义正文、语速换百分比；二进制帧按 2 字节大端头长拆开', () => {
    expect(edgeRate(1.25)).toBe('+25%');
    expect(edgeRate(0.5)).toBe('-50%');
    const ssml = buildEdgeSsml(`<a & 'b'>`, 'zh-CN-XiaoxiaoNeural', 1);
    expect(ssml).toContain('&lt;a &amp; &apos;b&apos;&gt;');
    expect(ssml).toContain("xml:lang='zh-CN'");
    const frame = parseEdgeBinaryFrame(audioFrame(Buffer.from('xyz')));
    expect(frame?.headers.path).toBe('audio');
    expect(frame?.payload.toString()).toBe('xyz');
    expect(parseEdgeBinaryFrame(Buffer.from([0xff, 0xff, 0x00]))).toBeNull();
  });

  it('握手带令牌参数；先 speech.config 再 ssml；只拼 Path:audio 的负载，turn.end 收尾', async () => {
    let seen: { messages: string[]; url: string } | null = null;
    const baseUrl = await startFakeEdge((messages, url) => { seen = { messages, url }; });
    const now = () => Date.UTC(2026, 8, 15, 8, 3, 0);
    const result = await createEdgeTts({ now }).synthesize({ options: { baseUrl, allowPrivateNetwork: true }, apiKey: null, http: createVoiceHttpClient() }, { text: '你好', voice: 'zh-CN-YunxiNeural' });
    expect(result).toEqual({ audio: Buffer.from('AAAABBBB'), contentType: 'audio/mpeg' });
    const query = new URL(`http://x${seen!.url}`).searchParams;
    expect(query.get('TrustedClientToken')).toBe(EDGE_TRUSTED_CLIENT_TOKEN);
    expect(query.get('Sec-MS-GEC')).toBe(edgeSecMsGec(now()));
    expect(seen!.messages[0]).toContain('Path:speech.config');
    expect(seen!.messages[0]).toContain('audio-24khz-48kbitrate-mono-mp3');
    expect(seen!.messages[1]).toContain('Path:ssml');
    expect(seen!.messages[1]).toContain("<voice name='zh-CN-YunxiNeural'>");
    expect(seen!.messages[1]).toContain('你好');
  });

  it('出站策略：WebSocket 地址落在回环、没打开「受信任局域网」→ voice.urlBlocked，连接都不建', async () => {
    let connected = false;
    const baseUrl = await startFakeEdge(() => { connected = true; });
    const error = await createEdgeTts().synthesize({ options: { baseUrl }, apiKey: null, http: createVoiceHttpClient() }, { text: 'x' }).catch((caught) => caught);
    expect(error.errorCode).toBe('voice.urlBlocked');
    expect(connected).toBe(false);
  });
});

describe('出站策略（HTTP）', () => {
  it('回环地址没打开 allowPrivateNetwork → voice.urlBlocked，假上游一个请求都没收到；打开后放行', async () => {
    const upstream = await startFakeUpstream(() => ({ body: Buffer.from('ID3') }));
    closers.push(upstream.close);
    const adapter = createOpenAiCompatibleTts('custom');
    const blocked = await adapter.synthesize({ options: { baseUrl: upstream.baseUrl }, apiKey: 'k-policy-1', http: createVoiceHttpClient() }, { text: 'x' }).catch((caught) => caught);
    expect(blocked.errorCode).toBe('voice.urlBlocked');
    expect(upstream.requests).toHaveLength(0);
    await adapter.synthesize({ options: { baseUrl: upstream.baseUrl, allowPrivateNetwork: true }, apiKey: 'k-policy-1', http: createVoiceHttpClient() }, { text: 'x' });
    expect(upstream.requests).toHaveLength(1);
  });

  it('主机名解析到内网也拦（不只看字面量）；地址里带账号口令拦；非 http 协议拦', async () => {
    const client = createVoiceHttpClient({ resolver: async () => [{ address: '10.0.0.5', family: 4 }] });
    await expect(client({ url: 'https://voice.example.com/v1/models' })).rejects.toMatchObject({ errorCode: 'voice.urlBlocked', params: { reason: 'privateAddress' } });
    await expect(client({ url: 'https://user:pw@api.example.com/' })).rejects.toMatchObject({ errorCode: 'voice.urlBlocked' });
    await expect(client({ url: 'file:///etc/passwd' })).rejects.toMatchObject({ errorCode: 'voice.urlBlocked' });
  });

  it('不跟随重定向：302 原样当失败，Location 指向的地址不会被请求', async () => {
    const target = await startFakeUpstream(() => ({ body: Buffer.from('ID3') }));
    closers.push(target.close);
    const redirect = await startFakeUpstream(() => ({ status: 302, headers: { location: `${target.baseUrl}/audio/speech` } }));
    closers.push(redirect.close);
    const error = await createOpenAiCompatibleTts('custom')
      .synthesize({ options: { baseUrl: redirect.baseUrl, allowPrivateNetwork: true }, apiKey: null, http: createVoiceHttpClient() }, { text: 'x' })
      .catch((caught) => caught);
    expect(error.errorCode).toBe('voice.upstreamFailed');
    expect(target.requests).toHaveLength(0);
  });

  it('响应体超过上限即中止（voice.upstreamResponseTooLarge）', async () => {
    const upstream = await startFakeUpstream(() => ({ body: Buffer.alloc(64 * 1024, 1) }));
    closers.push(upstream.close);
    await expect(createVoiceHttpClient()({ url: upstream.baseUrl, allowPrivateNetwork: true, maxResponseBytes: 1024 })).rejects.toMatchObject({ errorCode: 'voice.upstreamResponseTooLarge' });
  });
});
