/**
 * 语音用例共用：本机假上游（记下每个请求的方法、路径、头与原始请求体，按路由回脚本化的响应）。
 */
import http from 'http';
import type { AddressInfo } from 'net';

export type CapturedRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
export type FakeReply = { status?: number; headers?: Record<string, string>; body?: Buffer | string | object };

export async function startFakeUpstream(route: (request: CapturedRequest) => FakeReply) {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const captured = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(captured);
      const reply = route(captured);
      const body = reply.body === undefined ? '' : Buffer.isBuffer(reply.body) || typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, { 'content-type': typeof reply.body === 'object' && !Buffer.isBuffer(reply.body) ? 'application/json' : 'application/octet-stream', ...(reply.headers ?? {}) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** multipart 请求体里的普通字段与文件（够测试用的朴素解析）。 */
export function parseMultipart(body: Buffer, contentType: string | undefined): { fields: Record<string, string>; files: Record<string, { filename: string; contentType: string; data: Buffer }> } {
  const boundary = /boundary=(.+)$/.exec(contentType ?? '')?.[1];
  if (!boundary) throw new Error('no boundary');
  const fields: Record<string, string> = {};
  const files: Record<string, { filename: string; contentType: string; data: Buffer }> = {};
  const text = body.toString('latin1');
  for (const part of text.split(`--${boundary}`)) {
    if (!part.trim() || part.startsWith('--')) continue;
    const [rawHead, ...rest] = part.replace(/^\r\n/, '').split('\r\n\r\n');
    const content = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    const name = /name="([^"]+)"/.exec(rawHead)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]+)"/.exec(rawHead)?.[1];
    if (filename) {
      files[name] = { filename, contentType: /Content-Type: (.+)/i.exec(rawHead)?.[1]?.trim() ?? '', data: Buffer.from(content, 'latin1') };
    } else {
      fields[name] = Buffer.from(content, 'latin1').toString('utf-8');
    }
  }
  return { fields, files };
}
