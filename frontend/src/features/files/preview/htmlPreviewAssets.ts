/**
 * HTML 预览里相对路径的图片：沙箱文档不许联网（CSP 只放 data: / blob:），所以由外层页面经鉴权的
 * HTML 预览接口（与入口文件同一道可服务路径闸门 + 数据面授权，子资源不得越出入口目录）先取回来，换成 blob: 地址。
 *
 * 上限：最多 40 张、每张 10 MB、必须是 image/*；超出或失败的只是不显示，数量报给界面。
 */
import { collectRelativeImageSources } from './htmlSandbox';

export const HTML_PREVIEW_MAX_IMAGES = 40;
export const HTML_PREVIEW_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const HTML_PREVIEW_ROUTE_PREFIX = '/api/files/html-preview/';

export type ResolvedHtmlImages = {
  sources: Map<string, string>;
  skipped: number;
  revoke(): void;
};

/** 相对入口地址解析；解析后必须仍在同源的 HTML 预览接口下，否则不取。 */
export function resolveHtmlPreviewAssetUrl(entryUrl: string, relative: string, origin: string): string | null {
  try {
    const resolved = new URL(relative, new URL(entryUrl, origin));
    if (resolved.origin !== origin) return null;
    if (!resolved.pathname.startsWith(HTML_PREVIEW_ROUTE_PREFIX)) return null;
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return null;
  }
}

export async function resolveHtmlPreviewImages(source: string, entryUrl: string | null, options: {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  origin: string;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}): Promise<ResolvedHtmlImages> {
  const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const sources = new Map<string, string>();
  const created: string[] = [];
  const revoke = () => created.splice(0).forEach((url) => revokeObjectUrl(url));
  if (!entryUrl) return { sources, skipped: 0, revoke };

  const candidates = collectRelativeImageSources(source);
  let skipped = Math.max(0, candidates.length - HTML_PREVIEW_MAX_IMAGES);
  for (const relative of candidates.slice(0, HTML_PREVIEW_MAX_IMAGES)) {
    if (options.signal?.aborted) break;
    const url = resolveHtmlPreviewAssetUrl(entryUrl, relative, options.origin);
    if (!url) {
      skipped += 1;
      continue;
    }
    try {
      const response = await options.fetchImpl(url, { signal: options.signal });
      const type = response.headers.get('content-type') || '';
      const declared = Number(response.headers.get('content-length') || '0');
      if (!response.ok || !type.toLowerCase().startsWith('image/') || declared > HTML_PREVIEW_MAX_IMAGE_BYTES) {
        skipped += 1;
        continue;
      }
      const blob = await response.blob();
      if (blob.size > HTML_PREVIEW_MAX_IMAGE_BYTES) {
        skipped += 1;
        continue;
      }
      const objectUrl = createObjectUrl(blob);
      created.push(objectUrl);
      sources.set(relative, objectUrl);
    } catch {
      skipped += 1;
    }
  }
  return { sources, skipped, revoke };
}
