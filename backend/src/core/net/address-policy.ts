/**
 * 服务端按用户 / 配置给的 URL 出站时的地址策略（SSRF 闸门）。**全仓库只有这一份判据。**
 *
 * AGENTS.md 的三道检查缺一不可：协议白名单（缺省 http/https）、**解析后的全部地址**不得落在内网/保留段、
 * 重定向后的最终地址再查一遍（或干脆不跟）。调用方：
 * - 出站 Webhook（`automation/webhooks`）：端点可显式「允许内网」；
 * - `.clawpack` 远端拉取（`control/packs`）：只收公网，逐跳查重定向；
 * - 本地模型代理的上游（`runtime/proxy`）：服务商显式标成本地（`isLocalModelProvider`）才放行内网；
 * - 远程 OpenClaw 网关（`runtime/remote-openclaw`）：只收 ws/wss，打开「受信任的局域网」才放行内网。
 * 放宽只有 `allowPrivateNetwork` 一个口子，由调用方按上面各自的显式开关给；协议与 userinfo 的检查照旧。
 *
 * 校验之后还要**连接时钉住校验过的那个 IP**（`pinnedLookup` / `pinnedFetch`），
 * 否则校验与连接之间 DNS 换了答案（rebinding），前面的检查全部作废。
 *
 * 198.18.0.0/15（基准测试段）按保留段拦：开了 fake-IP 代理的开发机会把公网域名解析到这一段，
 * 在那种机器上真实公网地址会被拒——宁可在开发机上失败，也不在 fake-IP 代理替我们远端解析 `localtest.me` 时漏过回环。
 */
import dns from 'dns/promises';
import http from 'http';
import https from 'https';
import net from 'net';
import type { LookupFunction } from 'net';
import { Readable } from 'stream';

export type AddressVerdict =
  | { ok: true; url: URL; addresses: ResolvedAddress[] }
  | { ok: false; reason: UrlBlockReason; detail: string };

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type UrlBlockReason =
  | 'invalidUrl'
  | 'protocolNotAllowed'
  | 'userinfoNotAllowed'
  | 'privateHostname'
  | 'privateAddress'
  | 'unresolvable';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
}

const IPV4_BLOCKED_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return IPV4_BLOCKED_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
  });
}

/** 把 IPv6 文本展开成 8 组 16 进制数。内嵌 IPv4 尾巴（::ffff:1.2.3.4）一并换算。 */
function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4Tail) {
    const value = ipv4ToInt(v4Tail[1]);
    text = `${text.slice(0, -v4Tail[1].length)}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isBlockedIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true; // 认不出的地址按不可达处理：朝安全的方向失败
  const allZeroPrefix = g.slice(0, 6).every((x) => x === 0);
  if (allZeroPrefix && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: 与 ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    // IPv4-mapped：按内嵌的 IPv4 判
    return isBlockedIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (allZeroPrefix) return true; // IPv4-compatible（已废弃）
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地（已废弃）
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 文档段
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF 协议分配（含 Teredo 2001::/32）
  if (g[0] === 0x2002) return true; // 6to4，可内嵌任意 IPv4
  if (g[0] === 0x0064 && g[1] === 0xff9b) return true; // NAT64，可内嵌任意 IPv4
  return false;
}

/** 字面量 IP 是否落在内网 / 回环 / 保留段。不是 IP 的文本返回 false（交给主机名判据）。 */
export function isBlockedIpAddress(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (family === 4) return isBlockedIpv4(host);
  if (family === 6) return isBlockedIpv6(host);
  return false;
}

/** 字面量层面就能判定的内网主机名。 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || isBlockedIpAddress(host);
}

const DEFAULT_PROTOCOLS: readonly string[] = ['http:', 'https:'];

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
};

export type OutboundUrlOptions = {
  /** 缺省 `['http:', 'https:']`；远程 OpenClaw 网关用 `['ws:', 'wss:']`。 */
  protocols?: readonly string[];
  allowPrivateNetwork?: boolean;
  resolver?: Resolver;
};

/**
 * 语法 + 协议 + 解析后全部地址。任何一个解析结果落在内网都拒绝（只查首个挡不住多记录混放）。
 * `allowPrivateNetwork` 只放宽地址段判定，协议与 userinfo 的检查照旧。
 */
export async function checkOutboundUrl(
  rawUrl: string,
  options: OutboundUrlOptions = {},
): Promise<AddressVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalidUrl', detail: String(rawUrl).slice(0, 200) };
  }
  if (!(options.protocols ?? DEFAULT_PROTOCOLS).includes(url.protocol)) {
    return { ok: false, reason: 'protocolNotAllowed', detail: url.protocol };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'userinfoNotAllowed', detail: url.hostname };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const allowPrivate = options.allowPrivateNetwork === true;
  if (!allowPrivate && isPrivateHostname(hostname)) {
    return { ok: false, reason: 'privateHostname', detail: hostname };
  }
  if (net.isIP(hostname)) {
    return { ok: true, url, addresses: [{ address: hostname, family: net.isIP(hostname) === 6 ? 6 : 4 }] };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await (options.resolver ?? systemResolver)(hostname);
  } catch {
    return { ok: false, reason: 'unresolvable', detail: hostname };
  }
  if (!addresses.length) return { ok: false, reason: 'unresolvable', detail: hostname };
  if (!allowPrivate) {
    const blocked = addresses.find((record) => isBlockedIpAddress(record.address));
    if (blocked) return { ok: false, reason: 'privateAddress', detail: blocked.address };
  }
  return { ok: true, url, addresses };
}

/**
 * 给 `http.request({ lookup })` 用的查找函数：永远只回校验过的那个地址。
 * 主机名照常进 Host 头与 TLS SNI，连接却落在钉住的 IP 上——DNS rebinding 无从下手。
 */
export function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return ((_hostname: string, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const wantsAll = typeof options === 'object' && options?.all === true;
    if (wantsAll) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  }) as LookupFunction;
}

/** 结构化错误码（`net.*`），给抛异常风格的调用方（代理、远程网关）用。 */
export const OUTBOUND_URL_ERROR_CODES: Record<UrlBlockReason, string> = {
  invalidUrl: 'net.invalidUrl',
  protocolNotAllowed: 'net.protocolNotAllowed',
  userinfoNotAllowed: 'net.credentialsInUrl',
  privateHostname: 'net.privateAddressBlocked',
  privateAddress: 'net.privateAddressBlocked',
  unresolvable: 'net.dnsFailed',
};

export class OutboundUrlError extends Error {
  readonly errorCode: string;
  constructor(readonly reason: UrlBlockReason, readonly detail: string) {
    super(`Outbound URL rejected (${reason})`);
    this.name = 'OutboundUrlError';
    this.errorCode = OUTBOUND_URL_ERROR_CODES[reason];
  }
}

/** `checkOutboundUrl` 的抛异常版：通过时回 URL 与要钉住的地址（第一条解析记录）。 */
export async function assertOutboundUrl(rawUrl: string, options: OutboundUrlOptions = {}): Promise<{ url: URL; address: ResolvedAddress; addresses: ResolvedAddress[] }> {
  const verdict = await checkOutboundUrl(rawUrl, options);
  if (!verdict.ok) throw new OutboundUrlError(verdict.reason, verdict.detail);
  return { url: verdict.url, address: verdict.addresses[0], addresses: verdict.addresses };
}

const LOCAL_MODEL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'vllm', 'localai', 'local']);

/** 模型服务商是否显式标成本地（本地模型代理据此给上游放行内网）。 */
export function isLocalModelProvider(provider: string): boolean {
  const id = provider.trim().toLowerCase();
  return LOCAL_MODEL_PROVIDER_IDS.has(id) || id.startsWith('local:');
}

/**
 * 钉住 IP 的 fetch：连接落在校验过的地址上（Host 头与 TLS SNI 仍是原主机名），**从不跟随重定向**
 * （3xx 原样交回调用方）。回的是标准 `Response`，响应体按流读。
 */
export function pinnedFetch(
  url: URL,
  address: ResolvedAddress,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const transport = url.protocol === 'https:' ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      return;
    }
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body));
    const req = transport.request({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers,
      lookup: pinnedLookup(address),
      ...(url.protocol === 'https:' ? { servername: hostname } : {}),
    }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
        else if (value !== undefined) responseHeaders.set(key, String(value));
      }
      const status = res.statusCode ?? 502;
      const nullBody = status === 204 || status === 304 || (init.method ?? 'GET').toUpperCase() === 'HEAD';
      if (nullBody) res.resume();
      resolve(new Response(nullBody ? null : Readable.toWeb(res) as unknown as ReadableStream, { status, statusText: res.statusMessage, headers: responseHeaders }));
    });
    const onAbort = () => {
      req.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (error) => reject(error));
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
