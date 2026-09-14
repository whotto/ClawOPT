import DOMPurify from 'dompurify';
import { getFileCapabilities } from '../../../api/files';

export const TEXT_SELECTION_STYLE = {
  userSelect: 'text' as const,
  WebkitUserSelect: 'text' as const,
  WebkitTouchCallout: 'default' as const,
};

const HTML_PREVIEW_ROUTE_PADDING_SEGMENT = '__claw_preview_root__';
const HTML_PREVIEW_ROUTE_PADDING_DEPTH = 24;
export const DOCUMENT_PREVIEW_WIDTH_CLASS = 'max-w-[1200px]';
export const DOCUMENT_PREVIEW_SCROLL_CLASS = 'w-full h-full overflow-y-auto';
export const DOCUMENT_PREVIEW_SURFACE_CLASS = `w-full ${DOCUMENT_PREVIEW_WIDTH_CLASS} mx-auto bg-white sm:rounded-2xl sm:border border-gray-200`;
export const DOCUMENT_PREVIEW_BODY_CLASS = 'p-6 sm:p-10';

/**
 * 消毒后的 HTML。
 *
 * 原来的做法只删 script/style/meta 等**标签**，属性一个不动——`onerror=`、
 * `onload=`、`href="javascript:"` 全部存活，等于没消毒。而这段 HTML 可能来自
 * 智能体写进工作区的文件，一点预览就在同源执行。
 */
export function sanitizeHtmlFragment(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
    FORBID_ATTR: ['srcdoc', 'formaction', 'ping'],
    ALLOW_DATA_ATTR: false,
  });
}

function extractRenderableDocumentBody(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return '';
  }

  if (!/<(?:!doctype|html|head|body)\b/i.test(trimmed)) {
    return trimmed;
  }

  if (typeof DOMParser === 'undefined') {
    return trimmed;
  }

  try {
    const document = new DOMParser().parseFromString(trimmed, 'text/html');
    document.querySelectorAll('script, noscript, style, meta, link, title, base').forEach((node) => node.remove());
    return document.body?.innerHTML?.trim() || trimmed;
  } catch {
    return trimmed;
  }
}

export function buildRenderedHtmlDocument(content: string): string {
  const normalizedContent = extractRenderableDocumentBody(content);
  return `
    <style>
      .preview-root {
        color: #1f2937;
        line-height: 1.7;
        font-size: 15px;
        user-select: text;
        -webkit-user-select: text;
      }
      .preview-root > :first-child { margin-top: 0 !important; }
      .preview-root > :last-child { margin-bottom: 0 !important; }
      .preview-root h1 { font-size: 24px; font-weight: 800; margin: 24px 0 12px; color: #111827; }
      .preview-root h2 { font-size: 20px; font-weight: 700; margin: 20px 0 10px; color: #1f2937; }
      .preview-root h3 { font-size: 17px; font-weight: 600; margin: 16px 0 8px; color: #374151; }
      .preview-root p { margin: 8px 0; }
      .preview-root ul, .preview-root ol { padding-left: 24px; margin: 8px 0; }
      .preview-root li { margin: 4px 0; }
      .preview-root table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
      .preview-root th, .preview-root td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
      .preview-root th { background: #f9fafb; font-weight: 600; color: #374151; }
      .preview-root tr:nth-child(even) { background: #fafbfc; }
      .preview-root tr:hover { background: #f0f4ff; }
      .preview-root img { max-width: 100%; height: auto; border-radius: 8px; margin: 8px 0; }
      .preview-root a { color: #2563eb; text-decoration: none; }
      .preview-root a:hover { text-decoration: underline; }
      .preview-root blockquote { border-left: 3px solid #d1d5db; padding-left: 16px; margin: 12px 0; color: #6b7280; }
      .preview-root pre, .preview-root code {
        user-select: text;
        -webkit-user-select: text;
      }
    </style>
    <div class="preview-root">${normalizedContent}</div>
  `;
}

export type PreviewState = 
  | { status: 'loading' }
  | { status: 'ready'; type: 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'text' | 'code' | 'epub' | 'unsupported'; content?: string; pdfUrl?: string; pdfData?: Uint8Array; epubData?: ArrayBuffer }
  | { status: 'error'; message: string };

// Cache capabilities result
let cachedCapabilities: { libreoffice: boolean } | null = null;

export function resolvePreviewErrorMessage(
  data: { errorCode?: string; errorParams?: Record<string, string | number | boolean | null> | null; error?: string; message?: string } | null,
  t: (key: string, options?: any) => string,
  fallbackKey: string
): string {
  if (data?.errorCode) {
    const translated = t(data.errorCode, (data.errorParams || {}) as any);
    if (translated !== data.errorCode) {
      return translated;
    }
  }

  if (typeof data?.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }

  if (typeof data?.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }

  return t(fallbackKey);
}

export async function getCapabilities(): Promise<{ libreoffice: boolean }> {
  if (cachedCapabilities) return cachedCapabilities;
  try {
    const res = await getFileCapabilities();
    cachedCapabilities = await res.json();
    return cachedCapabilities!;
  } catch {
    cachedCapabilities = { libreoffice: false };
    return cachedCapabilities;
  }
}

export function getFileType(filename: string): string {
  const cleanName = filename.split(/[?#]/, 1)[0].trim();
  const ext = cleanName.split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'ogg', 'mov', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'm4a', 'aac', 'opus'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx'].includes(ext)) return 'docx';
  if (['xls', 'xlsx'].includes(ext)) return 'xlsx';
  if (ext === 'csv') return 'csv';
  if (['ppt', 'pptx'].includes(ext)) return 'pptx';
  if (ext === 'epub') return 'epub';
  if (['txt', 'md', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf'].includes(ext)) return 'text';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'html', 'css', 'scss', 'less', 'sql', 'sh', 'bash', 'zsh'].includes(ext)) return 'code';
  return 'unknown';
}

export function isLibreOfficeHintRelevant(fileType: string): boolean {
  return ['docx', 'xlsx', 'csv', 'pptx'].includes(fileType);
}

export function getFileExtension(filename: string): string {
  const cleanName = filename.split(/[?#]/, 1)[0].trim();
  return cleanName.split('.').pop()?.toLowerCase() || '';
}

export function getDefaultViewMode(filename: string): 'source' | 'render' {
  const ext = getFileExtension(filename);
  return ['md', 'markdown', 'html', 'htm'].includes(ext) ? 'render' : 'source';
}

function extractPathParam(url: string): string | null {
  try {
    const match = url.match(/[?&]path=([^&]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function buildPreviewUrl(url: string): string {
  const pathParam = extractPathParam(url);
  if (pathParam && url.startsWith('/api/files/download')) {
    return `/api/files/preview?path=${pathParam}&mode=source`;
  }

  if (url.startsWith('/uploads/')) {
    const filenameInUrl = url.split('/').pop();
    if (filenameInUrl) {
      const rawFilename = decodeURIComponent(filenameInUrl);
      return `/api/files/preview?filename=${encodeURIComponent(rawFilename)}&mode=source`;
    }
  }

  return url;
}

export function buildPreviewDataUrl(url: string, mode: 'source' | 'converted' = 'source'): string | null {
  const pathParam = extractPathParam(url);
  if (pathParam && url.startsWith('/api/files/download')) {
    return `/api/files/preview-data?path=${pathParam}&mode=${mode}`;
  }

  if (url.startsWith('/uploads/')) {
    const filenameInUrl = url.split('/').pop();
    if (filenameInUrl) {
      const rawFilename = decodeURIComponent(filenameInUrl);
      return `/api/files/preview-data?filename=${encodeURIComponent(rawFilename)}&mode=${mode}`;
    }
  }

  return null;
}

function encodeBase64ForPathSegment(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Utf8(base64: string): string | null {
  try {
    const normalized = base64.trim();
    const binary = window.atob(normalized);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function buildHtmlPreviewRenderUrl(url: string): string | null {
  const previewPadding = Array.from({ length: HTML_PREVIEW_ROUTE_PADDING_DEPTH }, () => HTML_PREVIEW_ROUTE_PADDING_SEGMENT).join('/');
  const pathParam = extractPathParam(url);

  if (pathParam && url.startsWith('/api/files/download')) {
    const decodedPath = decodeBase64Utf8(decodeURIComponent(pathParam));
    const entryFilename = decodedPath?.split('/').filter(Boolean).pop();
    if (!entryFilename) {
      return null;
    }
    return `/api/files/html-preview/path/${encodeBase64ForPathSegment(decodeURIComponent(pathParam))}/${previewPadding}/${encodeURIComponent(entryFilename)}`;
  }

  if (url.startsWith('/uploads/')) {
    const filenameInUrl = url.split('/').pop();
    if (filenameInUrl) {
      const storedFilename = decodeURIComponent(filenameInUrl);
      const encodedStoredFilename = encodeURIComponent(storedFilename);
      return `/api/files/html-preview/upload/${encodedStoredFilename}/${previewPadding}/${encodedStoredFilename}`;
    }
  }

  return null;
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
  const normalized = base64.trim();
  const binary = window.atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
