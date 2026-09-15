/**
 * 本地模型代理的测试台：一个假上游（按用例脚本回 SSE / JSON，记下收到的请求）+ 一个只挂代理路由的 Express。
 *
 * 目标 base URL 用不存在的域名（`upstream.test` 这类），`fetchImpl` 把它改写到本机假上游；
 * `resolver` 把域名解析成公网地址——这样出站地址策略走的是真实判据，而不是被「127.0.0.1」短路。
 */
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';

import { LocalProviderProxy, registerRuntimeProxyBodyParser, registerRuntimeProxyRoutes } from '../../src/runtime';
import type { CanonicalRuntimeEvent } from '../../src/runtime';

export type UpstreamRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; body: any };
export type UpstreamReply = { status?: number; headers?: Record<string, string>; body: string | Buffer; chunkBytes?: number };

export function readProxyFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'runtime-proxy', name), 'utf-8');
}

export interface ProxyHarness {
  proxyUrl: string;
  upstreamRequests: UpstreamRequest[];
  proxy: LocalProviderProxy;
  replies: UpstreamReply[];
  events: CanonicalRuntimeEvent[];
  close(): Promise<void>;
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function createProxyHarness(options: { dataDir?: string; publicAddress?: string } = {}): Promise<ProxyHarness> {
  const upstreamRequests: UpstreamRequest[] = [];
  const replies: UpstreamReply[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      let body: any = raw;
      try { body = JSON.parse(raw); } catch { /* 非 JSON 原样记 */ }
      upstreamRequests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const reply = replies.shift() ?? { status: 500, body: '{"error":{"message":"no scripted reply"}}' };
      res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'application/json' });
      const payload = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body, 'utf-8');
      // 按很小的块写出去：跨块的行、被切开的多字节字符都要被解析器接住。
      const size = reply.chunkBytes ?? payload.length;
      let offset = 0;
      const pump = () => {
        if (offset >= payload.length) return res.end();
        res.write(payload.subarray(offset, offset + size));
        offset += size;
        setImmediate(pump);
      };
      pump();
    });
  });
  const upstreamUrl = await listen(upstream);

  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const rewritten = `${upstreamUrl}${url.pathname}${url.search}`;
    return fetch(rewritten, { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-original-host': url.host } });
  };

  const proxy = new LocalProviderProxy({
    publicBaseUrl: () => 'http://127.0.0.1:9',
    dataDir: options.dataDir,
    fetchImpl,
    resolver: async () => [{ address: options.publicAddress ?? '93.184.216.34', family: 4 }],
    log: () => {},
  });
  const app = express();
  registerRuntimeProxyBodyParser(app);
  app.use(express.json());
  registerRuntimeProxyRoutes(app, { providerProxy: proxy });
  const server = http.createServer(app);
  const proxyUrl = await listen(server);

  const events: CanonicalRuntimeEvent[] = [];
  return {
    proxyUrl,
    upstreamRequests,
    proxy,
    replies,
    events,
    close: async () => {
      server.closeAllConnections?.();
      upstream.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

/** 把代理地址里的 `http://127.0.0.1:9` 换成测试台真实地址。 */
export function localize(harness: ProxyHarness, url: string): string {
  return url.replace('http://127.0.0.1:9', harness.proxyUrl);
}

export function parseSseText(text: string): Array<{ event: string | null; data: any }> {
  return text
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event: string | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      const joined = data.join('\n');
      let parsed: any = joined;
      try { parsed = JSON.parse(joined); } catch { /* [DONE] 之类 */ }
      return { event, data: parsed };
    });
}

export const SSE_HEADERS = { 'content-type': 'text/event-stream' };
