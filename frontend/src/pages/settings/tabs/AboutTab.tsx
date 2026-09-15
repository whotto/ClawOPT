// 关于系统页签（版本、升级、诊断）。
import { Activity, Check, Loader2, X } from 'lucide-react';
import type { SettingsController } from '../useSettingsController';

export default function AboutTab({ ctx }: { ctx: SettingsController }) {
  const {
    appVersionError,
    appVersionInfo,
    diagnosticsState,
    handleCopyDiagnostics,
    handleLatestVersionAction,
    handleOpenClawLatestVersionAction,
    isLoadingAppVersion,
    openClawCurrentVersion,
    openClawUpdateProgressButtonWidthClass,
    openClawUpdateProgressTitle,
    openClawUpdateProgressToneClasses,
    openClawUpdateProgressVisual,
    openClawUpdateProgressWidthClass,
    renderProgressActionButton,
    t,
    updateProgressButtonWidthClass,
    updateProgressTitle,
    updateProgressToneClasses,
    updateProgressVisual,
    updateProgressWidthClass,
  } = ctx;

  return (
      <div className="space-y-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-6 w-full">
          <div className="flex w-full flex-col gap-6">
          <div className="flex w-full flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-baseline gap-3">
              <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight">{t('settings.openclawUpdate.title')}</div>
              <span className="text-[0.8rem] font-medium text-gray-500 leading-none">
                {isLoadingAppVersion
                  ? t('settings.about.loadingVersion')
                  : openClawCurrentVersion || t('settings.about.unavailable')}
              </span>
            </div>
            <div className="flex min-w-0 justify-end">
              {renderProgressActionButton(
                openClawUpdateProgressVisual,
                openClawUpdateProgressToneClasses,
                handleOpenClawLatestVersionAction,
                openClawUpdateProgressWidthClass,
                openClawUpdateProgressButtonWidthClass,
                openClawUpdateProgressTitle,
              )}
            </div>
          </div>

          <div className="w-full border-t border-gray-200" />

          {/* Header */}
          <div className="flex w-full flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="w-full text-left sm:w-auto">
              <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight mb-1">ClawOPT</div>
              <div className="flex items-baseline gap-2 whitespace-nowrap leading-none">
                <div className="text-[0.9rem] font-medium text-gray-400 leading-tight">应用版本</div>
                <div className="text-[0.8rem] font-medium text-gray-400 leading-none">
                  {isLoadingAppVersion
                    ? t('settings.about.loadingVersion')
                    : appVersionInfo?.version || t('settings.about.unavailable')}
                </div>
              </div>
            </div>
            <div className="flex min-w-0 justify-end">
              {renderProgressActionButton(
                updateProgressVisual,
                updateProgressToneClasses,
                handleLatestVersionAction,
                updateProgressWidthClass,
                updateProgressButtonWidthClass,
                updateProgressTitle,
              )}
            </div>
          </div>

          <div className="w-full border-t border-gray-200" />

          {appVersionError.message && (
            <div className="w-full rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <div className="font-semibold">{appVersionError.message}</div>
              {appVersionError.detail ? <div className="mt-1 whitespace-pre-wrap text-red-600">{appVersionError.detail}</div> : null}
            </div>
          )}

          {/* Project Info */}
          <div className="w-full text-center text-xl font-medium leading-8 text-gray-700">
            {t('settings.about.projectName')}
          </div>
          <div className="w-full text-center text-[13px] sm:text-[15px] text-gray-500 px-4">
            {t('settings.about.projectTagline')}
          </div>

          </div>
      </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-6 w-full">
          <div className="flex w-full flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight mb-1">
                {t('settings.about.diagnosticsTitle')}
              </div>
              <div className="text-[0.85rem] font-medium text-gray-400 leading-snug">
                {t('settings.about.diagnosticsHint')}
              </div>
            </div>
            <button
              type="button"
              id="copy-diagnostics"
              onClick={handleCopyDiagnostics}
              disabled={diagnosticsState === 'working'}
              className={`flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60 ${
                diagnosticsState === 'failed'
                  ? 'bg-red-50 text-red-600 border border-red-200'
                  : diagnosticsState === 'copied'
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'bg-gray-900 text-white hover:bg-gray-800'
              }`}
            >
              {diagnosticsState === 'working' && <Loader2 className="w-4 h-4 animate-spin" />}
              {diagnosticsState === 'copied' && <Check className="w-4 h-4" />}
              {diagnosticsState === 'failed' && <X className="w-4 h-4" />}
              {diagnosticsState === 'idle' && <Activity className="w-4 h-4" />}
              {diagnosticsState === 'working'
                ? t('settings.about.diagnosticsCopying')
                : diagnosticsState === 'copied'
                  ? t('settings.about.diagnosticsCopied')
                  : diagnosticsState === 'failed'
                    ? t('settings.about.diagnosticsFailed')
                    : t('settings.about.diagnosticsCopy')}
            </button>
          </div>
        </div>

    </div>
  );
}
