import { useState, useEffect, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Book, Rendition } from 'epubjs';
import { DOCUMENT_PREVIEW_WIDTH_CLASS } from './previewUtils';

export function EpubViewer({ epubData, filename }: { epubData?: ArrayBuffer; filename: string }) {
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
