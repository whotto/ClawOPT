import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DOCUMENT_PREVIEW_WIDTH_CLASS } from './previewUtils';
import { HTML_PREVIEW_SANDBOX } from './htmlSandbox';

/**
 * 渲染已消毒、已注入严格 CSP 的 HTML 文档（`buildSandboxedHtmlDocument` 的产物）。
 * `srcdoc` + 空 `sandbox`：不透明源、不执行脚本、不能提交表单、不能弹窗、不能导航顶层；不带 Referer。
 */
export function HtmlFrameViewer({ html, skippedImages }: { html: string; skippedImages: number }) {
  const { t } = useTranslation();

  return (
    <div className="w-full h-full overflow-hidden">
      <div className={`w-full h-full ${DOCUMENT_PREVIEW_WIDTH_CLASS} mx-auto bg-white sm:rounded-2xl sm:border border-gray-200 relative min-h-[420px] overflow-hidden flex flex-col`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-b border-gray-100 text-[11px] text-gray-500">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            {t('filePreviewSafety.htmlSandboxNotice')}
          </span>
          {skippedImages > 0 && (
            <span className="text-amber-600">{t('filePreviewSafety.htmlImagesSkipped', { count: skippedImages })}</span>
          )}
        </div>
        <iframe
          srcDoc={html}
          title={t('filePreviewSafety.htmlFrameTitle')}
          sandbox={HTML_PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          className="w-full flex-1 min-h-0 border-0 bg-white"
        />
      </div>
    </div>
  );
}
