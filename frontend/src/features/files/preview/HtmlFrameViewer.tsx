import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DOCUMENT_PREVIEW_WIDTH_CLASS } from './previewUtils';

export function HtmlFrameViewer({ src }: { src: string }) {
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
