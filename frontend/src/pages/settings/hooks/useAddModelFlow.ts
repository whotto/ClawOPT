// 模型连通性测试与添加模型弹窗：端点与模型下拉、模型发现、单个 / 批量 / 已有模型测试、添加。
import { useEffect, useRef, useState } from 'react';
import { ArrowUpDown, Eye, Globe, Image as ImageIcon, Link2, Wrench, Zap } from 'lucide-react';
import type { TestStatus } from '../shared/settingsTypes';
import { addModel, discoverModels, testModel } from '../../../api/models';
import { resolveStructuredErrorDisplay } from '../shared/settingsHelpers';
import type { useModelSettings } from './useModelSettings';
import type { useSettingsShared } from './useSettingsShared';

export function useAddModelFlow(deps: Pick<ReturnType<typeof useModelSettings> & ReturnType<typeof useSettingsShared>, 'fetchModels' | 'modelSupportsImageGeneration' | 'models' | 'setIsAddModelModalOpen' | 'setIsLoading' | 't'>) {
  const { fetchModels, modelSupportsImageGeneration, models, setIsAddModelModalOpen, setIsLoading, t } = deps;

  const [newModelEndpoint, setNewModelEndpoint] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [newModelAlias, setNewModelAlias] = useState('');
  const [newModelInput, setNewModelInput] = useState<string[]>(['text']);
  const [modelError, setModelError] = useState('');
  const [isEndpointDropdownOpen, setIsEndpointDropdownOpen] = useState(false);
  const [endpointSearchQuery, setEndpointSearchQuery] = useState('');

  const [testModelMessage, setTestModelMessage] = useState('');

  const [addModelTestStatus, setAddModelTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [addModelTestMessage, setAddModelTestMessage] = useState('');
  const [showForceAddModal, setShowForceAddModal] = useState(false);

  // --- Model Discovery State ---
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const discoverAbortControllerRef = useRef<AbortController | null>(null);
  const testAllAbortControllerRef = useRef<AbortController | null>(null);
  const [addModelError, setAddModelError] = useState('');
  const [addModelErrorDetail, setAddModelErrorDetail] = useState('');
  const [existingModelTestStatus, setExistingModelTestStatus] = useState<Record<string, TestStatus>>({}); 

  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [showOnlyConnected, setShowOnlyConnected] = useState(false);
  const [individualTestStatus, setIndividualTestStatus] = useState<Record<string, TestStatus>>({});

  const dropdownRef = useRef<HTMLDivElement>(null);
  const [modelDropdownMaxHeight, setModelDropdownMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (isModelDropdownOpen && dropdownRef.current) {
      const rect = dropdownRef.current.getBoundingClientRect();
      const availableSpace = window.innerHeight - (rect.top + 80) - 24;
      setModelDropdownMaxHeight(Math.max(200, availableSpace));
    }
  }, [isModelDropdownOpen]);

  // Capability definitions
  const CAPABILITIES = [
    { id: 'image',     label: t('settings.models.capability.image'), Icon: Eye,         color: 'text-violet-600 bg-violet-50 border-violet-200' },
    { id: 'image_generation', label: t('settings.models.capability.imageGeneration'), Icon: ImageIcon, color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
    { id: 'reasoning', label: t('settings.models.capability.reasoning'), Icon: Zap,         color: 'text-amber-600 bg-amber-50 border-amber-200' },
    { id: 'tools',     label: t('settings.models.capability.tools'), Icon: Wrench,      color: 'text-pink-600 bg-pink-50 border-pink-200' },
    { id: 'web',       label: t('settings.models.capability.web'), Icon: Globe,       color: 'text-blue-600 bg-blue-50 border-blue-200' },
    { id: 'rerank',    label: t('settings.models.capability.rerank'), Icon: ArrowUpDown, color: 'text-gray-600 bg-gray-50 border-gray-200' },
    { id: 'embed',     label: t('settings.models.capability.embed'), Icon: Link2,       color: 'text-gray-600 bg-gray-50 border-gray-200' },
  ] as const;

  const guessCapabilities = (modelId: string): string[] => {
    const id = modelId.toLowerCase();
    const caps = new Set<string>(['text']);
    if (/vision|4v|claude-3|claude-opus|claude-sonnet|claude-haiku|gpt-4o|gpt-4-turbo|gemini|llava|qwen.*vl|intern.*vl|glm-4v|minicpm.*v|cogvlm|pixtral|phi.*vision|qvq|kimi.*vl|chatglm.*vl|(^|\/)gpt-5\.4$/.test(id)) caps.add('image');
    if (/gpt[-_.]?image|dall[-_.]?e|imagen|flux|sdxl|stable[-_.]?diffusion|seedream|jimeng|image[-_.]?01|grok[-_.]?imagine|gemini.*image|image[-_.]?preview|comfy.*workflow|workflow.*comfy/.test(id)) caps.add('image_generation');
    if (/o1|o3|o4|thinking|reasoning|deepthink|r1|r2/.test(id)) caps.add('reasoning');
    if (/embed|embedding|text-embedding|bge|e5-/.test(id)) caps.add('embed');
    if (/rerank|reranker|bce-reranker/.test(id)) caps.add('rerank');
    return Array.from(caps);
  };

  const handleDiscoverModels = async (endpointId: string) => {
    if (!endpointId) return;
    
    // Abort any ongoing fetch
    if (discoverAbortControllerRef.current) {
      discoverAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    discoverAbortControllerRef.current = controller;

    setIsDiscovering(true);
    setHasFetched(false);
    setDiscoveredModels([]);
    setModelSearchQuery('');
    setIndividualTestStatus({});
    setIsModelDropdownOpen(false); // keep closed until results are back
    setAddModelError('');
    setAddModelErrorDetail('');

    try {
      const res = await discoverModels(endpointId, controller.signal);
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setDiscoveredModels(data.models || []);
        setHasFetched(true);
        if ((data.models || []).length > 0) {
          setIsModelDropdownOpen(true);
        }
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.discoverFailed');
        setAddModelError(display.message);
        setAddModelErrorDetail(display.detail);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('Discovery aborted');
      } else {
        const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
        setAddModelError(t('settings.models.discoverFailed'));
        setAddModelErrorDetail(detail);
      }
    } finally {
      if (discoverAbortControllerRef.current === controller) {
        setIsDiscovering(false);
        discoverAbortControllerRef.current = null;
      }
    }
  };

  const cancelDiscovery = () => {
    if (discoverAbortControllerRef.current) {
      discoverAbortControllerRef.current.abort();
      discoverAbortControllerRef.current = null;
      setIsDiscovering(false);
    }
  };

  const handleTestSingleModel = async (modelId: string, e?: React.MouseEvent, signal?: AbortSignal) => {
    if (e) e.stopPropagation();
    const shouldUseImageGenerationTest = guessCapabilities(modelId).includes('image_generation');
    setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'testing', message: '' }}));
    try {
      const res = await testModel({ endpoint: newModelEndpoint.trim(), modelName: modelId }, { imageGeneration: shouldUseImageGenerationTest, signal });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setIndividualTestStatus(prev => ({
          ...prev,
          [modelId]: {
            status: 'success',
            message: shouldUseImageGenerationTest ? t('settings.models.imageGenerationLightCheckGood') : 'OK',
            detail: typeof data.warning === 'string' && data.warning.trim() ? data.warning.trim() : undefined,
          },
        }));
      } else {
        const display = resolveStructuredErrorDisplay(data, t, shouldUseImageGenerationTest ? 'settings.models.imageGenerationLightCheckFailed' : 'settings.models.connectivityFailed');
        setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'error', message: display.message, detail: display.detail || undefined }}));
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Just clear the testing state if aborted, don't show an error
        setIndividualTestStatus(prev => {
          const next = { ...prev };
          delete next[modelId];
          return next;
        });
      } else {
        const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
        const message = t('settings.models.testNetworkError');
        setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'error', message, detail: detail || undefined }}));
      }
    }
  };

  const handleTestExistingSingleModel = async (fullModelId: string, endpoint: string, modelName: string) => {
    const shouldUseImageGenerationTest = modelSupportsImageGeneration(models.find((model) => model.id === fullModelId) || {});
    setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'testing' } }));
    try {
      const res = await testModel({ endpoint, modelName }, { imageGeneration: shouldUseImageGenerationTest });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        setExistingModelTestStatus(prev => ({
          ...prev,
          [fullModelId]: {
            status: 'success',
            message: shouldUseImageGenerationTest ? t('settings.models.imageGenerationLightCheckGood') : undefined,
            detail: typeof data.warning === 'string' && data.warning.trim() ? data.warning.trim() : undefined,
          },
        }));
      } else {
        const display = resolveStructuredErrorDisplay(data, t, shouldUseImageGenerationTest ? 'settings.models.imageGenerationLightCheckFailed' : 'settings.models.connectivityFailed');
        setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'error', message: display.message, detail: display.detail || undefined } }));
      }
    } catch (err: any) {
      const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
      const message = t('settings.models.testNetworkError');
      setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'error', message, detail: detail || undefined } }));
    }
  };

  const existingModelIds = new Set(models.map(m => m.id));

  const handleTestAllFiltered = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    
    if (testAllAbortControllerRef.current) {
      testAllAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    testAllAbortControllerRef.current = controller;

    const filtered = discoveredModels.filter(m => m.toLowerCase().includes(modelSearchQuery.toLowerCase()));
    const testPromises = filtered.map(async (m) => {
      if (existingModelIds.has(`${newModelEndpoint.trim()}/${m}`)) return;
      await handleTestSingleModel(m, undefined, controller.signal);
    });

    try {
      await Promise.all(testPromises);
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        setAddModelError(error.message || t('settings.models.partialBatchTestFailed'));
        setAddModelErrorDetail('');
      }
    } finally {
      if (testAllAbortControllerRef.current === controller) {
        testAllAbortControllerRef.current = null;
      }
    }
  };

  const cancelTestAll = () => {
    if (testAllAbortControllerRef.current) {
      testAllAbortControllerRef.current.abort();
      testAllAbortControllerRef.current = null;
    }
  };

  const handleTestModel = async (e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    if (!newModelEndpoint.trim() || !newModelName.trim()) {
      setAddModelError(t('settings.models.endpointModelRequiredForTest'));
      setAddModelErrorDetail('');
      setTimeout(() => setAddModelError(''), 3000);
      return false;
    }
    setAddModelTestStatus('testing');
    const shouldUseImageGenerationTest = modelSupportsImageGeneration({ input: newModelInput });
    setAddModelTestMessage(shouldUseImageGenerationTest ? t('settings.models.imageGenerationLightChecking') : t('settings.models.testingConnectivity'));
    try {
      const res = await testModel({
          endpoint: newModelEndpoint.trim(),
          modelName: newModelName.trim()
        }, { imageGeneration: shouldUseImageGenerationTest });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        setAddModelTestStatus('success');
        const latency = data.latency !== undefined ? `${data.latency}ms` : t('settings.models.unknownLatency');
        setAddModelTestMessage(shouldUseImageGenerationTest
          ? t('settings.models.imageGenerationLightCheckGoodWithLatency', { latency })
          : t('settings.models.connectivityGood', { latency }));
        setTestModelMessage(typeof data.warning === 'string' && data.warning.trim() ? data.warning.trim() : '');
        return true;
      } else {
        const display = resolveStructuredErrorDisplay(data, t, shouldUseImageGenerationTest ? 'settings.models.imageGenerationLightCheckFailed' : 'settings.models.connectivityFailed');
        setAddModelTestStatus('error');
        setAddModelTestMessage(display.message);
        setTestModelMessage(display.detail || display.message);
        return false;
      }
    } catch (err: any) {
      const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
      const message = t('settings.models.testNetworkError');
      setAddModelTestStatus('error');
      setAddModelTestMessage(message);
      setTestModelMessage(detail || message);
      return false;
    }
  };

  const handleAddModel = async () => {
    if (!newModelEndpoint.trim() || !newModelName.trim()) {
      setAddModelError(t('settings.models.endpointModelRequired'));
      setAddModelErrorDetail('');
      setTimeout(() => setAddModelError(''), 3000);
      return;
    }

    setIsLoading(true);
    try {
      const res = await addModel({
          endpoint: newModelEndpoint.trim(),
          modelName: newModelName.trim(),
          alias: newModelAlias.trim() || undefined,
          input: newModelInput.length > 0 ? newModelInput : undefined,
        });
      
      if (res.ok) {
        setNewModelEndpoint('');
        setNewModelName('');
        setNewModelAlias('');
        setNewModelInput(['text']);
        setAddModelError('');
        setAddModelErrorDetail('');
        setIsAddModelModalOpen(false);
        fetchModels();
      } else {
        const data = await res.json().catch(() => ({}));
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.saveModelFailed');
        setAddModelError(display.message);
        setAddModelErrorDetail(display.detail);
      }
    } catch (err) {
      console.error(err);
      setAddModelError(t('settings.models.addModelNetworkError'));
      setAddModelErrorDetail(err instanceof Error && err.message.trim() ? err.message.trim() : '');
    } finally {
      setIsLoading(false);
    }
  };
  const newModelUsesImageGeneration = modelSupportsImageGeneration({ input: newModelInput });

  return {
    newModelEndpoint,
    setNewModelEndpoint,
    newModelName,
    setNewModelName,
    newModelAlias,
    setNewModelAlias,
    newModelInput,
    setNewModelInput,
    modelError,
    setModelError,
    isEndpointDropdownOpen,
    setIsEndpointDropdownOpen,
    endpointSearchQuery,
    setEndpointSearchQuery,
    testModelMessage,
    setTestModelMessage,
    addModelTestStatus,
    setAddModelTestStatus,
    addModelTestMessage,
    setAddModelTestMessage,
    showForceAddModal,
    setShowForceAddModal,
    isDiscovering,
    setIsDiscovering,
    hasFetched,
    setHasFetched,
    discoverAbortControllerRef,
    testAllAbortControllerRef,
    addModelError,
    setAddModelError,
    addModelErrorDetail,
    setAddModelErrorDetail,
    existingModelTestStatus,
    setExistingModelTestStatus,
    discoveredModels,
    setDiscoveredModels,
    modelSearchQuery,
    setModelSearchQuery,
    isModelDropdownOpen,
    setIsModelDropdownOpen,
    showOnlyConnected,
    setShowOnlyConnected,
    individualTestStatus,
    setIndividualTestStatus,
    dropdownRef,
    modelDropdownMaxHeight,
    setModelDropdownMaxHeight,
    CAPABILITIES,
    guessCapabilities,
    handleDiscoverModels,
    cancelDiscovery,
    handleTestSingleModel,
    handleTestExistingSingleModel,
    existingModelIds,
    handleTestAllFiltered,
    cancelTestAll,
    handleTestModel,
    handleAddModel,
    newModelUsesImageGeneration,
  };
}
