/**
 * 出站 Webhook：SSRF 地址策略、钉 IP 投递、签名、不跟随重定向、outbox 按端点保序、重试退避、重启后至少一次、
 * 事件 id 稳定、凭据不回显、事件总线扇出。
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { createHmac } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { EventBus } from '../../src/core/events';
import { checkOutboundUrl, isBlockedIpAddress } from '../../src/core/net';
import { deliverWebhook } from '../../src/automation/webhooks/delivery';
import { buildWebhookPayload, stableEventId, truncateUtf8 } from '../../src/automation/webhooks/webhook-events';
import { createWebhookService, retryDelayMs } from '../../src/automation/webhooks/webhook-service';
import { createWebhookStore } from '../../src/automation/webhooks/webhook-store';
import { memoryDb, waitFor } from './helpers';

type Received = { headers: http.IncomingHttpHeaders; body: string };

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function receiver(respond: (req: Received, index: number) => { status: number; headers?: Record<string, string> } = () => ({ status: 200 })) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const entry = { headers: req.headers, body };
      received.push(entry);
      const reply = respond(entry, received.length - 1);
      res.writeHead(reply.status, reply.headers);
      res.end(reply.status >= 300 ? 'nope' : 'ok');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { received, port: (server.address() as AddressInfo).port };
}

describe('SSRF 地址策略', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2002:c0a8:101::1', '64:ff9b::7f00:1',
  ])('拦截 %s', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111'])('放行公网 %s', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(false);
  });

  it('只允许 http/https；拒绝 userinfo；localhost 字面量拒绝', async () => {
    expect(await checkOutboundUrl('ftp://example.com/x')).toMatchObject({ ok: false, reason: 'protocolNotAllowed' });
    expect(await checkOutboundUrl('file:///etc/passwd')).toMatchObject({ ok: false, reason: 'protocolNotAllowed' });
    expect(await checkOutboundUrl('https://user:pw@example.com/')).toMatchObject({ ok: false, reason: 'userinfoNotAllowed' });
    expect(await checkOutboundUrl('http://localhost:3000/')).toMatchObject({ ok: false, reason: 'privateHostname' });
    expect(await checkOutboundUrl('http://api.localhost/')).toMatchObject({ ok: false, reason: 'privateHostname' });
    expect(await checkOutboundUrl('http://[::1]/')).toMatchObject({ ok: false, reason: 'privateHostname' });
  });

  it('解析出的**任何一条**记录落在内网都拒绝（不只看第一条）', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }, { address: '10.0.0.5', family: 4 as const }];
    expect(await checkOutboundUrl('https://mixed.example/', { resolver })).toMatchObject({ ok: false, reason: 'privateAddress', detail: '10.0.0.5' });
  });

  it('解析到回环的域名（localtest.me 形状）被拒绝', async () => {
    const resolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
    expect(await checkOutboundUrl('http://localtest.me/', { resolver })).toMatchObject({ ok: false, reason: 'privateAddress' });
  });

  it('allowPrivateNetwork 只放宽地址段，不放宽协议', async () => {
    expect(await checkOutboundUrl('http://127.0.0.1:1/', { allowPrivateNetwork: true })).toMatchObject({ ok: true });
    expect(await checkOutboundUrl('gopher://127.0.0.1/', { allowPrivateNetwork: true })).toMatchObject({ ok: false, reason: 'protocolNotAllowed' });
  });
});

describe('单次投递', () => {
  it('签名 = HMAC-SHA256(secret, "<timestamp>.<body>")，并带事件头', async () => {
    const { received, port } = await receiver();
    const body = JSON.stringify({ hello: 'world' });
    const outcome = await deliverWebhook({ url: `http://127.0.0.1:${port}/hook`, secret: 's3cret', allowPrivateNetwork: true, eventType: 'workflow.run.completed', eventId: 'evt1', body });
    expect(outcome).toMatchObject({ ok: true, status: 200 });
    const headers = received[0].headers;
    const expected = createHmac('sha256', 's3cret').update(`${headers['x-clawopt-timestamp']}.${body}`).digest('hex');
    expect(headers['x-clawopt-signature-256']).toBe(`sha256=${expected}`);
    expect(headers['x-clawopt-event']).toBe('workflow.run.completed');
    expect(headers['x-clawopt-event-id']).toBe('evt1');
    expect(headers['x-clawopt-delivery']).toMatch(/^[0-9a-f-]{36}$/);
    expect(received[0].body).toBe(body);
  });

  it('没配私网放行时，指向本机的端点在投递那一刻被拦下，请求根本没发出去', async () => {
    const { received, port } = await receiver();
    const outcome = await deliverWebhook({ url: `http://127.0.0.1:${port}/hook`, secret: null, allowPrivateNetwork: false, eventType: 'x', eventId: 'y', body: '{}' });
    expect(outcome).toMatchObject({ ok: false, retryable: false, blocked: 'privateHostname' });
    expect(received).toHaveLength(0);
  });

  it('钉 IP：连接落在校验过的地址上，Host 头保留原主机名（域名本身在 DNS 里并不存在）', async () => {
    const { received, port } = await receiver();
    const resolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
    const outcome = await deliverWebhook({ url: `http://pinned.invalid:${port}/p`, secret: null, allowPrivateNetwork: true, eventType: 'x', eventId: 'y', body: '{}', resolver });
    expect(outcome.ok).toBe(true);
    expect(received[0].headers.host).toBe(`pinned.invalid:${port}`);
  });

  it('DNS rebinding：校验时解析到内网就拒绝，即使之后会换成公网', async () => {
    let calls = 0;
    const resolver = async () => (calls++ === 0 ? [{ address: '10.0.0.1', family: 4 as const }] : [{ address: '8.8.8.8', family: 4 as const }]);
    const outcome = await deliverWebhook({ url: 'http://rebind.invalid/', secret: null, allowPrivateNetwork: false, eventType: 'x', eventId: 'y', body: '{}', resolver });
    expect(outcome).toMatchObject({ ok: false, blocked: 'privateAddress' });
    expect(calls).toBe(1);
  });

  it('不跟随重定向：302 算失败且不重试', async () => {
    const { received, port } = await receiver(() => ({ status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } }));
    const outcome = await deliverWebhook({ url: `http://127.0.0.1:${port}/r`, secret: null, allowPrivateNetwork: true, eventType: 'x', eventId: 'y', body: '{}' });
    expect(outcome).toMatchObject({ ok: false, status: 302, retryable: false });
    expect(received).toHaveLength(1);
  });

  it('5xx / 429 / 408 / 网络错误可重试；4xx 不重试', async () => {
    const { port } = await receiver((_req, index) => ({ status: [500, 429, 408, 404][index] }));
    const url = `http://127.0.0.1:${port}/x`;
    const send = () => deliverWebhook({ url, secret: null, allowPrivateNetwork: true, eventType: 'x', eventId: 'y', body: '{}' });
    expect((await send()).retryable).toBe(true);
    expect((await send()).retryable).toBe(true);
    expect((await send()).retryable).toBe(true);
    expect((await send()).retryable).toBe(false);
    const refused = await deliverWebhook({ url: 'http://127.0.0.1:1/x', secret: null, allowPrivateNetwork: true, eventType: 'x', eventId: 'y', body: '{}' });
    expect(refused).toMatchObject({ status: 0, retryable: true });
  });
});

describe('事件负载', () => {
  it('事件 id 由内容派生、稳定：同一次运行的同一事件永远同一个 id', () => {
    const payload = { workflowId: 'wf', runId: 'r1', startedAt: 10, status: 'completed' };
    const a = buildWebhookPayload('workflow.run.completed', payload, 1, false)!;
    const b = buildWebhookPayload('workflow.run.completed', payload, 999, false)!;
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(stableEventId('workflow.run.completed', 'wf', 'r1:10'));
    expect(buildWebhookPayload('workflow.run.completed', { ...payload, startedAt: 11 }, 1, false)!.id).not.toBe(a.id);
  });

  it('聊天完成事件只在端点允许时带正文，且按 UTF-8 字节截断', () => {
    const payload = { sessionId: 's', runId: 'r', agentId: 'main', text: '你好' };
    expect(buildWebhookPayload('chat.run.completed', payload, 1, false)!.message).toBeUndefined();
    expect(buildWebhookPayload('chat.run.completed', payload, 1, true)!.message).toEqual({ text: '你好', truncated: false });
    expect(truncateUtf8('你好世界', 7)).toEqual({ text: '你好', truncated: true });
  });
});

describe('outbox', () => {
  function setup(options: { deliver?: any; now?: () => number; random?: () => number } = {}) {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }];
    const db = memoryDb();
    const store = createWebhookStore(db, options.now);
    const service = createWebhookService({ store, resolver, deliver: options.deliver, now: options.now, random: options.random, receiverSecret: () => 'receiver', backendPort: () => 3170 });
    return { db, store, service };
  }

  it('端点列表不回显密钥，只报 hasSecret；空串密钥 = 不修改；clear_secret 才清空', async () => {
    const { service, store } = setup();
    const created = await service.create({ name: 'n', url: 'https://example.com/h', secret: 'topsecret', event_types: ['workflow.run.completed'] , allow_private_network: false });
    expect(JSON.stringify(service.list())).not.toContain('topsecret');
    expect(service.list()[0].hasSecret).toBe(true);
    await service.update(created.id, { secret: '' });
    expect(store.getEndpoint(created.id).secret).toBe('topsecret');
    await service.update(created.id, { clear_secret: true });
    expect(store.getEndpoint(created.id).secret).toBeNull();
  });

  it('创建 / 更新时 URL 过地址策略：内网地址 400', async () => {
    const { service } = setup();
    await expect(service.create({ name: 'n', url: 'http://10.0.0.1/h', event_types: ['workflow.run.completed'] })).rejects.toMatchObject({ status: 400, code: 'webhooks.urlBlocked' });
    await expect(service.create({ name: 'n', url: 'https://x.test/h', event_types: ['nope'] })).rejects.toMatchObject({ status: 400, code: 'webhooks.invalidBody' });
  });

  it('事件总线扇出：只给订阅了该类型的启用端点入队；同一事件重复发布不重复入队', async () => {
    const delivered: string[] = [];
    const { service, store } = setup({ deliver: async (req: any) => { delivered.push(req.eventType); return { ok: true, status: 200, retryable: false, error: null, deliveryId: 'd', durationMs: 1 }; } });
    const a = store.saveEndpoint({ name: 'a', url: 'http://127.0.0.1/a', secret: null, eventTypes: ['workflow.run.completed'], enabled: true, includeContent: false, allowPrivateNetwork: true, maxRetries: 3 });
    store.saveEndpoint({ name: 'b', url: 'http://127.0.0.1/b', secret: null, eventTypes: ['chat.run.completed'], enabled: true, includeContent: false, allowPrivateNetwork: true, maxRetries: 3 });
    store.saveEndpoint({ name: 'c', url: 'http://127.0.0.1/c', secret: null, eventTypes: ['workflow.run.completed'], enabled: false, includeContent: false, allowPrivateNetwork: true, maxRetries: 3 });
    const bus = new EventBus();
    service.attach(bus);
    const payload = { workflowId: 'wf', runId: 'r', startedAt: 1, status: 'completed' };
    bus.publish('workflow.run.completed', payload);
    bus.publish('workflow.run.completed', payload);
    await waitFor(() => delivered.length === 1);
    await service.idle();
    expect(store.stats(a.id)).toMatchObject({ delivered: 1, pending: 0 });
    expect(delivered).toEqual(['workflow.run.completed']);
  });

  it('按端点保序：队头失败重试期间，后面的事件不越过它', async () => {
    let clock = 1_000_000;
    const order: string[] = [];
    let firstAttempts = 0;
    const { service, store } = setup({
      now: () => clock,
      random: () => 0,
      deliver: async (req: any) => {
        const body = JSON.parse(req.body);
        order.push(body.subject.run_id);
        if (body.subject.run_id === 'r1' && firstAttempts++ === 0) return { ok: false, status: 503, retryable: true, error: 'busy', deliveryId: 'd', durationMs: 1 };
        return { ok: true, status: 200, retryable: false, error: null, deliveryId: 'd', durationMs: 1 };
      },
    });
    const endpoint = store.saveEndpoint({ name: 'a', url: 'http://127.0.0.1/a', secret: null, eventTypes: ['workflow.run.completed'], enabled: true, includeContent: false, allowPrivateNetwork: true, maxRetries: 3 });
    service.enqueueEvent('workflow.run.completed', { workflowId: 'wf', runId: 'r1', startedAt: 1 }, clock);
    service.enqueueEvent('workflow.run.completed', { workflowId: 'wf', runId: 'r2', startedAt: 1 }, clock);
    await service.idle();
    expect(order).toEqual(['r1']);
    expect(store.head(endpoint.id)!.lastStatus).toBe(503);
    expect(service.drain()).toBe(0); // 退避未到，队头不动，r2 也不动
    clock += retryDelayMs(1, () => 0);
    service.drain();
    await waitFor(() => order.length === 3);
    await service.idle();
    expect(order).toEqual(['r1', 'r1', 'r2']);
  });

  it('重试次数用完 → failed，队列继续往后走', async () => {
    const clock = { t: 1 };
    const { service, store } = setup({
      now: () => clock.t,
      random: () => 0,
      deliver: async () => ({ ok: false, status: 500, retryable: true, error: 'down', deliveryId: 'd', durationMs: 1 }),
    });
    const endpoint = store.saveEndpoint({ name: 'a', url: 'http://127.0.0.1/a', secret: null, eventTypes: ['workflow.run.failed'], enabled: true, includeContent: false, allowPrivateNetwork: true, maxRetries: 1 });
    service.enqueueEvent('workflow.run.failed', { workflowId: 'wf', runId: 'r1', startedAt: 1 }, 1);
    await service.idle();
    clock.t += 10 * 60 * 1000;
    service.drain();
    await service.idle();
    expect(store.stats(endpoint.id)).toMatchObject({ failed: 1, pending: 0 });
  });

  it('重启后至少一次：投到一半（delivering）的行回到 pending 并被新进程投出', async () => {
    const db = memoryDb();
    const store = createWebhookStore(db);
    const endpoint = store.saveEndpoint({ name: 'a', url: 'http://127.0.0.1/a', secret: null, eventTypes: ['workflow.run.completed'], enabled: true, includeContent: false, allowPrivateNetwork: true, maxRetries: 3 });
    store.enqueue(endpoint.id, 'evt', 'workflow.run.completed', '{"schema_version":1}');
    store.markDelivering(store.head(endpoint.id)!.id); // 进程在这里崩了
    const delivered: string[] = [];
    const restarted = createWebhookService({
      store: createWebhookStore(db),
      deliver: async (req: any) => { delivered.push(req.eventId); return { ok: true, status: 200, retryable: false, error: null, deliveryId: 'd', durationMs: 1 }; },
      receiverSecret: () => 'r',
      backendPort: () => 3170,
    });
    restarted.start();
    await waitFor(() => delivered.length === 1);
    await restarted.stop();
    expect(delivered).toEqual(['evt']);
    expect(store.stats(endpoint.id).delivered).toBe(1);
  });

  it('退避：min(300s, 5s·2^(n−1)) × U[0.5, 1]', () => {
    expect(retryDelayMs(1, () => 0)).toBe(2_500);
    expect(retryDelayMs(1, () => 1)).toBe(5_000);
    expect(retryDelayMs(3, () => 1)).toBe(20_000);
    expect(retryDelayMs(20, () => 1)).toBe(300_000);
  });

  it('删除端点：未完成的行标 dropped，不再投', async () => {
    const { store, service } = setup({ deliver: async () => new Promise(() => undefined) });
    const endpoint = store.saveEndpoint({ name: 'a', url: 'http://127.0.0.1/a', secret: null, eventTypes: ['workflow.run.completed'], enabled: false, includeContent: false, allowPrivateNetwork: true, maxRetries: 3 });
    store.enqueue(endpoint.id, 'e1', 'workflow.run.completed', '{}');
    service.remove(endpoint.id);
    expect(store.stats(endpoint.id)).toMatchObject({ dropped: 1, pending: 0 });
  });

  it('本机测试收件箱：非回环来源、错误令牌、头与体不一致都拒绝；签名能对上端点密钥则标 valid', async () => {
    const { service, store } = setup();
    const target = service.localTestTarget();
    const token = target.url.split('/').pop()!;
    store.saveEndpoint({ name: 'local', url: target.url, secret: 'k', eventTypes: ['workflow.run.completed'], enabled: true, includeContent: false, allowPrivateNetwork: true, maxRetries: 0 });
    const body = { schema_version: 1, id: 'evt', type: 'webhook.test' };
    const raw = Buffer.from(JSON.stringify(body));
    const ts = '1700000000';
    const headers = { 'x-clawopt-event': 'webhook.test', 'x-clawopt-event-id': 'evt', 'x-clawopt-timestamp': ts, 'x-clawopt-signature-256': `sha256=${createHmac('sha256', 'k').update(`${ts}.${raw}`).digest('hex')}` };
    expect(service.receiveTest({ token, remoteAddress: '203.0.113.9', headers, rawBody: raw, body })).toBe(false);
    expect(service.receiveTest({ token: `${token}x`, remoteAddress: '127.0.0.1', headers, rawBody: raw, body })).toBe(false);
    expect(service.receiveTest({ token, remoteAddress: '127.0.0.1', headers: { ...headers, 'x-clawopt-event-id': 'other' }, rawBody: raw, body })).toBe(false);
    expect(service.receiveTest({ token, remoteAddress: '::ffff:127.0.0.1', headers, rawBody: raw, body })).toBe(true);
    expect(service.testEvents()[0]).toMatchObject({ eventId: 'evt', signatureValid: true });
  });
});
