import { useState, useEffect, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as pdfjsLib from 'pdfjs-dist';
import { DOCUMENT_PREVIEW_WIDTH_CLASS } from './previewUtils';

// Configure pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

// PDF Canvas Viewer — renders each page as a canvas (works on mobile)
export function PdfCanvasViewer({ pdfUrl, pdfData }: { pdfUrl?: string; pdfData?: Uint8Array }) {
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
