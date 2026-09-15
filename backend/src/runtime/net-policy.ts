/**
 * 运行时平面的出站地址策略：代理上游、远程 OpenClaw 网关、MCP HTTP 探测共用一份判据。
 *
 * AGENTS.md 的三道检查：协议白名单、**解析后的地址**不落内网段（只查字面量挡不住 `localtest.me`）、
 * 重定向后的地址再查（代理对上游一律 `redirect: 'manual'`，3xx 直接当错误，不跟）。
 *
 * 内网段放行只有两个口子，且都要显式：
 * - 模型代理：服务商被标成本地（ollama / lmstudio / llamacpp / vllm / localai，或 `local:` 前缀）；
 * - 远程 OpenClaw 成员：成员配置里打开「受信任的局域网」。
 *
 * 已知残余：解析与真正建连之间有 TOCTOU 窗口（DNS rebinding）。建连不钉 IP，
 * 因为全局 fetch 钉 IP 要引入 undici 依赖；风险记在 P2-platform 报告里。
 * 198.18.0.0/15（基准测试段）**不拦**：本机代理的 fake-IP 把公网域名解析到这一段，拦了就连不上任何真实服务商。
 */
import dns from 'dns';
import net from 'net';

export class NetPolicyError extends Error {
  constructor(readonly errorCode: string, message: string) {
    super(message);
    this.name = 'NetPolicyError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateAddress(address: string): boolean {
  let ip = address.trim().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) {
    const value = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd]/.test(lower)) return true;       // fc00::/7 唯一本地
    if (/^fe[89ab]/.test(lower)) return true;    // fe80::/10 链路本地
    if (/^ff/.test(lower)) return true;          // 组播
    return false;
  }
  return true; // 认不出的地址按内网处理
}

export type Lookup = (hostname: string) => Promise<string[]>;

export const systemLookup: Lookup = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

export async function assertOutboundUrlAllowed(
  rawUrl: string,
  options: { protocols: readonly string[]; allowPrivate: boolean; lookup?: Lookup },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetPolicyError('net.invalidUrl', 'URL is not valid');
  }
  if (!options.protocols.includes(url.protocol)) {
    throw new NetPolicyError('net.protocolNotAllowed', `Protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new NetPolicyError('net.credentialsInUrl', 'Credentials in URL are not allowed');
  }
  if (options.allowPrivate) return url;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new NetPolicyError('net.invalidUrl', 'URL has no host');
  if (hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost')) {
    throw new NetPolicyError('net.privateAddressBlocked', 'Private or loopback addresses are not allowed');
  }
  const addresses = net.isIP(hostname) ? [hostname] : await (options.lookup ?? systemLookup)(hostname).catch(() => {
    throw new NetPolicyError('net.dnsFailed', 'Host name could not be resolved');
  });
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new NetPolicyError('net.privateAddressBlocked', 'Private or loopback addresses are not allowed');
  }
  return url;
}

const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'vllm', 'localai', 'local']);

/** 服务商是否显式标成本地（允许上游在回环 / 内网上）。 */
export function isLocalProvider(provider: string): boolean {
  const id = provider.trim().toLowerCase();
  return LOCAL_PROVIDER_IDS.has(id) || id.startsWith('local:');
}
