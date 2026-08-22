import { useState, useEffect, useRef } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import * as pdfjsLib from 'pdfjs-dist';
import type { Book, Rendition } from 'epubjs';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { getFileIconInfo } from '../utils/fileUtils';

// Configure pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

interface FilePreviewModalProps {
  url: string;
  filename: string;
  onClose: () => void;
}

const TEXT_SELECTION_STYLE = {
  userSelect: 'text' as const,
  WebkitUserSelect: 'text' as const,
  WebkitTouchCallout: 'default' as const,
};

const HTML_PREVIEW_ROUTE_PADDING_SEGMENT = '__claw_preview_root__';
const HTML_PREVIEW_ROUTE_PADDING_DEPTH = 24;
const DOCUMENT_PREVIEW_WIDTH_CLASS = 'max-w-[1200px]';
const DOCUMENT_PREVIEW_SCROLL_CLASS = 'w-full h-full overflow-y-auto';
const DOCUMENT_PREVIEW_SURFACE_CLASS = `w-full ${DOCUMENT_PREVIEW_WIDTH_CLASS} mx-auto bg-white sm:rounded-2xl sm:border border-gray-200`;
const DOCUMENT_PREVIEW_BODY_CLASS = 'p-6 sm:p-10';

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

function buildRenderedHtmlDocument(content: string): string {
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

type PreviewState = 
  | { status: 'loading' }
  | { status: 'ready'; type: 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'text' | 'code' | 'epub' | 'unsupported'; content?: string; pdfUrl?: string; pdfData?: Uint8Array; epubData?: ArrayBuffer }
  | { status: 'error'; message: string };

// Cache capabilities result
let cachedCapabilities: { libreoffice: boolean } | null = null;

function resolvePreviewErrorMessage(
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

async function getCapabilities(): Promise<{ libreoffice: boolean }> {
  if (cachedCapabilities) return cachedCapabilities;
  try {
    const res = await fetch('/api/files/capabilities');
    cachedCapabilities = await res.json();
    return cachedCapabilities!;
  } catch {
    cachedCapabilities = { libreoffice: false };
    return cachedCapabilities;
  }
}

function getFileType(filename: string): string {
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

function isLibreOfficeHintRelevant(fileType: string): boolean {
  return ['docx', 'xlsx', 'csv', 'pptx'].includes(fileType);
}

function getFileExtension(filename: string): string {
  const cleanName = filename.split(/[?#]/, 1)[0].trim();
  return cleanName.split('.').pop()?.toLowerCase() || '';
}

function getDefaultViewMode(filename: string): 'source' | 'render' {
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

function buildPreviewUrl(url: string): string {
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

function buildPreviewDataUrl(url: string, mode: 'source' | 'converted' = 'source'): string | null {
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

function buildHtmlPreviewRenderUrl(url: string): string | null {
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

function decodeBase64ToBytes(base64: string): Uint8Array {
  const normalized = base64.trim();
  const binary = window.atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

// Zoomable Wrapper for mobile pinch-to-zoom using react-zoom-pan-pinch
function ZoomableWrapper({ children, center = false }: { children: React.ReactNode, center?: boolean }) {
  const [isZoomed, setIsZoomed] = useState(false);

  return (
    <div className={`w-full h-full flex flex-col ${center ? 'items-center justify-center' : 'items-start justify-start'} overflow-hidden`}>
      <TransformWrapper
        initialScale={1}
        minScale={1}
        maxScale={4}
        centerOnInit={center}
        centerZoomedOut={center}
        limitToBounds={false}
        wheel={{ step: 0.1, activationKeys: ["Control", "Meta"] }} // Require Ctrl/Cmd to zoom on PC to restore native mouse wheel scroll
        doubleClick={{ step: 0.5 }}
        panning={{ disabled: !isZoomed, velocityDisabled: true }} // Disable JS pan when unzoomed to restore native 1-finger scroll
        alignmentAnimation={{ animationTime: 200 }}
        onZoom={(ref) => setIsZoomed(ref.state.scale > 1)}
        onZoomStop={(ref) => {
          const zoomed = ref.state.scale > 1.05; // give a slight buffer for floating point
          setIsZoomed(zoomed);
          if (!zoomed) {
            // Snap back to exactly center (x=0, y=0) when fully zoomed out
            // This fixes the issue where panning off-axis leaves blank space 
            ref.resetTransform();
          }
        }}
        onInit={(ref) => setIsZoomed(ref.state.scale > 1)}
        // `TransformWrapper` renders a hidden dom element that wraps `TransformComponent`.
        // By default it grows to `max-content`. Adding basic dimension constraint via CSS.
      >
        <TransformComponent 
          wrapperStyle={{ 
            width: '100%', 
            height: '100%', 
            // Crucial fix: DO NOT toggle overflow dynamically. 
            // It causes massive React re-renders and reflows during touch events,
            // resulting in lag, Android tearing, and iOS Safari crashes.
            overflowY: 'auto',
            overflowX: 'hidden',
            touchAction: isZoomed ? 'none' : 'pan-y' // Tell browser to natively allow vertical scroll or block it
          }} 
          contentStyle={{ 
            width: '100%', 
            minHeight: '100%', 
            display: center ? 'flex' : 'block',
            alignItems: center ? 'center' : 'flex-start',
            justifyContent: center ? 'center' : 'flex-start',
            willChange: isZoomed ? 'transform' : 'auto' 
          }}
        >
          {children}
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
}

// PDF Canvas Viewer — renders each page as a canvas (works on mobile)
function PdfCanvasViewer({ pdfUrl, pdfData }: { pdfUrl?: string; pdfData?: Uint8Array }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [renderedPages, setRenderedPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { t } = useTranslation();


  useEffect(() => {
    let cancelled = false;
    const loadPdf = async () => {
      try {
        setLoading(true);
        setError('');
        setRenderedPages(0);
        const source = pdfData ? { data: pdfData } : pdfUrl;
        if (!source) {
          throw new Error(t('filePreview.loadPdfFail'));
        }
        const pdf = await pdfjsLib.getDocument(source as any).promise;
        if (cancelled) return;
        setPageCount(pdf.numPages);

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = '';

        const containerWidth = container.clientWidth - 32; // account for padding

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          if (cancelled) return;

          const baseViewport = page.getViewport({ scale: 1 });
          const dpr = window.devicePixelRatio || 1;
          const fitScale = containerWidth / baseViewport.width;
          
          const isMobile = window.innerWidth <= 768;
          const isLargePdf = pdf.numPages >= 120;
          // Cap large-document render scale to keep huge PDFs responsive instead of blocking on hundreds of canvases.
          const desktopScaleMultiplier = isLargePdf ? 1.15 : 2;
          const renderScale = fitScale * (isMobile ? Math.min(dpr, 1.5) : Math.min(dpr * desktopScaleMultiplier, 2));
          
          const viewport = page.getViewport({ scale: renderScale });

          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = '100%'; // Let it scale to container
          canvas.style.height = 'auto';
          canvas.style.display = 'block';
          if (i > 1) {
            canvas.style.marginTop = '8px';
            canvas.style.borderTop = '1px solid #e5e7eb';
            canvas.style.paddingTop = '8px';
          }

          const ctx = canvas.getContext('2d');
          if (ctx) {
            await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          }
          if (cancelled) return;
          container.appendChild(canvas);
          setRenderedPages(i);
          if (i === 1) {
            setLoading(false);
          }
          if (i % 4 === 0) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          }
        }
        setLoading(false);
      } catch (err: any) {
         if (!cancelled) {
          setError(err.message || t('filePreview.loadPdfFail'));
          setLoading(false);
        }

      }
    };
    loadPdf();
    return () => { cancelled = true; };
  }, [pdfData, pdfUrl, t]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 bg-white p-8 rounded-2xl max-w-md text-center">
        <div className="w-16 h-16 rounded-2xl bg-red-100 flex items-center justify-center">
          <X className="w-8 h-8 text-red-500" />
        </div>
        <p className="text-sm font-medium text-gray-600">{error}</p>
      </div>
    );
  }

  return (
    <div className={`w-full ${DOCUMENT_PREVIEW_WIDTH_CLASS} mx-auto bg-white sm:rounded-2xl sm:border border-gray-200 relative min-h-[400px]`}>
      {loading && renderedPages === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
          <div className="flex flex-col items-center gap-3 text-gray-500">
             <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
            <span className="text-sm font-medium">{t('filePreview.renderingDoc')}</span>
          </div>

        </div>
      )}
      {renderedPages > 0 && renderedPages < pageCount && (
        <div className="sticky top-3 z-10 flex justify-end px-3 pt-3 pointer-events-none">
          <div className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white/95 px-3 py-1.5 text-xs text-gray-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
            <span>{t('filePreview.renderingDoc')}</span>
            <span>{renderedPages}/{pageCount}</span>
          </div>
        </div>
      )}
      <div ref={containerRef} className="p-4" />
      {!loading && pageCount > 0 && (
         <div className="sticky bottom-0 bg-white/90 backdrop-blur-sm border-t border-gray-100 px-4 py-2 text-center text-xs text-gray-400 font-medium">
          {t('filePreview.totalPages', { count: pageCount })}
        </div>

      )}
    </div>
  );
}

function EpubViewer({ epubData, filename }: { epubData?: ArrayBuffer; filename: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;

    const loadEpub = async () => {
      if (!epubData) {
        setError(t('filePreview.loadEpubFail'));
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError('');

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = '';

        const { default: createEpub } = await import('epubjs');
        const book = createEpub(epubData);
        bookRef.current = book;
        await book.ready;
        if (cancelled) return;

        const rendition = book.renderTo(container, {
          width: '100%',
          height: '100%',
          manager: 'continuous',
          flow: 'scrolled-doc',
          spread: 'none',
        });
        renditionRef.current = rendition;
        rendition.themes.default({
          body: {
            margin: '0 auto',
            padding: '24px 20px 40px',
            color: '#1f2937',
            background: '#ffffff',
            'font-size': '16px',
            'line-height': '1.85',
            'word-break': 'break-word',
          },
          p: {
            margin: '0 0 1em',
          },
          'img, svg, video': {
            'max-width': '100%',
            height: 'auto',
          },
          a: {
            color: '#2563eb',
          },
        });
        await rendition.display();
        if (cancelled) return;

        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setError(t('filePreview.previewEpubFail', { message: err?.message || filename }));
        setLoading(false);
      }
    };

    void loadEpub();

    return () => {
      cancelled = true;
      renditionRef.current?.destroy();
      renditionRef.current = null;
      bookRef.current?.destroy();
      bookRef.current = null;
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, [epubData, filename, t]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 bg-white p-8 rounded-2xl max-w-md text-center">
        <div className="w-16 h-16 rounded-2xl bg-red-100 flex items-center justify-center">
          <X className="w-8 h-8 text-red-500" />
        </div>
        <p className="text-sm font-medium text-gray-600">{error}</p>
      </div>
    );
  }

  return (
    <div className={`w-full ${DOCUMENT_PREVIEW_WIDTH_CLASS} mx-auto bg-white sm:rounded-2xl sm:border border-gray-200 relative min-h-[420px] h-full overflow-hidden`}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
          <div className="flex flex-col items-center gap-3 text-gray-500">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
            <span className="text-sm font-medium">{t('filePreview.renderingDoc')}</span>
          </div>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full overflow-auto" />
    </div>
  );
}

function HtmlFrameViewer({ src }: { src: string }) {
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation();

  useEffect(() => {
    setLoading(true);
  }, [src]);

  return (
    <div className="w-full h-full overflow-hidden">
      <div className={`w-full h-full ${DOCUMENT_PREVIEW_WIDTH_CLASS} mx-auto bg-white sm:rounded-2xl sm:border border-gray-200 relative min-h-[420px] overflow-hidden flex flex-col`}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
            <div className="flex flex-col items-center gap-3 text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
              <span className="text-sm font-medium">{t('filePreview.loadingPreview')}</span>
            </div>
          </div>
        )}
        <iframe
          key={src}
          src={src}
          title="HTML preview"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
          className="w-full flex-1 min-h-0 border-0 bg-white"
          onLoad={() => setLoading(false)}
        />
      </div>
    </div>
  );
}

 export default function FilePreviewModal({ url, filename, onClose }: FilePreviewModalProps) {
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [viewMode, setViewMode] = useState<'source' | 'render'>(() => getDefaultViewMode(filename));
  const { t } = useTranslation();
  const previewUrl = buildPreviewUrl(url);

  useEffect(() => {
    setViewMode(getDefaultViewMode(filename));
  }, [filename, url]);


  // --- History API Integration for Mobile Back Gesture ---
  useEffect(() => {
    // Push a new state into history when the modal opens
    window.history.pushState({ modal: 'filePreview' }, '');

    const handlePopState = (e: PopStateEvent) => {
      // If the back button is pressed, the state we pushed is popped.
      // We just call onClose to hide the modal.
      e.preventDefault();
      onClose();
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [onClose]);

  const handleClose = () => {
    // When manually closing via button or backdrop, navigate back
    // to remove the history state we pushed, which triggers popstate -> onClose
    window.history.back();
  };

  useEffect(() => {
    loadPreview();
  }, [url, filename]);

  async function loadPreview() {
    try {
      // Proactive check to ensure file exists before attempting any rendering logic
      const headResponse = await fetch(previewUrl, { method: 'HEAD' });
       if (!headResponse.ok) {
        if (headResponse.status === 404) {
          setPreview({ status: 'error', message: t('filePreview.fileNotFound') });
          return;
        }

        // If it's another error (like 500), we still let it try the specific loaders 
         // which might have better error handling, or we can just throw here.
        // Let's throw to be safe and clear.
        throw new Error(t('filePreview.accessFail', { status: headResponse.status }));
      }
    } catch (err: any) {
      setPreview({ status: 'error', message: err.message || t('filePreview.networkFail') });
      return;
    }


    const fileType = getFileType(filename);

    switch (fileType) {
      case 'image':
        setPreview({ status: 'ready', type: 'image' });
        return;
      case 'video':
        setPreview({ status: 'ready', type: 'video' });
        return;
      case 'audio':
        setPreview({ status: 'ready', type: 'audio' });
        return;
      case 'pdf':
        await loadPdfData('source');
        return;
      case 'docx':
      case 'xlsx':
      case 'csv':
      case 'pptx':
        await loadOfficeFile(fileType);
        return;
      case 'epub':
        await loadEpub();
        return;
      case 'text':
      case 'code':
        await loadText(fileType as 'text' | 'code');
        return;
      default:
        setPreview({ status: 'ready', type: 'unsupported' });
    }
  }

  async function loadOfficeFile(fileType: string) {
    const caps = await getCapabilities();

    if (caps.libreoffice) {
      await loadPdfData('converted');
      return;
    }

    switch (fileType) {
      case 'docx':
        await loadDocxFallback();
        return;
      case 'xlsx':
      case 'csv':
        await loadXlsxFallback();
        return;
      default:
        setPreview({ status: 'ready', type: 'unsupported' });
    }
  }

  async function loadDocxFallback() {
     try {
      const response = await fetch(previewUrl);
      if (!response.ok) throw new Error(response.status === 404 ? t('filePreview.fileNotFound') : t('filePreview.loadFailStatus', { status: response.status }));
      const arrayBuffer = await response.arrayBuffer();

      const result = await mammoth.convertToHtml({ arrayBuffer });
       setPreview({ status: 'ready', type: 'html', content: result.value });
    } catch (err: any) {
      setPreview({ status: 'error', message: t('filePreview.previewWordFail', { message: err.message }) });
    }

  }

  async function loadPdfData(mode: 'source' | 'converted') {
    try {
      const dataUrl = buildPreviewDataUrl(url, mode);
      if (!dataUrl) {
        throw new Error(t('filePreview.loadPdfFail'));
      }

      const response = await fetch(dataUrl);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = resolvePreviewErrorMessage(payload, t, 'filePreview.loadPdfFail');
        throw new Error(message);
      }

      if (!payload?.data || typeof payload.data !== 'string') {
        throw new Error(t('filePreview.loadPdfFail'));
      }

      setPreview({
        status: 'ready',
        type: 'pdf',
        pdfData: decodeBase64ToBytes(payload.data),
      });
    } catch (err: any) {
      setPreview({ status: 'error', message: err.message || t('filePreview.loadPdfFail') });
    }
  }

  async function loadXlsxFallback() {
     try {
      const response = await fetch(previewUrl);
      if (!response.ok) throw new Error(response.status === 404 ? t('filePreview.fileNotFound') : t('filePreview.loadFailStatus', { status: response.status }));
      const arrayBuffer = await response.arrayBuffer();

      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      
      const htmlParts: string[] = [];
      workbook.SheetNames.forEach((name) => {
        const sheet = workbook.Sheets[name];
        const html = XLSX.utils.sheet_to_html(sheet, { editable: false });
        htmlParts.push(
          `<div class="sheet-tab">${workbook.SheetNames.length > 1 ? `<h3 style="margin: 16px 0 8px; font-size: 14px; font-weight: 700; color: #374151;">📄 ${name}</h3>` : ''}${html}</div>`
        );
      });

       setPreview({ status: 'ready', type: 'html', content: htmlParts.join('') });
    } catch (err: any) {
      setPreview({ status: 'error', message: t('filePreview.previewExcelFail', { message: err.message }) });
    }

  }

  async function loadText(type: 'text' | 'code') {
     try {
      const response = await fetch(previewUrl);
      if (!response.ok) throw new Error(response.status === 404 ? t('filePreview.fileNotFound') : t('filePreview.loadFailStatus', { status: response.status }));
      const buffer = await response.arrayBuffer();

      
      let decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      try {
        text = decoder.decode(buffer);
      } catch {
        decoder = new TextDecoder('gbk');
        text = decoder.decode(buffer);
      }
       
      setPreview({ status: 'ready', type, content: text });
    } catch (err: any) {
      setPreview({ status: 'error', message: t('filePreview.previewTextFail', { message: err.message }) });
    }

  }

  async function loadEpub() {
    try {
      const response = await fetch(previewUrl);
      if (!response.ok) {
        throw new Error(response.status === 404 ? t('filePreview.fileNotFound') : t('filePreview.loadFailStatus', { status: response.status }));
      }

      const arrayBuffer = await response.arrayBuffer();
      setPreview({ status: 'ready', type: 'epub', epubData: arrayBuffer });
    } catch (err: any) {
      setPreview({ status: 'error', message: t('filePreview.previewEpubFail', { message: err.message }) });
    }
  }

  function handleDownload() {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  const ext = filename.split('.').pop()?.toUpperCase() || '';
  const normalizedExt = getFileExtension(filename);
  const supportsRenderToggle = ['md', 'markdown', 'html', 'htm'].includes(normalizedExt);
  const isMarkdownFile = ['md', 'markdown'].includes(normalizedExt);
  const isHtmlFile = ['html', 'htm'].includes(normalizedExt);
  const isRenderedMode = supportsRenderToggle && viewMode === 'render';
  const htmlRenderUrl = isHtmlFile ? buildHtmlPreviewRenderUrl(url) : null;
  const fileType = getFileType(filename);
  const renderedHtmlDocument = buildRenderedHtmlDocument(preview.status === 'ready' ? (preview.content || '') : '');
  const { Icon, typeText, bgColor } = getFileIconInfo(filename);

  return (
    <div 
      className="fixed inset-0 z-[200] bg-slate-500/60 backdrop-blur-md flex flex-col animate-in fade-in duration-200"
      onClick={handleClose}
    >
      {/* Top toolbar - Light Theme */}
      <div 
        className="flex items-center justify-between gap-3 px-3 sm:px-6 py-2.5 bg-white/95 border-b border-gray-200 flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-1 min-w-0 items-center gap-2 sm:gap-3">
          <div className={`hidden sm:flex w-8 h-8 rounded-lg ${bgColor} items-center justify-center flex-shrink-0 text-white border border-black/5`}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-gray-900 font-semibold text-sm truncate">{filename}</h3>
            <p className="text-gray-500 text-[10px] font-medium tracking-wider uppercase">{ext} • {typeText}</p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5 sm:gap-2">
          {supportsRenderToggle && (
            <div className="flex flex-shrink-0 items-center h-9 rounded-xl border border-gray-200 bg-gray-200/80 p-1">
              <button
                type="button"
                onClick={() => setViewMode('source')}
                className={`flex h-full flex-shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-2.5 sm:px-3 text-xs leading-none transition-colors ${
                  !isRenderedMode
                    ? 'bg-white text-gray-900 font-semibold border border-gray-200'
                    : 'font-normal text-gray-500 hover:text-gray-700 hover:font-semibold'
                }`}
              >
                {t('filePreview.viewSource')}
              </button>
              <button
                type="button"
                onClick={() => setViewMode('render')}
                className={`flex h-full flex-shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-2.5 sm:px-3 text-xs leading-none transition-colors ${
                  isRenderedMode
                    ? 'bg-white text-gray-900 font-semibold border border-gray-200'
                    : 'font-normal text-gray-500 hover:text-gray-700 hover:font-semibold'
                }`}
              >
                {t('filePreview.viewRendered')}
              </button>
            </div>
          )}


          <button 
            onClick={handleDownload}
            className="w-9 h-9 sm:w-auto flex-shrink-0 flex items-center justify-center sm:gap-1.5 sm:px-4 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold transition-all border border-gray-200"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t('common.download')}</span>
          </button>

          <button 
            onClick={handleClose}
            className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 transition-all border border-gray-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Content area */}
      <div 
        className="flex-1 flex items-center justify-center p-0 sm:p-6 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
         {preview.status === 'loading' && (
          <div className="flex flex-col items-center gap-4 text-gray-500">
            <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
            <p className="text-sm font-medium">{t('filePreview.loadingPreview')}</p>
          </div>
        )}


        {preview.status === 'error' && (
          <div className="flex flex-col items-center gap-4 text-gray-600 bg-white p-8 rounded-3xl max-w-md text-center">
            <div className="w-16 h-16 rounded-2xl bg-red-100 flex items-center justify-center">
              <X className="w-8 h-8 text-red-500" />
            </div>
            <p className="text-sm font-medium">{preview.message}</p>
            <button
              onClick={handleClose}
               className="px-8 py-2.5 bg-blue-600 hover:bg-blue-700 rounded-xl text-white text-sm font-bold transition-all flex items-center gap-2"
            >
              {t('common.close')}
            </button>

          </div>
        )}

        {preview.status === 'ready' && preview.type === 'image' && (
          <ZoomableWrapper center>
            <div className="p-4 flex items-center justify-center min-h-full">
                <img 
                src={previewUrl} 
                alt={filename}
                className="max-w-full max-h-[80vh] object-contain rounded-xl border-4 border-white"
              />
            </div>
          </ZoomableWrapper>
        )}

        {preview.status === 'ready' && preview.type === 'video' && (
          <div className="p-4 flex items-center justify-center min-h-full w-full max-w-5xl mx-auto">
            <video 
              src={previewUrl} 
              controls 
              autoPlay
              playsInline
              className="max-w-full max-h-[80vh] rounded-xl shadow-2xl bg-black border-4 border-white"
            >
              {t('common.browserNotSupportVideo')}
            </video>
          </div>
        )}

        {preview.status === 'ready' && preview.type === 'audio' && (
          <div className="p-4 flex items-center justify-center min-h-full w-full max-w-3xl mx-auto">
            <div className="w-full rounded-2xl border border-gray-200 bg-white p-6 sm:p-8">
              <audio
                src={previewUrl}
                controls
                autoPlay
                preload="metadata"
                className="w-full"
              >
                {t('common.browserNotSupportAudio')}
              </audio>
            </div>
          </div>
        )}

        {preview.status === 'ready' && preview.type === 'pdf' && (
          <ZoomableWrapper>
            <PdfCanvasViewer pdfUrl={preview.pdfUrl || previewUrl} pdfData={preview.pdfData} />
          </ZoomableWrapper>
        )}

        {preview.status === 'ready' && preview.type === 'epub' && (
          <div className="w-full h-full overflow-hidden px-0 sm:px-0 py-0">
            <EpubViewer epubData={preview.epubData} filename={filename} />
          </div>
        )}

        {preview.status === 'ready' && preview.type === 'html' && !isHtmlFile && (
          <div className={DOCUMENT_PREVIEW_SCROLL_CLASS}>
            <div
              className={`${DOCUMENT_PREVIEW_SURFACE_CLASS} ${DOCUMENT_PREVIEW_BODY_CLASS} overflow-hidden cursor-text`}
              style={TEXT_SELECTION_STYLE}
              dangerouslySetInnerHTML={{ __html: renderedHtmlDocument }}
            />
          </div>
        )}

        {preview.status === 'ready' && isHtmlFile && isRenderedMode && (
          htmlRenderUrl ? (
            <HtmlFrameViewer src={htmlRenderUrl} />
          ) : (
            <div className={DOCUMENT_PREVIEW_SCROLL_CLASS}>
              <div
                className={`${DOCUMENT_PREVIEW_SURFACE_CLASS} ${DOCUMENT_PREVIEW_BODY_CLASS} overflow-hidden cursor-text`}
                style={TEXT_SELECTION_STYLE}
                dangerouslySetInnerHTML={{ __html: renderedHtmlDocument }}
              />
            </div>
          )
        )}

        {preview.status === 'ready' && isMarkdownFile && isRenderedMode && (
          <div className={DOCUMENT_PREVIEW_SCROLL_CLASS}>
            <div
              className={`${DOCUMENT_PREVIEW_SURFACE_CLASS} ${DOCUMENT_PREVIEW_BODY_CLASS} cursor-text`}
              style={TEXT_SELECTION_STYLE}
            >
              <div className="prose prose-sm sm:prose-base max-w-none prose-slate break-words select-text">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {preview.content || ''}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        )}

        {preview.status === 'ready' && (preview.type === 'text' || preview.type === 'code') && !isRenderedMode && (
          <div className={DOCUMENT_PREVIEW_SCROLL_CLASS}>
            <div className={DOCUMENT_PREVIEW_SURFACE_CLASS}>
              <pre
                className={`${DOCUMENT_PREVIEW_BODY_CLASS} leading-relaxed text-slate-800 font-mono whitespace-pre-wrap break-words transition-all duration-200 cursor-text select-text`}
                style={TEXT_SELECTION_STYLE}
              >
                {preview.content}
              </pre>
            </div>
          </div>
        )}

        {preview.status === 'ready' && preview.type === 'unsupported' && (
          <div className="flex flex-col items-center gap-6 bg-white p-10 rounded-3xl max-w-md text-center border border-gray-100">
            <div className={`w-20 h-20 rounded-3xl ${bgColor.replace('bg-', 'bg-opacity-10 bg-')} flex items-center justify-center`}>
              <Icon className={`w-10 h-10 ${bgColor.replace('bg-', 'text-')}`} />
            </div>
             <div>
             <p className="text-gray-900 font-bold text-xl mb-1">{filename}</p>
              <p className="text-gray-500 text-sm">{t('filePreview.unsupportedType')}</p>
              {isLibreOfficeHintRelevant(fileType) && (
                <p className="text-blue-500/60 text-xs mt-2 font-medium bg-blue-50 py-1 px-3 rounded-full inline-block">
                  {t('filePreview.installLibreOffice')}
                </p>
              )}
            </div>

             <button
              onClick={handleDownload}
              className="px-8 py-3 bg-blue-600 hover:bg-blue-700 rounded-xl text-white text-sm font-bold transition-all flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              {t('common.downloadFile')}
            </button>

          </div>
        )}
      </div>
    </div>
  );
}
