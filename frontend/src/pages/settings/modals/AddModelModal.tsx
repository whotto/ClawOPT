// 添加模型弹窗与连通性失败时的强制添加确认。
import { Activity, Check, Loader2, Plus, X } from 'lucide-react';
import type { SettingsController } from '../useSettingsController';

export default function AddModelModal({ ctx }: { ctx: SettingsController }) {
  const {
    CAPABILITIES,
    addModelError,
    addModelErrorDetail,
    addModelTestMessage,
    addModelTestStatus,
    cancelDiscovery,
    cancelTestAll,
    discoveredModels,
    dropdownRef,
    endpointSearchQuery,
    existingModelIds,
    guessCapabilities,
    handleAddModel,
    handleDiscoverModels,
    handleTestAllFiltered,
    handleTestModel,
    handleTestSingleModel,
    hasFetched,
    individualTestStatus,
    isAddModelModalOpen,
    isDiscovering,
    isEndpointDropdownOpen,
    isLoading,
    isModelDropdownOpen,
    knownEndpoints,
    modelDropdownMaxHeight,
    modelSearchQuery,
    newModelAlias,
    newModelEndpoint,
    newModelInput,
    newModelName,
    newModelUsesImageGeneration,
    setEndpointSearchQuery,
    setHasFetched,
    setIsAddModelModalOpen,
    setIsEndpointDropdownOpen,
    setIsModelDropdownOpen,
    setModelSearchQuery,
    setNewModelAlias,
    setNewModelEndpoint,
    setNewModelInput,
    setNewModelName,
    setShowForceAddModal,
    setShowOnlyConnected,
    showForceAddModal,
    showOnlyConnected,
    t,
    testModelMessage,
  } = ctx;

  return (
    <>
      {isAddModelModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsAddModelModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl min-h-[400px] max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200 flex flex-col">
            <div className="px-6 py-5 border-b border-gray-100 flex justify-between items-start bg-gray-50/50 rounded-t-2xl">
              <div>
                <h3 className="text-lg font-bold text-gray-900 mt-1">{t('settings.models.addModelTitle')}</h3>
                <div className="text-xs text-gray-500 mt-1">
                  {t('settings.models.addModelIntro')}
                  <div className="text-red-500 font-bold mt-1 space-y-0.5 leading-relaxed">
                    <p>{t('settings.models.addModelNoteAutoFetch')}</p>
                    <p>{t('settings.models.addModelNoteTestConsumesToken')}</p>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setIsAddModelModalOpen(false)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                title={t('common.close')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 flex-1 overflow-visible flex flex-col">
              {addModelError && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                  <X className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div>{addModelError}</div>
                    {addModelErrorDetail && (
                      <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {addModelErrorDetail}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 z-[210]">
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-900 mb-1.5">
                    {t('settings.models.endpointLabel')} <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={isEndpointDropdownOpen ? endpointSearchQuery : newModelEndpoint}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEndpointSearchQuery(val);
                        if (!isEndpointDropdownOpen) setIsEndpointDropdownOpen(true);
                      }}
                      onFocus={() => {
                        setEndpointSearchQuery('');
                        setIsEndpointDropdownOpen(true);
                      }}
                      placeholder={newModelEndpoint ? newModelEndpoint : t('settings.models.endpointPlaceholder')}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all text-sm font-mono text-gray-900 pr-8"
                    />
                    {newModelEndpoint && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNewModelEndpoint('');
                          setEndpointSearchQuery('');
                          setIsEndpointDropdownOpen(false);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-all"
                        title={t('common.clear')}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {isEndpointDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-[10]" onClick={() => {
                        setIsEndpointDropdownOpen(false);
                        if (endpointSearchQuery && !newModelEndpoint) {
                          setNewModelEndpoint(endpointSearchQuery.trim());
                          handleDiscoverModels(endpointSearchQuery.trim());
                        }
                      }} />
                      <div className="absolute z-[20] top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl max-h-[160px] overflow-y-auto">
                        {knownEndpoints
                          .filter(ep => {
                            if (!endpointSearchQuery) return true;
                            return ep.toLowerCase().includes(endpointSearchQuery.toLowerCase());
                          })
                          .map((ep, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                setNewModelEndpoint(ep);
                                setHasFetched(false);
                                setEndpointSearchQuery('');
                                setIsEndpointDropdownOpen(false);
                              }}
                              className={`w-full text-left px-4 py-2 text-sm hover:bg-blue-50 transition-colors flex items-center gap-2 ${ newModelEndpoint === ep ? 'bg-blue-50 text-blue-600' : 'text-gray-700' }`}
                            >
                              <span className="font-mono text-xs max-w-[200px] truncate">{ep}</span>
                            </button>
                          ))
                        }
                        {endpointSearchQuery && !knownEndpoints.some(ep => ep.toLowerCase() === endpointSearchQuery.toLowerCase()) && (
                          <button
                            type="button"
                            onClick={() => {
                              const val = endpointSearchQuery.trim();
                              setNewModelEndpoint(val);
                              setHasFetched(false);
                              setEndpointSearchQuery('');
                              setIsEndpointDropdownOpen(false);
                            }}
                            className="w-full text-left px-4 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors border-t border-gray-100 bg-gray-50 flex items-center justify-between"
                          >
                            <span>{t('settings.models.useNewEndpoint')} <strong className="font-mono">{endpointSearchQuery}</strong></span>
                            <Plus className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-900 mb-1.5">{t('settings.models.aliasOptionalLabel')}</label>
                  <input
                    type="text"
                    value={newModelAlias}
                    onChange={(e) => setNewModelAlias(e.target.value)}
                    placeholder={t('settings.models.aliasExamplePlaceholder')}
                    className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                  />
                </div>
              </div>

              <div className="flex-1 flex flex-col relative z-10" ref={dropdownRef}>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-gray-900">
                    {t('settings.models.modelIdLabel')} <span className="text-red-500">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (isDiscovering) {
                        cancelDiscovery();
                      } else if (hasFetched && discoveredModels.length > 0) {
                        setHasFetched(false);
                      } else {
                        handleDiscoverModels(newModelEndpoint.trim());
                      }
                    }}
                    disabled={!newModelEndpoint.trim()}
                    title={isDiscovering ? t('settings.models.fetchingModelsTitle') : ""}
                    className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all border flex items-center gap-1.5 ${ !newModelEndpoint.trim() ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : isDiscovering ? 'bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50' }`}
                  >
                    {isDiscovering && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {isDiscovering 
                      ? t('settings.models.autoFetching')
                      : (hasFetched && discoveredModels.length > 0) 
                        ? t('settings.models.manualInput')
                        : t('settings.models.autoFetch')
                    }
                  </button>
                </div>
                <div 
                  className="relative cursor-pointer block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus-within:bg-white focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-500/20 transition-all text-sm min-h-[46px] flex items-center gap-2 flex-wrap"
                  onClick={() => {
                    if (hasFetched && discoveredModels.length > 0) {
                      setIsModelDropdownOpen(true);
                    }
                  }}
                >
                  <input
                    type="text"
                    value={newModelName}
                    onChange={(e) => {
                      setNewModelName(e.target.value);
                      setModelSearchQuery(e.target.value);
                      // Auto-detect capabilities when user types a model name
                      if (e.target.value.trim()) {
                        setNewModelInput(guessCapabilities(e.target.value.trim()));
                      }
                    }}
                    placeholder={!hasFetched ? t('settings.models.modelPlaceholderNoFetch') : (discoveredModels.length > 0 ? t('settings.models.modelPlaceholderFetched', { count: discoveredModels.length }) : t('settings.models.modelPlaceholderEmpty'))}
                    className="bg-transparent border-none outline-none w-full text-sm placeholder-gray-400 py-1"
                    onFocus={() => {
                      if (hasFetched && discoveredModels.length > 0) {
                        setIsModelDropdownOpen(true);
                      }
                    }}
                  />
                  {newModelName && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setNewModelName('');
                        setModelSearchQuery('');
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-all"
                      title={t('common.clear')}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {isModelDropdownOpen && (hasFetched && discoveredModels.length > 0) && (
                  <>
                  <div className="fixed inset-0 z-[40]" onClick={(e) => { e.stopPropagation(); setIsModelDropdownOpen(false); }} />
                  <div 
                    className="absolute z-50 left-0 right-0 top-[80px] bg-white border border-gray-200 rounded-xl flex flex-col overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200"
                    style={{ maxHeight: modelDropdownMaxHeight ? `${modelDropdownMaxHeight}px` : '350px' }}
                  >
                    {(() => {
                      const visibleDiscoveredModels = discoveredModels.filter(m => {
                        if (showOnlyConnected && individualTestStatus[m]?.status !== 'success') return false;
                        return m.toLowerCase().includes(modelSearchQuery.toLowerCase());
                      }).sort((a, b) => a.localeCompare(b));
                      const isAnyTesting = Object.values(individualTestStatus).some(t => t.status === 'testing');
                      const hasAnyTests = Object.keys(individualTestStatus).length > 0;

                      return (
                        <>
                          <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 bg-gray-50/95 backdrop-blur">
                            <span className="text-sm text-gray-700 font-semibold flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 rounded-full bg-green-500"></span>
                              {t('settings.models.modelListTitle', { count: visibleDiscoveredModels.length })}
                            </span>

                            <div className="flex items-center gap-3">
                              <div className="flex items-center bg-gray-200/50 p-0.5 rounded-lg border border-gray-200/50">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setShowOnlyConnected(false); }}
                                  disabled={isAnyTesting}
                                  className={`text-sm px-3 py-1.5 rounded-md font-medium transition-all border ${ !showOnlyConnected ? 'bg-white text-gray-800 border-gray-200' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-200/50' } ${isAnyTesting ? 'opacity-50 cursor-not-allowed' : ''}`}
                                >
                                  {t('settings.models.filterAll')}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setShowOnlyConnected(true); }}
                                  disabled={isAnyTesting || !hasAnyTests}
                                  className={`text-sm px-3 py-1.5 rounded-md font-medium transition-all border ${ showOnlyConnected ? 'bg-white text-green-700 border-green-200' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-200/50' } ${(isAnyTesting || !hasAnyTests) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  title={!hasAnyTests ? t('settings.models.noConnectivityTestsYet') : ""}
                                >
                                  {t('settings.models.filterValid')}
                                </button>
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                if (isAnyTesting) {
                                  cancelTestAll();
                                } else {
                                  handleTestAllFiltered();
                                }
                              }}
                              disabled={!isAnyTesting && visibleDiscoveredModels.length === 0}
                              title={isAnyTesting ? t('settings.models.fetchingModelsTitle') : ""}
                              className={`text-sm flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all border ${ !isAnyTesting && visibleDiscoveredModels.length === 0 ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : isAnyTesting ? 'text-red-600 bg-red-50 hover:bg-red-100 border-red-200' : 'text-indigo-700 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 border-indigo-200' }`}
                            >
                              {isAnyTesting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                              {isAnyTesting
                                  ? t('settings.models.testingCount', { count: Object.values(individualTestStatus).filter(t => t.status === 'testing').length })
                                  : t('settings.models.testModels')
                                }
                              </button>
                            </div>
                          </div>

                          <div className="overflow-y-auto flex-1 p-1.5 space-y-0.5 min-h-[100px]" onClick={() => setIsModelDropdownOpen(false)}>
                            {visibleDiscoveredModels.length === 0 && (
                              <div className="py-8 text-center text-gray-400 text-sm">
                                {showOnlyConnected ? t('settings.models.noValidModelsFound') : t('settings.models.noMatchingModels', { query: modelSearchQuery })}
                              </div>
                            )}
                            {visibleDiscoveredModels.map(m => {
                              const isExisting = existingModelIds.has(`${newModelEndpoint.trim()}/${m}`);
                              const testData = individualTestStatus[m];
                              const isSelected = newModelName === m;

                              return (
                                <div 
                                  key={m}
                                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all ${ isExisting ? 'opacity-60 bg-gray-50/50 cursor-not-allowed' : isSelected ? 'bg-blue-50/80 border-blue-100 font-medium cursor-pointer ' : 'hover:bg-gray-100 cursor-pointer border-transparent' } border`}
                                  onClick={(e) => {
                                    if (isExisting) return;
                                    e.preventDefault();
                                    if (isSelected) {
                                      setNewModelName('');
                                    } else {
                                      setNewModelName(m);
                                      setIsModelDropdownOpen(false);
                                      // Auto-detect capabilities when a model is selected from dropdown
                                      setNewModelInput(guessCapabilities(m));
                                    }
                                  }}
                                >
                                  <div className="flex items-center gap-3 overflow-hidden flex-1">
                                    <span className={`truncate ${isSelected ? 'text-blue-900' : 'text-gray-700'}`} title={m}>{m}</span>
                                    {isExisting && <span className="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full ml-1 shrink-0 font-medium">{t('settings.models.alreadyInUse')}</span>}
                                  </div>

                                  {!isExisting && (
                                    <div className="flex items-center gap-2 shrink-0 ml-3" onClick={e => e.stopPropagation()}>
                                      {testData?.status === 'testing' && <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />}
                                      {testData?.status === 'success' && <span title={t('settings.models.valid')}><Check className="w-3.5 h-3.5 text-green-500" /></span>}
                                      {testData?.status === 'error' && <span title={testData.detail || testData.message}><X className="w-3.5 h-3.5 text-red-500" /></span>}

                                      <button 
                                        onClick={(e) => handleTestSingleModel(m, e)}
                                        className="text-xs text-gray-500 hover:text-indigo-600 px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 transition-colors"
                                        title={t('settings.models.testSingleModel')}
                                      >
                                        {t('common.test')}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  </>
                )}
              </div>

              {/* Model Capabilities Section */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <label className="block text-sm font-medium text-gray-900">{t('settings.models.capabilitiesLabel')}</label>
                  <span className="text-xs text-gray-400">{t('settings.models.capabilitiesHint')}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {CAPABILITIES.map(cap => {
                    const active = newModelInput.includes(cap.id);
                    return (
                      <button
                        key={cap.id}
                        type="button"
                        onClick={() => setNewModelInput(prev =>
                          prev.includes(cap.id) ? prev.filter(i => i !== cap.id) : [...prev, cap.id]
                        )}
                        className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${ active ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-gray-400 bg-gray-50 border-gray-200 hover:bg-gray-100' }`}
                      >
                        <cap.Icon className="w-3.5 h-3.5" />
                        {cap.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100 rounded-b-2xl">
              <button
                type="button"
                onClick={() => setIsAddModelModalOpen(false)}
                className="flex-[0.5] px-3 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all text-sm whitespace-nowrap"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleTestModel}
                disabled={addModelTestStatus === 'testing' || !newModelEndpoint.trim() || !newModelName.trim()}
                className={`flex-[1.5] px-3 py-2.5 rounded-xl font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 text-sm overflow-hidden ${ addModelTestStatus === 'testing' ? 'bg-blue-50 text-blue-600 border border-blue-200' : addModelTestStatus === 'success' ? 'bg-green-50 text-green-600 border border-green-200' : addModelTestStatus === 'error' ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-indigo-50 text-indigo-700 border border-indigo-200 hover:text-indigo-800 hover:bg-indigo-100' }`}
                title={addModelTestStatus !== 'idle' ? addModelTestMessage : (newModelUsesImageGeneration ? t('settings.models.testImageGenerationLight') : t('settings.models.testThisModel'))}
              >
                {addModelTestStatus === 'testing' ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> :
                 addModelTestStatus === 'success' ? <Check className="w-4 h-4 shrink-0" /> :
                 addModelTestStatus === 'error' ? <X className="w-4 h-4 shrink-0" /> :
                 <Activity className="w-4 h-4 shrink-0" />}
                <span className="truncate">
                  {addModelTestStatus === 'idle' ? t('common.test') : addModelTestMessage}
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleAddModel()}
                disabled={isLoading || addModelTestStatus === 'testing' || !newModelEndpoint.trim() || !newModelName.trim()}
                className="flex-[0.8] px-3 py-2.5 text-white bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition-all disabled:opacity-50 flex items-center justify-center gap-2 text-sm whitespace-nowrap"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {t('settings.models.add')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showForceAddModal && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <h3 className="text-xl font-bold text-gray-900 mb-2">{t('settings.models.forceAddTitle')}</h3>
              <p className="text-sm text-gray-700 mb-6 bg-red-50 p-3 rounded-lg border border-red-100">{testModelMessage}</p>
              <p className="text-sm text-gray-600 mb-6">{t('settings.models.forceAddDescription')}</p>
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => setShowForceAddModal(false)}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors cursor-pointer"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    setShowForceAddModal(false);
                    handleAddModel();
                  }}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition-colors cursor-pointer"
                >
                  {t('settings.models.forceAdd')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
