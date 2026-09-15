import { useState } from 'react';
import type { TFunction } from 'i18next';
import { getModelFallbacks } from '../../api/models';
import { createSession, getSessionConfigs, listSessions, updateSession } from '../../api/sessions';
import type { ModelFallbackMode } from '../../components/ModelFallbackEditor';
import { requestActiveContextRefresh } from '../../utils/contextRefresh';
import type { SettingsTab, ViewType } from '../routeState';
import { buildLocalAgentPromptChars, formatCompactCount, resolveSidebarSubmitError } from './sidebarFormat';
import type {
  AgentEditorTab,
  AgentFormData,
  AgentRuntimeMetrics,
  AgentRuntimeMode,
  AgentSystemPromptMode,
  AgentToolMode,
} from './sidebarTypes';

type AgentEditorDeps = {
  t: TFunction;
  language: string;
  availableModels: any[];
  reloadSessions: () => Promise<void>;
  activeSessionId: string;
  setActiveSessionId: (id: string) => void;
  navigateTo: (view: ViewType, tab?: SettingsTab, openMenu?: boolean) => void;
  currentView: ViewType;
  closeSessionInfo: () => void;
};

/** 新建 / 编辑智能体弹窗：表单状态、派生展示值、提交与载入编辑数据。 */
export function useAgentEditor({
  t,
  language,
  availableModels,
  reloadSessions,
  activeSessionId,
  setActiveSessionId,
  navigateTo,
  currentView,
  closeSessionInfo,
}: AgentEditorDeps) {
  // Modal State
  const [newSessionData, setNewSessionData] = useState<AgentFormData>({
    id: '', name: '', model: '', process_start_tag: '', process_end_tag: '',
    runtimeMode: 'configured' as AgentRuntimeMode,
    systemPromptMode: 'system' as AgentSystemPromptMode,
    toolMode: 'full' as AgentToolMode,
    runtimeMetrics: null as AgentRuntimeMetrics | null,
    soulContent: '', userContent: '', agentsContent: '', toolsContent: '', heartbeatContent: '', identityContent: '',
    fallbackMode: 'disabled' as ModelFallbackMode,
    fallbacks: [] as string[],
  });
  const [activeTab, setActiveTab] = useState<AgentEditorTab>('soul');
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [modelProviderTab, setModelProviderTab] = useState('all');

  // New Session/Persona Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isGlobalFallbackEnabled, setIsGlobalFallbackEnabled] = useState(true);

  const agentFallbackTabMode: 'inherit' | 'custom' =
    newSessionData.fallbackMode === 'custom' || (newSessionData.fallbackMode === 'disabled' && newSessionData.fallbacks.length > 0)
      ? 'custom'
      : 'inherit';
  const shouldLockAgentFallbackTabs = !isGlobalFallbackEnabled;
  const effectiveAgentFallbackTabMode: 'inherit' | 'custom' = shouldLockAgentFallbackTabs
    ? 'custom'
    : agentFallbackTabMode;
  const effectiveAgentFallbackEditorMode: ModelFallbackMode =
    newSessionData.fallbackMode === 'disabled'
      ? 'disabled'
      : shouldLockAgentFallbackTabs && newSessionData.fallbackMode === 'inherit'
        ? 'custom'
        : newSessionData.fallbackMode;
  const runtimeModeOptions: Array<{ id: AgentRuntimeMode; label: string }> = [
    { id: 'configured', label: t('sidebar.runtimeModeConfigured') },
    { id: 'direct', label: t('sidebar.runtimeModeDirect') },
  ];
  const systemPromptModeOptions: Array<{ id: AgentSystemPromptMode; label: string }> = [
    { id: 'system', label: t('sidebar.systemPromptModeSystem') },
    { id: 'agent', label: t('sidebar.systemPromptModeAgent') },
  ];
  const toolModeOptions: Array<{ id: AgentToolMode; label: string }> = [
    { id: 'full', label: t('sidebar.toolModeFull') },
    { id: 'coding', label: t('sidebar.toolModeCoding') },
    { id: 'messaging', label: t('sidebar.toolModeMessaging') },
    { id: 'minimal', label: t('sidebar.toolModeMinimal') },
    { id: 'off', label: t('sidebar.toolModeOff') },
  ];
  const formatCharCountLabel = (count: number | null | undefined) => (
    typeof count === 'number' && Number.isFinite(count)
      ? t('sidebar.charCountLabel', { count: formatCompactCount(count, language) })
      : ''
  );
  const systemPromptChars = newSessionData.systemPromptMode === 'agent'
    ? buildLocalAgentPromptChars(newSessionData)
    : newSessionData.runtimeMetrics?.systemPrompt?.systemChars;
  const toolSchemaChars = newSessionData.runtimeMetrics?.tools?.charsByMode?.[newSessionData.toolMode];
  const systemPromptTitle = `${t('sidebar.systemPromptModeTitle')}${formatCharCountLabel(systemPromptChars)}`;
  const toolModeTitle = `${t('sidebar.toolModeTitle')}${formatCharCountLabel(toolSchemaChars)}`;
  const getRuntimeModeLabel = (mode?: string) => runtimeModeOptions.find((option) => option.id === mode)?.label || t('sidebar.runtimeModeConfigured');
  const getSystemPromptModeLabel = (mode?: string) => systemPromptModeOptions.find((option) => option.id === mode)?.label || t('sidebar.systemPromptModeSystem');
  const getToolModeLabel = (mode?: string) => toolModeOptions.find((option) => option.id === mode)?.label || t('sidebar.toolModeFull');
  const getEffectiveSystemPromptModeLabel = (runtimeMode?: string, mode?: string) => (
    runtimeMode === 'direct' ? t('sidebar.runtimeModeDirect') : getSystemPromptModeLabel(mode)
  );
  const getEffectiveToolModeLabel = (runtimeMode?: string, mode?: string) => (
    runtimeMode === 'direct' ? t('sidebar.runtimeModeDirect') : getToolModeLabel(mode)
  );

  // Template contents for new agents
  const templates = {
    soul: t('sidebar.templateSoul'),
    user: t('sidebar.templateUser'),
    agents: t('sidebar.templateAgents'),
    tools: t('sidebar.templateTools'),
    heartbeat: t('sidebar.templateHeartbeat'),
    identity: t('sidebar.templateIdentity')
  };

  const syncGlobalFallbackEnabled = async () => {
    try {
      const res = await getModelFallbacks();
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) {
        const enabled = Array.isArray(data?.config?.fallbacks) && data.config.fallbacks.length > 0;
        setIsGlobalFallbackEnabled(enabled);
        return enabled;
      }
    } catch {}

    return isGlobalFallbackEnabled;
  };

  const normalizeAgentFallbackForSubmit = (sessionData: typeof newSessionData) => {
    const availableModelIds = new Set(availableModels.map((model) => model.id));
    const normalizedFallbacks = sessionData.fallbacks.filter((fallbackId) => (
      fallbackId !== sessionData.model && availableModelIds.has(fallbackId)
    ));
    const requestedMode: ModelFallbackMode =
      sessionData.fallbackMode === 'disabled'
        ? 'disabled'
        : (!isGlobalFallbackEnabled && sessionData.fallbackMode === 'inherit')
          ? 'custom'
          : sessionData.fallbackMode;

    if (requestedMode === 'custom' && normalizedFallbacks.length === 0) {
      return {
        fallbackMode: 'disabled' as ModelFallbackMode,
        fallbacks: [] as string[],
      };
    }

    return {
      fallbackMode: requestedMode,
      fallbacks: normalizedFallbacks,
    };
  };

  const handleModalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSessionData.name.trim()) return;

    try {
      const normalizedFallbackConfig = normalizeAgentFallbackForSubmit(newSessionData);
      const normalizedSessionData = {
        ...newSessionData,
        ...normalizedFallbackConfig,
      };
      if (
        normalizedSessionData.fallbackMode !== newSessionData.fallbackMode
        || normalizedSessionData.fallbacks.join('\n') !== newSessionData.fallbacks.join('\n')
      ) {
        setNewSessionData(normalizedSessionData);
      }
      let res;
      if (modalMode === 'create') {
        res = await createSession({
            id: normalizedSessionData.id,
            name: normalizedSessionData.name,
            model: normalizedSessionData.model,
            runtimeMode: normalizedSessionData.runtimeMode,
            systemPromptMode: normalizedSessionData.systemPromptMode,
            toolMode: normalizedSessionData.toolMode,
            fallbackMode: normalizedSessionData.fallbackMode,
            fallbacks: normalizedSessionData.fallbacks,
            process_start_tag: normalizedSessionData.process_start_tag,
            process_end_tag: normalizedSessionData.process_end_tag,
            soulContent: normalizedSessionData.soulContent,
            userContent: normalizedSessionData.userContent,
            agentsContent: normalizedSessionData.agentsContent,
            toolsContent: normalizedSessionData.toolsContent,
            heartbeatContent: normalizedSessionData.heartbeatContent,
            identityContent: normalizedSessionData.identityContent,
          });
      } else if (modalMode === 'edit' && editingSessionId) {
        res = await updateSession(editingSessionId, {
            name: normalizedSessionData.name,
            model: normalizedSessionData.model,
            runtimeMode: normalizedSessionData.runtimeMode,
            systemPromptMode: normalizedSessionData.systemPromptMode,
            toolMode: normalizedSessionData.toolMode,
            fallbackMode: normalizedSessionData.fallbackMode,
            fallbacks: normalizedSessionData.fallbacks,
            process_start_tag: normalizedSessionData.process_start_tag,
            process_end_tag: normalizedSessionData.process_end_tag,
            soulContent: normalizedSessionData.soulContent,
            userContent: normalizedSessionData.userContent,
            agentsContent: normalizedSessionData.agentsContent,
            toolsContent: normalizedSessionData.toolsContent,
            heartbeatContent: normalizedSessionData.heartbeatContent,
            identityContent: normalizedSessionData.identityContent,
          });
      }

      if (res && res.ok) {
        const data = await res.json();
        if (data.success) {
          setIsModalOpen(false);
          setSubmitError(null);
          setNewSessionData({
            id: '',
            name: '',
            model: '',
            process_start_tag: '',
            process_end_tag: '',
            runtimeMode: 'configured',
            systemPromptMode: 'system',
            toolMode: 'full',
            runtimeMetrics: null,
            soulContent: '',
            userContent: '',
            agentsContent: '',
            toolsContent: '',
            heartbeatContent: '',
            identityContent: '',
            fallbackMode: 'disabled',
            fallbacks: [],
          });
          await reloadSessions();
          if (modalMode === 'create' && data.session?.id) {
            setActiveSessionId(data.session.id);
            navigateTo('chat');
          } else if (modalMode === 'edit' && editingSessionId && activeSessionId === editingSessionId && currentView === 'chat') {
            requestActiveContextRefresh({ mode: 'chat', id: editingSessionId });
          }
        } else {
          setSubmitError(resolveSidebarSubmitError(data, t, 'sidebar.createFail'));
        }
      } else if (res && !res.ok) {
        const data = await res.json().catch(() => ({}));
        setSubmitError(resolveSidebarSubmitError(data, t, 'sidebar.requestFail'));
      }
    } catch (err) {
      console.error('Failed to handle modal submit:', err);
      setSubmitError(t('sidebar.netError'));
    }
  };

  const handleStartEdit = async (e: React.MouseEvent | null, session: {id: string, name: string}) => {
    if (e) e.stopPropagation();

    try {
      const globalFallbackPromise = syncGlobalFallbackEnabled();
      const res = await listSessions();
      if (res.ok) {
        const data = await res.json();
        const fullSession = data.find((s: any) => s.id === session.id);

        let configs = {
          soulContent: '',
          userContent: '',
          agentsContent: '',
          toolsContent: '',
          heartbeatContent: '',
          identityContent: '',
          model: '',
          modelOverride: '',
          fallbackMode: 'inherit' as ModelFallbackMode,
          fallbacks: [] as string[],
          runtimeMode: 'configured' as AgentRuntimeMode,
          systemPromptMode: 'system' as AgentSystemPromptMode,
          toolMode: 'full' as AgentToolMode,
          runtimeMetrics: null as AgentRuntimeMetrics | null,
        };
        if (fullSession) {
          const configRes = await getSessionConfigs(session.id);
          if (configRes.ok) {
            const configData = await configRes.json();
            if (configData.success) {
              configs = configData.configs;
            }
          }

          setNewSessionData({
            id: fullSession.agentId || '',
            name: fullSession.name || '',
            model: configs.modelOverride || configs.model || '',
            runtimeMode: configs.runtimeMode || fullSession.runtimeMode || fullSession.runtime_mode || 'configured',
            systemPromptMode: configs.systemPromptMode || fullSession.systemPromptMode || fullSession.system_prompt_mode || 'system',
            toolMode: configs.toolMode || fullSession.toolMode || fullSession.tool_mode || 'full',
            runtimeMetrics: configs.runtimeMetrics || null,
            process_start_tag: fullSession.process_start_tag || '',
            process_end_tag: fullSession.process_end_tag || '',
            soulContent: configs.soulContent || '',
            userContent: configs.userContent || '',
            agentsContent: configs.agentsContent || '',
            toolsContent: configs.toolsContent || '',
            heartbeatContent: configs.heartbeatContent || '',
            identityContent: configs.identityContent || '',
            fallbackMode: configs.fallbackMode || 'inherit',
            fallbacks: Array.isArray(configs.fallbacks)
              ? configs.fallbacks.filter((fallbackId: string) => fallbackId !== (configs.modelOverride || configs.model || ''))
              : [],
          });
          await globalFallbackPromise;
          setEditingSessionId(session.id);
          setModalMode('edit');
          setIsModalOpen(true);
          closeSessionInfo();
        }
      }
    } catch (e) {
      console.error('Failed to fetch session details for editing', e);
    }
  };

  return {
    newSessionData, setNewSessionData,
    activeTab, setActiveTab,
    isModelDropdownOpen, setIsModelDropdownOpen,
    modelSearchQuery, setModelSearchQuery,
    modelProviderTab, setModelProviderTab,
    isModalOpen, setIsModalOpen,
    modalMode, setModalMode,
    setEditingSessionId,
    submitError, setSubmitError,
    shouldLockAgentFallbackTabs,
    effectiveAgentFallbackTabMode,
    effectiveAgentFallbackEditorMode,
    runtimeModeOptions,
    systemPromptModeOptions,
    toolModeOptions,
    systemPromptTitle,
    toolModeTitle,
    getRuntimeModeLabel,
    getEffectiveSystemPromptModeLabel,
    getEffectiveToolModeLabel,
    templates,
    syncGlobalFallbackEnabled,
    handleModalSubmit,
    handleStartEdit,
  };
}

export type AgentEditorState = ReturnType<typeof useAgentEditor>;
