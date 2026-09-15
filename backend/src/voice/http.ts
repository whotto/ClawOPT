/**
 * 语音服务商的出站请求：地址先过 `core/net` 的唯一出站策略（协议白名单、解析后全部地址不落内网与保留段），
 * 连接钉住校验过的 IP（`pinnedLookup`），**不跟随重定向**，响应体有上限，整次请求有超时。
 *
 * 为什么不直接用 `pinnedFetch`：它的请求体只收字符串，而语音要发音频二进制与 multipart。
 * 这里只是换了请求体的类型，判据（`checkOutboundUrl` + `pinnedLookup`）仍是 core/net 那一份。
 * 放宽只有一个口子：服务商配置里显式打开的 `allowPrivateNetwork`（本地 / 受信任局域网端点）。
 */
import http from 'http';
import https from 'https';

import { checkOutboundUrl, pinnedLookup, type Resolver } from '../core/net';
import { VoiceError } from './errors';

export type VoiceHttpRequest = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Buffer | string;
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
};

export type VoiceHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
  json<T = any>(): T | null;
};

export type VoiceHttpClient = (request: VoiceHttpRequest) => Promise<VoiceHttpResponse>;

export const DEFAULT_VOICE_TIMEOUT_MS = 60_000;
export const DEFAULT_VOICE_MAX_RESPONSE_BYTES = 30 * 1024 * 1024;

export function createVoiceHttpClient(options: { resolver?: Resolver } = {}): VoiceHttpClient {
  return async (request) => {
    const verdict = await checkOutboundUrl(request.url, { allowPrivateNetwork: request.allowPrivateNetwork === true, resolver: options.resolver });
    if (!verdict.ok) {
      throw new VoiceError('voice.urlBlocked', 400, `${verdict.reason}: ${verdict.detail}`, { reason: verdict.reason });
    }
    const url = verdict.url;
    const address = verdict.addresses[0];
    const transport = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const timeoutMs = request.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
    const maxBytes = request.maxResponseBytes ?? DEFAULT_VOICE_MAX_RESPONSE_BYTES;
    const body = request.body === undefined ? undefined : Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, 'utf-8');

    return new Promise<VoiceHttpResponse>((resolve, reject) => {
      let settled = false;
      const fail = (error: VoiceError) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const headers: Record<string, string> = { ...(request.headers ?? {}) };
      if (body) headers['content-length'] = String(body.length);
      const req = transport.request({
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method ?? (body ? 'POST' : 'GET'),
        headers,
        lookup: pinnedLookup(address),
        ...(url.protocol === 'https:' ? { servername: hostname } : {}),
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            fail(new VoiceError('voice.upstreamResponseTooLarge', 502, `response exceeded ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
          }
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 502,
            headers: responseHeaders,
            body: buffer,
            text: () => buffer.toString('utf-8'),
            json: () => {
              try {
                return JSON.parse(buffer.toString('utf-8'));
              } catch {
                return null;
              }
            },
          });
        });
        res.on('error', () => fail(new VoiceError('voice.upstreamFailed', 502, 'response stream error')));
      });
      const timer = setTimeout(() => {
        req.destroy();
        fail(new VoiceError('voice.upstreamTimeout', 504, `no response within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        req.destroy();
        fail(new VoiceError('voice.aborted', 499, null));
      };
      if (request.signal?.aborted) onAbort();
      request.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(new VoiceError('voice.upstreamUnreachable', 502, error.code ?? error.name));
      });
      req.on('close', () => request.signal?.removeEventListener('abort', onAbort));
      if (body) req.write(body);
      req.end();
    });
  };
}

/** 最小 multipart/form-data 编码（语音识别上传只要文本字段 + 一个文件）。 */
export function encodeMultipart(fields: Record<string, string | undefined>, file: { field: string; filename: string; contentType: string; data: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----clawoptvoice${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf-8'));
  }
  const safeName = file.filename.replace(/["\r\n]/g, '_');
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safeName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, 'utf-8'));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
