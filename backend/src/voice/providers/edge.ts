/**
 * Edge 朗读（**实验性，非官方端点**）：浏览器「大声朗读」用的 WebSocket 协议，免费、无 key。
 *
 * 协议（按公开的客户端行为实现，不保证长期可用——微软随时可能改令牌算法或下线）：
 * - 连接 `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=…&Sec-MS-GEC=…&Sec-MS-GEC-Version=…&ConnectionId=…`；
 *   `Sec-MS-GEC` = SHA-256(「Windows 文件时间（100ns 刻度，按 5 分钟向下取整）」+ TrustedClientToken) 的大写十六进制；
 * - 先发文本帧 `Path:speech.config`（输出格式），再发 `Path:ssml`（SSML 正文）；
 * - 服务端回二进制帧：前 2 字节大端 = 头部长度，头部含 `Path:audio`，其后是音频字节；文本帧 `Path:turn.end` 表示结束。
 *
 * 出站：地址同样先过 `core/net` 策略（协议只收 wss/ws），WebSocket 连接钉住校验过的 IP；整次合成有超时、音频有上限。
 * 用现有的 `ws` 依赖，不引新包。
 */
import { createHash, randomUUID } from 'crypto';
import WebSocket from 'ws';

import { checkOutboundUrl, pinnedLookup, type Resolver } from '../../core/net';
import { VoiceError, sanitizeVoiceDetail } from '../errors';
import { clampSpeed, probeFailure } from './common';
import type { TtsAdapter } from './types';

export const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const EDGE_BASE_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
export const EDGE_GEC_VERSION = '1-130.0.2849.68';
const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const EDGE_TIMEOUT_MS = 30_000;
const EDGE_MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** `Sec-MS-GEC`：Windows 文件时间刻度（5 分钟粒度）+ 固定令牌的 SHA-256。 */
export function edgeSecMsGec(nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000) + WINDOWS_EPOCH_OFFSET_SECONDS;
  const rounded = BigInt(seconds - (seconds % 300)) * 10_000_000n;
  return createHash('sha256').update(`${rounded.toString()}${EDGE_TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

export function escapeSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 语速倍率 → SSML 百分比（1.0 = +0%）。 */
export function edgeRate(speed: number): string {
  const percent = Math.round((clampSpeed(speed) - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

export function buildEdgeSsml(text: string, voice: string, speed: number): string {
  const lang = /^[a-z]{2}-[A-Z]{2}/.exec(voice)?.[0] ?? 'en-US';
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${escapeSsml(voice)}'><prosody pitch='+0Hz' rate='${edgeRate(speed)}' volume='+0%'>${escapeSsml(text)}</prosody></voice></speak>`;
}

/** 二进制帧 → { headers, payload }；头部长度越界返回 null。 */
export function parseEdgeBinaryFrame(frame: Buffer): { headers: Record<string, string>; payload: Buffer } | null {
  if (frame.length < 2) return null;
  const headerLength = frame.readUInt16BE(0);
  if (2 + headerLength > frame.length) return null;
  const headers: Record<string, string> = {};
  for (const line of frame.subarray(2, 2 + headerLength).toString('utf-8').split('\r\n')) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { headers, payload: frame.subarray(2 + headerLength) };
}

export type EdgeTtsOptions = { now?: () => number; resolver?: Resolver };

export function createEdgeTts(edgeOptions: EdgeTtsOptions = {}): TtsAdapter {
  const now = edgeOptions.now ?? Date.now;
  const defaults = { baseUrl: EDGE_BASE_URL, voice: 'zh-CN-XiaoxiaoNeural', speed: 1, format: 'mp3' };

  const synthesize: TtsAdapter['synthesize'] = async (call, input) => {
    const base = (call.options.baseUrl || defaults.baseUrl).trim();
    const connectionId = randomUUID().replace(/-/g, '');
    const url = `${base}${base.includes('?') ? '&' : '?'}TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${edgeSecMsGec(now())}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}&ConnectionId=${connectionId}`;
    const verdict = await checkOutboundUrl(url, { protocols: ['wss:', 'ws:'], allowPrivateNetwork: call.options.allowPrivateNetwork === true, resolver: edgeOptions.resolver });
    if (!verdict.ok) throw new VoiceError('voice.urlBlocked', 400, `${verdict.reason}: ${verdict.detail}`, { reason: verdict.reason });
    const voice = input.voice || call.options.voice || defaults.voice;
    const speed = input.speed ?? call.options.speed ?? 1;

    return new Promise((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let size = 0;
      const socket = new WebSocket(url, {
        lookup: pinnedLookup(verdict.addresses[0]) as any,
        headers: {
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
        },
        followRedirects: false,
        handshakeTimeout: 10_000,
      });
      const finish = (error: VoiceError | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        call.signal?.removeEventListener('abort', onAbort);
        try { socket.close(); } catch { /* 已断开 */ }
        if (error) reject(error);
        else if (!size) reject(new VoiceError('voice.upstreamEmptyAudio', 502));
        else resolve({ audio: Buffer.concat(chunks), contentType: 'audio/mpeg' });
      };
      const timer = setTimeout(() => finish(new VoiceError('voice.upstreamTimeout', 504, `no turn.end within ${EDGE_TIMEOUT_MS} ms`)), EDGE_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => finish(new VoiceError('voice.aborted', 499));
      call.signal?.addEventListener('abort', onAbort, { once: true });

      socket.on('open', () => {
        const timestamp = new Date(now()).toString();
        socket.send(`X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({
          context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: EDGE_OUTPUT_FORMAT } } },
        })}`);
        socket.send(`X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n${buildEdgeSsml(input.text, voice, speed)}`);
      });
      socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (isBinary) {
          const frame = parseEdgeBinaryFrame(buffer);
          if (!frame || frame.headers.path !== 'audio' || !frame.payload.length) return;
          size += frame.payload.length;
          if (size > EDGE_MAX_AUDIO_BYTES) {
            finish(new VoiceError('voice.upstreamResponseTooLarge', 502));
            return;
          }
          chunks.push(frame.payload);
          return;
        }
        if (/Path:turn\.end/i.test(buffer.toString('utf-8'))) finish(null);
      });
      socket.on('unexpected-response', (_req, res) => {
        finish(new VoiceError(res.statusCode === 403 ? 'voice.upstreamAuthFailed' : 'voice.upstreamFailed', 502, `HTTP ${res.statusCode ?? '?'}`));
      });
      socket.on('error', (error: NodeJS.ErrnoException) => finish(new VoiceError('voice.upstreamUnreachable', 502, sanitizeVoiceDetail(error.code ?? error.name))));
      socket.on('close', () => finish(size ? null : new VoiceError('voice.upstreamFailed', 502, 'connection closed before turn.end')));
    });
  };

  return {
    id: 'edge',
    requiresKey: false,
    defaults,
    synthesize,
    async probe(call) {
      try {
        await synthesize(call, { text: 'ok' });
        return { ok: true, models: [], errorCode: null, detail: null };
      } catch (error) {
        return probeFailure(error);
      }
    },
  };
}
