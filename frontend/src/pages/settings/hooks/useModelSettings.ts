// 模型与端点：列表、默认模型、故障转移、图像模型、模型发现与连通性测试。
import { useEffect, useRef, useState } from 'react';
import { EMPTY_INLINE_ERROR, type EndpointConfig, type InlineErrorState, type SettingsProps } from '../shared/settingsTypes';
import type { ModelFallbackMode } from '../../../components/ModelFallbackEditor';
import { getImageGenerationModel, getModelFallbacks, listModels, saveImageGenerationModel, saveModelFallbacks, setDefaultModel, updateModel } from '../../../api/models';
import { resolveStructuredErrorDisplay } from '../shared/settingsHelpers';
import { createFallbackAutosave, fallbackSaveBody, type FallbackDraft } from '../shared/fallbackAutosave';
import { listEndpoints, saveEndpoint, testEndpoint } from '../../../api/endpoints';
import type { useSettingsShared } from './useSettingsShared';

export function useModelSettings(deps: Pick<SettingsProps & ReturnType<typeof useSettingsShared>, 'onModelsChanged' | 'openSettingsErrorModal' | 'setDeleteModalMessage' | 'setDeleteTarget' | 'setIsDeleteModalOpen' | 'setIsLoading' | 't'>) {
  const { onModelsChanged, openSettingsErrorModal, setDeleteModalMessage, setDeleteTarget, setIsDeleteModalOpen, setIsLoading, t } = deps;

  // --- Model Management State ---
  const [expandedEndpoints, setExpandedEndpoints] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('openclaw_expandedEndpoints');
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  useEffect(() => {
    localStorage.setItem('openclaw_expandedEndpoints', JSON.stringify(Array.from(expandedEndpoints)));
  }, [expandedEndpoints]);

  const toggleEndpointExpanded = (epName: string) => {
    setExpandedEndpoints(prev => {
      const next = new Set(prev);
      if (next.has(epName)) next.delete(epName);
      else next.add(epName);
      return next;
    });
  };
  const [models, setModels] = useState<{ id: string; alias?: string; primary: boolean; input: string[] }[]>([]);
  const [defaultModelId, setDefaultModelId] = useState('');
  const [defaultModelError, setDefaultModelError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isSavingDefaultModel, setIsSavingDefaultModel] = useState(false);
  const [imageGenerationModelId, setImageGenerationModelId] = useState('');
  const [imageGenerationFallbacks, setImageGenerationFallbacks] = useState<string[]>([]);
  const [imageGenerationFallbackMode, setImageGenerationFallbackMode] = useState<ModelFallbackMode>('disabled');
  const [imageGenerationModelError, setImageGenerationModelError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isSavingImageGenerationModel, setIsSavingImageGenerationModel] = useState(false);
  const [globalFallbacks, setGlobalFallbacks] = useState<string[]>([]);
  const [globalFallbackMode, setGlobalFallbackMode] = useState<ModelFallbackMode>('disabled');
  const [globalFallbackError, setGlobalFallbackError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [, setIsSavingGlobalFallbacks] = useState(false);
  // 自动保存只由 changeGlobalFallbacks（用户操作）触发；读到服务端的值走 loaded()，不写。见 shared/fallbackAutosave.ts。
  const saveGlobalFallbacksRef = useRef<(draft: FallbackDraft) => void>(() => undefined);
  const [globalFallbackAutosave] = useState(() => createFallbackAutosave({ save: (draft) => saveGlobalFallbacksRef.current(draft) }));

  const modelSupportsImageGeneration = (model: { input?: string[] }) => (
    (model.input || []).some((capability) => {
      const normalized = capability.toLowerCase().replace(/[-\s]+/g, '_');
      return normalized === 'image_generation' || normalized === 'image_generate' || normalized === 'image_output';
    })
  );

  const sortModelsByDisplayName = <T extends { id: string; alias?: string }>(items: T[]) => (
    [...items].sort((a, b) => {
      const labelA = a.alias || a.id;
      const labelB = b.alias || b.id;
      return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
    })
  );

  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editingAlias, setEditingAlias] = useState('');
  const [editingInput, setEditingInput] = useState<string[]>([]);
  const editAliasInputRef = useRef<HTMLInputElement>(null);
  const [modelActionError, setModelActionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [endpoints, setEndpoints] = useState<EndpointConfig[]>([]);
  const [isEndpointModalOpen, setIsEndpointModalOpen] = useState(false);
  const [isAddModelModalOpen, setIsAddModelModalOpen] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointConfig | null>(null);
  const [newEndpointData, setNewEndpointData] = useState<EndpointConfig>({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });
  const [endpointTestStatus, setEndpointTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [endpointTestMessage, setEndpointTestMessage] = useState('');
  const [endpointModalError, setEndpointModalError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);

  const fetchModels = async () => {
    try {
      const res = await listModels();
      const data = await res.json();
      if (data.success) {
        const nextModels = data.models || [];
        const nextDefaultModelId = nextModels.find((model: { id: string; primary: boolean }) => model.primary)?.id || '';
        setModels(nextModels);
        setDefaultModelId(nextDefaultModelId);
        onModelsChanged?.();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchImageGenerationModelConfig = async () => {
    try {
      const res = await getImageGenerationModel();
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        const primary = typeof data?.config?.primary === 'string' ? data.config.primary : '';
        const fallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        setImageGenerationModelId(primary);
        setImageGenerationFallbacks(fallbacks);
        setImageGenerationFallbackMode(fallbacks.length > 0 ? 'custom' : 'disabled');
        setImageGenerationModelError(EMPTY_INLINE_ERROR);
      } else {
        setImageGenerationModelError(resolveStructuredErrorDisplay(data, t, 'settings.models.imageGenerationLoadFailed'));
      }
    } catch (err) {
      setImageGenerationModelError({
        message: t('settings.models.imageGenerationLoadFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    }
  };

  const fetchGlobalFallbacks = async () => {
    try {
      const res = await getModelFallbacks();
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        const nextFallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        globalFallbackAutosave.loaded();
        setGlobalFallbacks(nextFallbacks);
        setGlobalFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        setGlobalFallbackError(EMPTY_INLINE_ERROR);
      } else {
        setGlobalFallbackError(resolveStructuredErrorDisplay(data, t, 'settings.models.globalFallbackSaveFailed'));
      }
    } catch (err) {
      setGlobalFallbackError({
        message: t('settings.models.globalFallbackLoadFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    }
  };

  const fetchEndpoints = async () => {
    try {
      const res = await listEndpoints();
      const data = await res.json();
      if (data.success) {
        setEndpoints(data.endpoints || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveGlobalFallbacks = async (draft: FallbackDraft) => {
    setIsSavingGlobalFallbacks(true);
    setGlobalFallbackError(EMPTY_INLINE_ERROR);

    try {
      const res = await saveModelFallbacks(fallbackSaveBody(draft));
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        const nextFallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        setGlobalFallbacks(nextFallbacks);
        setGlobalFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        return;
      }

      setGlobalFallbackError(resolveStructuredErrorDisplay(data, t, 'settings.models.globalFallbackSaveFailed'));
    } catch (err) {
      setGlobalFallbackError({
        message: t('settings.models.globalFallbackSaveFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsSavingGlobalFallbacks(false);
    }
  };

  const handleSaveImageGenerationModelConfig = async (primary: string, fallbacks: string[]) => {
    const normalizedPrimary = primary.trim();
    const normalizedFallbacks = Array.from(new Set(fallbacks.filter((id) => id && id !== normalizedPrimary)));
    setImageGenerationModelError(EMPTY_INLINE_ERROR);
    setIsSavingImageGenerationModel(true);

    try {
      const res = await saveImageGenerationModel({
          primary: normalizedPrimary || null,
          fallbacks: normalizedPrimary ? normalizedFallbacks : [],
        });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        const nextPrimary = typeof data?.config?.primary === 'string' ? data.config.primary : '';
        const nextFallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        setImageGenerationModelId(nextPrimary);
        setImageGenerationFallbacks(nextFallbacks);
        setImageGenerationFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        return;
      }

      setImageGenerationModelError(resolveStructuredErrorDisplay(data, t, 'settings.models.imageGenerationSaveFailed'));
      await fetchImageGenerationModelConfig();
    } catch (err) {
      setImageGenerationModelError({
        message: t('settings.models.imageGenerationSaveFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
      await fetchImageGenerationModelConfig();
    } finally {
      setIsSavingImageGenerationModel(false);
    }
  };

  saveGlobalFallbacksRef.current = (draft) => { void handleSaveGlobalFallbacks(draft); };
  useEffect(() => () => globalFallbackAutosave.dispose(), [globalFallbackAutosave]);

  /** 用户在界面上改了全局故障转移（开关、模式、勾选）：更新界面并去抖保存这份草稿。 */
  const changeGlobalFallbacks = (draft: FallbackDraft) => {
    setGlobalFallbackMode(draft.mode);
    setGlobalFallbacks(draft.fallbacks);
    globalFallbackAutosave.edited(draft);
  };

  const handleDeleteModel = (id: string, isPrimary: boolean) => {
    setDeleteTarget({ type: 'model', id });
    setDeleteModalMessage(t('settings.models.deleteModelConfirm', {
      id,
      defaultWarning: isPrimary ? t('settings.models.defaultModelWarning') : '',
    }));
    setIsDeleteModalOpen(true);
  };

  const handleSaveDefaultModelSelection = async (id: string) => {
    const nextId = id.trim();
    if (!nextId) {
      setDefaultModelError({
        message: t('settings.models.defaultModelNoSelection'),
        detail: '',
      });
      return;
    }

    const previousId = defaultModelId;
    setDefaultModelId(nextId);
    setDefaultModelError(EMPTY_INLINE_ERROR);
    setIsSavingDefaultModel(true);

    try {
      const res = await setDefaultModel({ id: nextId });

      if (res.ok) {
        await fetchModels();
        return;
      }

      const data = await res.json().catch(() => ({}));
      setDefaultModelId(previousId);
      setDefaultModelError(resolveStructuredErrorDisplay(data, t, 'settings.models.setDefaultModelFailed'));
    } catch (err) {
      setDefaultModelId(previousId);
      setDefaultModelError({
        message: t('settings.models.setDefaultModelNetworkError'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsSavingDefaultModel(false);
    }
  };

  const handleSetDefaultModel = async (id: string) => {
    setIsLoading(true);
    try {
      await handleSaveDefaultModelSelection(id);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const startEditModel = (model: { id: string; alias?: string; input: string[] }) => {
    setEditingModelId(model.id);
    setEditingAlias(model.alias || '');
    setEditingInput(model.input || []);
    setTimeout(() => editAliasInputRef.current?.focus(), 50);
  };

  const handleDeleteEndpoint = (endpoint: string, count: number) => {
    setDeleteTarget({ type: 'endpoint', name: endpoint });
    setDeleteModalMessage(t('settings.models.deleteEndpointConfirm', { endpoint, count }));
    setIsDeleteModalOpen(true);
  };

  const cancelEditModel = () => {
    setEditingModelId(null);
    setEditingAlias('');
  };

  const handleSaveModelAlias = async () => {
    if (!editingModelId) return;
    setIsLoading(true);
    try {
      const res = await updateModel({ id: editingModelId, alias: editingAlias, input: editingInput });
      if (res.ok) {
        setModelActionError(EMPTY_INLINE_ERROR);
        setEditingModelId(null);
        setEditingAlias('');
        setEditingInput([]);
        fetchModels();
        fetchImageGenerationModelConfig();

      } else {
        const data = await res.json().catch(() => ({}));
        setModelActionError(resolveStructuredErrorDisplay(data, t, 'settings.models.editAliasFailed'));
      }
    } catch (err) {
      console.error(err);
      setModelActionError({
        message: t('settings.models.editAliasNetworkError'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const openAddEndpointModal = () => {
    setEditingEndpoint(null);
    setNewEndpointData({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });
    setEndpointTestStatus('idle');
    setEndpointTestMessage('');
    setEndpointModalError(EMPTY_INLINE_ERROR);
    setIsEndpointModalOpen(true);
  };

  const openEditEndpointModal = (ep: EndpointConfig) => {
    setEditingEndpoint(ep);
    // 后端不回传 apiKey：编辑时输入框起手为空，留空 = 保持原值。
    setNewEndpointData({ ...ep, apiKey: '' });
    setEndpointTestStatus('idle');
    setEndpointTestMessage('');
    setEndpointModalError(EMPTY_INLINE_ERROR);
    setIsEndpointModalOpen(true);
  };

  const handleSaveEndpoint = async () => {
    if (!newEndpointData.id.trim() || !newEndpointData.baseUrl.trim() || !newEndpointData.api) {
      setEndpointModalError({ message: t('settings.models.endpointConfigRequired'), detail: '' });
      return;
    }
    setIsLoading(true);
    try {
      const res = await saveEndpoint(
        { id: newEndpointData.id, baseUrl: newEndpointData.baseUrl, apiKey: newEndpointData.apiKey, api: newEndpointData.api },
        editingEndpoint?.revision ?? null,
      );
      if (res.ok) {
        setEndpointModalError(EMPTY_INLINE_ERROR);
        setIsEndpointModalOpen(false);
        fetchEndpoints();

      } else if (res.status === 412) {
        // 别处（另一个标签页、CLI、网关）改过这个服务商：载入最新版本，提示后让用户再保存一次。
        const data = await res.json().catch(() => ({}));
        const latest = data?.current?.value as EndpointConfig | undefined;
        if (latest) {
          setEditingEndpoint(latest);
          setNewEndpointData({ ...latest, apiKey: newEndpointData.apiKey });
        }
        setEndpointModalError({ message: t('control.common.changedElsewhere'), detail: '' });
        fetchEndpoints();
      } else {
        const data = await res.json().catch(() => ({}));
        setEndpointModalError(resolveStructuredErrorDisplay(data, t, 'settings.models.saveEndpointFailed'));
      }
    } catch (err) {
      console.error(err);
      setEndpointModalError({
        message: t('settings.models.saveEndpointNetworkError'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestEndpoint = async () => {
    if (!newEndpointData.baseUrl.trim() || !newEndpointData.api) {
      setEndpointTestStatus('error');
      setEndpointTestMessage(t('settings.models.fillBaseUrlApiType'));
      return;
    }
    
    setEndpointTestStatus('testing');
    setEndpointTestMessage(t('settings.models.testing'));
    
    try {
      const res = await testEndpoint({
          baseUrl: newEndpointData.baseUrl,
          apiKey: newEndpointData.apiKey,
          api: newEndpointData.api,
          // 编辑时 key 留空：让后端用库里保存的 key 测（前端拿不到它）。
          endpointId: editingEndpoint?.id,
        });
      const data = await res.json();
      if (data.success) {
        setEndpointTestStatus('success');
        // 404/405 on /models：可达，但上游不提供目录——提示手动输入模型 ID，而不是报失败。
        setEndpointTestMessage(data.catalogUnavailable ? t('control.models.reachableNoCatalog') : t('settings.models.endpointConnectionSuccess'));
        setTimeout(() => setEndpointTestStatus('idle'), 3000);
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.endpointConnectionFailed');
        setEndpointTestStatus('error');
        setEndpointTestMessage(display.message);
        if (display.detail) {
          openSettingsErrorModal(display.message, display.detail);
        }
      }
    } catch (err: any) {
      const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
      setEndpointTestStatus('error');
      setEndpointTestMessage(t('settings.models.networkConnectionError'));
      if (detail) {
        openSettingsErrorModal(t('settings.models.networkConnectionError'), detail);
      }
    }
  };

  // Get distinct endpoints from current models, merged with actual endpoints objects
  const knownEndpoints = Array.from(new Set([
    ...endpoints.map(ep => ep.id),
    ...models.map(m => m.id.split('/')[0]).filter(Boolean)
  ])).sort((a, b) => a.localeCompare(b));
  const currentPrimaryModelId = models.find((model) => model.primary)?.id || '';
  const sortedModels = sortModelsByDisplayName(models);
  const imageGenerationModels = sortModelsByDisplayName(models.filter(modelSupportsImageGeneration));
  const hasImageGenerationModels = imageGenerationModels.length > 0;

  return {
    expandedEndpoints,
    setExpandedEndpoints,
    toggleEndpointExpanded,
    models,
    setModels,
    defaultModelId,
    setDefaultModelId,
    defaultModelError,
    setDefaultModelError,
    isSavingDefaultModel,
    setIsSavingDefaultModel,
    imageGenerationModelId,
    setImageGenerationModelId,
    imageGenerationFallbacks,
    setImageGenerationFallbacks,
    imageGenerationFallbackMode,
    setImageGenerationFallbackMode,
    imageGenerationModelError,
    setImageGenerationModelError,
    isSavingImageGenerationModel,
    setIsSavingImageGenerationModel,
    globalFallbacks,
    globalFallbackMode,
    // 界面只经 changeGlobalFallbacks 改（带自动保存）；不导出原始 setter，免得绕开「只有用户操作才写」。
    changeGlobalFallbacks,
    globalFallbackError,
    setGlobalFallbackError,
    setIsSavingGlobalFallbacks,
    modelSupportsImageGeneration,
    sortModelsByDisplayName,
    editingModelId,
    setEditingModelId,
    editingAlias,
    setEditingAlias,
    editingInput,
    setEditingInput,
    editAliasInputRef,
    modelActionError,
    setModelActionError,
    endpoints,
    setEndpoints,
    isEndpointModalOpen,
    setIsEndpointModalOpen,
    isAddModelModalOpen,
    setIsAddModelModalOpen,
    editingEndpoint,
    setEditingEndpoint,
    newEndpointData,
    setNewEndpointData,
    endpointTestStatus,
    setEndpointTestStatus,
    endpointTestMessage,
    setEndpointTestMessage,
    endpointModalError,
    setEndpointModalError,
    fetchModels,
    fetchImageGenerationModelConfig,
    fetchGlobalFallbacks,
    fetchEndpoints,
    handleSaveImageGenerationModelConfig,
    handleDeleteModel,
    handleSaveDefaultModelSelection,
    handleSetDefaultModel,
    startEditModel,
    handleDeleteEndpoint,
    cancelEditModel,
    handleSaveModelAlias,
    openAddEndpointModal,
    openEditEndpointModal,
    handleSaveEndpoint,
    handleTestEndpoint,
    knownEndpoints,
    currentPrimaryModelId,
    sortedModels,
    imageGenerationModels,
    hasImageGenerationModels,
  };
}
