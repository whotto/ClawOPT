// 导入 .clawpack：本地文件或链接、检查、改名冲突、安装。
import { Check, ChevronRight, Loader2, TriangleAlert } from 'lucide-react';
import type { PresetLibraryController } from './usePresetLibrary';

export default function PackImportSection({ ctx }: { ctx: PresetLibraryController }) {
  const {
    applyModel,
    conflictCount,
    importResults,
    importTeamResult,
    inspection,
    packBusy,
    packError,
    packFile,
    packOverwrite,
    packUrl,
    renameMap,
    renameNames,
    runInspect,
    runPackInstall,
    section,
    setApplyModel,
    setImportResults,
    setInspection,
    setPackError,
    setPackFile,
    setPackOverwrite,
    setPackUrl,
    setRenameMap,
    setRenameNames,
    statusClass,
    statusLabel,
    t,
  } = ctx;

  return (
    <>
      {/* ── 导入一个包 ────────────────────────────────────────────── */}
      {section === 'import' && (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.presets.importTitle')}</h3>
            <p className="text-sm text-gray-500">{t('settings.presets.importDescription')}</p>
          </div>

          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.presets.pickFile')}</label>
              <input
                type="file"
                accept=".clawpack,application/gzip"
                onChange={e => { setPackFile(e.target.files?.[0] || null); setPackUrl(''); setInspection(null); setImportResults(null); setPackError(''); }}
                className="block w-full text-sm text-gray-600 file:mr-4 file:px-4 file:py-2 file:rounded-xl file:border file:border-gray-200 file:bg-gray-50 file:text-sm file:text-gray-700 hover:file:bg-gray-100"
              />
              {packFile && <p className="text-xs text-gray-400 mt-1.5">{packFile.name} · {Math.round(packFile.size / 1024)} KB</p>}
            </div>

            <div className="flex items-center gap-3 text-xs text-gray-400">
              <span className="flex-1 h-px bg-gray-200" />{t('settings.presets.or')}<span className="flex-1 h-px bg-gray-200" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.presets.pasteUrl')}</label>
              <input
                type="text"
                value={packUrl}
                placeholder="https://..."
                onChange={e => { setPackUrl(e.target.value); setPackFile(null); setInspection(null); setImportResults(null); setPackError(''); }}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-orange-300"
              />
              <p className="text-xs text-gray-400 mt-1.5">{t('settings.presets.pasteUrlHint')}</p>
            </div>

            <button
              onClick={runInspect}
              disabled={(!packFile && !packUrl.trim()) || packBusy !== null}
              className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {packBusy === 'inspect' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
              {t('settings.presets.inspect')}
            </button>

            {packError && (
              <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
                <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="break-words">{packError}</span>
              </div>
            )}
          </div>

          {inspection && (
            <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
              <div>
                <p className="text-base font-semibold text-gray-900">{inspection.manifest.name}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {t('settings.presets.packMeta', {
                    kind: t(`settings.presets.kind.${inspection.kind}`),
                    agents: inspection.manifest.agentCount,
                    skills: inspection.manifest.skillCount,
                    files: inspection.manifest.fileCount,
                    size: Math.round(inspection.manifest.totalBytes / 1024),
                  })}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {t('settings.presets.packFrom', {
                    app: inspection.exportedBy?.app || 'ClawOPT',
                    version: inspection.exportedBy?.version || '',
                    date: (inspection.exportedAt || '').slice(0, 10),
                  })}
                </p>
              </div>

              {/* 装之前必须看清楚的东西 */}
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-1.5">
                <p className="text-sm font-medium text-amber-900">{t('settings.presets.beforeYouInstall')}</p>
                <ul className="text-xs text-amber-800 space-y-1 list-disc list-inside">
                  {inspection.manifest.riskySkills.filter(skill => skill.exec).length > 0 && (
                    <li>{t('settings.presets.warnExec', { list: inspection.manifest.riskySkills.filter(s => s.exec).map(s => s.skill).join(' · ') })}</li>
                  )}
                  {inspection.manifest.riskySkills.filter(skill => !skill.exec && skill.network).length > 0 && (
                    <li>{t('settings.presets.warnNetwork', { count: inspection.manifest.riskySkills.filter(s => !s.exec && s.network).length })}</li>
                  )}
                  {inspection.manifest.includesAutomations && <li>{t('settings.presets.warnAutomations')}</li>}
                  {inspection.manifest.includesMemory && <li>{t('settings.presets.warnMemory')}</li>}
                  {inspection.manifest.warnings.map((warning, index) => (
                    <li key={index}>{warning.code}{warning.detail ? ` — ${warning.detail}` : ''}</li>
                  ))}
                  <li>{t('settings.presets.warnPromptContent')}</li>
                </ul>
              </div>

              <div className="space-y-2">
                {inspection.agents.map(agent => (
                  <div key={agent.id} className="p-3 rounded-xl border border-gray-200">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">{agent.name}</span>
                      <span className="text-xs text-gray-400">{agent.id}</span>
                      {agent.conflict && (
                        <span className="text-xs px-2 py-0.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-700">
                          {t('settings.presets.conflict')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {t('settings.presets.wroteFiles', { files: agent.fileCount, skills: agent.skills.length })}
                    </p>
                    {agent.skills.length > 0 && <p className="text-xs text-gray-400 mt-1 break-words">{agent.skills.join(' · ')}</p>}
                    {agent.conflict && (
                      <input
                        type="text"
                        value={renameMap[agent.id] ?? ''}
                        placeholder={t('settings.presets.renamePlaceholder', { id: agent.id })}
                        onChange={e => setRenameMap(prev => ({ ...prev, [agent.id]: e.target.value }))}
                        className="mt-2 w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-orange-300"
                      />
                    )}
                    {(() => {
                      const savingAsCopy = Boolean(renameMap[agent.id]?.trim());
                      // 只有「确实会多出一条同名智能体」时才提示：覆盖同一个 ID 不会。
                      const wouldDuplicate = agent.nameConflict && (savingAsCopy || !agent.conflict);
                      if (!wouldDuplicate) return null;
                      return (
                        <>
                          <input
                            type="text"
                            value={renameNames[agent.id] ?? `${agent.name}${t('settings.presets.importedSuffix')}`}
                            placeholder={agent.name}
                            onChange={e => setRenameNames(prev => ({ ...prev, [agent.id]: e.target.value }))}
                            className="mt-2 w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-orange-300"
                          />
                          <p className="text-xs text-amber-600 mt-1">{t('settings.presets.nameConflictHint', { name: agent.name })}</p>
                        </>
                      );
                    })()}
                  </div>
                ))}
              </div>

              {inspection.team && (
                <div className="p-3 rounded-xl border border-gray-200">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900">{inspection.team.name}</span>
                    <span className="text-xs text-gray-400">{inspection.team.id}</span>
                    {inspection.team.conflict && (
                      <span className="text-xs px-2 py-0.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-700">
                        {t('settings.presets.conflict')}
                      </span>
                    )}
                  </div>
                  {inspection.team.conflict && (
                    <input
                      type="text"
                      value={renameMap[`team:${inspection.team.id}`] ?? ''}
                      placeholder={t('settings.presets.renamePlaceholder', { id: inspection.team.id })}
                      onChange={e => setRenameMap(prev => ({ ...prev, [`team:${inspection.team!.id}`]: e.target.value }))}
                      className="mt-2 w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-orange-300"
                    />
                  )}
                </div>
              )}

              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={packOverwrite} onChange={e => setPackOverwrite(e.target.checked)} className="mt-1" />
                <span>
                  {t('settings.presets.overwriteLabel')}
                  <span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.overwriteHint')}</span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={applyModel} onChange={e => setApplyModel(e.target.checked)} className="mt-1" />
                <span>
                  {t('settings.presets.applyModelLabel')}
                  <span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.applyModelHint')}</span>
                </span>
              </label>

              {conflictCount > 0 && !packOverwrite && (
                <p className="text-xs text-amber-700">{t('settings.presets.conflictHint', { count: conflictCount })}</p>
              )}

              <button
                onClick={runPackInstall}
                disabled={packBusy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {packBusy === 'install' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t('settings.presets.installPack')}
              </button>
            </div>
          )}

          {importResults && (
            <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
              <h4 className="text-sm font-medium text-gray-900 mb-3">{t('settings.presets.resultTitle')}</h4>
              <div className="space-y-2">
                {importResults.map(result => (
                  <div key={result.sourceId} className="flex items-start gap-3 p-3 rounded-xl border border-gray-200">
                    <span className={`text-xs px-2 py-1 rounded-lg border shrink-0 ${statusClass(result.status)}`}>
                      {statusLabel(result.status)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">
                        {result.sourceId}{result.targetId !== result.sourceId ? ` → ${result.targetId}` : ''}
                      </p>
                      {typeof result.fileCount === 'number' && (
                        <p className="text-xs text-gray-500 mt-1">{t('settings.presets.wroteFiles', { files: result.fileCount, skills: result.skills?.length || 0 })}</p>
                      )}
                      {result.error && <p className="text-xs text-red-600 mt-1 break-words">{result.error}</p>}
                    </div>
                  </div>
                ))}
                {importTeamResult && (
                  <div className="flex items-start gap-3 p-3 rounded-xl border border-gray-200">
                    <span className={`text-xs px-2 py-1 rounded-lg border shrink-0 ${statusClass(importTeamResult.status)}`}>
                      {statusLabel(importTeamResult.status)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">{importTeamResult.targetId}</p>
                      <p className="text-xs text-gray-500 mt-1">{t('settings.presets.teamMembers', { count: importTeamResult.memberCount || 0 })}</p>
                    </div>
                  </div>
                )}
              </div>
              {inspection?.manifest.includesAutomations && (
                <p className="text-xs text-gray-500 mt-4">{t('settings.presets.automationsNotRun')}</p>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
