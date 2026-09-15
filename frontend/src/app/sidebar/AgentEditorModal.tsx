import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import ModelFallbackEditor from '../../components/ModelFallbackEditor';
import {
  AGENT_EDITOR_CONTENT_KEYS,
  MODAL_EDITOR_TEXTAREA_CLASS,
  MODAL_FIELD_LABEL_CLASS,
  MODAL_FORM_FONT_STYLE,
  MODAL_TEXT_INPUT_CLASS,
  type AgentEditorTab,
  type AgentSystemPromptMode,
  type AgentToolMode,
} from './sidebarTypes';
import type { AgentEditorState } from './useAgentEditor';

/** 新建 / 编辑智能体弹窗。 */
export default function AgentEditorModal({
  editor,
  availableModels,
}: {
  editor: AgentEditorState;
  availableModels: any[];
}) {
  const { t } = useTranslation();
  const {
    setIsModalOpen, modalMode, handleModalSubmit, submitError, newSessionData, setNewSessionData, setSubmitError,
    isModelDropdownOpen, setIsModelDropdownOpen, modelSearchQuery, setModelSearchQuery, modelProviderTab, setModelProviderTab,
    shouldLockAgentFallbackTabs, effectiveAgentFallbackTabMode, effectiveAgentFallbackEditorMode,
    runtimeModeOptions, systemPromptModeOptions, toolModeOptions, systemPromptTitle, toolModeTitle,
    activeTab, setActiveTab, templates,
  } = editor;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsModalOpen(false)}></div>
      <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 flex flex-col" style={MODAL_FORM_FONT_STYLE}>
        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-gray-100 bg-gray-50/50">
          <h3 className="text-xl font-bold text-gray-900">{modalMode === 'create' ? t('sidebar.newAgentTitle') : t('sidebar.editAgentTitle')}</h3>
          <button 
            onClick={() => setIsModalOpen(false)}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <form onSubmit={handleModalSubmit} className="min-w-0 flex-1 min-h-0 flex flex-col">
          <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
            {submitError && (
              <div className="bg-red-50 border border-red-200 text-red-600 text-sm px-4 py-3 rounded-xl">
                {submitError}
              </div>
            )}
            
            <div className="flex gap-4">
              <div className="flex-1">
                <label className={MODAL_FIELD_LABEL_CLASS}>{t('sidebar.agentId')} <span className="text-red-500">*</span></label>
                <input 
                  type="text" 
                  value={newSessionData.id}
                  onChange={e => {
                    // Only allow alphanumeric and dashes/underscores for ID
                    const val = e.target.value.replace(/[^a-zA-Z0-9_-]/g, '');
                    setNewSessionData(prev => ({...prev, id: val}));
                    setSubmitError(null);
                  }}
                  disabled={modalMode === 'edit'}
                  placeholder={t('sidebar.agentIdPlaceholder')}
                  autoFocus={modalMode === 'create'}
                  className={`${MODAL_TEXT_INPUT_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
                  required
                />
              </div>
              <div className="flex-1">
                <label className={MODAL_FIELD_LABEL_CLASS}>{t('sidebar.agentName')} <span className="text-red-500">*</span></label>
                <input 
                  type="text" 
                  value={newSessionData.name}
                  onChange={e => setNewSessionData(prev => ({...prev, name: e.target.value}))}
                  placeholder={t('sidebar.agentNamePlaceholder')}
                  className={MODAL_TEXT_INPUT_CLASS}
                  required
                />
              </div>
            </div>

            <div className="relative">
              <label className={MODAL_FIELD_LABEL_CLASS}>{t('sidebar.independentModel')}</label>
              <div className="relative">
                <input 
                  type="text" 
                  value={isModelDropdownOpen ? modelSearchQuery : (newSessionData.model ? (availableModels.find(m => m.id === newSessionData.model)?.alias || newSessionData.model) : '')}
                  onChange={e => {
                    setModelSearchQuery(e.target.value);
                    if (!isModelDropdownOpen) setIsModelDropdownOpen(true);
                  }}
                  onFocus={() => {
                    setModelSearchQuery('');
                    setIsModelDropdownOpen(true);
                  }}
                  placeholder={newSessionData.model ? (availableModels.find(m => m.id === newSessionData.model)?.alias || newSessionData.model) : t('sidebar.modelSelectPlaceholder')}
                  className={`${MODAL_TEXT_INPUT_CLASS} pr-8`}
                />
                {newSessionData.model && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setNewSessionData(prev => ({...prev, model: ''}));
                      setModelSearchQuery('');
                      setIsModelDropdownOpen(false);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-all"
                    title={t('common.clear')}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {isModelDropdownOpen && (
                <>
                  <div className="fixed inset-0 z-[10]" onClick={() => setIsModelDropdownOpen(false)} />
                  <div className="absolute z-[20] top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl max-h-[220px] overflow-hidden flex flex-col">
                    <div className="flex px-2 pt-2 gap-1 overflow-x-auto no-scrollbar border-b border-gray-100 flex-shrink-0">
                      <button 
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setModelProviderTab('all'); }}
                        className={`flex-none px-3 py-1.5 text-xs font-bold rounded-t-lg transition-colors border-b-2 ${modelProviderTab === 'all' ? 'text-blue-600 border-blue-600 bg-blue-50/50' : 'text-gray-500 border-transparent hover:text-gray-700 hover:bg-gray-50'}`}
                      >
                        {t('sidebar.allModels')}
                      </button>
                      {Array.from(new Set(availableModels.map(m => m.id.split('/')[0]).filter(Boolean))).map(p => (
                        <button 
                          key={p} type="button"
                          onClick={(e) => { e.stopPropagation(); setModelProviderTab(p); }}
                          className={`flex-none px-3 py-1.5 text-xs font-bold rounded-t-lg transition-colors border-b-2 whitespace-nowrap ${modelProviderTab === p ? 'text-blue-600 border-blue-600 bg-blue-50/50' : 'text-gray-500 border-transparent hover:text-gray-700 hover:bg-gray-50'}`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                    <div className="flex-1 overflow-y-auto w-full">
                      {availableModels
                        .filter(m => {
                          if (modelProviderTab !== 'all' && m.id.split('/')[0] !== modelProviderTab) return false;
                          if (!modelSearchQuery) return true;
                          const q = modelSearchQuery.toLowerCase();
                          return m.id.toLowerCase().includes(q) || (m.alias && m.alias.toLowerCase().includes(q));
                        })
                        .sort((a, b) => {
                          const nameA = a.alias || a.id;
                          const nameB = b.alias || b.id;
                          return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
                        })
                        .map(m => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setNewSessionData(prev => ({
                                ...prev,
                                model: m.id,
                                fallbacks: prev.fallbacks.filter((fallbackId) => fallbackId !== m.id),
                              }));
                              setModelSearchQuery('');
                              setIsModelDropdownOpen(false);
                            }}
                            className={`w-full text-left px-4 py-2 text-sm hover:bg-blue-50 transition-colors flex items-center justify-between gap-2 ${ newSessionData.model === m.id ? 'bg-blue-50 text-blue-600' : 'text-gray-700' }`}
                          >
                            <span className="min-w-0 flex-1 truncate text-sm">
                              {m.alias || m.id}
                            </span>
                            <div className="flex items-center flex-shrink-0 gap-2">
                              {m.primary && <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 rounded text-blue-600 font-medium">{t('sidebar.defaultModel')}</span>}
                              {m.input?.includes('image') && <span className="text-[10px] px-1.5 py-0.5 bg-green-100 rounded text-green-600 font-medium" title={t('sidebar.visionModel')}>{t('sidebar.visionModel')}</span>}
                            </div>
                          </button>
                        ))
                      }
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-bold text-gray-700">{t('sidebar.fallbackModelTitle')}</span>
                  <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={newSessionData.fallbackMode !== 'disabled'}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setNewSessionData((prev) => ({
                            ...prev,
                            fallbackMode: prev.fallbackMode === 'disabled'
                              ? (shouldLockAgentFallbackTabs ? 'custom' : (prev.fallbacks.length > 0 ? 'custom' : 'inherit'))
                              : prev.fallbackMode,
                          }));
                        } else {
                          setNewSessionData((prev) => ({
                            ...prev,
                            fallbackMode: 'disabled',
                          }));
                        }
                      }}
                    />
                    <div className="w-11 h-6 bg-blue-100 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-200 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                  </label>
                </div>

                <div className={`inline-flex items-center gap-1 rounded-2xl border border-gray-200 bg-gray-100/80 p-1 ${(newSessionData.fallbackMode === 'disabled' || shouldLockAgentFallbackTabs) ? 'opacity-50' : ''}`}>
                  <button
                    type="button"
                    disabled={newSessionData.fallbackMode === 'disabled' || shouldLockAgentFallbackTabs}
                    onClick={() => setNewSessionData((prev) => ({ ...prev, fallbackMode: 'inherit' }))}
                    className={`min-w-[112px] rounded-xl px-4 py-2 text-sm transition-all ${
                      effectiveAgentFallbackTabMode === 'inherit'
                        ? 'bg-white font-bold text-gray-900'
                        : 'text-gray-500 hover:bg-white/50 hover:text-gray-700'
                    } ${(newSessionData.fallbackMode === 'disabled' || shouldLockAgentFallbackTabs) ? 'cursor-not-allowed' : ''}`}
                  >
                    {t('sidebar.fallbackModeInherit')}
                  </button>
                  <button
                    type="button"
                    disabled={newSessionData.fallbackMode === 'disabled' || shouldLockAgentFallbackTabs}
                    onClick={() => setNewSessionData((prev) => ({ ...prev, fallbackMode: 'custom' }))}
                    className={`min-w-[112px] rounded-xl px-4 py-2 text-sm transition-all ${
                      effectiveAgentFallbackTabMode === 'custom'
                        ? 'bg-white font-bold text-gray-900'
                        : 'text-gray-500 hover:bg-white/50 hover:text-gray-700'
                    } ${(newSessionData.fallbackMode === 'disabled' || shouldLockAgentFallbackTabs) ? 'cursor-not-allowed' : ''}`}
                  >
                    {t('sidebar.fallbackModeCustom')}
                  </button>
                </div>
              </div>

              <div className="text-xs text-gray-400 font-normal">
                {t('sidebar.fallbackModelDescription')}
              </div>

              <ModelFallbackEditor
                availableModels={[...availableModels].sort((a, b) => {
                  const labelA = a.alias || a.id;
                  const labelB = b.alias || b.id;
                  return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
                })}
                mode={effectiveAgentFallbackEditorMode}
                onModeChange={(mode) => setNewSessionData((prev) => ({ ...prev, fallbackMode: mode }))}
                selectedModelIds={newSessionData.fallbacks}
                onSelectedModelIdsChange={(fallbacks) => setNewSessionData((prev) => ({
                  ...prev,
                  fallbacks,
                  fallbackMode: fallbacks.length > 0 ? 'custom' : prev.fallbackMode,
                }))}
                allowInherit
                excludedModelIds={newSessionData.model ? [newSessionData.model] : []}
                title=""
                description=""
                inheritLabel={t('sidebar.fallbackModeInherit')}
                inheritHint=""
                customLabel={t('sidebar.fallbackModeCustom')}
                customHint=""
                disabledLabel={t('sidebar.fallbackModeDisabled')}
                disabledHint=""
                searchPlaceholder={t('sidebar.fallbackSearchPlaceholder')}
                selectedTitle={t('sidebar.fallbackSelectedTitle')}
                availableTitle={t('sidebar.fallbackAvailableTitle')}
                emptySelectedText={t('sidebar.fallbackSelectedEmpty')}
                emptyAvailableText={t('sidebar.fallbackAvailableEmpty')}
                defaultBadgeLabel={t('sidebar.defaultModel')}
                hideModeSelector
                allModelsTabLabel={t('sidebar.allModels')}
                visionBadgeLabel={t('sidebar.visionModel')}
                selectionUiVariant="model-picker"
                className="min-w-0"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-bold text-gray-700">{t('sidebar.runtimeModeTitle')}</div>
                <div className="mt-1 text-xs text-gray-400">{t('sidebar.runtimeModeHint')}</div>
              </div>
              <div className="inline-flex items-center gap-1 rounded-2xl border border-gray-200 bg-gray-100/80 p-1">
                {runtimeModeOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setNewSessionData((prev) => ({ ...prev, runtimeMode: option.id }))}
                    className={`min-w-[96px] rounded-xl px-4 py-2 text-sm transition-all ${
                      newSessionData.runtimeMode === option.id
                        ? 'bg-white font-bold text-gray-900'
                        : 'text-gray-500 hover:bg-white/50 hover:text-gray-700'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {newSessionData.runtimeMode === 'configured' ? (
              <div className="rounded-2xl border border-gray-100 bg-gray-50/40 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm font-bold text-gray-700">{systemPromptTitle}</span>
                  <select
                    value={newSessionData.systemPromptMode}
                    onChange={(event) => setNewSessionData((prev) => ({
                      ...prev,
                      systemPromptMode: event.target.value as AgentSystemPromptMode,
                    }))}
                    className="min-w-[180px] px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 outline-none transition-all focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  >
                    {systemPromptModeOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm font-bold text-gray-700">{toolModeTitle}</span>
                  <select
                    value={newSessionData.toolMode}
                    onChange={(event) => setNewSessionData((prev) => ({
                      ...prev,
                      toolMode: event.target.value as AgentToolMode,
                    }))}
                    className="min-w-[180px] px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 outline-none transition-all focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  >
                    {toolModeOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </div>

</div>
            ) : (
              <div className="rounded-2xl border border-gray-100 bg-gray-50/40 p-4 text-xs text-gray-400">
                {t('sidebar.runtimeModeDirectHint')}
              </div>
            )}
            
            <div className="flex items-center gap-4 mb-1.5">
              <span className="text-sm font-bold text-gray-700">{t('sidebar.outputProcess')}</span>
              <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                <input 
                  type="checkbox" 
                  className="sr-only peer"
                  checked={!!newSessionData.process_start_tag}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setNewSessionData(prev => ({
                        ...prev, 
                        process_start_tag: '[执行工作_Start]', 
                        process_end_tag: '[执行工作_End]'
                      }));
                    } else {
                      setNewSessionData(prev => ({
                        ...prev, 
                        process_start_tag: '', 
                        process_end_tag: ''
                      }));
                    }
                  }}
                />
                <div className="w-11 h-6 bg-blue-100 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-200 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
              </label>
            </div>
            <div className="mb-4 text-xs text-gray-400 font-normal">
               {t('sidebar.outputProcessHint')}
            </div>

            <div className="flex-1 flex flex-col min-h-0 border border-gray-100 rounded-2xl overflow-hidden mt-2 bg-gray-50/30">
              <div className="flex p-1 bg-gray-100/50 gap-1 overflow-x-auto no-scrollbar">
                {[
                  { id: 'soul', name: t('sidebar.tabSoul') },
                  { id: 'user', name: t('sidebar.tabUser') },
                  { id: 'agents', name: t('sidebar.tabAgents') },
                  { id: 'tools', name: t('sidebar.tabTools') },
                  { id: 'heartbeat', name: t('sidebar.tabHeartbeat') },
                  { id: 'identity', name: t('sidebar.tabIdentity') }
                ].map(tab => (
                  <button
                    key={tab.id} type="button" onClick={() => setActiveTab(tab.id as AgentEditorTab)}
                    className={`flex-none px-3 py-1.5 text-sm rounded-lg transition-all whitespace-nowrap border border-gray-200 ${activeTab === tab.id ? 'bg-white text-blue-600 font-bold' : 'font-normal text-gray-500 hover:text-gray-700 hover:bg-white/50'}`}
                  >
                    {tab.name}
                  </button>
                ))}
              </div>
              <div className="flex-1 relative">
                <textarea 
                  value={newSessionData[AGENT_EDITOR_CONTENT_KEYS[activeTab]]}
                  onChange={e => setNewSessionData(prev => ({...prev, [AGENT_EDITOR_CONTENT_KEYS[activeTab]]: e.target.value}))}
                  placeholder={templates[activeTab as keyof typeof templates]}
                  className={MODAL_EDITOR_TEXTAREA_CLASS}
                />
              </div>
            </div>
          </div>
          <div className="p-4 sm:p-6 border-t border-gray-100 bg-gray-50/50 pt-4 flex gap-3">
            <button 
              type="button" 
              onClick={() => setIsModalOpen(false)}
              className="flex-1 px-4 py-2.5 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl font-bold transition-all active:scale-[0.98]"
            >
              {t('common.cancel')}
            </button>
            <button 
              type="submit" 
              disabled={!newSessionData.name.trim()}
              className="flex-1 px-4 py-2.5 text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-bold transition-all active:scale-[0.98]"
            >
              {modalMode === 'create' ? t('sidebar.confirmCreateBtn') : t('common.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
