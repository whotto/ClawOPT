/**
 * 服务端按用户给的 URL 出站时的地址策略（SSRF 闸门）。
 *
 * AGENTS.md 的三道检查缺一不可：协议只允许 http/https、**解析后的全部地址**不得落在内网/保留段、
 * 重定向后的最终地址再查一遍。`.clawpack` 远端拉取与出站 Webhook 共用这一份判据——
 * 两处各写一份迟早分家（这个仓库为「判据分家」栽过不止一次）。
 *
 * 出站 Webhook 还要多一道：**连接时钉住校验过的那个 IP**（`pinnedLookup`），
 * 否则校验与连接之间 DNS 换了答案（rebinding），前面的检查全部作废。
 */
import dns from 'dns/promises';
import net from 'net';
import type { LookupFunction } from 'net';

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

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
};

/**
 * 语法 + 协议 + 解析后全部地址。任何一个解析结果落在内网都拒绝（只查首个挡不住多记录混放）。
 * `allowPrivateNetwork` 只放宽地址段判定，协议与 userinfo 的检查照旧。
 */
export async function checkOutboundUrl(
  rawUrl: string,
  options: { allowPrivateNetwork?: boolean; resolver?: Resolver } = {},
): Promise<AddressVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalidUrl', detail: String(rawUrl).slice(0, 200) };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
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
