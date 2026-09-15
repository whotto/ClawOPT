/**
 * 唯一的出站地址策略（`core/net`）：四个调用方——出站 Webhook、`.clawpack` 远端拉取、本地模型代理上游、
 * 远程 OpenClaw 网关——共用同一份判据与同一种 IP 钉住。
 *
 * - 抛异常风格（代理 / 远程网关）的错误码、协议白名单（ws/wss）、「允许内网」开关；
 * - 本地模型服务商判据；
 * - `pinnedFetch`：连接落在校验过的地址上（域名本身根本解析不了也能连到），不跟重定向；
 * - 代理缺省走 `pinnedFetch`（不注入 fetchImpl 时真的钉住）；
 * - `.clawpack` 逐跳过策略：公网 302 到内网被拦，而且拦在连接之前。
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertOutboundUrl, checkOutboundUrl, isBlockedIpAddress, isLocalModelProvider, pinnedFetch, type Resolver } from '../src/core/net';
import { fetchRemotePack } from '../src/control/packs/pack-service';
import { PACK_URL_BLOCKED_ERROR_CODE } from '../src/core/http';
import { LocalProviderProxy } from '../src/runtime';
import { validateRemoteGatewayUrl } from '../src/runtime/remote-openclaw';

const resolveTo = (address: string): Resolver => async () => [{ address, family: address.includes(':') ? 6 : 4 }];

let server: http.Server;
let port = 0;
const seen: Array<{ url: string; host: string | undefined }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', host: req.headers.host });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1/secret' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('出站地址策略（core/net）', () => {
  it.each([
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.20.0.1', true], ['192.168.1.1', true], ['169.254.169.254', true],
    ['100.64.0.1', true], ['198.18.0.5', true], ['::1', true], ['fd00::1', true], ['fe80::1', true], ['::ffff:127.0.0.1', true],
    ['93.184.216.34', false], ['2606:4700::1111', false],
  ])('%s 拦=%s', (address, expected) => {
    expect(isBlockedIpAddress(address)).toBe(expected);
  });

  it('抛异常版：解析后的地址才算数，错误码是 net.*；协议白名单可换成 ws/wss；允许内网只放宽地址段', async () => {
    await expect(assertOutboundUrl('https://localtest.me/v1', { resolver: resolveTo('127.0.0.1') })).rejects.toMatchObject({ errorCode: 'net.privateAddressBlocked' });
    await expect(assertOutboundUrl('https://ok.test/v1', { resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] })).rejects.toMatchObject({ errorCode: 'net.privateAddressBlocked' });
    await expect(assertOutboundUrl('ftp://ok.test', { allowPrivateNetwork: true })).rejects.toMatchObject({ errorCode: 'net.protocolNotAllowed' });
    await expect(assertOutboundUrl('https://user:pw@ok.test', { allowPrivateNetwork: true })).rejects.toMatchObject({ errorCode: 'net.credentialsInUrl' });
    await expect(assertOutboundUrl('https://ok.test', { resolver: async () => { throw new Error('nx'); } })).rejects.toMatchObject({ errorCode: 'net.dnsFailed' });
    await expect(assertOutboundUrl('ws://gw.example', { resolver: resolveTo('93.184.216.34') })).rejects.toMatchObject({ errorCode: 'net.protocolNotAllowed' });
    expect(await checkOutboundUrl('wss://gw.example', { protocols: ['ws:', 'wss:'], resolver: resolveTo('93.184.216.34') })).toMatchObject({ ok: true });
    expect((await assertOutboundUrl('http://127.0.0.1:11434/v1', { allowPrivateNetwork: true })).address).toEqual({ address: '127.0.0.1', family: 4 });
  });

  it('本地模型服务商判据是显式的', () => {
    expect(isLocalModelProvider('ollama')).toBe(true);
    expect(isLocalModelProvider('vllm')).toBe(true);
    expect(isLocalModelProvider('local:my-vllm')).toBe(true);
    expect(isLocalModelProvider('openai')).toBe(false);
    expect(isLocalModelProvider('ollama-cloud')).toBe(false);
  });

  it('远程 OpenClaw 网关用同一份策略：http 拦、内网要打开受信任局域网，回的 lookup 钉住校验过的地址', async () => {
    await expect(validateRemoteGatewayUrl({ gatewayUrl: 'http://gw.lan:18789', trustedLan: true }, resolveTo('192.168.1.20'))).rejects.toMatchObject({ messageCode: 'remoteOpenclaw.urlBlocked' });
    await expect(validateRemoteGatewayUrl({ gatewayUrl: 'ws://gw.lan:18789', trustedLan: false }, resolveTo('192.168.1.20'))).rejects.toMatchObject({ messageCode: 'remoteOpenclaw.privateAddressNeedsTrustedLan' });
    const { lookup } = await validateRemoteGatewayUrl({ gatewayUrl: 'ws://gw.lan:18789', trustedLan: true }, resolveTo('192.168.1.20'));
    const answer = await new Promise<string>((resolve) => (lookup as any)('gw.lan', {}, (_e: unknown, address: string) => resolve(address)));
    expect(answer).toBe('192.168.1.20');
  });
});

describe('钉住 IP', () => {
  it('pinnedFetch 连到钉住的地址（域名本身解析不了），Host 头仍是原主机名，3xx 原样交回不跟', async () => {
    const url = new URL(`http://no-such-host.invalid:${port}/hello?x=1`);
    const response = await pinnedFetch(url, { address: '127.0.0.1', family: 4 }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: '/hello?x=1' });
    expect(seen.at(-1)?.host).toBe(`no-such-host.invalid:${port}`);

    const redirect = await pinnedFetch(new URL(`http://no-such-host.invalid:${port}/redirect`), { address: '127.0.0.1', family: 4 });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('http://127.0.0.1/secret');
  });

  it('本地模型代理不注入 fetchImpl 时经 pinnedFetch 连上游：解析器给的地址就是连接落点', async () => {
    const proxy = new LocalProviderProxy({ publicBaseUrl: () => 'http://127.0.0.1:9', resolver: resolveTo('127.0.0.1'), log: () => {} });
    const entry = (proxy as any).entries as Map<string, any>;
    const registered = proxy.register({ provider: 'vllm', model: 'm', baseUrl: `http://pinned-upstream.invalid:${port}/v1`, apiKey: 'k', apiMode: 'chat_completions', runtime: 'codex', runId: 'r', sessionId: 's' });
    const before = seen.length;
    const response: Response = await (proxy as any).callUpstream(entry.get(registered.routeKey), { model: 'm', messages: [] }, false, new AbortController().signal);
    expect(response.status).toBe(200);
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)?.host).toBe(`pinned-upstream.invalid:${port}`);
    // 服务商不是本地的：同一个回环落点被策略拦下，根本不连。
    const remote = proxy.register({ provider: 'openai', model: 'm', baseUrl: `http://pinned-upstream.invalid:${port}/v1`, apiKey: 'k', apiMode: 'chat_completions', runtime: 'codex', runId: 'r2', sessionId: 's2' });
    await expect((proxy as any).callUpstream(entry.get(remote.routeKey), {}, false, new AbortController().signal)).rejects.toMatchObject({ errorCode: 'net.privateAddressBlocked' });
    expect(seen.length).toBe(before + 1);
  });
});

describe('.clawpack 远端拉取逐跳过策略', () => {
  it('公网 302 到内网：第二跳在连接之前被拦；每一跳拿到的 lookup 钉住的是那一跳校验过的地址', async () => {
    const hops: Array<{ url: string; pinned: string }> = [];
    const resolver: Resolver = async (hostname) => [{ address: hostname === 'internal.example' ? '10.0.0.5' : '93.184.216.34', family: 4 }];
    const fetchHop = async (url: URL, lookup: any) => {
      const pinned = await new Promise<string>((resolve) => lookup(url.hostname, {}, (_e: unknown, address: string) => resolve(address)));
      hops.push({ url: url.toString(), pinned });
      return url.hostname === 'gist.example'
        ? { status: 302, location: 'http://internal.example/pack', data: Buffer.alloc(0) }
        : { status: 200, data: Buffer.from('never') };
    };
    await expect(fetchRemotePack('https://gist.example/raw/x', { resolver, fetchHop })).rejects.toMatchObject({ code: PACK_URL_BLOCKED_ERROR_CODE });
    expect(hops).toEqual([{ url: 'https://gist.example/raw/x', pinned: '93.184.216.34' }]);

    await expect(fetchRemotePack('http://localtest.me/pack', { resolver: resolveTo('127.0.0.1'), fetchHop })).rejects.toMatchObject({ code: PACK_URL_BLOCKED_ERROR_CODE });
    expect(hops).toHaveLength(1);

    const ok = await fetchRemotePack('https://cdn.example/pack', { resolver, fetchHop: async () => ({ status: 200, data: Buffer.from('pack-bytes') }) });
    expect(ok.toString()).toBe('pack-bytes');
  });
});
