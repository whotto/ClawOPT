// 预设库：选择预设、勾选角色、填参数、预览与安装。
import { Boxes, Check, ChevronRight, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import type { PresetLibraryController } from './usePresetLibrary';

export default function PresetCatalogSection({ ctx }: { ctx: PresetLibraryController }) {
  const {
    activeId,
    activePreset,
    busy,
    errorText,
    loadPresets,
    loading,
    overwrite,
    paramValues,
    postInstall,
    presets,
    results,
    resultsAreDryRun,
    runInstall,
    section,
    selectedRoles,
    setActiveId,
    setOverwrite,
    setParamValues,
    setResults,
    setSelectedRoles,
    statusClass,
    statusLabel,
    t,
    toggleRole,
  } = ctx;

  return (
    <>
      {section === 'library' && loading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}
        </div>
      )}

      {section === 'library' && !loading && !presets.length && (
        <div className="bg-white p-6 rounded-2xl border border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.presets.title')}</h3>
          <p className="text-sm text-gray-500">{t('settings.presets.empty')}</p>
        </div>
      )}

      {section === 'library' && !loading && presets.length > 0 && (
      <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.presets.title')}</h3>
        <p className="text-sm text-gray-500">{t('settings.presets.description')}</p>
      </div>

      {presets.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {presets.map(preset => (
            <button
              key={preset.id}
              disabled={Boolean(preset.broken)}
              onClick={() => setActiveId(preset.id)}
              className={`px-4 py-2 text-sm rounded-xl border transition-all ${
                preset.id === activeId
                  ? 'font-semibold text-gray-900 bg-amber-50 border-orange-300'
                  : 'font-normal text-gray-600 bg-white border-gray-200 hover:bg-gray-50'
              }`}
            >
              {preset.name}{preset.broken ? ' ⚠' : ''}
            </button>
          ))}
        </div>
      )}

      {activePreset && (
        <>
          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
            <div className="flex items-start gap-3">
              <Boxes className="w-5 h-5 text-gray-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base font-semibold text-gray-900">{activePreset.name}</span>
                  {activePreset.version && <span className="text-xs text-gray-400">v{activePreset.version}</span>}
                </div>
                {activePreset.tagline && <p className="text-sm text-gray-600 mt-1">{activePreset.tagline}</p>}
                {activePreset.description && <p className="text-sm text-gray-500 mt-2 leading-relaxed">{activePreset.description}</p>}
                {activePreset.broken && (
                  <p className="text-sm text-red-600 mt-2">{t('settings.presets.presetBroken', { reason: activePreset.broken })}</p>
                )}
              </div>
            </div>
          </div>

          {/* 角色选择 */}
          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-medium text-gray-900">{t('settings.presets.rolesTitle')}</h4>
              <div className="flex gap-2 text-xs">
                <button className="text-gray-500 hover:text-gray-900" onClick={() => setSelectedRoles(activePreset.roles.map(r => r.id))}>
                  {t('settings.presets.selectAll')}
                </button>
                <span className="text-gray-300">|</span>
                <button className="text-gray-500 hover:text-gray-900" onClick={() => setSelectedRoles([])}>
                  {t('settings.presets.selectNone')}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {activePreset.roles.map(role => {
                const checked = selectedRoles.includes(role.id);
                return (
                  <label
                    key={role.id}
                    className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                      checked ? 'bg-amber-50 border-orange-300' : 'bg-white border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleRole(role.id)} className="mt-1" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-900">{role.emoji} {role.name}</span>
                        {role.position && <span className="text-xs text-gray-400">{role.position}</span>}
                        {role.installed && (
                          <span className="text-xs px-2 py-0.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-500">
                            {t('settings.presets.alreadyInstalled')}
                          </span>
                        )}
                      </div>
                      {role.slogan && <p className="text-xs text-gray-500 mt-1">{role.slogan}</p>}
                      <p className="text-xs text-gray-400 mt-1">
                        {t('settings.presets.skillCount', { count: role.skills.length })}
                        {role.externalSkills.length > 0 && ` · ${t('settings.presets.externalCount', { count: role.externalSkills.length })}`}
                      </p>
                      {role.note && <p className="text-xs text-gray-400 mt-1 leading-relaxed">{role.note}</p>}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* 参数 */}
          {activePreset.params.length > 0 && (
            <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
              <h4 className="text-sm font-medium text-gray-900">{t('settings.presets.paramsTitle')}</h4>
              {activePreset.params.map(param => (
                <div key={param.key}>
                  <label className="block text-sm font-medium text-gray-900 mb-1">{param.label}</label>
                  {param.hint && <p className="text-xs text-gray-500 mb-2">{param.hint}</p>}
                  <input
                    type="text"
                    value={paramValues[param.key] ?? ''}
                    placeholder={param.default}
                    onChange={e => { setParamValues(prev => ({ ...prev, [param.key]: e.target.value })); setResults(null); }}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-orange-300"
                  />
                  {param.examples.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {param.examples.map(example => (
                        <button
                          key={example}
                          onClick={() => { setParamValues(prev => ({ ...prev, [param.key]: example })); setResults(null); }}
                          className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
                        >
                          {example}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 动作 */}
          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
            <label className="flex items-start gap-2 text-sm text-gray-600 mb-4">
              <input type="checkbox" checked={overwrite} onChange={e => { setOverwrite(e.target.checked); setResults(null); }} className="mt-1" />
              <span>
                {t('settings.presets.overwriteLabel')}
                <span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.overwriteHint')}</span>
              </span>
            </label>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => runInstall(true)}
                disabled={!selectedRoles.length || busy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                {t('settings.presets.preview')}
              </button>
              <button
                onClick={() => runInstall(false)}
                disabled={!selectedRoles.length || busy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {busy === 'install' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t('settings.presets.install', { count: selectedRoles.length })}
              </button>
              <button
                onClick={loadPresets}
                disabled={busy !== null}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm rounded-xl text-gray-500 hover:bg-gray-50 disabled:opacity-50"
              >
                <RefreshCw className="w-4 h-4" />
                {t('settings.presets.refresh')}
              </button>
            </div>

            {errorText && (
              <div className="mt-4 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
                <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="break-words">{errorText}</span>
              </div>
            )}
          </div>

          {/* 结果 */}
          {results && (
            <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
              <h4 className="text-sm font-medium text-gray-900 mb-3">
                {resultsAreDryRun ? t('settings.presets.previewTitle') : t('settings.presets.resultTitle')}
              </h4>
              <div className="space-y-2">
                {results.map(result => (
                  <div key={result.roleId} className="flex items-start gap-3 p-3 rounded-xl border border-gray-200">
                    <span className={`text-xs px-2 py-1 rounded-lg border shrink-0 ${statusClass(result.status)}`}>
                      {statusLabel(result.status)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">{result.emoji} {result.name}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {t('settings.presets.resultDetail', {
                          chars: result.markdownChars,
                          files: result.workspaceFileCount,
                          skills: result.skillNames.length,
                        })}
                      </p>
                      {result.skillNames.length > 0 && (
                        <p className="text-xs text-gray-400 mt-1 break-words">{result.skillNames.join(' · ')}</p>
                      )}
                      {result.externalSkills.length > 0 && (
                        <p className="text-xs text-amber-600 mt-1 break-words">
                          {t('settings.presets.externalPending', { list: result.externalSkills.join(' · ') })}
                        </p>
                      )}
                      {result.error && <p className="text-xs text-red-600 mt-1 break-words">{result.error}</p>}
                    </div>
                  </div>
                ))}
              </div>

              {!resultsAreDryRun && postInstall.length > 0 && (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <p className="text-sm font-medium text-gray-900 mb-2">{t('settings.presets.nextSteps')}</p>
                  <ol className="list-decimal list-inside space-y-1 text-sm text-gray-600">
                    {postInstall.map((step, index) => <li key={index}>{step}</li>)}
                  </ol>
                </div>
              )}
            </div>
          )}
        </>
      )}
      </div>
      )}
    </>
  );
}
