/**
 * 出站 Webhook：事件总线消费者（扇出入队）+ outbox 派发器 + 测试发送 + 本机回环测试收件箱。
 *
 * 派发规则：
 * - 全局并发 `GLOBAL_CONCURRENCY`；每个端点同时最多一个在投；
 * - 只投队头，队头没结束后面的不动（按端点保序）；
 * - 可重试（网络错误 / 408 / 429 / 5xx）时退避：min(300s, 5s·2^(n−1)) × U[0.5, 1]，行留在队头；
 * - 停用的端点暂停派发（行保留）；删除的端点其未完成行标 dropped。
 */
import { createHmac, timingSafeEqual } from 'crypto';

import type { EventBus } from '../../core/events';
import type { Resolver } from '../../core/net';
import { checkOutboundUrl } from '../../core/net';
import { AutomationError, WEBHOOK_ERROR } from '../shared/errors';
import { deliverWebhook, type DeliveryOutcome } from './delivery';
import { buildWebhookPayload, signWebhookBody, stableEventId, WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT_TYPE, type WebhookPayload } from './webhook-events';
import { parseEndpointBody, toEndpointView, type WebhookStore } from './webhook-store';

export const GLOBAL_CONCURRENCY = 4;
export const DISPATCH_TICK_MS = 1_000;
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 300_000;
export const MAX_TEST_EVENTS = 50;
export const MAX_TEST_BODY_BYTES = 128 * 1024;
const RECEIVER_PURPOSE = 'clawopt-webhook-local-test-receiver';

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}

export type WebhookServiceDeps = {
  store: WebhookStore;
  deliver?: typeof deliverWebhook;
  resolver?: Resolver;
  now?: () => number;
  random?: () => number;
  receiverSecret: () => string;
  backendPort: () => number;
};

export type TestReceiverEvent = {
  receivedAt: number;
  eventType: string;
  eventId: string;
  deliveryId: string;
  timestamp: string;
  signatureValid: boolean | null;
  body: unknown;
};

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || /^127\./.test(address) || /^::ffff:127\./.test(address);
}

export function createWebhookService(deps: WebhookServiceDeps) {
  const { store } = deps;
  const deliver = deps.deliver ?? deliverWebhook;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const activeEndpoints = new Set<string>();
  const inflight = new Set<Promise<void>>();
  const testEvents: TestReceiverEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function deliverHead(endpointId: string): Promise<void> {
    const endpoint = store.listEndpoints().find((item) => item.id === endpointId);
    const head = store.head(endpointId);
    if (!endpoint || !head) return;
    store.markDelivering(head.id);
    const attempt = head.attempts + 1;
    let outcome: DeliveryOutcome;
    try {
      outcome = await deliver({
        url: endpoint.url,
        secret: endpoint.secret,
        allowPrivateNetwork: endpoint.allowPrivateNetwork,
        eventType: head.eventType,
        eventId: head.eventId,
        body: head.payloadJson,
        resolver: deps.resolver,
        now,
      });
    } catch (error) {
      outcome = { status: 0, ok: false, retryable: true, error: (error as Error)?.message ?? 'delivery error', deliveryId: '', durationMs: 0 };
    }
    if (outcome.ok) store.markDelivered(head.id, outcome.status);
    else if (outcome.retryable && attempt <= endpoint.maxRetries) store.markRetry(head.id, outcome.status, outcome.error, now() + retryDelayMs(attempt, random));
    else store.markFailed(head.id, outcome.status, outcome.error);
  }

  /** 扫一遍所有端点，能投的队头就投。返回这一轮启动了几个投递。 */
  function drain(): number {
    if (stopped) return 0;
    let started = 0;
    for (const endpoint of store.listEndpoints()) {
      if (!endpoint.enabled || activeEndpoints.has(endpoint.id)) continue;
      if (activeEndpoints.size >= GLOBAL_CONCURRENCY) break;
      const head = store.head(endpoint.id);
      // 队头是 delivering 而本进程并没有在投它：那是上一个进程崩在半路留下的，等 start() 把它放回 pending，
      // 不在这里抢——否则同一进程里的并发派发也可能把同一行投两次。
      if (!head || head.status !== 'pending' || head.nextAttemptAt > now()) continue;
      activeEndpoints.add(endpoint.id);
      started += 1;
      const task = deliverHead(endpoint.id)
        .catch((error) => console.warn('[Webhooks] delivery crashed:', (error as Error)?.message))
        .finally(() => {
          activeEndpoints.delete(endpoint.id);
          inflight.delete(task);
          drain();
        });
      inflight.add(task);
    }
    return started;
  }

  /** 事件 → 每个订阅了它的启用端点各入队一行。 */
  function enqueueEvent(type: string, payload: Record<string, unknown>, publishedAt: number): number {
    let queued = 0;
    for (const endpoint of store.listEndpoints()) {
      if (!endpoint.enabled || !endpoint.eventTypes.includes(type)) continue;
      const body = buildWebhookPayload(type, payload, publishedAt, endpoint.includeContent);
      if (!body) continue;
      if (store.enqueue(endpoint.id, body.id, type, JSON.stringify(body))) queued += 1;
    }
    if (queued) drain();
    return queued;
  }

  async function validateUrl(url: string, allowPrivateNetwork: boolean) {
    const verdict = await checkOutboundUrl(url, { allowPrivateNetwork, resolver: deps.resolver });
    if (!verdict.ok) {
      throw new AutomationError(400, WEBHOOK_ERROR.urlBlocked, verdict.detail, { reason: verdict.reason });
    }
  }

  function receiverToken(): string {
    return createHmac('sha256', deps.receiverSecret()).update(RECEIVER_PURPOSE).digest('base64url');
  }

  return {
    drain,
    enqueueEvent,

    attach(bus: EventBus): () => void {
      return bus.subscribe('webhook-outbox', (event) => {
        enqueueEvent(event.type, (event.payload ?? {}) as Record<string, unknown>, event.publishedAt);
      }, { types: [...WEBHOOK_EVENT_TYPES] });
    },

    start(): void {
      stopped = false;
      const reset = store.resetInFlight();
      if (reset) console.log(`[Webhooks] ${reset} in-flight deliveries re-queued after restart`);
      drain();
      timer = setInterval(() => {
        drain();
        store.pruneFinished(now() - 7 * 24 * 3600 * 1000);
      }, DISPATCH_TICK_MS);
      timer.unref?.();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.allSettled([...inflight]);
    },

    idle: () => Promise.allSettled([...inflight]).then(() => undefined),

    list() {
      return store.listEndpoints().map((endpoint) => ({ ...toEndpointView(endpoint), stats: store.stats(endpoint.id) }));
    },

    async create(body: Record<string, unknown>) {
      const input = parseEndpointBody(body);
      await validateUrl(input.url, input.allowPrivateNetwork);
      return toEndpointView(store.saveEndpoint(input));
    },

    async update(id: string, body: Record<string, unknown>) {
      const current = store.getEndpoint(id);
      const input = parseEndpointBody(body, current);
      await validateUrl(input.url, input.allowPrivateNetwork);
      const saved = toEndpointView(store.saveEndpoint(input, id));
      drain();
      return saved;
    },

    remove(id: string): void {
      store.deleteEndpoint(id);
    },

    deliveries: (id: string) => {
      store.getEndpoint(id);
      return store.recentDeliveries(id).map(({ payloadJson: _payload, ...row }) => row);
    },

    /** 测试发送：绕过队列直接投一次合成事件，把结果原样告诉界面。 */
    async sendTest(id: string) {
      const endpoint = store.getEndpoint(id);
      const occurredAt = now();
      const payload: WebhookPayload = {
        schema_version: 1,
        id: stableEventId(WEBHOOK_TEST_EVENT_TYPE, endpoint.id, String(occurredAt)),
        type: WEBHOOK_TEST_EVENT_TYPE,
        occurred_at: new Date(occurredAt).toISOString(),
        source: 'test',
        subject: { endpoint_id: endpoint.id },
        summary: { status: 'test' },
      };
      return deliver({
        url: endpoint.url, secret: endpoint.secret, allowPrivateNetwork: endpoint.allowPrivateNetwork,
        eventType: payload.type, eventId: payload.id, body: JSON.stringify(payload), resolver: deps.resolver, now,
      });
    },

    localTestTarget() {
      return { url: `http://127.0.0.1:${deps.backendPort()}/api/hooks/webhook-test/${receiverToken()}`, allowPrivateNetwork: true };
    },

    /** 本机测试收件箱：只收回环来源、令牌常数时间比较、体积封顶；签名能对上哪个端点的密钥就标 valid。 */
    receiveTest(input: { token: string; remoteAddress: string | undefined; headers: Record<string, string | undefined>; rawBody: Buffer; body: unknown }): boolean {
      if (!isLoopbackAddress(input.remoteAddress)) return false;
      const expected = Buffer.from(receiverToken());
      const provided = Buffer.from(String(input.token || ''));
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return false;
      if (input.rawBody.length > MAX_TEST_BODY_BYTES) return false;
      const body = input.body as Record<string, unknown> | null;
      const eventType = input.headers['x-clawopt-event'] ?? '';
      const eventId = input.headers['x-clawopt-event-id'] ?? '';
      if (!body || body.schema_version !== 1 || body.type !== eventType || body.id !== eventId) return false;
      const timestamp = input.headers['x-clawopt-timestamp'] ?? '';
      const signature = input.headers['x-clawopt-signature-256'];
      let signatureValid: boolean | null = null;
      if (signature) {
        const target = this.localTestTarget().url;
        const candidates = store.listEndpoints().filter((endpoint) => endpoint.url === target && endpoint.secret);
        signatureValid = candidates.some((endpoint) => signWebhookBody(endpoint.secret!, timestamp, input.rawBody.toString('utf-8')) === signature);
      }
      testEvents.unshift({
        receivedAt: now(), eventType, eventId, deliveryId: input.headers['x-clawopt-delivery'] ?? '', timestamp, signatureValid, body,
      });
      testEvents.length = Math.min(testEvents.length, MAX_TEST_EVENTS);
      return true;
    },

    testEvents: () => [...testEvents],
    clearTestEvents: () => { testEvents.length = 0; },
  };
}

export type WebhookService = ReturnType<typeof createWebhookService>;
