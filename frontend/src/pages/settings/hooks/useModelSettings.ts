// 模型与端点：列表、默认模型、故障转移、图像模型、模型发现与连通性测试。
import { useEffect, useRef, useState } from 'react';
import { EMPTY_INLINE_ERROR, type EndpointConfig, type InlineErrorState, type SettingsProps } from '../shared/settingsTypes';
import type { ModelFallbackMode } from '../../../components/ModelFallbackEditor';
import { getImageGenerationModel, getModelFallbacks, listModels, saveImageGenerationModel, saveModelFallbacks, setDefaultModel, updateModel } from '../../../api/models';
import { resolveStructuredErrorDisplay } from '../shared/settingsHelpers';
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
  const globalFallbackAutosaveTimerRef = useRef<number | null>(null);
  const globalFallbackAutosaveUnlockTimerRef = useRef<number | null>(null);
  const suppressGlobalFallbackAutosaveRef = useRef(true);

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
        suppressGlobalFallbackAutosaveRef.current = true;
        if (globalFallbackAutosaveUnlockTimerRef.current !== null) {
          window.clearTimeout(globalFallbackAutosaveUnlockTimerRef.current);
        }
        setGlobalFallbacks(nextFallbacks);
        setGlobalFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        setGlobalFallbackError(EMPTY_INLINE_ERROR);
        globalFallbackAutosaveUnlockTimerRef.current = window.setTimeout(() => {
          suppressGlobalFallbackAutosaveRef.current = false;
          globalFallbackAutosaveUnlockTimerRef.current = null;
        }, 0);
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

  const handleSaveGlobalFallbacks = async () => {
    setIsSavingGlobalFallbacks(true);
    setGlobalFallbackError(EMPTY_INLINE_ERROR);

    try {
      const res = await saveModelFallbacks({
          fallbacks: globalFallbackMode === 'disabled' ? [] : globalFallbacks,
        });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        const nextFallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        suppressGlobalFallbackAutosaveRef.current = true;
        if (globalFallbackAutosaveUnlockTimerRef.current !== null) {
          window.clearTimeout(globalFallbackAutosaveUnlockTimerRef.current);
        }
        setGlobalFallbacks(nextFallbacks);
        setGlobalFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        globalFallbackAutosaveUnlockTimerRef.current = window.setTimeout(() => {
          suppressGlobalFallbackAutosaveRef.current = false;
          globalFallbackAutosaveUnlockTimerRef.current = null;
        }, 0);
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

  useEffect(() => {
    if (suppressGlobalFallbackAutosaveRef.current) return;
    if (globalFallbackMode === 'custom' && globalFallbacks.length === 0) return;

    if (globalFallbackAutosaveTimerRef.current !== null) {
      window.clearTimeout(globalFallbackAutosaveTimerRef.current);
    }

    globalFallbackAutosaveTimerRef.current = window.setTimeout(() => {
      void handleSaveGlobalFallbacks();
      globalFallbackAutosaveTimerRef.current = null;
    }, 180);

    return () => {
      if (globalFallbackAutosaveTimerRef.current !== null) {
        window.clearTimeout(globalFallbackAutosaveTimerRef.current);
        globalFallbackAutosaveTimerRef.current = null;
      }
    };
  }, [globalFallbackMode, globalFallbacks]);

  useEffect(() => {
    return () => {
      if (globalFallbackAutosaveTimerRef.current !== null) {
        window.clearTimeout(globalFallbackAutosaveTimerRef.current);
      }
      if (globalFallbackAutosaveUnlockTimerRef.current !== null) {
        window.clearTimeout(globalFallbackAutosaveUnlockTimerRef.current);
      }
    };
  }, []);

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
    setNewEndpointData({ ...ep });
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
      const res = await saveEndpoint(newEndpointData);
      if (res.ok) {
        setEndpointModalError(EMPTY_INLINE_ERROR);
        setIsEndpointModalOpen(false);
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
          api: newEndpointData.api
        });
      const data = await res.json();
      if (data.success) {
        setEndpointTestStatus('success');
        setEndpointTestMessage(t('settings.models.endpointConnectionSuccess'));
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
    setGlobalFallbacks,
    globalFallbackMode,
    setGlobalFallbackMode,
    globalFallbackError,
    setGlobalFallbackError,
    setIsSavingGlobalFallbacks,
    globalFallbackAutosaveTimerRef,
    globalFallbackAutosaveUnlockTimerRef,
    suppressGlobalFallbackAutosaveRef,
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
    handleSaveGlobalFallbacks,
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
