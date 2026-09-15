// 模型设置页签。
import { Activity, Check, ChevronDown, Edit2, Library, Loader2, Plus, Trash2, X } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { SettingsController } from '../useSettingsController';
import ModelSinglePicker from '../../../components/ModelSinglePicker';
import ModelFallbackEditor from '../../../components/ModelFallbackEditor';
import ModelsExtrasPanel from '../models/ModelsExtrasPanel';
import ProviderCatalogModal from '../models/ProviderCatalogModal';

export default function ModelsTab({ ctx }: { ctx: SettingsController }) {
  // P5a：服务商模型目录弹窗（刷新 / 撤销 / 可见性 / 上下文长度）。
  const [catalogProvider, setCatalogProvider] = useState<string | null>(null);
  const {
    fetchEndpoints,
    CAPABILITIES,
    cancelEditModel,
    currentPrimaryModelId,
    defaultModelError,
    defaultModelId,
    editAliasInputRef,
    editingAlias,
    editingInput,
    editingModelId,
    endpoints,
    existingModelTestStatus,
    expandedEndpoints,
    globalFallbackError,
    globalFallbackMode,
    globalFallbacks,
    handleDeleteEndpoint,
    handleDeleteModel,
    handleSaveDefaultModelSelection,
    handleSaveImageGenerationModelConfig,
    handleSaveModelAlias,
    handleSetDefaultModel,
    handleTestExistingSingleModel,
    hasImageGenerationModels,
    imageGenerationFallbackMode,
    imageGenerationFallbacks,
    imageGenerationModelError,
    imageGenerationModelId,
    imageGenerationModels,
    isLoading,
    isSavingDefaultModel,
    isSavingImageGenerationModel,
    knownEndpoints,
    modelActionError,
    modelError,
    modelSupportsImageGeneration,
    models,
    openAddEndpointModal,
    openEditEndpointModal,
    setAddModelError,
    setAddModelErrorDetail,
    setAddModelTestStatus,
    setDiscoveredModels,
    setEditingAlias,
    setEditingInput,
    setGlobalFallbackMode,
    setGlobalFallbacks,
    setImageGenerationFallbackMode,
    setImageGenerationFallbacks,
    setImageGenerationModelId,
    setIndividualTestStatus,
    setIsAddModelModalOpen,
    setModelError,
    setModelSearchQuery,
    setNewModelAlias,
    setNewModelEndpoint,
    setNewModelName,
    setShowOnlyConnected,
    setTestModelMessage,
    sortedModels,
    startEditModel,
    t,
    toggleEndpointExpanded,
  } = ctx;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-start sm:items-center">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.models.title')}</h3>
          <p className="text-sm text-gray-500">{t('settings.models.description')}</p>
        </div>
        <button
          onClick={openAddEndpointModal}
          className="h-[40px] px-5 rounded-xl bg-blue-600 text-white font-medium text-sm hover:bg-blue-700 transition-all flex items-center gap-1.5 shrink-0"
        >
          <Plus className="w-4 h-4" />
          {t('settings.models.addEndpoint')}
        </button>
      </div>

      {modelActionError.message && (
        <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
          <X className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div>{modelActionError.message}</div>
            {modelActionError.detail && (
              <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                {modelActionError.detail}
              </div>
            )}
          </div>
        </div>
      )}

      {modelError && (
        <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-center gap-2">
          <X className="w-4 h-4 shrink-0" />
          {modelError}
        </div>
      )}

      {/* Unified Endpoint + Model List */}
      <div className="space-y-3">
        {knownEndpoints.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-200 px-4 py-12 text-center text-gray-400 text-sm">
            {t('settings.models.emptyEndpoints')}
          </div>
        ) : (
          knownEndpoints.map(epName => {
            const epModels = models.filter(m => m.id.startsWith(`${epName}/`)).sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
            const epConfig = endpoints.find(e => e.id === epName) || { id: epName, baseUrl: '', apiKey: '', api: 'openai-completions' };
            const displayApi = epConfig.api === 'openai-completions' ? 'OpenAI' : 
                               epConfig.api === 'anthropic-messages' ? 'Anthropic' :
                               epConfig.api === 'google-genai' ? 'Gemini' : 
                               epConfig.api === 'ollama' ? 'Ollama' : epConfig.api;
            const isExpanded = expandedEndpoints.has(epName);

            return (
              <div key={epName} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                {/* Endpoint Header Row */}
                <div
                  className="flex items-center gap-3 px-4 py-4 cursor-pointer hover:bg-gray-50/80 transition-colors select-none group"
                  onClick={() => toggleEndpointExpanded(epName)}
                >
                  <ChevronDown className={`w-6 h-6 text-gray-400 transition-transform duration-200 shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5 mb-0.5">
                      <span className="font-semibold text-gray-900 text-base">{epName}</span>
                      <span className="px-2 py-0.5 rounded-md bg-gray-100/80 border border-gray-200 text-gray-500 text-xs font-mono">
                        {displayApi}
                      </span>
                      <span className="hidden sm:inline text-xs text-gray-400">{t('settings.models.modelCount', { count: epModels.length })}</span>
                    </div>
                    <div className="text-sm text-gray-400 truncate">{epConfig.baseUrl || '-'}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => {
                        setNewModelEndpoint(epName);
                        setNewModelName('');
                        setNewModelAlias('');
                        setAddModelTestStatus('idle');
                        setTestModelMessage('');
                        setDiscoveredModels([]);
                        setModelSearchQuery('');
                        setIndividualTestStatus({});
                        setShowOnlyConnected(false);
                        setModelError('');
                        setAddModelError('');
                        setAddModelErrorDetail('');
                        setIsAddModelModalOpen(true);
                      }}
                      className="flex items-center gap-1 px-2 py-1.5 text-sm text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-all"
                      title={t('settings.models.addModel')}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">{t('settings.models.addModel')}</span>
                    </button>
                    <button
                      onClick={() => setCatalogProvider(epName)}
                      className="flex items-center gap-1 px-2 py-1.5 text-sm text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                      title={t('control.models.catalog')}
                    >
                      <Library className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">{t('control.models.catalog')}</span>
                    </button>
                    <button
                      onClick={() => openEditEndpointModal(epConfig)}
                      className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                      title={t('settings.models.editEndpoint')}
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteEndpoint(epName, epModels.length)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                      title={t('settings.models.deleteEntireEndpoint')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Expanded Models Section */}
                {isExpanded && (
                  <div className="border-t border-gray-100">
                    {epModels.length === 0 ? (
                      <div className="px-6 py-6 text-center text-gray-400 text-sm">
                        {t('settings.models.noModelsPrefix')}
                        <button
                          onClick={() => {
                            setNewModelEndpoint(epName);
                            setNewModelName('');
                            setNewModelAlias('');
                            setAddModelTestStatus('idle');
                            setTestModelMessage('');
                            setDiscoveredModels([]);
                            setModelSearchQuery('');
                            setIndividualTestStatus({});
                            setShowOnlyConnected(false);
                            setModelError('');
                            setAddModelError('');
                            setAddModelErrorDetail('');
                            setIsAddModelModalOpen(true);
                          }}
                          className="text-blue-600 hover:text-blue-700 font-medium hover:underline"
                        >
                          {t('settings.models.clickToAdd')}
                        </button>
                      </div>
                    ) : (
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-gray-50/80 border-b border-gray-100">
                            <th className="px-6 py-2.5 font-medium text-gray-500 whitespace-nowrap text-xs">{t('settings.models.tableModelId')}</th>
                            <th className="px-4 py-2.5 font-medium text-gray-500 whitespace-nowrap text-xs">{t('settings.models.tableAlias')}</th>
                            <th className="px-4 py-2.5 font-medium text-gray-500 whitespace-nowrap w-20 text-xs">{t('settings.models.tableStatus')}</th>
                            <th className="px-4 py-2.5 font-medium text-gray-500 whitespace-nowrap text-right w-28 text-xs">{t('settings.models.tableActions')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {epModels.map((model, idx) => {
                            const modelName = model.id.substring(epName.length + 1);
                            return (
                              <Fragment key={model.id}>
                              <tr className={`transition-colors text-sm ${editingModelId === model.id ? 'bg-blue-50/30' : 'group'}`}>
                                <td className="px-6 py-3 text-gray-700">
                                  <div className="text-[13px]">{modelName}</div>
                                </td>
                                <td className="px-4 py-3 text-gray-600 text-[13px]">
                                  {editingModelId === model.id ? (
                                    <input
                                      ref={editAliasInputRef}
                                      type="text"
                                      value={editingAlias}
                                      onChange={(e) => setEditingAlias(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSaveModelAlias();
                                        if (e.key === 'Escape') cancelEditModel();
                                      }}
                                      placeholder={t('settings.models.aliasPlaceholder')}
                                      className="w-full px-2 py-1 text-[13px] border border-blue-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                                    />
                                  ) : (
                                    model.alias || <span className="text-gray-300">-</span>
                                  )}
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex items-center gap-2">
                                    {(() => {
                                      const testData = existingModelTestStatus[model.id];
                                      if (testData?.status === 'testing') return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
                                      if (testData?.status === 'success') return <Check className="w-4 h-4 text-green-500" />;
                                      if (testData?.status === 'error') return <span title={testData.detail || testData.message}><X className="w-4 h-4 text-red-500" /></span>;
                                      return null;
                                    })()}
                                    {model.primary ? (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 whitespace-nowrap">
                                        {t('settings.models.defaultTag')}
                                      </span>
                                    ) : null}
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-right">
                                  {editingModelId === model.id ? (
                                    <div className="flex items-center justify-end gap-1">
                                      <button
                                        onClick={handleSaveModelAlias}
                                        disabled={isLoading}
                                        className="p-1.5 text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors"
                                        title={t('common.save')}
                                      >
                                        <Check className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        onClick={cancelEditModel}
                                        className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                        title={t('common.cancel')}
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <button
                                        onClick={() => startEditModel(model)}
                                        className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                        title={t('settings.models.editAlias')}
                                      >
                                        <Edit2 className="w-4 h-4" />
                                      </button>
                                      {!model.primary && (
                                        <button
                                          onClick={() => handleSetDefaultModel(model.id)}
                                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                          title={t('settings.models.setDefault')}
                                        >
                                          <Check className="w-4 h-4" />
                                        </button>
                                      )}
                                      <button
                                        onClick={() => {
                                          handleTestExistingSingleModel(model.id, epName, modelName);
                                        }}
                                        disabled={existingModelTestStatus[model.id]?.status === 'testing'}
                                        className={`p-1.5 rounded-lg transition-colors ${ existingModelTestStatus[model.id]?.status === 'testing' ? 'text-gray-300 cursor-not-allowed' : 'text-gray-400 hover:text-purple-600 hover:bg-purple-50' }`}
                                        title={modelSupportsImageGeneration(model) ? t('settings.models.testImageGenerationLight') : t('settings.models.testAvailability')}
                                      >
                                        <Activity className="w-4 h-4" />
                                      </button>
                                      <button
                                        onClick={() => handleDeleteModel(model.id, model.primary)}
                                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                        title={t('common.delete')}
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                              {/* Capabilities row */}
                              {editingModelId === model.id ? (
                                <tr className="bg-blue-50/30">
                                  <td colSpan={3} className="px-6 pt-0 pb-3">
                                    <div className="flex flex-nowrap gap-1">
                                      {CAPABILITIES.map(cap => {
                                        const active = editingInput.includes(cap.id);
                                        return (
                                          <button
                                            key={cap.id}
                                            type="button"
                                            onClick={() => setEditingInput(prev =>
                                              prev.includes(cap.id) ? prev.filter(i => i !== cap.id) : [...prev, cap.id]
                                            )}
                                            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium border transition-all ${ active ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-gray-400 bg-gray-50 border-gray-200' }`}
                                          >
                                            <cap.Icon className="w-2.5 h-2.5" />
                                            {cap.label}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </td>
                                  <td></td>
                                </tr>
                              ) : (
                                (model.input || []).filter(i => i !== 'text').length > 0 && (
                                  <tr>
                                    <td colSpan={3} className="px-6 pt-0 pb-3">
                                      <div className="flex flex-nowrap gap-1">
                                        {CAPABILITIES.filter(c => (model.input || []).includes(c.id)).map(cap => (
                                          <span key={cap.id} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium border text-blue-600 bg-blue-50 border-blue-200">
                                            <cap.Icon className="w-2.5 h-2.5" />
                                            {cap.label}
                                          </span>
                                        ))}
                                      </div>
                                    </td>
                                    <td></td>
                                  </tr>
                                )
                              )}
                              {idx < epModels.length - 1 && (
                                <tr><td colSpan={4} className="p-0"><div className="mx-5 border-b border-gray-200"></div></td></tr>
                              )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="space-y-4 pt-2">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-gray-900">
            {t('settings.models.defaultModelTitle')}
          </h3>
          <p className="text-sm text-gray-500 leading-relaxed">
            {t('settings.models.defaultModelDescription')}
          </p>
        </div>

        {defaultModelError.message ? (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
            <div>{defaultModelError.message}</div>
            {defaultModelError.detail ? (
              <div className="mt-2 rounded-lg border border-red-100 bg-white/80 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                {defaultModelError.detail}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
          <ModelSinglePicker
            availableModels={sortedModels}
            selectedModelId={defaultModelId}
            onSelectedModelIdChange={(id) => {
              void handleSaveDefaultModelSelection(id);
            }}
            placeholder={t('settings.models.defaultModelPlaceholder')}
            emptyText={t('settings.models.defaultModelEmpty')}
            allModelsTabLabel={t('sidebar.allModels')}
            defaultBadgeLabel={t('settings.models.defaultTag')}
            visionBadgeLabel={t('sidebar.visionModel')}
            imageGenerationBadgeLabel={t('settings.models.imageGenerationBadge')}
            disabled={isSavingDefaultModel || models.length === 0}
          />
        </div>
      </div>

      <div className="space-y-4 pt-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">
              {t('settings.models.globalFallbackTitle')}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed">
              {t('settings.models.globalFallbackDescription')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={globalFallbackMode !== 'disabled'}
            aria-label={t('settings.models.globalFallbackTitle')}
            onClick={() => setGlobalFallbackMode((prev) => prev === 'disabled' ? 'custom' : 'disabled')}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${globalFallbackMode !== 'disabled' ? 'bg-blue-600' : 'bg-gray-200'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${globalFallbackMode !== 'disabled' ? 'translate-x-6' : 'translate-x-1'}`}
            />
          </button>
        </div>

        {globalFallbackError.message ? (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
            <div>{globalFallbackError.message}</div>
            {globalFallbackError.detail ? (
              <div className="mt-2 rounded-lg border border-red-100 bg-white/80 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                {globalFallbackError.detail}
              </div>
            ) : null}
          </div>
        ) : null}

        {globalFallbackMode !== 'disabled' ? (
          <ModelFallbackEditor
            availableModels={[...models].sort((a, b) => {
              const labelA = a.alias || a.id;
              const labelB = b.alias || b.id;
              return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
            })}
            mode={globalFallbackMode}
            onModeChange={(mode) => setGlobalFallbackMode(mode)}
            selectedModelIds={globalFallbacks}
            onSelectedModelIdsChange={(ids) => {
              setGlobalFallbacks(ids);
              if (ids.length === 0) {
                setGlobalFallbackMode('disabled');
              } else if (globalFallbackMode !== 'custom') {
                setGlobalFallbackMode('custom');
              }
            }}
            excludedModelIds={currentPrimaryModelId ? [currentPrimaryModelId] : []}
            title=""
            description=""
            customLabel={t('settings.models.fallbackModeCustom')}
            customHint=""
            disabledLabel={t('settings.models.fallbackModeDisabled')}
            disabledHint=""
            hideModeSelector
            searchPlaceholder={t('settings.models.fallbackSearchPlaceholder')}
            selectedTitle={t('settings.models.fallbackSelectedTitle')}
            availableTitle={t('settings.models.fallbackAvailableTitle')}
            emptySelectedText={t('settings.models.fallbackSelectedEmpty')}
            emptyAvailableText={t('settings.models.fallbackAvailableEmpty')}
            defaultBadgeLabel={t('settings.models.defaultTag')}
            allModelsTabLabel={t('sidebar.allModels')}
            visionBadgeLabel={t('sidebar.visionModel')}
            imageGenerationBadgeLabel={t('settings.models.imageGenerationBadge')}
            selectionUiVariant="model-picker"
            className="min-w-0"
          />
        ) : null}
      </div>

      <div className="space-y-4 pt-2">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-gray-900">
            {t('settings.models.imageGenerationTitle')}
          </h3>
          <p className="text-sm text-gray-500 leading-relaxed">
            {t('settings.models.imageGenerationDescription')}
          </p>
        </div>

        {imageGenerationModelError.message ? (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
            <div>{imageGenerationModelError.message}</div>
            {imageGenerationModelError.detail ? (
              <div className="mt-2 rounded-lg border border-red-100 bg-white/80 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                {imageGenerationModelError.detail}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="min-w-0 space-y-4 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
          <ModelSinglePicker
            availableModels={imageGenerationModels}
            selectedModelId={imageGenerationModelId}
            onSelectedModelIdChange={(id) => {
              const nextFallbacks = imageGenerationFallbacks.filter((fallbackId) => fallbackId !== id);
              setImageGenerationModelId(id);
              setImageGenerationFallbacks(nextFallbacks);
              if (nextFallbacks.length === 0) {
                setImageGenerationFallbackMode('disabled');
              }
              void handleSaveImageGenerationModelConfig(id, nextFallbacks);
            }}
            placeholder={t('settings.models.imageGenerationPlaceholder')}
            emptyText={t('settings.models.imageGenerationEmpty')}
            allModelsTabLabel={t('sidebar.allModels')}
            defaultBadgeLabel={t('settings.models.defaultTag')}
            visionBadgeLabel={t('sidebar.visionModel')}
            imageGenerationBadgeLabel={t('settings.models.imageGenerationBadge')}
            disabled={isSavingImageGenerationModel || !hasImageGenerationModels}
          />

          {!imageGenerationModelId ? (
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-500">
              {hasImageGenerationModels
                ? t('settings.models.imageGenerationOpenClawDefaultHint')
                : t('settings.models.imageGenerationNoSupportedHint')}
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-4 pt-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">
              {t('settings.models.imageGenerationFallbackTitle')}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed">
              {t('settings.models.imageGenerationFallbackDescription')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(imageGenerationModelId) && imageGenerationFallbackMode !== 'disabled'}
            aria-label={t('settings.models.imageGenerationFallbackTitle')}
            disabled={!imageGenerationModelId || isSavingImageGenerationModel}
            onClick={() => {
              if (!imageGenerationModelId) return;
              if (imageGenerationFallbackMode === 'disabled') {
                setImageGenerationFallbackMode('custom');
                return;
              }
              setImageGenerationFallbackMode('disabled');
              setImageGenerationFallbacks([]);
              void handleSaveImageGenerationModelConfig(imageGenerationModelId, []);
            }}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60 ${imageGenerationModelId && imageGenerationFallbackMode !== 'disabled' ? 'bg-blue-600' : 'bg-gray-200'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${imageGenerationModelId && imageGenerationFallbackMode !== 'disabled' ? 'translate-x-6' : 'translate-x-1'}`}
            />
          </button>
        </div>

        {imageGenerationModelId ? (
          imageGenerationFallbackMode !== 'disabled' ? (
            <ModelFallbackEditor
              availableModels={imageGenerationModels}
              mode={imageGenerationFallbackMode}
              onModeChange={(mode) => setImageGenerationFallbackMode(mode)}
              selectedModelIds={imageGenerationFallbacks}
              onSelectedModelIdsChange={(ids) => {
                const nextIds = ids.filter((id) => id !== imageGenerationModelId);
                setImageGenerationFallbacks(nextIds);
                setImageGenerationFallbackMode(nextIds.length > 0 ? 'custom' : 'disabled');
                void handleSaveImageGenerationModelConfig(imageGenerationModelId, nextIds);
              }}
              excludedModelIds={[imageGenerationModelId]}
              title=""
              description=""
              customLabel={t('settings.models.fallbackModeCustom')}
              customHint=""
              disabledLabel={t('settings.models.fallbackModeDisabled')}
              disabledHint=""
              hideModeSelector
              searchPlaceholder={t('settings.models.imageGenerationFallbackSearchPlaceholder')}
              selectedTitle={t('settings.models.fallbackSelectedTitle')}
              availableTitle={t('settings.models.fallbackAvailableTitle')}
              emptySelectedText={t('settings.models.fallbackSelectedEmpty')}
              emptyAvailableText={t('settings.models.fallbackAvailableEmpty')}
              defaultBadgeLabel={t('settings.models.defaultTag')}
              allModelsTabLabel={t('sidebar.allModels')}
              visionBadgeLabel={t('sidebar.visionModel')}
              imageGenerationBadgeLabel={t('settings.models.imageGenerationBadge')}
              selectionUiVariant="model-picker"
              className="min-w-0"
            />
          ) : null
        ) : (
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-500">
            {hasImageGenerationModels
              ? t('settings.models.imageGenerationFallbackNeedsPrimary')
              : t('settings.models.imageGenerationNoSupportedHint')}
          </div>
        )}
      </div>

      <ModelsExtrasPanel modelIds={models.map((model) => model.id)} />

      {catalogProvider && (
        <ProviderCatalogModal
          providerId={catalogProvider}
          revision={endpoints.find((endpoint) => endpoint.id === catalogProvider)?.revision ?? null}
          contextLengths={endpoints.find((endpoint) => endpoint.id === catalogProvider)?.contextLengths ?? {}}
          onClose={() => setCatalogProvider(null)}
          onChanged={() => void fetchEndpoints()}
        />
      )}
    </div>
  );
}
