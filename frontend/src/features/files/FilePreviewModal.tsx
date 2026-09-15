import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import mammoth from 'mammoth';
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { getFileIconInfo } from '../../utils/fileUtils';
import { fetchResource } from '../../api/files';
import { EpubViewer } from './preview/EpubViewer';
import { HtmlFrameViewer } from './preview/HtmlFrameViewer';
import { PdfCanvasViewer } from './preview/PdfCanvasViewer';
import { ZoomableWrapper } from './preview/ZoomableWrapper';
import { TEXT_SELECTION_STYLE, DOCUMENT_PREVIEW_SCROLL_CLASS, DOCUMENT_PREVIEW_SURFACE_CLASS, DOCUMENT_PREVIEW_BODY_CLASS, sanitizeHtmlFragment, buildRenderedHtmlDocument, resolvePreviewErrorMessage, getCapabilities, getFileType, isLibreOfficeHintRelevant, getFileExtension, getDefaultViewMode, buildPreviewUrl, buildPreviewDataUrl, buildHtmlPreviewRenderUrl, decodeBase64ToBytes } from './preview/previewUtils';
import type { PreviewState } from './preview/previewUtils';
import { buildSandboxedHtmlDocument } from './preview/htmlSandbox';
import { resolveHtmlPreviewImages } from './preview/htmlPreviewAssets';
import { createPreviewRequestGuard, type PreviewRequest } from './preview/previewRequestGuard';
import { TablePreview } from './preview/table/TablePreview';
import { createTablePreviewWorker, runTablePreviewWorker, TablePreviewError } from './preview/table/tableWorkerProtocol';
import { inspectZipArchive, looksLikeZip } from './preview/zipSafety';

interface FilePreviewModalProps {
  url: string;
  filename: string;
  onClose: () => void;
}

/** 源码高亮的上限：更大的文件用纯文本显示（高亮器在几百 KB 的单行 HTML 上会卡住主线程）。 */
const SOURCE_HIGHLIGHT_MAX_CHARS = 200_000;

export default function FilePreviewModal({ url, filename, onClose }: FilePreviewModalProps) {
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [viewMode, setViewMode] = useState<'source' | 'render'>(() => getDefaultViewMode(filename));
  const [sandboxedHtml, setSandboxedHtml] = useState<{ html: string; skippedImages: number } | null>(null);
  const { t } = useTranslation();
  const previewUrl = buildPreviewUrl(url);
  const guardRef = useRef(createPreviewRequestGuard());

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

  const commit = useCallback((request: PreviewRequest, next: PreviewState) => {
    if (request.isCurrent()) setPreview(next);
  }, []);

  // 每次换文件开一个新请求：上一个被中止，它晚到的结果一律丢掉；关闭预览时同样作废。
  useEffect(() => {
    const guard = guardRef.current;
    const request = guard.begin();
    setPreview({ status: 'loading' });
    void loadPreview(request);
    return () => guard.cancel();
  }, [url, filename]);

  const fetchOrThrow = async (request: PreviewRequest, target: string) => {
    const response = await fetchResource(target, { signal: request.signal });
    if (!response.ok) throw new Error(response.status === 404 ? t('filePreview.fileNotFound') : t('filePreview.loadFailStatus', { status: response.status }));
    return response;
  };

  /** OOXML 渲染前的 ZIP 预检。老格式（.doc / .xls）不是 ZIP，交给渲染库自己判。不通过时返回本地化原因。 */
  const zipSafetyError = (buffer: ArrayBuffer, requireZip: boolean): string | null => {
    if (!requireZip && !looksLikeZip(buffer)) return null;
    const verdict = inspectZipArchive(buffer);
    if (verdict.ok) return null;
    return t('filePreviewSafety.zipBlocked', { reason: t(`filePreviewSafety.zip.${verdict.reason}`) });
  };

  async function loadPreview(request: PreviewRequest) {
    try {
      // Proactive check to ensure file exists before attempting any rendering logic
      const headResponse = await fetchResource(previewUrl, { method: 'HEAD', signal: request.signal });
      if (!headResponse.ok) {
        if (headResponse.status === 404) {
          commit(request, { status: 'error', message: t('filePreview.fileNotFound') });
          return;
        }
        throw new Error(t('filePreview.accessFail', { status: headResponse.status }));
      }
    } catch (err: any) {
      commit(request, { status: 'error', message: err.message || t('filePreview.networkFail') });
      return;
    }

    const fileType = getFileType(filename);

    switch (fileType) {
      case 'image':
      case 'video':
      case 'audio':
        commit(request, { status: 'ready', type: fileType });
        return;
      case 'pdf':
        await loadPdfData(request, 'source');
        return;
      case 'docx':
      case 'xlsx':
      case 'csv':
      case 'pptx':
        await loadOfficeFile(request, fileType);
        return;
      case 'epub':
        await loadEpub(request);
        return;
      case 'text':
      case 'code':
        await loadText(request, fileType as 'text' | 'code');
        return;
      default:
        commit(request, { status: 'ready', type: 'unsupported' });
    }
  }

  async function loadOfficeFile(request: PreviewRequest, fileType: string) {
    const caps = await getCapabilities();
    if (!request.isCurrent()) return;

    if (caps.libreoffice) {
      await loadPdfData(request, 'converted');
      return;
    }

    switch (fileType) {
      case 'docx':
        await loadDocxFallback(request);
        return;
      case 'xlsx':
      case 'csv':
        await loadTable(request, fileType);
        return;
      default:
        commit(request, { status: 'ready', type: 'unsupported' });
    }
  }

  async function loadDocxFallback(request: PreviewRequest) {
    try {
      const response = await fetchOrThrow(request, previewUrl);
      const arrayBuffer = await response.arrayBuffer();
      const blocked = zipSafetyError(arrayBuffer, getFileExtension(filename) === 'docx');
      if (blocked) {
        commit(request, { status: 'error', message: blocked });
        return;
      }
      if (!request.isCurrent()) return;

      const result = await mammoth.convertToHtml({ arrayBuffer });
      commit(request, { status: 'ready', type: 'html', content: result.value });
    } catch (err: any) {
      commit(request, { status: 'error', message: t('filePreview.previewWordFail', { message: err.message }) });
    }
  }

  async function loadPdfData(request: PreviewRequest, mode: 'source' | 'converted') {
    try {
      const dataUrl = buildPreviewDataUrl(url, mode);
      if (!dataUrl) {
        throw new Error(t('filePreview.loadPdfFail'));
      }

      const response = await fetchResource(dataUrl, { signal: request.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = resolvePreviewErrorMessage(payload, t, 'filePreview.loadPdfFail');
        throw new Error(message);
      }

      if (!payload?.data || typeof payload.data !== 'string') {
        throw new Error(t('filePreview.loadPdfFail'));
      }

      commit(request, {
        status: 'ready',
        type: 'pdf',
        pdfData: decodeBase64ToBytes(payload.data),
      });
    } catch (err: any) {
      commit(request, { status: 'error', message: err.message || t('filePreview.loadPdfFail') });
    }
  }

  /** XLSX / CSV：ZIP 预检（仅 xlsx）之后交给 Worker 解析，带上限与超时；换文件或关闭时 Worker 被 terminate。 */
  async function loadTable(request: PreviewRequest, fileType: 'xlsx' | 'csv') {
    try {
      const response = await fetchOrThrow(request, previewUrl);
      const arrayBuffer = await response.arrayBuffer();
      if (fileType === 'xlsx') {
        const blocked = zipSafetyError(arrayBuffer, getFileExtension(filename) === 'xlsx');
        if (blocked) {
          commit(request, { status: 'error', message: blocked });
          return;
        }
      }
      const table = await runTablePreviewWorker(fileType, arrayBuffer, { createWorker: createTablePreviewWorker, signal: request.signal });
      commit(request, { status: 'ready', type: 'table', table });
    } catch (err: any) {
      const message = err instanceof TablePreviewError && err.code === 'timeout'
        ? t('filePreviewSafety.tableTimeout')
        : t('filePreview.previewExcelFail', { message: err.message });
      commit(request, { status: 'error', message });
    }
  }

  async function loadText(request: PreviewRequest, type: 'text' | 'code') {
    try {
      const response = await fetchOrThrow(request, previewUrl);
      const buffer = await response.arrayBuffer();

      let decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      try {
        text = decoder.decode(buffer);
      } catch {
        decoder = new TextDecoder('gbk');
        text = decoder.decode(buffer);
      }

      commit(request, { status: 'ready', type, content: text });
    } catch (err: any) {
      commit(request, { status: 'error', message: t('filePreview.previewTextFail', { message: err.message }) });
    }
  }

  async function loadEpub(request: PreviewRequest) {
    try {
      const response = await fetchOrThrow(request, previewUrl);
      const arrayBuffer = await response.arrayBuffer();
      commit(request, { status: 'ready', type: 'epub', epubData: arrayBuffer });
    } catch (err: any) {
      commit(request, { status: 'error', message: t('filePreview.previewEpubFail', { message: err.message }) });
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
  const htmlSource = isHtmlFile && preview.status === 'ready' ? (preview.content ?? null) : null;

  // HTML 渲染视图：相对图片先经鉴权接口取成 blob:，再消毒、注入 CSP，交给空 sandbox 的 srcdoc iframe。
  // 自带序号守卫：换文件、切回源码、关闭预览时作废，已取的 blob 地址释放。
  useEffect(() => {
    setSandboxedHtml(null);
    if (htmlSource === null || !isRenderedMode) return;
    const guard = createPreviewRequestGuard();
    const request = guard.begin();
    let revoke = () => {};
    void (async () => {
      const images = await resolveHtmlPreviewImages(htmlSource, buildHtmlPreviewRenderUrl(url), {
        fetchImpl: fetchResource,
        signal: request.signal,
        origin: window.location.origin,
      });
      if (!request.isCurrent()) {
        images.revoke();
        return;
      }
      revoke = images.revoke;
      const built = buildSandboxedHtmlDocument(htmlSource, { resolvedSources: images.sources });
      setSandboxedHtml({ html: built.html, skippedImages: images.skipped });
    })();
    return () => {
      guard.cancel();
      revoke();
    };
  }, [htmlSource, isRenderedMode, url]);

  const fileType = getFileType(filename);
  const renderedHtmlDocument = buildRenderedHtmlDocument(preview.status === 'ready' && preview.type === 'html' ? (preview.content || '') : '');
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
              dangerouslySetInnerHTML={{ __html: sanitizeHtmlFragment(renderedHtmlDocument) }}
            />
          </div>
        )}

        {preview.status === 'ready' && isHtmlFile && isRenderedMode && (
          sandboxedHtml ? (
            <HtmlFrameViewer html={sandboxedHtml.html} skippedImages={sandboxedHtml.skippedImages} />
          ) : (
            <div className="flex flex-col items-center gap-4 text-gray-500">
              <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
              <p className="text-sm font-medium">{t('filePreviewSafety.htmlPreparing')}</p>
            </div>
          )
        )}

        {preview.status === 'ready' && preview.type === 'table' && preview.table && (
          <TablePreview result={preview.table} />
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
              {isHtmlFile && (preview.content?.length ?? 0) <= SOURCE_HIGHLIGHT_MAX_CHARS ? (
                <div className={`${DOCUMENT_PREVIEW_BODY_CLASS} cursor-text select-text`} style={TEXT_SELECTION_STYLE}>
                  <SyntaxHighlighter
                    language="markup"
                    style={oneLight}
                    wrapLongLines
                    customStyle={{ margin: 0, padding: 0, background: 'transparent', fontSize: 13 }}
                  >
                    {preview.content || ''}
                  </SyntaxHighlighter>
                </div>
              ) : (
                <pre
                  className={`${DOCUMENT_PREVIEW_BODY_CLASS} leading-relaxed text-slate-800 font-mono whitespace-pre-wrap break-words transition-all duration-200 cursor-text select-text`}
                  style={TEXT_SELECTION_STYLE}
                >
                  {preview.content}
                </pre>
              )}
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
