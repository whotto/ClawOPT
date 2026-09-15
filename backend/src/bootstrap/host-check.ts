import type { IncomingHttpHeaders } from 'http';
import net from 'net';

/**
 * 反向代理下的 Host 白名单。HTTP 中间件与 WebSocket 升级共用这一处判据——
 * 只挡 HTTP 不挡升级，等于把实时通道留给了任意 Host 头。
 */
export function requestHostName(headers: IncomingHttpHeaders): string {
  const reqHost = (headers['x-forwarded-host'] || headers.host || '') as string;
  return reqHost.split(':')[0]; // get hostname without port
}

export function isRequestHostAllowed(headers: IncomingHttpHeaders, allowedHosts: string[] | undefined): boolean {
  const hostName = requestHostName(headers);
  // Allow local connections and pure IPs
  if (!hostName || hostName === 'localhost' || hostName === '127.0.0.1' || net.isIP(hostName)) {
    return true;
  }
  return (allowedHosts || []).includes(hostName);
}
