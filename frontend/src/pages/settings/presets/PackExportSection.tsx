// 导出智能体或团队为 .clawpack，或分享为私密 gist 链接。
import { Check, Copy, Download, Link2, Loader2, TriangleAlert } from 'lucide-react';
import type { PresetLibraryController } from './usePresetLibrary';

export default function PackExportSection({ ctx }: { ctx: PresetLibraryController }) {
  const {
    copied,
    copyToClipboard,
    exportBusy,
    exportDone,
    exportError,
    exportId,
    exportKind,
    exportTargets,
    includeAutomations,
    includeMemory,
    includeModelConfig,
    runExport,
    runShare,
    section,
    setExportDone,
    setExportId,
    setExportKind,
    setIncludeAutomations,
    setIncludeMemory,
    setIncludeModelConfig,
    shareResult,
    t,
  } = ctx;

  return (
    <>
      {/* ── 导出 ──────────────────────────────────────────────────── */}
      {section === 'export' && (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.presets.exportTitle')}</h3>
            <p className="text-sm text-gray-500">{t('settings.presets.exportDescription')}</p>
          </div>

          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
            <div className="flex gap-2">
              {(['agent', 'team'] as const).map(kind => (
                <button
                  key={kind}
                  onClick={() => { setExportKind(kind); setExportId(''); setExportDone(''); }}
                  className={`px-4 py-2 text-sm rounded-xl border transition-all ${
                    exportKind === kind
                      ? 'font-semibold text-gray-900 bg-amber-50 border-orange-300'
                      : 'font-normal text-gray-600 bg-white border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {t(`settings.presets.kind.${kind}`)}
                </button>
              ))}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.presets.pickTarget')}</label>
              <select
                value={exportId}
                onChange={e => { setExportId(e.target.value); setExportDone(''); }}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:border-orange-300"
              >
                <option value="">{t('settings.presets.pickTargetPlaceholder')}</option>
                {exportTargets.map(target => (
                  <option key={target.id} value={target.id}>{target.name} ({target.id})</option>
                ))}
              </select>
            </div>

            <div className="space-y-2 border-t border-gray-100 pt-4">
              <p className="text-sm font-medium text-gray-900">{t('settings.presets.includeTitle')}</p>
              <p className="text-xs text-gray-500">{t('settings.presets.includeAlways')}</p>
              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={includeAutomations} onChange={e => setIncludeAutomations(e.target.checked)} className="mt-1" />
                <span>{t('settings.presets.includeAutomations')}<span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.includeAutomationsHint')}</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={includeMemory} onChange={e => setIncludeMemory(e.target.checked)} className="mt-1" />
                <span>{t('settings.presets.includeMemory')}<span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.includeMemoryHint')}</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={includeModelConfig} onChange={e => setIncludeModelConfig(e.target.checked)} className="mt-1" />
                <span>{t('settings.presets.includeModel')}<span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.includeModelHint')}</span></span>
              </label>
              <p className="text-xs text-gray-400 pt-1">{t('settings.presets.neverIncluded')}</p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={runExport}
                disabled={!exportId || exportBusy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {exportBusy === 'download' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {t('settings.presets.exportButton')}
              </button>
              <button
                onClick={runShare}
                disabled={!exportId || exportBusy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {exportBusy === 'share' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                {t('settings.presets.shareButton')}
              </button>
            </div>
            <p className="text-xs text-gray-400">{t('settings.presets.shareHint')}</p>

            {shareResult && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2">
                <p className="text-sm font-medium text-emerald-900">{t('settings.presets.shareDone')}</p>
                <p className="text-xs text-emerald-800">{t('settings.presets.shareSecretWarning')}</p>
                {[
                  { label: t('settings.presets.shareLinkForImport'), value: shareResult.rawUrl, tag: 'raw' },
                  { label: t('settings.presets.shareLinkGist'), value: shareResult.gistUrl, tag: 'gist' },
                ].map(row => (
                  <div key={row.tag}>
                    <p className="text-xs text-emerald-800 mb-1">{row.label}</p>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={row.value}
                        onFocus={event => event.currentTarget.select()}
                        className="flex-1 min-w-0 px-3 py-1.5 text-xs font-mono bg-white border border-emerald-200 rounded-lg"
                      />
                      <button
                        onClick={() => copyToClipboard(row.value, row.tag)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-100"
                      >
                        {copied === row.tag ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        {copied === row.tag ? t('settings.presets.copied') : t('settings.presets.copy')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {exportDone && (
              <div className="flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                <Check className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="break-words">{t('settings.presets.exportDone', { file: exportDone })}</span>
              </div>
            )}

            {exportError && (
              <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
                <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="break-words">{exportError}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
