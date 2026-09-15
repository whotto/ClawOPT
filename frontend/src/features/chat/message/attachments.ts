import { normalizeNavigableHref } from './links';
import { maskFencedBlocks } from './markdownContent';

const HTML_PREVIEW_ROUTE_PADDING_SEGMENT = '__claw_preview_root__';
const HTML_PREVIEW_ROUTE_PADDING_DEPTH = 24;
const EMBED_PREVIEW_HEIGHT_SCALE = 0.5;
const DEFAULT_EMBED_PREVIEW_HEIGHT = 210;

export interface Attachment {
  name: string;
  url: string;
  isImage: boolean;
  localPath?: string;
}

export type EmbedPreview = {
  url: string;
  title: string;
  height: number;
};

export function isPreviewableFileLink(url: string): boolean {
  return url.startsWith('/uploads/') || url.startsWith('/api/files/');
}

export function isHtmlAttachmentFile(name?: string, url?: string): boolean {
  const candidates = [name, url]
    .map((value) => {
      const normalized = (value || '').trim();
      if (!normalized) return '';
      try {
        return decodeURIComponent(normalized);
      } catch {
        return normalized;
      }
    })
    .filter(Boolean);

  return candidates.some((value) => {
    const pathPart = value.split(/[?#]/)[0] || '';
    return /\.(?:html?|xhtml)$/i.test(pathPart);
  });
}

export function downloadAttachmentFile(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function extractDownloadPathParam(url: string): string | null {
  try {
    const match = url.match(/[?&]path=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function encodeBase64ForPathSegment(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildHtmlAttachmentOpenUrl(url: string): string | null {
  const previewPadding = Array.from({ length: HTML_PREVIEW_ROUTE_PADDING_DEPTH }, () => HTML_PREVIEW_ROUTE_PADDING_SEGMENT).join('/');
  const pathParam = extractDownloadPathParam(url);

  if (pathParam && url.startsWith('/api/files/download')) {
    const decodedPath = decodeBase64Utf8(pathParam);
    const entryFilename = decodedPath?.split('/').filter(Boolean).pop();
    if (!entryFilename) {
      return null;
    }
    return `/api/files/html-preview/path/${encodeBase64ForPathSegment(pathParam)}/${previewPadding}/${encodeURIComponent(entryFilename)}`;
  }

  if (url.startsWith('/uploads/')) {
    const filenameInUrl = url.split('/').pop();
    if (!filenameInUrl) {
      return null;
    }
    const storedFilename = decodeURIComponent(filenameInUrl);
    const encodedStoredFilename = encodeURIComponent(storedFilename);
    return `/api/files/html-preview/upload/${encodedStoredFilename}/${previewPadding}/${encodedStoredFilename}`;
  }

  return null;
}

export function openAttachmentFileInNewTab(url: string) {
  window.open(buildHtmlAttachmentOpenUrl(url) || url, '_blank', 'noopener,noreferrer');
}

function parseEmbedAttributes(rawAttributes: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(rawAttributes)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }

  return attrs;
}

function normalizeEmbedUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return trimmed;
  return normalizeNavigableHref(trimmed) || '';
}

export function parseStandaloneEmbedPreviews(text: string): EmbedPreview[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const embedRegex = /\[embed\s+([\s\S]*?)\/?\]/gi;
  const embeds: EmbedPreview[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = embedRegex.exec(normalized)) !== null) {
    if (normalized.slice(cursor, match.index).trim()) {
      return [];
    }

    const attrs = parseEmbedAttributes(match[1] || '');
    const url = normalizeEmbedUrl(attrs.url || attrs.src || '');
    if (!url) return [];

    const requestedHeight = Number.parseInt(attrs.height || '', 10);
    const height = Number.isFinite(requestedHeight)
      ? Math.max(160, Math.min(Math.round(requestedHeight * EMBED_PREVIEW_HEIGHT_SCALE), 420))
      : DEFAULT_EMBED_PREVIEW_HEIGHT;
    embeds.push({
      url,
      title: (attrs.title || attrs.name || url).trim(),
      height,
    });
    cursor = match.index + match[0].length;
  }

  if (embeds.length === 0 || normalized.slice(cursor).trim()) {
    return [];
  }

  return embeds;
}

function decodeBase64Utf8(value: string): string | null {
  try {
    const binary = globalThis.atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function encodeBase64Utf8(value: string): string | null {
  try {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return globalThis.btoa(binary);
  } catch {
    return null;
  }
}

function extractAbsolutePathFromDownloadUrl(url: string): string | null {
  if (!url.startsWith('/api/files/download?')) return null;

  try {
    const query = url.split('?')[1] || '';
    const pathParam = new URLSearchParams(query).get('path');
    if (!pathParam) return null;
    return decodeBase64Utf8(pathParam);
  } catch {
    return null;
  }
}

export function extractSingleLocalPath(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const standaloneLinks = extractStandaloneFileLinks(trimmed);
  if (standaloneLinks.length === 1) {
    return extractAbsolutePathFromDownloadUrl(standaloneLinks[0].url);
  }

  const directDownloadUrlMatch = trimmed.match(/^\/api\/files\/download\?[^)\s]+$/);
  if (directDownloadUrlMatch) {
    return extractAbsolutePathFromDownloadUrl(directDownloadUrlMatch[0]);
  }

  const inlineDownloadUrlMatch = trimmed.match(/\/api\/files\/download\?[^)\s]+/);
  if (inlineDownloadUrlMatch) {
    const decodedPath = extractAbsolutePathFromDownloadUrl(inlineDownloadUrlMatch[0]);
    if (decodedPath && !trimmed.replace(inlineDownloadUrlMatch[0], '').trim()) {
      return decodedPath;
    }
  }

  if (!trimmed.includes('\n') && trimmed.startsWith('/')) {
    return trimmed;
  }

  return null;
}

function getFilenameFromLocalPath(localPath: string): string {
  const segments = localPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || localPath;
}

function isPreviewableImagePath(localPath: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(localPath);
}

function isLikelyFilePath(localPath: string): boolean {
  const filename = getFilenameFromLocalPath(localPath);
  return /\.[^./\s]+$/u.test(filename);
}

export function buildDownloadUrlFromLocalPath(localPath: string): string | null {
  const encodedPath = encodeBase64Utf8(localPath);
  if (!encodedPath) return null;
  return `/api/files/download?path=${encodeURIComponent(encodedPath)}`;
}

export function buildFileAttachmentFromPath(codeText: string, localPath: string): Attachment | null {
  if (!isLikelyFilePath(localPath)) return null;

  const standaloneLinks = extractStandaloneFileLinks(codeText.trim());
  if (standaloneLinks.length === 1) {
    return {
      ...standaloneLinks[0],
      isImage: standaloneLinks[0].isImage || isPreviewableImagePath(localPath),
      name: standaloneLinks[0].name || getFilenameFromLocalPath(localPath),
      localPath,
    };
  }

  const url = buildDownloadUrlFromLocalPath(localPath);
  if (!url) return null;

  return {
    name: getFilenameFromLocalPath(localPath),
    url,
    isImage: isPreviewableImagePath(localPath),
    localPath,
  };
}

export function extractStandaloneFileLinks(content: string): Attachment[] {
  const attachments: Attachment[] = [];
  const linkRegex = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(content)) !== null) {
    const [fullMatch, exclaim, rawName, url] = match;
    if (!isPreviewableFileLink(url)) return [];
    if (content.slice(lastIndex, match.index).trim()) return [];

    attachments.push({
      name: rawName || (exclaim === '!' ? 'image' : 'file'),
      url,
      isImage: exclaim === '!',
      localPath: extractAbsolutePathFromDownloadUrl(url) || undefined,
    });
    lastIndex = match.index + fullMatch.length;
  }

  if (attachments.length === 0) return [];
  if (content.slice(lastIndex).trim()) return [];
  return attachments;
}

export function extractPreviewableLinksAndText(content: string): { attachments: Attachment[]; text: string } {
  const attachments: Attachment[] = [];
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const linkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
  const positions: { start: number; end: number; isImage: boolean; name: string; url: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = imageRegex.exec(content)) !== null) {
    const url = match[2];
    if (isPreviewableFileLink(url)) {
      positions.push({ start: match.index, end: match.index + match[0].length, isImage: true, name: match[1] || 'image', url });
    }
  }

  while ((match = linkRegex.exec(content)) !== null) {
    const url = match[2];
    if (isPreviewableFileLink(url) && !positions.some((position) => match!.index >= position.start && match!.index < position.end)) {
      positions.push({ start: match.index, end: match.index + match[0].length, isImage: false, name: match[1] || 'file', url });
    }
  }

  if (positions.length === 0) {
    return { attachments: [], text: content };
  }

  positions.sort((a, b) => a.start - b.start);
  let text = '';
  let cursor = 0;
  for (const position of positions) {
    text += content.slice(cursor, position.start);
    cursor = position.end;
    attachments.push({
      name: position.name,
      url: position.url,
      isImage: position.isImage,
      localPath: extractAbsolutePathFromDownloadUrl(position.url) || undefined,
    });
  }
  text += content.slice(cursor);

  return {
    attachments,
    text: text.replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n'),
  };
}

export function extractAttachmentFromStandaloneLine(line: string): Attachment | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const normalizedLine = trimmed.replace(/^(?:[-*+]\s+|\d+\.\s+)/, '');
  const localPath = extractSingleLocalPath(normalizedLine);
  if (!localPath) return null;

  return buildFileAttachmentFromPath(normalizedLine, localPath);
}

export const parseAttachmentsFromContent = (content: string): { attachments: Attachment[], text: string } => {
  const attachments: Attachment[] = [];
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const linkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
  const searchableContent = maskFencedBlocks(content);
  
  let text = content;
  let m: RegExpExecArray | null;
  const positions: {start: number, end: number, isImage: boolean, name: string, url: string}[] = [];
  
  while ((m = imageRegex.exec(searchableContent)) !== null) {
    const url = m[2];
    if (url.startsWith('/uploads/') || url.startsWith('/api/files/')) {
      positions.push({ start: m.index, end: m.index + m[0].length, isImage: true, name: m[1] || 'image', url });
    }
  }
  while ((m = linkRegex.exec(searchableContent)) !== null) {
    const url = m[2];
    if (url.startsWith('/uploads/') || url.startsWith('/api/files/')) {
      // Skip /api/files/download links — let those render via the markdown a() component
      // which shows a proper file card UI. Only extract /uploads/ and /api/files/view links.
      if (url.includes('/api/files/download')) continue;
      if (!positions.some(p => m!.index >= p.start && m!.index < p.end)) {
        positions.push({ start: m.index, end: m.index + m[0].length, isImage: false, name: m[1] || 'file', url });
      }
    }
  }
  
  if (positions.length > 0) {
    positions.sort((a, b) => a.start - b.start);
    let result = '';
    let last = 0;
    for (const pos of positions) {
      result += content.slice(last, pos.start);
      last = pos.end;
      attachments.push({ name: pos.name, url: pos.url, isImage: pos.isImage });
    }
    result += content.slice(last);
    text = result.replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n');
  }
  
  return { attachments, text };
};
