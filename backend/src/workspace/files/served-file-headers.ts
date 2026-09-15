/**
 * 按路径出文件的响应头（spec 01 §2.23）。所有出文件的入口共用这一处，不各写各的：
 *
 * - `X-Content-Type-Options: nosniff`：浏览器不许把一个 `.txt` / 无扩展名文件「嗅探」成 HTML 执行；
 * - `Cache-Control`：预览与下载接口 `no-store`（内容受数据面授权保护，不该留在任何缓存里）；
 *   `/uploads`、`/openclaw` 这两个被聊天气泡直接引用的出口用 `private, no-cache`（每次回源校验，但不进共享缓存）；
 * - `Content-Disposition`：ASCII 兜底的 `filename="…"` + RFC 5987 的 `filename*=UTF-8''…`，
 *   文件名里的引号、反斜杠、控制字符与非 ASCII 字符不会拆坏头部；
 * - 会执行的类型（HTML / SVG / XML 等）额外带 `Content-Security-Policy: sandbox …`：
 *   有人直接在浏览器里打开这个地址时，文档是不透明源、不执行脚本、不联网，偷不到 ClawOPT 的同源会话。
 *   这些文件是 Agent 写进工作区的产物，同源直出 = 存储型 XSS。
 */
import type express from 'express';
import path from 'path';

export const ACTIVE_CONTENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.xhtml', '.xht', '.shtml', '.svg', '.svgz', '.xml', '.xsl', '.xslt', '.mht', '.mhtml',
]);

export const ACTIVE_CONTENT_CSP = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:";

export type ServedFileCachePolicy = 'no-store' | 'revalidate';

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildContentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'download';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

export function isActiveContentFile(filename: string): boolean {
  return ACTIVE_CONTENT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function applyServedFileHeaders(res: express.Response, options: {
  filename: string;
  cache: ServedFileCachePolicy;
  disposition?: 'inline' | 'attachment';
}): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', options.cache === 'no-store' ? 'no-store' : 'private, no-cache');
  if (options.disposition) res.setHeader('Content-Disposition', buildContentDisposition(options.disposition, options.filename));
  if (isActiveContentFile(options.filename)) res.setHeader('Content-Security-Policy', ACTIVE_CONTENT_CSP);
}

/** JSON 形态的预览数据（base64 正文）：同样不缓存、不嗅探。 */
export function applyPreviewDataHeaders(res: express.Response): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}
