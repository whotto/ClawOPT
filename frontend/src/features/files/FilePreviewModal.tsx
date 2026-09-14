import { useState, useEffect } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { getFileIconInfo } from '../../utils/fileUtils';
import { fetchResource } from '../../api/files';
import { EpubViewer } from './preview/EpubViewer';
import { HtmlFrameViewer } from './preview/HtmlFrameViewer';
import { PdfCanvasViewer } from './preview/PdfCanvasViewer';
import { ZoomableWrapper } from './preview/ZoomableWrapper';
import { TEXT_SELECTION_STYLE, DOCUMENT_PREVIEW_SCROLL_CLASS, DOCUMENT_PREVIEW_SURFACE_CLASS, DOCUMENT_PREVIEW_BODY_CLASS, sanitizeHtmlFragment, buildRenderedHtmlDocument, resolvePreviewErrorMessage, getCapabilities, getFileType, isLibreOfficeHintRelevant, getFileExtension, getDefaultViewMode, buildPreviewUrl, buildPreviewDataUrl, buildHtmlPreviewRenderUrl, decodeBase64ToBytes } from './preview/previewUtils';
import type { PreviewState } from './preview/previewUtils';

interface FilePreviewModalProps {
  url: string;
  filename: string;
  onClose: () => void;
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
      const headResponse = await fetchResource(previewUrl, { method: 'HEAD' });
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
      const response = await fetchResource(previewUrl);
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

      const response = await fetchResource(dataUrl);
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
      const response = await fetchResource(previewUrl);
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
      const response = await fetchResource(previewUrl);
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
      const response = await fetchResource(previewUrl);
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
              dangerouslySetInnerHTML={{ __html: sanitizeHtmlFragment(renderedHtmlDocument) }}
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
                dangerouslySetInnerHTML={{ __html: sanitizeHtmlFragment(renderedHtmlDocument) }}
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
