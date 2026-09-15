/**
 * 单次投递。每一次（含每次重试）都重新过地址策略，然后**钉住校验过的 IP** 去连：
 * Host 头与 TLS SNI 仍是原主机名，连接落在钉住的地址上，DNS rebinding 无从下手。
 * 不跟随重定向（3xx 按失败处理，不重试）——跟随就等于让对方把我们引到内网。
 */
import http from 'http';
import https from 'https';
import { randomUUID } from 'crypto';

import { checkOutboundUrl, pinnedLookup, type Resolver } from '../../core/net';
import { signWebhookBody } from './webhook-events';

export const DELIVERY_TIMEOUT_MS = 10_000;
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const STORED_ERROR_CHARS = 500;

export type DeliveryRequest = {
  url: string;
  secret: string | null;
  allowPrivateNetwork: boolean;
  eventType: string;
  eventId: string;
  body: string;
  resolver?: Resolver;
  timeoutMs?: number;
  now?: () => number;
};

export type DeliveryOutcome = {
  status: number;
  ok: boolean;
  retryable: boolean;
  error: string | null;
  deliveryId: string;
  durationMs: number;
  blocked?: string;
};

export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export async function deliverWebhook(request: DeliveryRequest): Promise<DeliveryOutcome> {
  const started = Date.now();
  const deliveryId = randomUUID();
  const verdict = await checkOutboundUrl(request.url, { allowPrivateNetwork: request.allowPrivateNetwork, resolver: request.resolver });
  if (!verdict.ok) {
    return { status: 0, ok: false, retryable: false, error: `blocked: ${verdict.reason}`, deliveryId, durationMs: Date.now() - started, blocked: verdict.reason };
  }
  const url = verdict.url;
  const address = verdict.addresses[0];
  const timestamp = String(Math.floor((request.now ?? Date.now)() / 1000));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(request.body)),
    'User-Agent': 'ClawOPT-Webhooks/1',
    'X-ClawOPT-Event': request.eventType,
    'X-ClawOPT-Event-Id': request.eventId,
    'X-ClawOPT-Delivery': deliveryId,
    'X-ClawOPT-Timestamp': timestamp,
  };
  if (request.secret) headers['X-ClawOPT-Signature-256'] = signWebhookBody(request.secret, timestamp, request.body);

  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<DeliveryOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: Omit<DeliveryOutcome, 'deliveryId' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      resolve({ ...outcome, deliveryId, durationMs: Date.now() - started });
    };
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
      lookup: pinnedLookup(address),
      ...(url.protocol === 'https:' ? { servername: url.hostname.replace(/^\[|\]$/g, '') } : {}),
      timeout: request.timeoutMs ?? DELIVERY_TIMEOUT_MS,
      agent: false,
    }, (res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size >= MAX_ERROR_BODY_BYTES) return;
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => {
        const ok = status >= 200 && status < 300;
        const text = ok ? null : Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf-8').slice(0, STORED_ERROR_CHARS);
        finish({ status, ok, retryable: !ok && isRetryableStatus(status), error: ok ? null : `HTTP ${status}${text ? `: ${text}` : ''}` });
      });
      res.on('error', (error) => finish({ status: 0, ok: false, retryable: true, error: error.message.slice(0, STORED_ERROR_CHARS) }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => finish({ status: 0, ok: false, retryable: true, error: error.message.slice(0, STORED_ERROR_CHARS) }));
    req.end(request.body);
  });
}
