import React from 'react';
import { Check, Copy, Trash2, RefreshCw, Quote, X, Download, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { normalizeLanguage } from '../../i18n';
import { getFileIconInfo } from '../../utils/fileUtils';
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeMathMarkdown } from '../../utils/markdownMath';

const SEARCH_HIGHLIGHT_CLASS_NAME = 'rounded-[4px] bg-[#fff3b0] px-0.5 text-inherit';
const EXTERNAL_LINK_CLASS_NAME = 'text-[#1a73e8] no-underline hover:underline decoration-1 underline-offset-2 break-all transition-colors hover:text-[#1557b0]';
const HTML_PREVIEW_ROUTE_PADDING_SEGMENT = '__claw_preview_root__';
const HTML_PREVIEW_ROUTE_PADDING_DEPTH = 24;
const EMBED_PREVIEW_HEIGHT_SCALE = 0.5;
const DEFAULT_EMBED_PREVIEW_HEIGHT = 210;

const URL_WITH_PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_WITHOUT_PROTOCOL_PATTERN = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#][^\s]*)?$/i;

function escapeRegExpForPattern(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeNavigableHref(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;

  const candidate = URL_WITH_PROTOCOL_PATTERN.test(trimmed)
    ? trimmed
    : URL_WITHOUT_PROTOCOL_PATTERN.test(trimmed)
      ? `http://${trimmed}`
      : '';

  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {}

  return null;
}

function isInlineMarkdownCodeNode(node: any, className?: string): boolean {
  if (className) return false;
  const startLine = node?.position?.start?.line;
  const endLine = node?.position?.end?.line;
  return typeof startLine === 'number' && typeof endLine === 'number' && startLine === endLine;
}

function highlightSearchText(text: string, query: string, keyPrefix: string): React.ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let matchIndex = 0;

  while (cursor < text.length) {
    const matchStart = lowerText.indexOf(lowerQuery, cursor);
    if (matchStart === -1) {
      if (parts.length === 0) return text;
      parts.push(<React.Fragment key={`${keyPrefix}-tail`}>{text.slice(cursor)}</React.Fragment>);
      return parts;
    }

    if (matchStart > cursor) {
      parts.push(
        <React.Fragment key={`${keyPrefix}-text-${matchIndex}`}>
          {text.slice(cursor, matchStart)}
        </React.Fragment>
      );
    }

    const matchEnd = matchStart + normalizedQuery.length;
    parts.push(
      <mark key={`${keyPrefix}-match-${matchIndex}`} className={SEARCH_HIGHLIGHT_CLASS_NAME}>
        {text.slice(matchStart, matchEnd)}
      </mark>
    );

    cursor = matchEnd;
    matchIndex += 1;
  }

  return parts.length > 0 ? parts : text;
}

function highlightSearchNodes(node: React.ReactNode, query: string, keyPrefix = 'search'): React.ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return node;

  if (typeof node === 'string') {
    return highlightSearchText(node, normalizedQuery, keyPrefix);
  }

  if (typeof node === 'number') {
    return highlightSearchText(String(node), normalizedQuery, keyPrefix);
  }

  if (node == null || typeof node === 'boolean') {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child, index) => (
      <React.Fragment key={`${keyPrefix}-${index}`}>
        {highlightSearchNodes(child, normalizedQuery, `${keyPrefix}-${index}`)}
      </React.Fragment>
    ));
  }

  if (!React.isValidElement(node) || node.type === 'mark') {
    return node;
  }

  if (typeof node.type === 'string' && (node.type === 'code' || node.type === 'pre' || node.type === 'svg')) {
    return node;
  }

  const children = (node.props as { children?: React.ReactNode }).children;
  if (children === undefined) {
    return node;
  }

  return React.cloneElement(
    node,
    undefined,
    highlightSearchNodes(
      children,
      normalizedQuery,
      `${keyPrefix}-${typeof node.type === 'string' ? node.type : 'node'}`
    )
  );
}

function hasSearchMatchInProcessBlocks(content: string, query: string, processStartTag?: string, processEndTag?: string, explicitProcessContent?: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery && explicitProcessContent && explicitProcessContent.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  const startTag = processStartTag?.trim();
  const endTag = processEndTag?.trim();
  if (!content || !normalizedQuery || !startTag || !endTag) return false;

  const regex = new RegExp(
    `${escapeRegExpForPattern(startTag)}([\\s\\S]*?)(?:${escapeRegExpForPattern(endTag)}|$)`,
    'g'
  );

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if ((match[1] || '').toLowerCase().includes(normalizedQuery)) {
      return true;
    }
  }

  return false;
}

function findTrailingIncompleteProcessTagFragment(content: string, tag?: string): string {
  const normalizedTag = tag?.trim() || '';
  if (!content || !normalizedTag || content.endsWith(normalizedTag)) {
    return '';
  }

  const minFragmentLength = Math.min(3, Math.max(1, normalizedTag.length - 1));
  const maxFragmentLength = Math.min(content.length, normalizedTag.length - 1);

  for (let length = maxFragmentLength; length >= minFragmentLength; length -= 1) {
    const fragment = normalizedTag.slice(0, length);
    if (content.endsWith(fragment)) {
      return fragment;
    }
  }

  return '';
}

function sanitizeConfiguredProcessText(
  content: string,
  processStartTag?: string,
  processEndTag?: string,
): { content: string; hasTrailingPlaceholder: boolean } {
  if (!content) {
    return { content, hasTrailingPlaceholder: false };
  }

  const tags = [processStartTag?.trim(), processEndTag?.trim()]
    .filter((tag): tag is string => Boolean(tag));

  if (tags.length === 0) {
    return { content, hasTrailingPlaceholder: false };
  }

  let hasTrailingPlaceholder = false;
  let cleanedContent = content.replace(/\r\n?/g, '\n');

  for (const tag of tags) {
    cleanedContent = cleanedContent.replace(new RegExp(escapeRegExpForPattern(tag), 'g'), '');
  }

  cleanedContent = cleanedContent
    .split('\n')
    .map((line) => {
      let nextLine = line;

      while (true) {
        const startFragment = findTrailingIncompleteProcessTagFragment(nextLine, processStartTag);
        const endFragment = findTrailingIncompleteProcessTagFragment(nextLine, processEndTag);
        const fragment = startFragment.length >= endFragment.length ? startFragment : endFragment;

        if (!fragment) {
          return nextLine;
        }

        hasTrailingPlaceholder = true;
        nextLine = nextLine
          .slice(0, nextLine.length - fragment.length)
          .replace(/[ \t]+$/g, '');
      }
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  return {
    content: cleanedContent,
    hasTrailingPlaceholder,
  };
}

const EXECUTING_PLACEHOLDER_DOT_COUNTS = [1, 2, 3, 4, 5, 6];

const AnimatedExecutingPlaceholder: React.FC<{ label: string }> = ({ label }) => {
  const [dotIndex, setDotIndex] = React.useState(0);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setDotIndex((current) => (current + 1) % EXECUTING_PLACEHOLDER_DOT_COUNTS.length);
    }, 420);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <span>
      {label}
      {'.'.repeat(EXECUTING_PLACEHOLDER_DOT_COUNTS[dotIndex])}
    </span>
  );
};

export interface Attachment {
  name: string;
  url: string;
  isImage: boolean;
  localPath?: string;
}

const FILE_ATTACHMENT_CARD_CLASS_NAME = 'inline-flex w-full max-w-[420px] relative group/file';

type EmbedPreview = {
  url: string;
  title: string;
  height: number;
};

const previewableLocalPathAvailabilityCache = new Map<string, boolean>();

function isPreviewableFileLink(url: string): boolean {
  return url.startsWith('/uploads/') || url.startsWith('/api/files/');
}

function isHtmlAttachmentFile(name?: string, url?: string): boolean {
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

function downloadAttachmentFile(url: string, filename: string) {
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

function openAttachmentFileInNewTab(url: string) {
  window.open(buildHtmlAttachmentOpenUrl(url) || url, '_blank', 'noopener,noreferrer');
}

function getMarkdownNodePlainText(node: any): string {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') {
    return typeof node.value === 'string' ? node.value : '';
  }
  if (Array.isArray(node.children)) {
    return node.children.map(getMarkdownNodePlainText).join('');
  }
  return '';
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

function parseStandaloneEmbedPreviews(text: string): EmbedPreview[] {
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

function extractSingleLocalPath(content: string): string | null {
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

function buildDownloadUrlFromLocalPath(localPath: string): string | null {
  const encodedPath = encodeBase64Utf8(localPath);
  if (!encodedPath) return null;
  return `/api/files/download?path=${encodeURIComponent(encodedPath)}`;
}

function buildFileAttachmentFromPath(codeText: string, localPath: string): Attachment | null {
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

function useLocalPathAvailability(localPath?: string, url?: string): boolean | null {
  const [retryTick, setRetryTick] = React.useState(0);
  const [isAvailable, setIsAvailable] = React.useState<boolean | null>(() => {
    if (!localPath) return true;
    return previewableLocalPathAvailabilityCache.get(localPath) ?? null;
  });

  React.useEffect(() => {
    setRetryTick(0);
  }, [localPath, url]);

  React.useEffect(() => {
    if (!localPath || !url) {
      setIsAvailable(true);
      return;
    }

    const cached = previewableLocalPathAvailabilityCache.get(localPath);
    if (cached !== undefined) {
      setIsAvailable(cached);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    setIsAvailable(null);

    fetch(url, { method: 'HEAD' })
      .then((response) => {
        if (cancelled) return;
        setIsAvailable(response.ok);
        if (response.ok) {
          previewableLocalPathAvailabilityCache.set(localPath, true);
        } else if (retryTick < 2) {
          retryTimer = window.setTimeout(() => {
            setRetryTick((current) => current + 1);
          }, 1200);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setIsAvailable(false);
        if (retryTick < 2) {
          retryTimer = window.setTimeout(() => {
            setRetryTick((current) => current + 1);
          }, 1200);
        }
      });

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [localPath, retryTick, url]);

  return isAvailable;
}

function LocalPathAttachmentGuard({
  attachment,
  fallback,
  children,
}: {
  attachment: Attachment;
  fallback: React.ReactNode;
  children: React.ReactNode;
}) {
  const isAvailable = useLocalPathAvailability(attachment.localPath, attachment.url);

  if (attachment.localPath && isAvailable !== true) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}

const FileAttachmentActions: React.FC<{ url: string; filename: string }> = ({ url, filename }) => {
  const { t } = useTranslation();
  const shouldShowOpenInNewTab = isHtmlAttachmentFile(filename, url);

  return (
    <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
      {shouldShowOpenInNewTab ? (
        <button
          type="button"
          className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-gray-400 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
          onClick={(event) => {
            event.stopPropagation();
            openAttachmentFileInNewTab(url);
          }}
          title={t('common.openInNewTab')}
        >
          <ExternalLink className="h-4 w-4" />
        </button>
      ) : null}
      <button
        type="button"
        className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-gray-400 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
        onClick={(event) => {
          event.stopPropagation();
          downloadAttachmentFile(url, filename);
        }}
        title={t('common.downloadFile')}
      >
        <Download className="h-4 w-4" />
      </button>
    </div>
  );
};

function createStableContentKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

function buildCodeCopyId(messageId: string | number, node: any, codeText: string): string {
  const startOffset = node?.position?.start?.offset;
  const endOffset = node?.position?.end?.offset;

  if (Number.isFinite(startOffset) && Number.isFinite(endOffset)) {
    return `code-${messageId}-${startOffset}-${endOffset}`;
  }

  return `code-${messageId}-${createStableContentKey(codeText)}`;
}

function extractStandaloneFileLinks(content: string): Attachment[] {
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

function extractPreviewableLinksAndText(content: string): { attachments: Attachment[]; text: string } {
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

function looksLikeMarkdownContent(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;

  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(normalized)
    || /(^|\n)\s{0,3}```/.test(normalized)
    || /\[[^\]]+\]\([^)]+\)/.test(normalized)
    || /\*\*[^*]+\*\*/.test(normalized)
    || /`[^`]+`/.test(normalized);
}

function getCodeLanguage(className?: string): string {
  const match = /language-([^\s]+)/.exec(className || '');
  return (match?.[1] || '').toLowerCase();
}

function shouldRenderEmbeddedFilesAsMarkdown(language: string, text: string): boolean {
  const normalizedLanguage = language.trim().toLowerCase();
  const normalizedText = text.trim();
  if (!normalizedText) return true;

  if (['markdown', 'md', 'mdx', 'text', 'txt', 'plain', 'plaintext'].includes(normalizedLanguage)) {
    return true;
  }

  return looksLikeMarkdownContent(normalizedText);
}

function isFenceOpeningLine(line: string): { marker: '`' | '~'; length: number } | null {
  const match = line.match(/^ {0,3}((`{3,})|(~{3,}))(.*)$/);
  if (!match) return null;

  const fence = match[1];
  return {
    marker: fence[0] as '`' | '~',
    length: fence.length,
  };
}

function isFenceClosingLine(line: string, marker: '`' | '~', length: number): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith(marker.repeat(length))) return false;
  return new RegExp(`^\\${marker}{${length},}[ \\t]*$`).test(trimmed);
}

function stripTrailingBrokenFenceFragments(lines: string[], marker: '`' | '~'): string[] {
  const nextLines = [...lines];

  while (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() === '') {
    nextLines.pop();
  }

  while (
    nextLines.length > 0
    && new RegExp(`^ {0,3}\\${marker}{1,2}[ \\t]*$`).test(nextLines[nextLines.length - 1].trim())
  ) {
    nextLines.pop();
    while (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() === '') {
      nextLines.pop();
    }
  }

  return nextLines;
}

function maskFencedBlocks(content: string): string {
  if (!content || (!content.includes('```') && !content.includes('~~~'))) {
    return content;
  }

  const lines = content.split('\n');
  const maskedLines: string[] = [];
  let activeFence: { marker: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    if (!activeFence) {
      const openingFence = isFenceOpeningLine(line);
      if (openingFence) {
        activeFence = openingFence;
        maskedLines.push(' '.repeat(line.length));
        continue;
      }

      maskedLines.push(line);
      continue;
    }

    maskedLines.push(' '.repeat(line.length));
    if (isFenceClosingLine(line, activeFence.marker, activeFence.length)) {
      activeFence = null;
    }
  }

  return maskedLines.join('\n');
}

function isLikelyProseBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (/^(#{2,6}\s|>\s)/.test(trimmed)) {
    return true;
  }

  if (/^\*\*[^*]+\*\*[:：]?$/.test(trimmed)) {
    return true;
  }

  if (/[\u4e00-\u9fff]/.test(trimmed)) {
    if (/^(#|\/\/|--|\/\*|\*)/.test(trimmed)) return false;
    if (/[{}[\];]/.test(trimmed)) return false;
    if (/^(if|for|while|def|class|const|let|var|function|import|export|return|echo|curl|npm|pnpm|yarn|python|node|cd|ls|cat|cp|mv|rm|sudo|docker|kubectl|git|ffmpeg|openclaw)\b/i.test(trimmed)) {
      return false;
    }
    return true;
  }

  return /^[A-Za-z][A-Za-z0-9 _/-]{0,80}[:.!?]$/.test(trimmed);
}

function normalizeMalformedFencedBlocks(content: string): string {
  if (!content || (!content.includes('```') && !content.includes('~~~'))) {
    return content;
  }

  const lines = content.split('\n');
  const normalizedLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const openingFence = isFenceOpeningLine(lines[index]);
    if (!openingFence) {
      normalizedLines.push(lines[index]);
      index += 1;
      continue;
    }

    normalizedLines.push(lines[index]);
    index += 1;

    const blockLines: string[] = [];
    let closed = false;

    while (index < lines.length) {
      const currentLine = lines[index];

      if (isFenceClosingLine(currentLine, openingFence.marker, openingFence.length)) {
        normalizedLines.push(...blockLines, currentLine);
        index += 1;
        closed = true;
        break;
      }

      if (
        openingFence.length === 3
        &&
        blockLines.length > 0
        && index > 0
        && lines[index - 1].trim() === ''
        && isLikelyProseBoundaryLine(currentLine)
      ) {
        normalizedLines.push(
          ...stripTrailingBrokenFenceFragments(blockLines, openingFence.marker),
          openingFence.marker.repeat(openingFence.length)
        );
        closed = true;
        break;
      }

      blockLines.push(currentLine);
      index += 1;
    }

    if (!closed) {
      normalizedLines.push(...stripTrailingBrokenFenceFragments(blockLines, openingFence.marker));
      normalizedLines.push(openingFence.marker.repeat(openingFence.length));
    }
  }

  return normalizedLines.join('\n');
}

function extractAttachmentFromStandaloneLine(line: string): Attachment | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const normalizedLine = trimmed.replace(/^(?:[-*+]\s+|\d+\.\s+)/, '');
  const localPath = extractSingleLocalPath(normalizedLine);
  if (!localPath) return null;

  return buildFileAttachmentFromPath(normalizedLine, localPath);
}

function normalizeProcessPreviewablePathLines(content: string): string {
  if (!content || !content.includes('/')) return content;

  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const normalizedLines: string[] = [];
  let activeFence: { marker: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    if (!activeFence) {
      const openingFence = isFenceOpeningLine(line);
      if (openingFence) {
        activeFence = openingFence;
        normalizedLines.push(line);
        continue;
      }

      const attachment = extractAttachmentFromStandaloneLine(line);
      if (attachment?.url) {
        if (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1].trim() !== '') {
          normalizedLines.push('');
        }
        normalizedLines.push(`[${attachment.name}](${attachment.url})`);
        normalizedLines.push('');
        continue;
      }

      normalizedLines.push(line);
      continue;
    }

    normalizedLines.push(line);
    if (isFenceClosingLine(line, activeFence.marker, activeFence.length)) {
      activeFence = null;
    }
  }

  return normalizedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

type ProcessToolStep = {
  label: string;
  detail: string;
  status: 'running' | 'done' | 'error';
};

const KNOWN_TOOL_PROGRESS_LABELS = new Set([
  '子任务已返回结果',
  '子任务已启动',
  '页面操作已完成',
  '正在打开页面',
  '命令已完成',
  '命令执行失败',
  '正在执行工具',
  '文件读取已完成',
  '文件修改已完成',
  '图片查看已完成',
  '正在打开文件',
  '计划已更新',
  '正在运行命令',
  '搜索已完成',
  '正在搜索',
  '正在启动子任务',
  '工具已完成',
  '工具执行失败',
  '正在修改文件',
  '正在更新计划',
  '正在查看图片',
  '正在等待子任务结果',
  '子任務已返回結果',
  '子任務已啟動',
  '頁面操作已完成',
  '正在開啟頁面',
  '命令已完成',
  '命令執行失敗',
  '正在執行工具',
  '檔案讀取已完成',
  '檔案修改已完成',
  '圖片查看已完成',
  '正在開啟檔案',
  '計畫已更新',
  '正在執行命令',
  '搜尋已完成',
  '正在搜尋',
  '正在啟動子任務',
  '工具已完成',
  '工具執行失敗',
  '正在修改檔案',
  '正在更新計畫',
  '正在查看圖片',
  '正在等待子任務結果',
  'Subtask returned',
  'Subtask started',
  'Browser action completed',
  'Opening page',
  'Command completed',
  'Command failed',
  'Running tool',
  'File read completed',
  'File update completed',
  'Image inspection completed',
  'Opening file',
  'Plan updated',
  'Running command',
  'Search completed',
  'Searching',
  'Starting subtask',
  'Tool completed',
  'Tool failed',
  'Updating file',
  'Updating plan',
  'Inspecting image',
  'Waiting for subtask result',
]);

function isKnownToolProgressLabel(label: string): boolean {
  const normalized = label.trim();
  if (KNOWN_TOOL_PROGRESS_LABELS.has(normalized)) return true;
  return /^(正在执行工具|正在執行工具|Running tool)\s+\S+/.test(normalized);
}

function resolveProcessToolStepStatus(label: string): ProcessToolStep['status'] {
  if (/(失败|失敗|failed)/i.test(label)) return 'error';
  if (/^正在/.test(label) || /^(Running|Opening|Searching|Updating|Starting|Waiting|Inspecting)\b/i.test(label)) {
    return 'running';
  }
  return 'done';
}

function parseProcessToolStepLine(line: string): ProcessToolStep | null {
  const bulletMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
  if (!bulletMatch) return null;

  const text = bulletMatch[1].trim();
  const splitMatch = text.match(/^(.+?)(?:：|:\s+)([\s\S]*)$/);
  const label = (splitMatch?.[1] || text).trim();
  const detail = (splitMatch?.[2] || '').trim();
  if (!isKnownToolProgressLabel(label)) return null;

  return {
    label,
    detail,
    status: resolveProcessToolStepStatus(label),
  };
}

function splitProcessContent(content: string): { toolSteps: ProcessToolStep[]; modelContent: string } {
  const toolSteps: ProcessToolStep[] = [];
  const modelLines: string[] = [];

  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const toolStep = parseProcessToolStepLine(line);
    if (toolStep) {
      toolSteps.push(toolStep);
    } else {
      modelLines.push(line);
    }
  }

  return {
    toolSteps,
    modelContent: modelLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

export const ProcessStepBlock = ({
  content,
  initiallyExpanded,
  forceExpanded,
  searchQuery,
  isExtractingProcess,
  isDense,
  onPreview,
  processStartTag,
  processEndTag,
}: {
  content: string,
  initiallyExpanded: boolean,
  forceExpanded?: boolean,
  searchQuery?: string,
  isExtractingProcess?: boolean,
  isDense?: boolean,
  onPreview?: (url: string, filename: string) => void,
  processStartTag?: string,
  processEndTag?: string,
}) => {
  const { t } = useTranslation();
  const normalizedSearchQuery = searchQuery?.trim() || '';
  const [isExpanded, setIsExpanded] = React.useState(initiallyExpanded || !!forceExpanded);
  const sanitizedProcessContent = sanitizeConfiguredProcessText(content, processStartTag, processEndTag);
  const normalizedContent = normalizeProcessPreviewablePathLines(sanitizedProcessContent.content);
  const { toolSteps, modelContent } = React.useMemo(
    () => splitProcessContent(normalizedContent),
    [normalizedContent]
  );
  const hasModelContent = modelContent.trim().length > 0;
  const hasToolSteps = toolSteps.length > 0;
  const shouldRenderInlineExecutingPlaceholder = Boolean(
    isExtractingProcess && (!normalizedContent.trim() || sanitizedProcessContent.hasTrailingPlaceholder)
  );
  const isProcessActive = Boolean(isExtractingProcess || shouldRenderInlineExecutingPlaceholder);
  const hasRenderableProcessContent = hasToolSteps || hasModelContent || shouldRenderInlineExecutingPlaceholder;

  React.useEffect(() => {
    if (forceExpanded) {
      setIsExpanded(true);
    }
  }, [forceExpanded]);

  if (!hasRenderableProcessContent) {
    return null;
  }

  const renderSearchHighlighted = (children: React.ReactNode, scope: string) => (
    highlightSearchNodes(children, normalizedSearchQuery, `process-${isDense ? 'dense' : 'default'}-${scope}`)
  );

  const renderProcessAttachmentCards = (attachments: Attachment[], keyPrefix: string) => (
    <div className="flex flex-wrap gap-4 w-full items-start py-1">
      {attachments.map((att, index) => (
        <LocalPathAttachmentGuard
          key={`${keyPrefix}-${index}`}
          attachment={att}
          fallback={att.localPath ? (
            <div className="max-w-full">
              <div
                dir="ltr"
                title={att.localPath}
                className="max-w-full whitespace-pre-wrap break-all font-mono text-[13.5px] leading-6 text-gray-700"
              >
                {renderSearchHighlighted(att.localPath, `attachment-path-${index}`)}
              </div>
            </div>
          ) : null}
        >
          {att.isImage ? (
            <a
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              className="relative cursor-pointer rounded-xl border border-gray-300 bg-white p-1 hover:bg-[#fffdf0] hover:border-orange-300 transition-all flex items-center justify-center"
              onClick={(event) => {
                if (onPreview) {
                  event.preventDefault();
                  onPreview(att.url, att.name || t('common.file'));
                }
              }}
              title={t('common.previewImage')}
            >
              <img src={att.url} alt={att.name} className="w-20 h-20 object-cover rounded-lg" />
            </a>
          ) : (
            (() => {
              const fileName = att.name || t('common.file');
              const isHtmlFile = isHtmlAttachmentFile(fileName, att.url);
              const { Icon, typeText, bgColor } = getFileIconInfo(fileName);
              return (
                <div className={FILE_ATTACHMENT_CARD_CLASS_NAME}>
                  <div
                    className="flex items-center gap-3 p-2.5 rounded-xl border border-gray-300 bg-white hover:bg-[#fffdf0] hover:border-orange-300 cursor-pointer transition-all w-full"
                    onClick={(event) => {
                      if (onPreview) {
                        event.preventDefault();
                        onPreview(att.url, fileName);
                      } else {
                        window.open(att.url, '_blank');
                      }
                    }}
                  >
                    <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0 border border-gray-100`}>
                      <Icon className="w-5 h-5 text-white" />
                    </div>
                    <div className={`flex flex-col min-w-0 ${isHtmlFile ? 'pr-20' : 'pr-12'} w-full relative`}>
                      <div className="text-[13px] font-bold text-gray-800 truncate transition-colors w-full leading-snug">
                        {renderSearchHighlighted(fileName, `attachment-name-${index}`)}
                      </div>
                      <span className="text-[11px] text-gray-400 font-medium mt-0.5">{typeText}</span>
                    </div>
                    <FileAttachmentActions url={att.url} filename={fileName} />
                  </div>
                </div>
              );
            })()
          )}
        </LocalPathAttachmentGuard>
      ))}
    </div>
  );

  const processMarkdownComponents: any = {
    pre({ children, ...props }: any) {
      let hasStandaloneFileLinks = false;
      let hasMixedMarkdownFileLinks = false;
      let hasSingleLocalPath = false;

      React.Children.forEach(children, (child: any) => {
        const childText = child?.props?.children ? String(child.props.children).replace(/\n$/, '') : '';
        if (extractStandaloneFileLinks(childText.trim()).length > 0) {
          hasStandaloneFileLinks = true;
        }
        if (extractSingleLocalPath(childText)) {
          hasSingleLocalPath = true;
        }
        const childLanguage = getCodeLanguage(child?.props?.className);
        const embeddedFiles = extractPreviewableLinksAndText(childText.trim());
        if (
          embeddedFiles.attachments.length > 0
          && shouldRenderEmbeddedFilesAsMarkdown(childLanguage, embeddedFiles.text)
        ) {
          hasMixedMarkdownFileLinks = true;
        }
      });

      if (hasStandaloneFileLinks || hasMixedMarkdownFileLinks || hasSingleLocalPath) return <>{children}</>;
      return <pre {...props}>{children}</pre>;
    },
    p(props: any) {
      const embedPreviews = parseStandaloneEmbedPreviews(getMarkdownNodePlainText(props.node));
      if (embedPreviews.length > 0) {
        return (
          <div className="w-full">
            {embedPreviews.map((embed, index) => (
              <EmbedPreviewCard key={`${embed.url}-${index}`} embed={embed} />
            ))}
          </div>
        );
      }

      const nodes = props.node?.children || [];
      const isAttachmentBlock = nodes.length > 0 && nodes.every(
        (child: any) =>
          (child.type === 'element' && child.tagName === 'img') ||
          (child.type === 'element' && child.tagName === 'a') ||
          (child.type === 'text' && child.value.trim() === '') ||
          (child.type === 'element' && child.tagName === 'br')
      );
      const attachmentCount = nodes.filter(
        (child: any) => child.type === 'element' && (child.tagName === 'img' || child.tagName === 'a')
      ).length;

      if (isAttachmentBlock && attachmentCount > 0) {
        return (
          <div className="w-full space-y-4" style={{ marginTop: 0, marginBottom: '1rem' }}>
            {props.children}
          </div>
        );
      }

      return <p {...props}>{renderSearchHighlighted(props.children, 'p')}</p>;
    },
    li(props: any) {
      return <li {...props}>{renderSearchHighlighted(props.children, 'li')}</li>;
    },
    code({ inline, className, children, ...props }: any) {
      const codeLanguage = getCodeLanguage(className);
      const codeText = children ? String(children).replace(/\n$/, '') : '';
      const isInlineCode = typeof inline === 'boolean'
        ? inline
        : isInlineMarkdownCodeNode(props.node, className);
      const inlineLinkHref = isInlineCode ? normalizeNavigableHref(codeText) : null;
      const standaloneFileLinks = !inline ? extractStandaloneFileLinks(codeText.trim()) : [];
      const embeddedFileLinks = !inline ? extractPreviewableLinksAndText(codeText.trim()) : { attachments: [], text: codeText };
      const singleLocalPath = !inline ? extractSingleLocalPath(codeText) : null;
      const singleFileAttachment = !inline && singleLocalPath ? buildFileAttachmentFromPath(codeText, singleLocalPath) : null;

      if (!inline && singleFileAttachment) {
        return renderProcessAttachmentCards([singleFileAttachment], `process-code-path-${createStableContentKey(singleLocalPath || codeText)}`);
      }

      if (!inline && standaloneFileLinks.length > 0) {
        return renderProcessAttachmentCards(standaloneFileLinks, `process-code-files-${createStableContentKey(codeText)}`);
      }

      if (
        !inline
        && embeddedFileLinks.attachments.length > 0
        && shouldRenderEmbeddedFilesAsMarkdown(codeLanguage, embeddedFileLinks.text)
      ) {
        return (
          <div className="space-y-4">
            {renderProcessAttachmentCards(embeddedFileLinks.attachments, `process-code-mixed-${createStableContentKey(codeText)}`)}
            {embeddedFileLinks.text.trim() ? (
              <div className="prose prose-sm max-w-none prose-slate text-[13.5px] text-[#444]">
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  components={processMarkdownComponents}
                >
                  {normalizeMathMarkdown(embeddedFileLinks.text)}
                </ReactMarkdown>
              </div>
            ) : null}
          </div>
        );
      }

      if (isInlineCode && inlineLinkHref) {
        return (
          <a
            href={inlineLinkHref}
            target="_blank"
            rel="noopener noreferrer"
            className={`${EXTERNAL_LINK_CLASS_NAME} font-mono`}
          >
            {renderSearchHighlighted(codeText, 'inline-link')}
          </a>
        );
      }

      return isInlineCode ? (
        <code {...props}>{children}</code>
      ) : (
        <code className={className} {...props}>{children}</code>
      );
    },
    img(props: any) {
      if (props.src && isPreviewableFileLink(props.src)) {
        return renderProcessAttachmentCards([
          { name: props.alt || t('common.file'), url: props.src, isImage: true },
        ], `process-image-${createStableContentKey(String(props.src))}`);
      }

      return <img {...props} alt={props.alt} />;
    },
    strong(props: any) {
      return <strong {...props}>{renderSearchHighlighted(props.children, 'strong')}</strong>;
    },
    em(props: any) {
      return <em {...props}>{renderSearchHighlighted(props.children, 'em')}</em>;
    },
    a(props: any) {
      if (props.href && isPreviewableFileLink(props.href)) {
        const nodes = Array.isArray(props.children) ? props.children : [props.children];
        const fileName = nodes.map((node: any) => String(node)).join('') || t('common.file');
        return renderProcessAttachmentCards([
          { name: fileName, url: props.href, isImage: false },
        ], `process-link-${createStableContentKey(`${props.href}-${fileName}`)}`);
      }

      const normalizedHref = normalizeNavigableHref(props.href);
      return (
        <a
          {...props}
          href={normalizedHref || props.href}
          target="_blank"
          rel="noopener noreferrer"
          className={EXTERNAL_LINK_CLASS_NAME}
        >
          {renderSearchHighlighted(props.children, 'a')}
        </a>
      );
    },
    h1(props: any) {
      return <h1 {...props}>{renderSearchHighlighted(props.children, 'h1')}</h1>;
    },
    h2(props: any) {
      return <h2 {...props}>{renderSearchHighlighted(props.children, 'h2')}</h2>;
    },
    h3(props: any) {
      return <h3 {...props}>{renderSearchHighlighted(props.children, 'h3')}</h3>;
    },
    h4(props: any) {
      return <h4 {...props}>{renderSearchHighlighted(props.children, 'h4')}</h4>;
    },
    h5(props: any) {
      return <h5 {...props}>{renderSearchHighlighted(props.children, 'h5')}</h5>;
    },
    h6(props: any) {
      return <h6 {...props}>{renderSearchHighlighted(props.children, 'h6')}</h6>;
    },
    blockquote(props: any) {
      return <blockquote {...props}>{renderSearchHighlighted(props.children, 'blockquote')}</blockquote>;
    },
    td(props: any) {
      return <td {...props}>{renderSearchHighlighted(props.children, 'td')}</td>;
    },
    th(props: any) {
      return <th {...props}>{renderSearchHighlighted(props.children, 'th')}</th>;
    }
  };

  return (
    <div className={`process-step-container flex flex-col ${isDense ? 'my-1.5' : 'mt-1 mb-4'} w-fit max-w-full min-w-[240px] border border-gray-300 rounded-xl overflow-hidden bg-white transition-colors leading-normal`}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center justify-between gap-4 px-3 py-2 w-full bg-[#f2fbf4] hover:bg-[#e6f7ea] transition-colors cursor-pointer outline-none ${isExpanded ? 'border-b border-gray-300' : ''}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex-shrink-0 flex items-center justify-center pl-0.5 pr-1">
             {isProcessActive ? (
                <RefreshCw className="w-[16px] h-[16px] text-[#5ca36f] animate-spin" strokeWidth={2.5} />
             ) : (
                <Check className="w-[16px] h-[16px] text-[#5ca36f]" strokeWidth={2.5} />
             )}
          </div>
          <div className="flex min-w-0 flex-col items-start">
            <span className="text-[13.5px] font-medium text-gray-700 leading-tight">{t('messageBubble.processTitle')}</span>
          </div>
        </div>
        <div className="text-gray-400 flex-shrink-0">
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>
      {isExpanded && (
        <div className="px-3 py-2.5 bg-white space-y-3">
          {hasToolSteps ? (
            <div className="not-prose">
              <div className="mb-1.5 text-[11.5px] font-semibold text-gray-500">{t('messageBubble.toolStepsLabel')}</div>
              <ol className="space-y-1.5">
                {toolSteps.map((step, index) => (
                  <li key={`${step.label}-${step.detail}-${index}`} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-[13px] leading-[1.45] text-gray-700">
                    <span className="mt-[2px] flex h-[18px] w-[18px] items-center justify-center rounded-full border border-gray-300 bg-white">
                      {step.status === 'running' && isProcessActive ? (
                        <RefreshCw className="h-3 w-3 animate-spin text-[#5ca36f]" strokeWidth={2.4} />
                      ) : step.status === 'error' ? (
                        <X className="h-3 w-3 text-[#d93025]" strokeWidth={2.4} />
                      ) : (
                        <Check className="h-3 w-3 text-[#5ca36f]" strokeWidth={2.4} />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-gray-700">{renderSearchHighlighted(step.label, `tool-label-${index}`)}</span>
                      {step.detail ? (
                        <span className="text-gray-500">：{renderSearchHighlighted(step.detail, `tool-detail-${index}`)}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {hasModelContent ? (
            <div>
              {hasToolSteps ? (
                <div className="not-prose mb-1.5 border-t border-gray-200 pt-2 text-[11.5px] font-semibold text-gray-500">
                  {t('messageBubble.modelProcessLabel')}
                </div>
              ) : null}
              <div className="text-[13.5px] font-sans text-[#444] break-all prose prose-sm max-w-none" style={{ lineHeight: '1.6' }}>
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  components={processMarkdownComponents}
                >
                  {normalizeMathMarkdown(modelContent)}
                </ReactMarkdown>
              </div>
            </div>
          ) : null}
          {shouldRenderInlineExecutingPlaceholder ? (
            <div className="not-prose text-[13.5px] leading-[1.6] text-[#666]">
              <AnimatedExecutingPlaceholder label={t('messageBubble.executingPlaceholder')} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

export interface PendingFile {
  file: File;
  preview: string;
}

export interface MessageProps {
  id: string | number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  processContent?: string;
  processStreaming?: boolean;
  rawDetail?: string;
  timestamp: Date;
  isHighlighted?: boolean;
  searchQuery?: string;
  showDateDivider?: boolean;
  
  // Customization
  agentName?: string;
  modelDisplayName?: string;
  avatarUrl?: string;
  avatarChar?: string;
  avatarColorClass?: string;

  // Edit State
  isEditing?: boolean;
  editContent?: string;
  editIsDragging?: boolean;
  editExistingAttachments?: Attachment[];
  editPendingFiles?: PendingFile[];
  onSetEditIsDragging?: (isDragging: boolean) => void;
  onSetEditContent?: (content: string) => void;
  onSetEditExistingAttachments?: (setter: (prev: Attachment[]) => Attachment[] | Attachment[]) => void;
  onSetEditPendingFiles?: (setter: (prev: PendingFile[]) => PendingFile[] | PendingFile[]) => void;
  onDropNewFiles?: (files: File[]) => void;

  // Events
  onEditClick?: (attachments: Attachment[], text: string) => void;
  onCancelEdit?: () => void;
  onSaveEdit?: () => void;
  onRegenerate?: () => void;
  onQuote?: () => void;
  onCopy?: (content: string, id: string | number) => void;
  onDelete?: () => void;
  
  
  isCopied?: boolean;
  activeCopiedId?: string | null;
  isLoading?: boolean;
  onPreview?: (url: string, filename: string) => void;
  // Process Stream Rules
  processStartTag?: string;
  processEndTag?: string;

  isLatest?: boolean;
  preserveProcessExpansionWhenNotLatest?: boolean;
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

const QuoteBlock: React.FC<{ author: string; time: string; content: string; components?: any }> = ({ author, time, content, components }) => {
  const [expanded, setExpanded] = React.useState(false);
  const lines = content.split('\n');
  const isLong = lines.length > 3 || content.length > 150;

  return (
    <div className="my-1.5 border border-[#E5E7EB] rounded-2xl overflow-hidden bg-[#FAFAFA] flex flex-col w-full max-w-full z-10 relative shadow-sm not-prose">
      <button
        onClick={() => isLong && setExpanded(!expanded)}
        className={`px-3 py-2 bg-[#F3F4F6]/80 border-b border-[#E5E7EB] flex items-center gap-1.5 text-[13px] text-gray-600 w-full text-left outline-none ${isLong ? 'cursor-pointer hover:bg-[#ECEEF1]/80' : 'cursor-default'} transition-colors`}
      >
        <Quote className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <span>{author}</span>
        {time && <span className="text-gray-400">{time}</span>}
        {isLong && (
          <span className="ml-auto text-gray-400">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </span>
        )}
      </button>
      <div className="px-3.5 py-2 relative" style={{ padding: '0.5rem 0.875rem' }}>
        <div className={`text-[13px] text-gray-700 font-sans break-words custom-markdown quote-content-inner ${!expanded && isLong ? 'max-h-[120px] overflow-hidden' : ''}`} style={{ lineHeight: '1.5', wordBreak: 'break-word' }}>
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={components}
          >
            {normalizeMathMarkdown(content)}
          </ReactMarkdown>
        </div>
        {!expanded && isLong && (
          <div className="absolute bottom-0 left-0 w-full h-10 bg-gradient-to-t from-[#FAFAFA] to-transparent pointer-events-none" />
        )}
      </div>
    </div>
  );
};

const EmbedPreviewCard: React.FC<{ embed: EmbedPreview }> = ({ embed }) => {
  const { t } = useTranslation();

  return (
    <div className="not-prose my-4 w-full max-w-[900px] overflow-hidden rounded-lg border border-gray-300 bg-white">
      <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-gray-800">{embed.title}</div>
          <div className="truncate text-[11px] text-gray-500">{embed.url}</div>
        </div>
        <a
          href={embed.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
          title={t('common.preview')}
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
      <iframe
        src={embed.url}
        title={embed.title}
        className="block w-full border-0 bg-white"
        style={{ height: embed.height }}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
      />
    </div>
  );
};

export const normalizeProcessBlocks = (content: string, processStartTag?: string, processEndTag?: string) => {
  if (!content || !processStartTag || !processEndTag) return content;

  const startTag = processStartTag.trim();
  const endTag = processEndTag.trim();
  const startStr = escapeRegExpForPattern(startTag);
  const endStr = escapeRegExpForPattern(endTag);
  const cleanupTagArtifacts = (value: string) => (
    value
      .replace(new RegExp(`(?:${startStr}|${endStr})`, 'g'), '\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
  const regex = new RegExp(`${startStr}([\\s\\S]*?)(?:${endStr}|$)`, 'g');
  const processBlocks: { inner: string; isExtracting: boolean }[] = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    const isExtracting = !match[0].endsWith(endTag);
    processBlocks.push({ inner: match[1], isExtracting });
  }

  if (processBlocks.length === 0) return content;

  const mergedInner = cleanupTagArtifacts(processBlocks.map(block => block.inner).join('\n\n'));
  const isStillExtracting = processBlocks[processBlocks.length - 1].isExtracting;
  const lang = isStillExtracting ? 'process_step_thought_streaming' : 'process_step_thought';
  const cleanedContent = cleanupTagArtifacts(content.replace(regex, '\n'));

  if (!mergedInner) {
    return cleanedContent;
  }

  return `\`\`\`\`${lang}\n${mergedInner}\n\`\`\`\`\n\n${cleanedContent}`.trim();
};

const MessageBubbleInner: React.FC<MessageProps> = ({
  id, role, content, processContent, processStreaming, rawDetail, timestamp, isHighlighted, searchQuery, showDateDivider,
  agentName, modelDisplayName, avatarUrl, avatarChar, avatarColorClass,
  isEditing, editContent, editIsDragging, editExistingAttachments, editPendingFiles,
  onSetEditIsDragging, onSetEditContent, onSetEditExistingAttachments, onDropNewFiles,
  onEditClick, onCancelEdit, onSaveEdit, onRegenerate, onQuote, onCopy, onDelete,
  isCopied, activeCopiedId, isLoading, onPreview, processStartTag, processEndTag, isLatest,
  preserveProcessExpansionWhenNotLatest
}) => {
  const { t, i18n } = useTranslation();
  const currentLocale = normalizeLanguage(i18n.resolvedLanguage || i18n.language);
  const normalizedSearchQuery = searchQuery?.trim() || '';
  const canAcceptEditFileDrop = Boolean(isEditing && onDropNewFiles && onSetEditIsDragging);
  const [isProcessManualToggle] = React.useState<boolean | null>(null);
  const [hasBeenLatestForProcess, setHasBeenLatestForProcess] = React.useState(
    Boolean(isLatest && preserveProcessExpansionWhenNotLatest)
  );

  React.useEffect(() => {
    if (preserveProcessExpansionWhenNotLatest && isLatest) {
      setHasBeenLatestForProcess(true);
    }
  }, [isLatest, preserveProcessExpansionWhenNotLatest]);

  const shouldKeepProcessExpanded = preserveProcessExpansionWhenNotLatest
    ? hasBeenLatestForProcess
    : !!isLatest;
  const explicitProcessContent = typeof processContent === 'string' ? processContent.trim() : '';
  const sanitizedExplicitProcessContent = sanitizeConfiguredProcessText(
    explicitProcessContent,
    processStartTag,
    processEndTag,
  );
  const shouldRenderExplicitProcessBlock = !!sanitizedExplicitProcessContent.content || !!processStreaming;
  const isProcessExpanded = isProcessManualToggle !== null ? isProcessManualToggle : shouldKeepProcessExpanded;
  const shouldAutoExpandProcessBlocks = Boolean(
    isHighlighted && hasSearchMatchInProcessBlocks(
      content,
      normalizedSearchQuery,
      processStartTag,
      processEndTag,
      sanitizedExplicitProcessContent.content,
    )
  );
  const renderMessageSearchHighlighted = (children: React.ReactNode, scope: string) => (
    highlightSearchNodes(children, normalizedSearchQuery, `${scope}-${id}`)
  );
  let displayContent = content;

  // Parse structural quotes first so process blocks inside quotes stay inside
  if (displayContent) {
    const quoteRegex = /\[引用开始(?:[ \t]+author="(.*?)")?(?:[ \t]+time="(.*?)")?\]([\s\S]*?)(?:\[引用结束\]|$)/g;
    displayContent = displayContent.replace(quoteRegex, (_match, author, time, inner, offset, fullString) => {
      const lastNewlineIdx = fullString.lastIndexOf('\n', offset);
      const lineStartIdx = lastNewlineIdx === -1 ? 0 : lastNewlineIdx + 1;
      const lineTextBeforeTag = fullString.substring(lineStartIdx, offset);
      const prefixMatch = lineTextBeforeTag.match(/^[ \t>]*/);
      const prefix = prefixMatch ? prefixMatch[0] : '';
      const hasTextBefore = lineTextBeforeTag.length > prefix.length;

      const meta = `${author || t('common.unknown')}|${time || ''}`;
      const leadingInsert = hasTextBefore ? `\n${prefix}` : ``;
      const trailingInsert = `\n${prefix}`;
      return `${leadingInsert}\`\`\`\`\`\`chat_quote\n${meta}\n${inner.trim()}\n${prefix}\`\`\`\`\`\`${trailingInsert}`;
    });
  }

  // Then handle process blocks that are OUTSIDE quotes (not inside chat_quote blocks)
  if (!shouldRenderExplicitProcessBlock && processStartTag && processEndTag && displayContent) {
    // Split content by chat_quote blocks to avoid extracting process blocks from inside quotes
    const quoteBlockRegex = /``````chat_quote[\s\S]*?``````/g;
    const quoteBlocks: string[] = [];
    let contentWithPlaceholders = displayContent.replace(quoteBlockRegex, (match) => {
      const placeholder = `__QUOTE_BLOCK_${quoteBlocks.length}__`;
      quoteBlocks.push(match);
      return placeholder;
    });

    const normalizedContent = normalizeProcessBlocks(contentWithPlaceholders, processStartTag, processEndTag);

    if (normalizedContent !== contentWithPlaceholders) {
      contentWithPlaceholders = normalizedContent;
    }

    // Restore quote blocks
    quoteBlocks.forEach((block, i) => {
      contentWithPlaceholders = contentWithPlaceholders.replace(`__QUOTE_BLOCK_${i}__`, block);
    });

    displayContent = contentWithPlaceholders;
  }

  displayContent = normalizeMalformedFencedBlocks(displayContent);
  const trailingProcessPlaceholder = sanitizeConfiguredProcessText(
    displayContent,
    processStartTag,
    processEndTag,
  );
  displayContent = trailingProcessPlaceholder.content;
  const shouldRenderExecutingPlaceholder = role === 'assistant'
    && trailingProcessPlaceholder.hasTrailingPlaceholder
    && (!!isLatest || !!processStreaming);

  const renderFileAttachmentCards = (attachments: Attachment[], keyPrefix: string) => (
    <div className="flex flex-wrap gap-2 mb-3">
      {attachments.map((att, index) => (
        <LocalPathAttachmentGuard
          key={`${keyPrefix}-${index}`}
          attachment={att}
          fallback={att.localPath ? (
            <div className="max-w-full">
              <div
                dir="ltr"
                title={att.localPath}
                className="max-w-full whitespace-pre-wrap break-all font-mono text-[14px] leading-6 text-gray-700"
              >
                {renderMessageSearchHighlighted(att.localPath, `attachment-path-${index}`)}
              </div>
            </div>
          ) : null}
        >
          {att.isImage ? (
            <a
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              className="relative cursor-pointer rounded-xl border border-gray-300 bg-white p-1 hover:bg-[#fffdf0] hover:border-orange-300 transition-all flex items-center justify-center"
              onClick={(event) => {
                if (onPreview) {
                  event.preventDefault();
                  onPreview(att.url, att.name);
                }
              }}
              title={t('common.previewImage')}
            >
              <img src={att.url} alt={att.name} className="w-20 h-20 object-cover rounded-lg" />
            </a>
          ) : (
            (() => {
              const fileName = att.name || t('common.file');
              const isHtmlFile = isHtmlAttachmentFile(fileName, att.url);
              const { Icon, typeText, bgColor } = getFileIconInfo(fileName);
              return (
                <div className={FILE_ATTACHMENT_CARD_CLASS_NAME}>
                  <div
                    className="flex items-center gap-3 p-2.5 rounded-xl border border-gray-300 bg-white hover:bg-[#fffdf0] hover:border-orange-300 cursor-pointer transition-all w-full"
                    onClick={(event) => {
                      if (onPreview) {
                        event.preventDefault();
                        onPreview(att.url, fileName);
                      } else {
                        window.open(att.url, '_blank');
                      }
                    }}
                  >
                    <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0 border border-gray-100`}>
                      <Icon className="w-5 h-5 text-white" />
                    </div>
                    <div className={`flex flex-col min-w-0 ${isHtmlFile ? 'pr-20' : 'pr-12'} w-full relative`}>
                      <div className="text-[13px] font-bold text-gray-800 truncate transition-colors w-full leading-snug">
                        {fileName}
                      </div>
                      <span className="text-[11px] text-gray-400 font-medium mt-0.5">{typeText}</span>
                    </div>
                    <FileAttachmentActions url={att.url} filename={fileName} />
                  </div>
                </div>
              );
            })()
          )}
        </LocalPathAttachmentGuard>
      ))}
    </div>
  );

  return (
    <div key={id}>
      {showDateDivider && (
        <div className="flex items-center justify-center my-8 gap-4">
          <div className="h-px bg-gray-100 flex-1"></div>
          <span className="px-4 py-1.5 bg-[#eff1f4] text-gray-500 text-[11px] rounded-full">
            {timestamp.toLocaleDateString(currentLocale, { year: 'numeric', month: 'long', day: 'numeric' })}
          </span>
          <div className="h-px bg-gray-100 flex-1"></div>
        </div>
      )}
	      
	      {role === 'system' && (
	        <div data-msg-id={id} className={`flex justify-center transition-all duration-500 ${isHighlighted ? 'ring-4 ring-blue-500/20 bg-[#eff6ff] px-4 py-2 rounded-2xl' : ''}`}>
	          <div className={`text-xs text-gray-500 bg-gray-100 px-3 py-1.5 border border-gray-200 ${rawDetail ? 'rounded-2xl max-w-xl w-full' : 'rounded-full'}`}>
              <div>{highlightSearchNodes(content, normalizedSearchQuery, `system-${id}`)}</div>
              {rawDetail && (
                <div className="mt-2 pt-2 border-t border-gray-200 text-[11px] text-gray-400 whitespace-pre-wrap break-all font-mono">
                  {rawDetail}
                </div>
              )}
            </div>
	        </div>
	      )}

      {role !== 'system' && (
      <div data-msg-id={id} {...(role === 'user' ? {'data-user-msg-id': id} : {})} className={`flex w-full mb-6 transition-all duration-500 group/msg ${isHighlighted ? 'ring-4 ring-blue-500/20 bg-[#eff6ff] -mx-4 px-4 py-2 rounded-2xl' : ''} ${role === 'user' ? 'justify-end' : 'flex-col justify-start items-start'}`}>
        <div className={`flex flex-col min-w-0 ${isEditing ? 'w-full' : (role === 'user' ? 'items-end max-w-[85%]' : 'items-start flex-1 w-full')}`}>
          
          {role === 'assistant' && (
            <div className="flex items-center gap-3 mb-4 flex-wrap w-full">
              {avatarUrl ? (
                <img src={avatarUrl} alt={t('common.ai')} className="w-8 h-8 rounded-full border border-gray-200 object-cover bg-gray-50 flex-shrink-0" />
              ) : avatarChar ? (
                <div className={`w-8 h-8 rounded-full ${avatarColorClass || 'bg-blue-500'} border border-gray-200 flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
                  {avatarChar}
                </div>
              ) : (
                <div className="w-8 h-8 rounded-full border border-gray-200 object-cover bg-gray-50 flex-shrink-0" />
              )}
              <div className="flex items-end gap-2 flex-wrap min-w-0">
                <span className="text-[17px] font-bold text-gray-900 leading-none">{agentName || t('common.ai')}</span>
                {modelDisplayName && (
                  <span className="self-end text-gray-500 text-[12px] leading-none tracking-tight ml-1">
                    {modelDisplayName}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className={`group relative text-[16px] leading-[1.6] transition-all duration-300 w-full ${
            role === 'user' 
              ? `text-[#1f2937] border ${isEditing ? 'p-1' : 'px-5 py-3'} rounded-[20px] rounded-tr-[4px] ${isHighlighted ? 'bg-[#f7fbff] border-blue-300' : 'bg-gray-50 border-gray-200'}`
              : `text-[#1f2937] border-none p-0 bg-transparent`
          }`}>
            {isEditing ? (
              <div 
                className={`flex flex-col gap-0 w-full bg-white rounded-2xl border-2 transition-colors overflow-hidden ${canAcceptEditFileDrop && editIsDragging ? 'border-blue-400 bg-blue-50/30' : 'border-blue-200'}`}
                onDragOver={canAcceptEditFileDrop ? (e => { e.preventDefault(); onSetEditIsDragging?.(true); }) : undefined}
                onDragLeave={canAcceptEditFileDrop ? (e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onSetEditIsDragging?.(false); }) : undefined}
                onDrop={canAcceptEditFileDrop ? (e => {
                  e.preventDefault();
                  onSetEditIsDragging?.(false);
                  const files = Array.from(e.dataTransfer.files);
                  if (!files.length) return;
                  onDropNewFiles?.(files);
                }) : undefined}
              >
                {/* File previews row (existing + new) */}
                {((editExistingAttachments?.length || 0) > 0 || (editPendingFiles?.length || 0) > 0) && (
                  <div className="flex flex-wrap gap-2 p-3 pb-0 animate-in fade-in">
                    {/* Existing attachments */}
                    {editExistingAttachments?.map((att, idx) => (
                      <div key={`existing-${idx}`} className={`relative group ${ att.isImage ? 'w-20 h-20' : 'w-max min-w-[100px] max-w-[180px] h-12 pl-2 pr-3 flex items-center gap-2' } rounded-xl overflow-hidden bg-white border border-gray-300 flex-shrink-0 hover:border-red-200 transition-all`}>
                        {att.isImage ? (
                          <img src={att.url} className="w-full h-full object-cover" alt={att.name} />
                        ) : (() => {
                          const { Icon, typeText, bgColor } = getFileIconInfo(att.name);
                          return (
                            <>
                              <div className={`w-8 h-8 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0`}>
                                <Icon className="w-4 h-4 text-white" />
                              </div>
                              <div className="flex flex-col min-w-0 pr-3">
                                <span className="text-[11px] font-semibold text-gray-700 truncate w-full">{att.name}</span>
                                <span className="text-[10px] text-gray-400">{typeText}</span>
                              </div>
                            </>
                          );
                        })()}
                        <button
                          type="button"
                          onClick={() => {
                            if (onSetEditExistingAttachments) {
                                onSetEditExistingAttachments(prev => prev.filter((_, i) => i !== idx));
                            }
                          }}
                          className="absolute top-1 right-1 bg-black/60 hover:bg-red-500 text-white rounded-full p-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {/* Newly added files */}
                    {editPendingFiles?.map((pf, idx) => (
                      <div key={`new-${idx}`} className={`relative group ${ pf.preview ? 'w-20 h-20' : 'w-max min-w-[100px] max-w-[180px] h-12 pl-2 pr-3 flex items-center gap-2' } rounded-xl overflow-hidden bg-white border border-gray-300 flex-shrink-0 hover:border-red-200 transition-all`}>
                        {pf.preview ? (
                          <img src={pf.preview} className="w-full h-full object-cover" alt="preview" />
                        ) : (() => {
                          const { Icon, typeText, bgColor } = getFileIconInfo(pf.file.name);
                          return (
                            <>
                              <div className={`w-8 h-8 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0`}>
                                <Icon className="w-4 h-4 text-white" />
                              </div>
                              <div className="flex flex-col min-w-0 pr-3">
                                <span className="text-[11px] font-semibold text-gray-700 truncate w-full">{pf.file.name.split('.')[0]}</span>
                                <span className="text-[10px] text-gray-400">{typeText}</span>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  className={`w-full min-h-[60px] resize-none outline-none border-none text-[16px] font-medium bg-transparent leading-relaxed ${((editExistingAttachments?.length || 0) > 0 || (editPendingFiles?.length || 0) > 0) ? 'p-3 pt-2' : 'p-3'}`}
                  value={editContent || ''}
                  onChange={e => onSetEditContent?.(e.target.value)}
                  autoFocus
                  onFocus={(e) => {
                    const val = e.target.value;
                    e.target.value = '';
                    e.target.value = val;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      onSaveEdit?.();
                    } else if (e.key === 'Escape') {
                      onCancelEdit?.();
                    }
                  }}
                  placeholder={t('messageBubble.editMessagePlaceholder')}
                />
                <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-gray-100 bg-gray-50/50">
                  <button
                    onClick={onCancelEdit}
                    className="inline-flex min-w-[72px] flex-shrink-0 items-center justify-center whitespace-nowrap px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 text-sm font-medium transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={onSaveEdit}
                    className="inline-flex min-w-[72px] flex-shrink-0 items-center justify-center whitespace-nowrap px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium transition-colors"
                  >
                    {t('common.send')}
                  </button>
                </div>
              </div>
            ) : (
              <div className={`prose prose-sm max-w-none prose-slate text-[16px] pb-1 ${role === 'user' ? 'prose-pre:bg-gray-50' : (isHighlighted ? 'prose-pre:bg-[#f7fbff]' : 'prose-pre:bg-gray-50')}`}>
                {shouldRenderExplicitProcessBlock ? (
                  <ProcessStepBlock
                    content={explicitProcessContent}
                    initiallyExpanded={isProcessExpanded}
                    forceExpanded={shouldAutoExpandProcessBlocks}
                    searchQuery={normalizedSearchQuery}
                    isExtractingProcess={!!processStreaming}
                    onPreview={onPreview}
                    processStartTag={processStartTag}
                    processEndTag={processEndTag}
                  />
                ) : null}
                {/* Always show images/files at the top if there are any trailing attachments */}
                {(() => {
                  const { attachments } = parseAttachmentsFromContent(displayContent);
                  if (attachments.length > 0) {
                    return (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {attachments.map((att, i) =>
                          att.isImage ? (
                            <a href={att.url} target="_blank" rel="noopener noreferrer" key={i} 
                               className="relative cursor-pointer rounded-xl border border-gray-200 bg-white p-1 hover:bg-[#fffdf0] hover:border-orange-300 transition-all flex items-center justify-center"
                               onClick={(e) => {
                                  if (onPreview) { e.preventDefault(); onPreview(att.url, att.name); }
                               }}
                               title={t('common.previewImage')}
                            >
                              <img src={att.url} alt={att.name} className="w-20 h-20 object-cover rounded-lg" />
                            </a>
                          ) : (
                            (() => {
                              const fileName = att.name || t('common.file');
                              const isHtmlFile = isHtmlAttachmentFile(fileName, att.url);
                              const { Icon, typeText, bgColor } = getFileIconInfo(fileName);
                              return (
                                <div key={i} className={FILE_ATTACHMENT_CARD_CLASS_NAME}>
                                  <div className="flex items-center gap-3 p-2.5 rounded-xl border border-gray-200 bg-white hover:bg-[#fffdf0] hover:border-orange-300 cursor-pointer transition-all w-full"
                                       onClick={(e) => {
                                          if (onPreview) {
                                             e.preventDefault();
                                             onPreview(att.url, fileName);
                                          } else {
                                             window.open(att.url, '_blank');
                                          }
                                       }}>
                                    <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0 border border-gray-100`}>
                                      <Icon className="w-5 h-5 text-white" />
                                    </div>
                                    <div className={`flex flex-col min-w-0 ${isHtmlFile ? 'pr-20' : 'pr-12'} w-full relative`}>
                                      <div className="text-[13px] font-bold text-gray-800 truncate transition-colors w-full leading-snug">
                                        {fileName}
                                      </div>
                                      <span className="text-[11px] text-gray-400 font-medium mt-0.5">{typeText}</span>
                                    </div>
                                    <FileAttachmentActions url={att.url} filename={fileName} />
                                  </div>
                                </div>
                              );
                            })()
                          )
                        )}
                      </div>
                    );
                  }
                  return null;
                })()}

                {(() => {
                    const { text } = parseAttachmentsFromContent(displayContent);
                    const renderSearchHighlighted = (children: React.ReactNode, scope: string) => (
                      highlightSearchNodes(children, normalizedSearchQuery, `${scope}-${id}`)
                    );
                    const markdownComponents: any = {
                      pre({ node, children, ...props }: any) {
                        let isProcessStep = false;
                        let hasStandaloneFileLinks = false;
                        let hasMixedMarkdownFileLinks = false;
                        React.Children.forEach(children, (child: any) => {
                          if (child?.props?.className?.includes('language-process_step_thought')) {
                            isProcessStep = true;
                          }
                          const childText = child?.props?.children ? String(child.props.children).replace(/\n$/, '') : '';
                          if (extractStandaloneFileLinks(childText.trim()).length > 0) {
                            hasStandaloneFileLinks = true;
                          }
                          const childLanguage = getCodeLanguage(child?.props?.className);
                          const embeddedFiles = extractPreviewableLinksAndText(childText.trim());
                          if (
                            embeddedFiles.attachments.length > 0
                            && shouldRenderEmbeddedFilesAsMarkdown(childLanguage, embeddedFiles.text)
                          ) {
                            hasMixedMarkdownFileLinks = true;
                          }
                        });
                        if (isProcessStep) return <>{children}</>;
                        if (hasStandaloneFileLinks || hasMixedMarkdownFileLinks) return <>{children}</>;
                        return <pre {...props}>{children}</pre>;
                      },
                      code({ node, inline, className, children, ...props }: any) {
                        const codeLanguage = getCodeLanguage(className);
                        const codeText = children ? String(children).replace(/\n$/, '') : '';
                        const isInlineCode = typeof inline === 'boolean'
                          ? inline
                          : isInlineMarkdownCodeNode(node, className);
                        const inlineLinkHref = isInlineCode ? normalizeNavigableHref(codeText) : null;
                        const codeCopyId = !inline ? buildCodeCopyId(id, node, codeText) : '';
                        const isCodeCopied = !inline && activeCopiedId === codeCopyId;
                        const standaloneFileLinks = !inline ? extractStandaloneFileLinks(codeText.trim()) : [];
                        const embeddedFileLinks = !inline ? extractPreviewableLinksAndText(codeText.trim()) : { attachments: [], text: codeText };
                        const singleLocalPath = !inline ? extractSingleLocalPath(codeText) : null;
                        const singleFileAttachment = !inline && singleLocalPath ? buildFileAttachmentFromPath(codeText, singleLocalPath) : null;
                        if (!inline && singleFileAttachment) {
                          return renderFileAttachmentCards([singleFileAttachment], `code-path-file-${id}`);
                        }
                        if (!inline && singleLocalPath) {
                          return (
                            <div className="not-prose mb-4 max-w-full">
                              <div
                                dir="ltr"
                                title={singleLocalPath}
                                className="max-w-full whitespace-pre-wrap break-all font-mono text-[14px] leading-6 text-gray-700"
                              >
                                {renderSearchHighlighted(singleLocalPath, 'path-block')}
                              </div>
                            </div>
                          );
                        }
                        if (!inline && standaloneFileLinks.length > 0) {
                          return renderFileAttachmentCards(standaloneFileLinks, `code-file-${id}`);
                        }
                        if (
                          !inline
                          && embeddedFileLinks.attachments.length > 0
                          && shouldRenderEmbeddedFilesAsMarkdown(codeLanguage, embeddedFileLinks.text)
                        ) {
                          return (
                            <div className="mb-4">
                              {renderFileAttachmentCards(embeddedFileLinks.attachments, `code-file-mixed-${id}`)}
                              {embeddedFileLinks.text.trim() ? (
                                <div className="prose prose-sm max-w-none prose-slate text-[16px] pb-1">
                                  <ReactMarkdown
                                    remarkPlugins={markdownRemarkPlugins}
                                    rehypePlugins={markdownRehypePlugins}
                                    components={markdownComponents}
                                  >
                                    {normalizeMathMarkdown(embeddedFileLinks.text)}
                                  </ReactMarkdown>
                                </div>
                              ) : null}
                            </div>
                          );
                        }
                        if (!inline && (codeLanguage === 'process_step_thought' || codeLanguage === 'process_step_thought_streaming')) {
                           return (
                             <ProcessStepBlock
                               content={codeText.trim()}
                               initiallyExpanded={isProcessExpanded}
                               forceExpanded={shouldAutoExpandProcessBlocks}
                               searchQuery={normalizedSearchQuery}
                               isExtractingProcess={codeLanguage === 'process_step_thought_streaming'}
                               onPreview={onPreview}
                               processStartTag={processStartTag}
                               processEndTag={processEndTag}
                             />
                           );
                        }
                        if (!inline && codeLanguage === 'chat_quote') {
                           const lines = codeText.split('\n');
                           const meta = lines[0] || '';
                           const sepIdx = meta.indexOf('|');
                           const author = sepIdx !== -1 ? meta.slice(0, sepIdx) : t('common.unknown');
                           const time = sepIdx !== -1 ? meta.slice(sepIdx + 1) : '';
                           const quoteContent = normalizeMalformedFencedBlocks(
                             normalizeProcessBlocks(lines.slice(1).join('\n'), processStartTag, processEndTag)
                           );

                           const quoteMarkdownComponents = {
                             ...markdownComponents,
                             p(props: any) {
                               const nodes = props.node?.children || [];
                               const isAttachmentBlock = nodes.length > 0 && nodes.every(
                                 (child: any) =>
                                     (child.type === 'element' && child.tagName === 'img') ||
                                     (child.type === 'element' && child.tagName === 'a') ||
                                     (child.type === 'text' && child.value.trim() === '') ||
                                     (child.type === 'element' && child.tagName === 'br')
                               );

                               const attachmentCount = nodes.filter(
                                 (c: any) => c.type === 'element' && (c.tagName === 'img' || c.tagName === 'a')
                               ).length;

                               if (isAttachmentBlock && attachmentCount > 0) {
                                 return (
                                   <div className="flex flex-wrap gap-2 w-full items-start" style={{ marginTop: 0, marginBottom: '0.25rem' }}>
                                     {renderSearchHighlighted(props.children, 'quote-p-attachments')}
                                   </div>
                                 );
                               }
                               return (
                                 <p style={{ marginTop: 0, marginBottom: '0.25rem', wordBreak: 'break-word' }} {...props}>
                                   {renderSearchHighlighted(props.children, 'quote-p')}
                                 </p>
                               );
                             },
                             ol(props: any) {
                               return <ol style={{ marginTop: '0.125rem', marginBottom: '0.25rem', paddingLeft: 0, listStyle: 'none' }} {...props} />;
                             },
                             ul(props: any) {
                               return <ul style={{ marginTop: '0.125rem', marginBottom: '0.25rem', paddingLeft: 0, listStyle: 'none' }} {...props} />;
                             },
                             li(props: any) {
                               return (
                                 <li style={{ marginTop: 0, marginBottom: '0.25rem' }} {...props}>
                                   {renderSearchHighlighted(props.children, 'quote-li')}
                                 </li>
                               );
                             },
                             code(props: any) {
                               const innerMatch = /language-(\w+)/.exec(props.className || '');
                               const codeText = props.children ? String(props.children).replace(/\n$/, '') : '';
                               // Handle dense process step block inside quotes
                               if (!props.inline && innerMatch && (innerMatch[1] === 'process_step_thought' || innerMatch[1] === 'process_step_thought_streaming')) {
                                  return (
                                    <ProcessStepBlock
                                      content={codeText.trim()}
                                      initiallyExpanded={isProcessExpanded}
                                      forceExpanded={shouldAutoExpandProcessBlocks}
                                      searchQuery={normalizedSearchQuery}
                                      isExtractingProcess={innerMatch[1] === 'process_step_thought_streaming'}
                                      isDense
                                      onPreview={onPreview}
                                      processStartTag={processStartTag}
                                      processEndTag={processEndTag}
                                    />
                                  );
                               }
                               // Delegate normal code blocks logic back to main component
                               return markdownComponents.code(props);
                             }
                           };

                           return <QuoteBlock author={author} time={time} content={quoteContent} components={quoteMarkdownComponents} />;
                        }
                        if (isInlineCode && inlineLinkHref) {
                          return (
                            <a
                              href={inlineLinkHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`${EXTERNAL_LINK_CLASS_NAME} font-mono`}
                            >
                              {renderSearchHighlighted(codeText, 'inline-link')}
                            </a>
                          );
                        }
                        return !isInlineCode && codeLanguage ? (
                          <div className="relative group/code mt-4 mb-4 inline-block w-fit max-w-full align-top overflow-hidden rounded-xl border border-gray-300 bg-white transition-colors hover:bg-[#f3f5f8]">
                            <div className="absolute right-3 top-3 z-20">
                              <button
                                onClick={() => onCopy?.(codeText, codeCopyId)}
                                className={`p-1.5 rounded-md border cursor-pointer transition-colors flex items-center justify-center ${
                                  isCodeCopied === true
                                    ? 'opacity-100 '
                                    : 'opacity-0 group-hover/code:opacity-100 '
                                }${
                                  isCodeCopied === true
                                    ? 'bg-green-50 border-green-200 text-green-600 hover:bg-green-50 hover:border-green-200'
                                    : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600'
                                }`}
                                title={isCodeCopied === true ? t('common.copied') : t('common.copyCode')}
                              >
                                {isCodeCopied === true ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                              </button>
                            </div>
                            <SyntaxHighlighter
                              {...props}
                              style={oneLight as any}
                              language={codeLanguage}
                              PreTag="div"
                              codeTagProps={{
                                className: '!bg-transparent',
                                style: { backgroundColor: 'transparent' },
                              }}
                              className="!rounded-xl !text-[14px] !bg-[#f8f9fa] group-hover/code:!bg-[#f1f4f7] !p-5 !pr-14 !m-0 !max-w-full !overflow-x-auto transition-colors"
                            >
                              {codeText}
                            </SyntaxHighlighter>
                          </div>
                        ) : isInlineCode ? (
                          <code className="bg-[#f1f3f4] text-[#d93025] px-1.5 py-0.5 rounded font-mono text-[14px]" {...props}>
                            {children}
                          </code>
                        ) : (
                          <code className="bg-[#f1f3f4] text-[#d93025] px-1.5 py-0.5 rounded font-mono text-[14px]" {...props}>
                            {children}
                          </code>
                        );
                      },
                      img(props: any) {
                        return (
                          <a href={props.src} target="_blank" rel="noopener noreferrer" 
                             onClick={(e) => {
                               if (onPreview && props.src) {
                                  e.preventDefault();
                                  onPreview(props.src, props.alt || t('common.file'));
                               }
                             }}
                             className="block my-4 p-1.5 rounded-xl border border-gray-200 bg-white w-max max-w-full hover:bg-[#fffdf0] hover:border-orange-300 transition-all cursor-pointer">
                            <img src={props.src} alt={props.alt || t('common.file')} className="max-w-[300px] w-[300px] max-h-[300px] object-cover block my-0 rounded-lg" />
                          </a>
                        );
                      },
                      a(props: any) {
                        if (props.href?.startsWith('/uploads/') || props.href?.startsWith('/api/files/')) {
                          const nodes = Array.isArray(props.children) ? props.children : [props.children];
                          const fileName = nodes.map((n: any) => String(n)).join('') || t('common.file');
                          const isHtmlFile = isHtmlAttachmentFile(fileName, props.href);
                          const { Icon, typeText, bgColor } = getFileIconInfo(fileName);
                          return (
                            <div className={`${FILE_ATTACHMENT_CARD_CLASS_NAME} mr-3 mb-3`}>
                              <div className="flex items-center gap-3 p-2.5 rounded-xl border border-gray-200 bg-white hover:bg-[#fffdf0] hover:border-orange-300 cursor-pointer transition-all w-full"
                                   onClick={(e) => {
                                      if (onPreview) {
                                         e.preventDefault();
                                         onPreview(props.href, fileName);
                                      } else {
                                         window.open(props.href, '_blank');
                                      }
                                   }}>
                                <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0 border border-gray-100`}>
                                  <Icon className="w-5 h-5 text-white" />
                                </div>
                                <div className={`flex flex-col min-w-0 ${isHtmlFile ? 'pr-20' : 'pr-12'} w-full relative`}>
                                  <div className="text-[13px] font-bold text-gray-800 truncate transition-colors w-full leading-snug">
                                    {fileName}
                                  </div>
                                  <span className="text-[11px] text-gray-400 font-medium mt-0.5">{typeText}</span>
                                </div>
                                <FileAttachmentActions url={props.href} filename={fileName} />
                              </div>
                            </div>
                          );
                        }
                        const normalizedHref = normalizeNavigableHref(props.href);
                        return (
                          <a
                            {...props}
                            href={normalizedHref || props.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={EXTERNAL_LINK_CLASS_NAME}
                          >
                            {renderSearchHighlighted(props.children, 'link')}
                          </a>
                        );
                      },
                      h1(props: any) {
                        return <h1 {...props}>{renderSearchHighlighted(props.children, 'h1')}</h1>;
                      },
                      h2(props: any) {
                        return <h2 {...props}>{renderSearchHighlighted(props.children, 'h2')}</h2>;
                      },
                      h3(props: any) {
                        return <h3 {...props}>{renderSearchHighlighted(props.children, 'h3')}</h3>;
                      },
                      h4(props: any) {
                        return <h4 {...props}>{renderSearchHighlighted(props.children, 'h4')}</h4>;
                      },
                      h5(props: any) {
                        return <h5 {...props}>{renderSearchHighlighted(props.children, 'h5')}</h5>;
                      },
                      h6(props: any) {
                        return <h6 {...props}>{renderSearchHighlighted(props.children, 'h6')}</h6>;
                      },
                      p(props: any) {
                        const embedPreviews = parseStandaloneEmbedPreviews(getMarkdownNodePlainText(props.node));
                        if (embedPreviews.length > 0) {
                          return (
                            <div className="w-full">
                              {embedPreviews.map((embed, index) => (
                                <EmbedPreviewCard key={`${embed.url}-${index}`} embed={embed} />
                              ))}
                            </div>
                          );
                        }

                        const nodes = props.node?.children || [];
                        const isAttachmentBlock = nodes.length > 0 && nodes.every(
                          (child: any) => 
                              (child.type === 'element' && child.tagName === 'img') || 
                              (child.type === 'element' && child.tagName === 'a') || 
                              (child.type === 'text' && child.value.trim() === '') ||
                              (child.type === 'element' && child.tagName === 'br')
                        );
                        
                        const attachmentCount = nodes.filter(
                          (c: any) => c.type === 'element' && (c.tagName === 'img' || c.tagName === 'a')
                        ).length;
                        
                        if (isAttachmentBlock && attachmentCount > 0) {
                          return (
                            <div className="flex flex-wrap gap-3 mb-4 w-full items-start">
                              {renderSearchHighlighted(props.children, 'p-attachments')}
                            </div>
                          );
                        }
                        return (
                          <p className="mb-4 last:mb-0 break-words" {...props}>
                            {renderSearchHighlighted(props.children, 'p')}
                          </p>
                        );
                      },
                      li(props: any) {
                        return <li {...props}>{renderSearchHighlighted(props.children, 'li')}</li>;
                      },
                      td(props: any) {
                        return <td {...props}>{renderSearchHighlighted(props.children, 'td')}</td>;
                      },
                      th(props: any) {
                        return <th {...props}>{renderSearchHighlighted(props.children, 'th')}</th>;
                      }
                    };

                    return (
                  <ReactMarkdown
                    remarkPlugins={markdownRemarkPlugins}
                    rehypePlugins={markdownRehypePlugins}
                    components={markdownComponents}
                  >
                    {normalizeMathMarkdown(text)}
                  </ReactMarkdown>
                  );
                })()}
                {shouldRenderExecutingPlaceholder ? (
                  <div className="not-prose text-[16px] leading-[1.6] text-gray-500">
                    <AnimatedExecutingPlaceholder label={t('messageBubble.executingPlaceholder')} />
                  </div>
                ) : null}


              </div>
            )}
          </div>
          
          <div className={`mt-2 flex items-center gap-1.5 text-[14px] text-gray-500 font-sans font-normal w-full ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <span className={`text-[12px] opacity-70 font-sans ${role === 'user' ? 'mr-0' : 'mr-2'}`}>{timestamp.toLocaleTimeString(currentLocale, { hour: '2-digit', minute: '2-digit' })}</span>

            {role === 'user' && isLatest && (
              <button 
                onClick={() => {
                  const { attachments, text } = parseAttachmentsFromContent(content);
                  onEditClick?.(attachments, text);
                }} 
                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-all group/btn outline-none relative" 
                title={t('common.edit')}
              >
                 <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
              </button>
            )}
            
            {role === 'assistant' && onRegenerate && isLatest && (
              <button disabled={isLoading} onClick={onRegenerate} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-all group/btn outline-none relative disabled:opacity-50" title={t('common.regenerate')}>
                <RefreshCw className="w-[15px] h-[15px]" />
              </button>
            )}

            {onQuote && (
              <button onClick={onQuote} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-all group/btn outline-none relative" title={t('common.quote')}>
                  <Quote className="w-4 h-4" />
              </button>
            )}

            <button onClick={() => onCopy?.(content, id)} className={`p-1.5 hover:bg-blue-50 rounded-md transition-all group/btn outline-none relative ${isCopied ? 'text-blue-600 bg-blue-50' : 'text-gray-400 hover:text-blue-600'}`} title={t('common.copy')}>
                {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>

            {onDelete && (
              <button onClick={onDelete} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-all group/btn outline-none relative" title={t('common.delete')}>
                  <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
    </div>
      )}
    </div>
  );
};

// Custom comparator: skip function props (they're always recreated inline in .map() loops)
// Only re-render when data props actually change
const messageBubbleAreEqual = (prevProps: MessageProps, nextProps: MessageProps): boolean => {
  const dataKeys: (keyof MessageProps)[] = [
    'id', 'role', 'content', 'processContent', 'processStreaming', 'rawDetail', 'isHighlighted', 'searchQuery', 'showDateDivider',
    'agentName', 'modelDisplayName', 'avatarUrl', 'avatarChar', 'avatarColorClass',
    'isEditing', 'editContent', 'editIsDragging',
    'isCopied', 'activeCopiedId', 'isLoading', 'isLatest',
    'processStartTag', 'processEndTag',
    'preserveProcessExpansionWhenNotLatest'
  ];
  for (const key of dataKeys) {
    if (prevProps[key] !== nextProps[key]) return false;
  }
  // Check timestamp by value (Date objects are always new)
  if (prevProps.timestamp?.getTime() !== nextProps.timestamp?.getTime()) return false;
  return true;
};

export const MessageBubble = React.memo(MessageBubbleInner, messageBubbleAreEqual);
