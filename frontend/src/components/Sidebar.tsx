import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Settings, ArrowLeft, X, Network, Terminal, Edit2, Trash2, Info, Cpu, Check, Search, ChevronDown, RefreshCw, GripVertical, Star } from 'lucide-react';
import { Reorder } from 'motion/react';
import { ViewType, SettingsTab } from '../App';
import { requestActiveContextRefresh } from '../utils/contextRefresh';
import { getGroupIdValidationKey } from '../utils/groupId';
import ModelFallbackEditor, { type ModelFallbackMode } from './ModelFallbackEditor';

interface SidebarProps {
  currentView: ViewType;
  settingsTab?: SettingsTab;
  activeSessionId: string;
  setActiveSessionId: (id: string) => void;
  isMobileMenuOpen: boolean;
  sessions: {id: string, name: string, agentId?: string}[];
  sessionsLoaded: boolean;
  reloadSessions: () => Promise<void>;
  reorderSessions: (newSessions: {id: string, name: string}[]) => Promise<void>;
  navigateTo: (view: ViewType, tab?: SettingsTab, openMenu?: boolean) => void;
  onReturnToConversation: () => void;
  availableModels: any[];
  activeGroupId: string | null;
  onSelectGroup: (id: string) => void;
}

type AppVersionInfo = {
  version: string;
  openclawVersion: string | null;
};

type GroupSummary = {
  id: string;
  name: string;
  members?: { agent_id: string; display_name: string }[];
  [key: string]: any;
};

type SidebarListTab = 'agents' | 'groups' | 'favorites';
type SidebarFavoriteType = 'agents' | 'groups';
type AgentRuntimeMode = 'configured' | 'direct';
type AgentSystemPromptMode = 'system' | 'agent';
type AgentToolMode = 'full' | 'coding' | 'messaging' | 'minimal' | 'off';
type AgentRuntimeMetrics = {
  systemPrompt?: {
    systemChars?: number | null;
    agentChars?: number | null;
  };
  tools?: {
    charsByMode?: Partial<Record<AgentToolMode, number | null>>;
  };
};
type AgentEditorTab = 'soul' | 'user' | 'agents' | 'tools' | 'heartbeat' | 'identity';
type AgentEditorContentKey = 'soulContent' | 'userContent' | 'agentsContent' | 'toolsContent' | 'heartbeatContent' | 'identityContent';
type SidebarFavorites = {
  agents: string[];
  groups: string[];
  order: string[];
};

const SIDEBAR_FAVORITES_STORAGE_KEY = 'clawopt_sidebar_favorites';
const SIDEBAR_LIST_TAB_STORAGE_KEY = 'clawopt_sidebar_list_tab';
const MODAL_FORM_FONT_STYLE = {
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as const;
const MODAL_FIELD_LABEL_CLASS = 'block text-sm font-semibold text-gray-700 mb-1.5';
const MODAL_TEXT_INPUT_CLASS = 'w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500';
const MODAL_TEXTAREA_CLASS = 'w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all resize-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500';
const MODAL_EDITOR_TEXTAREA_CLASS = 'w-full h-36 p-4 bg-transparent outline-none transition-all resize-none text-[15px] text-gray-900 border-0 focus:ring-0 leading-relaxed placeholder:text-gray-400';
const AGENT_EDITOR_CONTENT_KEYS: Record<AgentEditorTab, AgentEditorContentKey> = {
  soul: 'soulContent',
  user: 'userContent',
  agents: 'agentsContent',
  tools: 'toolsContent',
  heartbeat: 'heartbeatContent',
  identity: 'identityContent',
};

function readSidebarListTab(currentView: ViewType): SidebarListTab {
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(SIDEBAR_LIST_TAB_STORAGE_KEY);
      if (raw === 'agents' || raw === 'groups' || raw === 'favorites') {
        return raw;
      }
    } catch {}
  }

  return currentView === 'groups' ? 'groups' : 'agents';
}

function makeSidebarFavoriteKey(type: SidebarFavoriteType, id: string): string {
  return `${type}:${id}`;
}

function parseSidebarFavoriteKey(value: string): { type: SidebarFavoriteType; id: string } | null {
  if (!value.startsWith('agents:') && !value.startsWith('groups:')) return null;
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) return null;

  const type = value.slice(0, separatorIndex) as SidebarFavoriteType;
  const id = value.slice(separatorIndex + 1);
  return id ? { type, id } : null;
}

function readSidebarFavorites(): SidebarFavorites {
  if (typeof window === 'undefined') {
    return { agents: [], groups: [], order: [] };
  }

  try {
    const raw = localStorage.getItem(SIDEBAR_FAVORITES_STORAGE_KEY);
    if (!raw) return { agents: [], groups: [], order: [] };
    const parsed = JSON.parse(raw);
    const normalizeStoredStringArray = (value: unknown): string[] => (
      Array.isArray(value)
        ? Array.from(new Set(value.filter((entry: unknown): entry is string => typeof entry === 'string')))
        : []
    );
    const agents = normalizeStoredStringArray(parsed?.agents);
    const groups = normalizeStoredStringArray(parsed?.groups);
    const fallbackOrder = [
      ...agents.map((id) => makeSidebarFavoriteKey('agents', id)),
      ...groups.map((id) => makeSidebarFavoriteKey('groups', id)),
    ];
    const allowedKeys = new Set(fallbackOrder);
    const parsedOrder = normalizeStoredStringArray(parsed?.order).filter((value) => allowedKeys.has(value));

    return {
      agents,
      groups,
      order: [
        ...parsedOrder,
        ...fallbackOrder.filter((key) => !parsedOrder.includes(key)),
      ],
    };
  } catch {
    return { agents: [], groups: [], order: [] };
  }
}

function normalizeSidebarFavorites(value: unknown): SidebarFavorites {
  const normalizeStoredStringArray = (input: unknown): string[] => (
    Array.isArray(input)
      ? Array.from(new Set(input.filter((entry: unknown): entry is string => typeof entry === 'string')))
      : []
  );

  const agents = normalizeStoredStringArray((value as { agents?: unknown } | null | undefined)?.agents);
  const groups = normalizeStoredStringArray((value as { groups?: unknown } | null | undefined)?.groups);
  const fallbackOrder = [
    ...agents.map((id) => makeSidebarFavoriteKey('agents', id)),
    ...groups.map((id) => makeSidebarFavoriteKey('groups', id)),
  ];
  const allowedKeys = new Set(fallbackOrder);
  const order = normalizeStoredStringArray((value as { order?: unknown } | null | undefined)?.order)
    .filter((entry) => allowedKeys.has(entry));

  return {
    agents,
    groups,
    order: [
      ...order,
      ...fallbackOrder.filter((entry) => !order.includes(entry)),
    ],
  };
}

function resolveSidebarSubmitError(
  data: { errorCode?: string; errorParams?: Record<string, string | number | boolean | null> | null; errorDetail?: string | null; error?: string; message?: string },
  t: (key: string, options?: any) => string,
  fallbackKey: string
): string {
  if (data.errorCode) {
    const translated = t(data.errorCode, (data.errorParams || {}) as any);
    if (translated !== data.errorCode) {
      return translated;
    }
  }

  if (typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }

  if (typeof data.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }

  if (typeof data.errorDetail === 'string' && data.errorDetail.trim()) {
    return data.errorDetail.trim();
  }

  return t(fallbackKey);
}

function SessionSkeleton() {
  return (
    <div className="space-y-1">
      {[1, 2, 3].map(i => (
        <div key={i} className="w-full py-2 px-3 rounded-xl border border-transparent animate-pulse">
          <div className="flex items-baseline gap-2">
            <div className="h-4 bg-gray-200 rounded-md w-20" />
            <div className="h-3 bg-gray-100 rounded-md w-12" />
          </div>
          <div className="mt-2">
            <div className="h-5 bg-gray-100 rounded-full w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SidebarHeader({ openclawVersion, appVersion }: { openclawVersion: string; appVersion: string }) {
  return (
    <div className="pt-4 pb-6 px-6">
      <div className="mb-1 flex items-baseline gap-2 whitespace-nowrap leading-none">
        <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight">OpenClaw</div>
        {openclawVersion ? (
          <div className="text-[0.8rem] font-medium text-gray-800 leading-none">{openclawVersion}</div>
        ) : null}
      </div>
      <div className="flex items-baseline gap-2 whitespace-nowrap leading-none">
        <div className="text-[1.15rem] font-bold text-gray-400 tracking-widest uppercase leading-tight">CLAWOPT</div>
        {appVersion ? (
          <div className="text-[0.8rem] font-medium text-gray-400 leading-none">{appVersion}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function Sidebar({
  currentView, 
  settingsTab = 'gateway', 
  activeSessionId, 
  setActiveSessionId, 
  isMobileMenuOpen, 
  sessions,
  sessionsLoaded,
  reloadSessions,
  reorderSessions,
  navigateTo,
  onReturnToConversation,
  availableModels,
  activeGroupId,
  onSelectGroup
}: SidebarProps) {
  const { t, i18n } = useTranslation();
  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/version')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.version === 'string') {
          setAppVersionInfo({
            version: data.version,
            openclawVersion: typeof data?.openclawVersion === 'string' ? data.openclawVersion : null,
          });
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const resolveGroupMemberDisplayName = (member: { agent_id?: string; agentId?: string; display_name?: string; displayName?: string }) => {
    const agentId = member.agent_id || member.agentId || '';
    const linkedSession = sessions.find((session) => (session.agentId || session.id) === agentId);
    return linkedSession?.name || member.display_name || member.displayName || agentId;
  };
  // On first render, use a plain static list (no Framer Motion).
  // After mount, switch to Reorder for drag support.
  const [enableReorder, setEnableReorder] = useState(false);
  useEffect(() => {
    // Use requestAnimationFrame to ensure the first paint has completed
    requestAnimationFrame(() => {
      setEnableReorder(true);
    });
  }, []);

  // Modal State
  const [newSessionData, setNewSessionData] = useState({ 
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



  // Delete Modal State
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);

  // Reset Modal State
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [resettingSessionId, setResettingSessionId] = useState<string | null>(null);

  // New Session/Persona Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Info Modal State
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [viewingSession, setViewingSession] = useState<any>(null);
  const [isGlobalFallbackEnabled, setIsGlobalFallbackEnabled] = useState(true);

  const [sidebarListTab, setSidebarListTab] = useState<SidebarListTab>(() => readSidebarListTab(currentView));
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
  const formatCompactCount = (count: number) => {
    const language = i18n.language || '';
    if (language.startsWith('zh')) {
      if (count >= 10000) {
        return `${(count / 10000).toFixed(1).replace(/\\.0$/, '')}万`;
      }
      return count.toLocaleString();
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1).replace(/\\.0$/, '')}k`;
    }
    return count.toLocaleString();
  };
  const formatCharCountLabel = (count: number | null | undefined) => (
    typeof count === 'number' && Number.isFinite(count)
      ? t('sidebar.charCountLabel', { count: formatCompactCount(count) })
      : ''
  );
  const buildLocalAgentPromptChars = () => {
    const sections = [
      ['IDENTITY.md', newSessionData.identityContent],
      ['SOUL.md', newSessionData.soulContent],
      ['AGENTS.md', newSessionData.agentsContent],
      ['USER.md', newSessionData.userContent],
      ['TOOLS.md', newSessionData.toolsContent],
      ['HEARTBEAT.md', newSessionData.heartbeatContent],
    ]
      .map(([filename, content]) => [filename, String(content || '').trim()] as const)
      .filter(([, content]) => content.length > 0)
      .map(([filename, content]) => `## ${filename}\n\n${content}`);

    if (sections.length === 0) {
      return 0;
    }

    return [
      `# Agent ${newSessionData.id || 'agent'}`,
      'Follow this agent-specific prompt. The sections below come from this agent workspace.',
      ...sections,
    ].join('\n\n').length;
  };
  const systemPromptChars = newSessionData.systemPromptMode === 'agent'
    ? buildLocalAgentPromptChars()
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
  const [sidebarFavorites, setSidebarFavorites] = useState<SidebarFavorites>(() => readSidebarFavorites());
  const [sidebarFavoritesLoaded, setSidebarFavoritesLoaded] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_LIST_TAB_STORAGE_KEY, sidebarListTab);
    } catch {}
  }, [sidebarListTab]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_FAVORITES_STORAGE_KEY, JSON.stringify(sidebarFavorites));
    } catch {}
  }, [sidebarFavorites]);

  useEffect(() => {
    let cancelled = false;

    const syncSidebarFavorites = async () => {
      const localFavorites = readSidebarFavorites();

      try {
        const response = await fetch('/api/sidebar/favorites');
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;

        const remoteFavorites = normalizeSidebarFavorites(data?.favorites);
        const hasRemoteFavorites = remoteFavorites.order.length > 0;
        const hasLocalFavorites = localFavorites.order.length > 0;

        if (!hasRemoteFavorites && hasLocalFavorites) {
          setSidebarFavorites(localFavorites);
          await fetch('/api/sidebar/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: localFavorites }),
          }).catch(() => {});
        } else {
          setSidebarFavorites(remoteFavorites);
        }
      } catch {
        if (!cancelled) {
          setSidebarFavorites(localFavorites);
        }
      } finally {
        if (!cancelled) {
          setSidebarFavoritesLoaded(true);
        }
      }
    };

    void syncSidebarFavorites();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sidebarFavoritesLoaded) return;

    void fetch('/api/sidebar/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorites: sidebarFavorites }),
    }).catch(() => {});
  }, [sidebarFavorites, sidebarFavoritesLoaded]);


  // Group info modal
  const [isGroupInfoOpen, setIsGroupInfoOpen] = useState(false);
  const [viewingGroup, setViewingGroup] = useState<any>(null);
  const [infoActiveRoleTab, setInfoActiveRoleTab] = useState<string>('');
  const [infoActiveTab, setInfoActiveTab] = useState<string>('soul');
  const [draggedAgentId, setDraggedAgentId] = useState<string | null>(null);
  const [isDeleteGroupModalOpen, setIsDeleteGroupModalOpen] = useState(false);
  const [isResetGroupModalOpen, setIsResetGroupModalOpen] = useState(false);

  // --- Group Chat States ---
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [groupModalMode, setGroupModalMode] = useState<'create' | 'edit'>('create');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [newGroupId, setNewGroupId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [newGroupSystemPrompt, setNewGroupSystemPrompt] = useState('');
  const [newProcessStartTag, setNewProcessStartTag] = useState('');
  const [newProcessEndTag, setNewProcessEndTag] = useState('');
  const [newMaxChainDepth, setNewMaxChainDepth] = useState<number>(6);
  const [selectedGroupMembers, setSelectedGroupMembers] = useState<{agentId: string, displayName: string, roleDescription: string}[]>([]);
  const [groupSearchQuery, setGroupSearchQuery] = useState('');
  const [isMemberDropdownOpen, setIsMemberDropdownOpen] = useState(false);
  const memberDropdownRef = useRef<HTMLDivElement>(null);
  const [activeRoleTab, setActiveRoleTab] = useState('');
  const [groupSubmitError, setGroupSubmitError] = useState<string | null>(null);
  const groupIdErrorKey = getGroupIdValidationKey(
    newGroupId,
    groups.map((group) => group.id),
    {
      currentId: groupModalMode === 'edit' ? editingGroupId : null,
      requireValue: groupModalMode === 'create',
    }
  );
  const groupIdError = groupIdErrorKey
    ? String(t(groupIdErrorKey, { groupId: newGroupId.trim() }))
    : null;
  const visibleGroupIdError = groupIdErrorKey && groupIdErrorKey !== 'groups.idRequired'
    ? groupIdError
    : null;

  useEffect(() => {
    if (selectedGroupMembers.length === 0) {
      if (activeRoleTab) {
        setActiveRoleTab('');
      }
      return;
    }

    if (!selectedGroupMembers.some((member) => member.agentId === activeRoleTab)) {
      setActiveRoleTab(selectedGroupMembers[0].agentId);
    }
  }, [activeRoleTab, selectedGroupMembers]);

  useEffect(() => {
    if (!isMemberDropdownOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (memberDropdownRef.current && !memberDropdownRef.current.contains(event.target as Node)) {
        setIsMemberDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isMemberDropdownOpen]);

  // Load groups
  useEffect(() => {
    const loadGroups = async () => {
      try {
        const res = await fetch('/api/groups');
        const data = await res.json();
        if (data.success) {
          setGroups(data.groups);
          setGroupsLoaded(true);
        }
      } catch {}
    };
    loadGroups();
    const timer = setInterval(loadGroups, 10000);
    return () => clearInterval(timer);
  }, []);

  const reloadGroups = async () => {
    try {
      const res = await fetch('/api/groups');
      const data = await res.json();
      if (data.success) {
        setGroups(data.groups);
        setGroupsLoaded(true);
      }
    } catch {}
  };

  const reorderGroups = async (newGroups: GroupSummary[]) => {
    setGroups(newGroups);
    try {
      await fetch('/api/groups/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: newGroups.map((group) => group.id) }),
      });
    } catch (err) {
      console.error('Failed to save group order:', err);
      reloadGroups();
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupId.trim() || !newGroupName.trim() || selectedGroupMembers.length === 0) return;
    if (groupModalMode === 'create' && groupIdError) {
      setGroupSubmitError(groupIdError);
      return;
    }
    try {
      const url = groupModalMode === 'edit' && editingGroupId ? `/api/groups/${editingGroupId}` : '/api/groups';
      const method = groupModalMode === 'edit' ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: newGroupId.trim(),
          name: newGroupName.trim(),
          description: newGroupDesc.trim(),
          system_prompt: newGroupSystemPrompt.trim(),
          process_start_tag: newProcessStartTag,
          process_end_tag: newProcessEndTag,
          max_chain_depth: newMaxChainDepth,
          members: selectedGroupMembers,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setShowGroupDialog(false);
        setNewGroupId('');
        setNewGroupName('');
        setNewGroupDesc('');
        setNewGroupSystemPrompt('');
        setNewProcessStartTag('');
        setNewProcessEndTag('');
        setNewMaxChainDepth(6);
        setSelectedGroupMembers([]);
        setGroupSubmitError(null);
        await reloadGroups();
        if (groupModalMode === 'create') {
          onSelectGroup(data.id);
          navigateTo('groups', settingsTab, false);
        } else if (groupModalMode === 'edit' && editingGroupId && activeGroupId === editingGroupId && currentView === 'groups') {
          requestActiveContextRefresh({ mode: 'group', id: editingGroupId });
        }
      } else {
        setGroupSubmitError(resolveSidebarSubmitError(data, t, 'sidebar.createFail'));
      }
    } catch {
      setGroupSubmitError(t('sidebar.netError'));
    }
  };

  const toggleGroupMember = (agentId: string, name: string) => {
    setSelectedGroupMembers(prev => {
      const exists = prev.find(m => m.agentId === agentId);
      if (exists) return prev.filter(m => m.agentId !== agentId);
      return [...prev, { agentId, displayName: name, roleDescription: '' }];
    });
  };

  const removeGroupMember = (agentId: string) => {
    setSelectedGroupMembers((prev) => prev.filter((member) => member.agentId !== agentId));
  };

  const updateGroupMemberRole = (agentId: string, role: string) => {
    setSelectedGroupMembers(prev => prev.map(m => m.agentId === agentId ? { ...m, roleDescription: role } : m));
  };

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
      const res = await fetch('/api/models/fallbacks');
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
        res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
          })
        });
      } else if (modalMode === 'edit' && editingSessionId) {
        res = await fetch(`/api/sessions/${editingSessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
          })
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

  const confirmDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeletingSessionId(id);
    setIsDeleteModalOpen(true);
  };

  const handleDeleteSession = async () => {
    if (deletingSessionId) {
      try {
        const res = await fetch(`/api/sessions/${deletingSessionId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          setIsDeleteModalOpen(false);
          await reloadSessions();
        }
      } catch (err) {
        console.error('Failed to delete session:', err);
      } finally {
        setIsDeleteModalOpen(false);
        setDeletingSessionId(null);
      }
    }
  };

  const confirmResetSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setResettingSessionId(id);
    setIsResetModalOpen(true);
  };

  const handleResetSession = async () => {
    if (resettingSessionId) {
      try {
        const res = await fetch(`/api/sessions/${resettingSessionId}/reset`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          setIsResetModalOpen(false);
          await reloadSessions();

          // If currently viewing this session, refresh the chat view
          if (activeSessionId === resettingSessionId && currentView === 'chat') {
            // Trigger reload by temporarily switching away and back
            setActiveSessionId('');
            setTimeout(() => setActiveSessionId(resettingSessionId), 50);
          }
        }
      } catch (err) {
        console.error('Failed to reset session:', err);
      } finally {
        setIsResetModalOpen(false);
        setResettingSessionId(null);
      }
    }
  };

  const handleStartEdit = async (e: React.MouseEvent | null, session: {id: string, name: string}) => {
    if (e) e.stopPropagation();
    
    try {
      const globalFallbackPromise = syncGlobalFallbackEnabled();
      const res = await fetch('/api/sessions');
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
          const configRes = await fetch(`/api/sessions/${session.id}/configs`);
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
          setIsInfoModalOpen(false);
        }
      }
    } catch (e) {
      console.error('Failed to fetch session details for editing', e);
    }
  };

  const handleShowInfo = async (e: React.MouseEvent, session: {id: string, name: string}) => {
    e.stopPropagation();
    setIsInfoModalOpen(true);
    setInfoActiveTab('soul');
    setViewingSession(session);

    try {
      const [sessRes, cfgRes] = await Promise.all([
        fetch('/api/sessions'),
        fetch(`/api/sessions/${session.id}/configs`)
      ]);
      const sessData = sessRes.ok ? await sessRes.json() : [];
      const cfgData = cfgRes.ok ? await cfgRes.json() : null;
      const fullSession = sessData.find((s: any) => s.id === session.id) || session;
      const configs = cfgData?.configs || {};
      setViewingSession({ ...fullSession, ...configs });
    } catch (e) {
      console.error('Failed to fetch session details for info', e);
    }
  };

  const sidebarCardActionButtonClass = 'p-1.5 rounded-lg bg-blue-50 text-blue-500 hover:bg-yellow-100 hover:text-yellow-600 transition-all md:opacity-0 md:group-hover:opacity-100';

  const isFavorite = (type: SidebarFavoriteType, id: string) => sidebarFavorites[type].includes(id);

  const toggleFavorite = (type: SidebarFavoriteType, id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setSidebarFavorites((prev) => {
      const current = prev[type];
      const favoriteKey = makeSidebarFavoriteKey(type, id);
      const isRemoving = current.includes(id);
      const nextItems = isRemoving
        ? current.filter((itemId) => itemId !== id)
        : [...current, id];
      return {
        ...prev,
        [type]: nextItems,
        order: isRemoving
          ? prev.order.filter((key) => key !== favoriteKey)
          : [...prev.order.filter((key) => key !== favoriteKey), favoriteKey],
      };
    });
  };

  const renderFavoriteButton = (type: SidebarFavoriteType, id: string, className: string = sidebarCardActionButtonClass) => {
    const favoriteActive = isFavorite(type, id);

    return (
      <button
        type="button"
        onClick={(event) => toggleFavorite(type, id, event)}
        className={className}
        title={favoriteActive ? t('sidebar.removeFromFavorites') : t('sidebar.addToFavorites')}
        aria-label={favoriteActive ? t('sidebar.removeFromFavorites') : t('sidebar.addToFavorites')}
      >
        <Star className={`w-4 h-4 ${favoriteActive ? 'fill-current' : ''}`} />
      </button>
    );
  };

  const reorderFavorites = (nextOrder: string[]) => {
    setSidebarFavorites((prev) => ({
      ...prev,
      order: nextOrder,
    }));
  };


  const renderSessionCard = (s: {id: string, name: string}) => (
    <div
      onClick={() => { setActiveSessionId(s.id); onSelectGroup(''); navigateTo('chat', settingsTab, false); }}
      className={`w-full group text-left py-2 pr-3 pl-2 text-sm rounded-xl transition-all flex items-center justify-between cursor-pointer border ${activeSessionId === s.id && currentView === 'chat' ? 'font-semibold bg-amber-50 border-orange-300 text-gray-600' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
    >
      <div className="flex flex-1 min-w-0 items-start gap-2">
        <GripVertical className="h-3.5 w-3.5 self-center shrink-0 cursor-grab text-gray-300 transition-colors group-hover:text-gray-400 active:cursor-grabbing" />
        <div className="flex flex-col items-start gap-1.5 w-full">
          <div className="text-[15px] truncate w-full flex-1 min-w-0 text-gray-900">
            {s.name || t('sidebar.agentNum').replace('{{num}}', s.id)}
          </div>
          {(s as any).model && (() => {
            const mId = (s as any).model;
            const mInfo = availableModels.find(m => m.id === mId);
            const displayName = mInfo?.alias || mId;
            return (
              <div className="text-[11px] font-medium truncate max-w-full text-gray-500">
                {displayName}
              </div>
            );
          })()}
        </div>
      </div>
      <div className="flex items-center gap-1 ml-2 flex-shrink-0">
        <button 
          onClick={(e) => handleShowInfo(e, s)} 
          className={sidebarCardActionButtonClass}
          title={t('common.details')}
        >
          <Info className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  const renderGroupCard = (g: GroupSummary) => {
    const isActive = activeGroupId === g.id && currentView === 'groups';

    return (
      <div
        onClick={() => { setActiveSessionId(''); onSelectGroup(g.id); navigateTo('groups', settingsTab, false); }}
        className={`w-full group text-left py-2 pr-3 pl-2 text-sm rounded-xl transition-all flex items-center justify-between cursor-pointer border ${isActive ? 'font-semibold bg-amber-50 border-orange-300 text-gray-600' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
      >
        <div className="flex flex-1 min-w-0 items-start gap-2">
          <GripVertical className="h-3.5 w-3.5 self-center shrink-0 cursor-grab text-gray-300 transition-colors group-hover:text-gray-400 active:cursor-grabbing" />
          <div className="flex flex-col items-start gap-1.5 w-full">
            <div className="text-[15px] truncate w-full flex-1 min-w-0 text-gray-900">
              {g.name}
            </div>
            <div className="text-[11px] font-medium truncate max-w-full text-gray-500">
              {g.members?.map((m: any) => resolveGroupMemberDisplayName(m)).join('、')}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setViewingGroup(g); if(g.members && g.members.length > 0) setInfoActiveRoleTab(g.members[0].agent_id); setIsGroupInfoOpen(true); }}
            className={sidebarCardActionButtonClass}
            title={t('common.details')}
          >
            <Info className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  const renderListTabs = () => (
    <div className="mb-3 rounded-xl border border-gray-200 bg-gray-200/80 p-0.5">
      <div className="grid grid-cols-3 gap-1">
        <button
          type="button"
          onClick={() => setSidebarListTab('agents')}
          className={`rounded-xl px-3 py-1.5 text-sm transition-colors ${
            sidebarListTab === 'agents'
              ? 'bg-white font-semibold text-gray-900 border border-gray-200'
              : 'font-normal text-gray-500 hover:text-gray-700 hover:font-semibold'
          }`}
        >
          {t('sidebar.agentGroup')}
        </button>
        <button
          type="button"
          onClick={() => setSidebarListTab('groups')}
          className={`rounded-xl px-3 py-1.5 text-sm transition-colors ${
            sidebarListTab === 'groups'
              ? 'bg-white font-semibold text-gray-900 border border-gray-200'
              : 'font-normal text-gray-500 hover:text-gray-700 hover:font-semibold'
          }`}
        >
          {t('sidebar.workGroup')}
        </button>
        <button
          type="button"
          onClick={() => setSidebarListTab('favorites')}
          className={`rounded-xl px-3 py-1.5 text-sm transition-colors ${
            sidebarListTab === 'favorites'
              ? 'bg-white font-semibold text-gray-900 border border-gray-200'
              : 'font-normal text-gray-500 hover:text-gray-700 hover:font-semibold'
          }`}
        >
          {t('sidebar.favoritesTab')}
        </button>
      </div>
    </div>
  );

  const renderAgentsList = () => (
    !sessionsLoaded ? (
      <SessionSkeleton />
    ) : enableReorder ? (
      <Reorder.Group axis="y" values={sessions} onReorder={reorderSessions} className="space-y-1" layout={false}>
        {sessions.length > 0 ? (
          sessions.map((s) => (
            <Reorder.Item key={s.id} value={s} className="w-full" initial={false}>
              {renderSessionCard(s)}
            </Reorder.Item>
          ))
        ) : (
          <div className="w-full h-[58px] flex items-center justify-center bg-white/50 rounded-xl border border-dashed border-gray-200">
            <p className="text-sm text-gray-400 font-medium">{t('sidebar.noItems')}</p>
          </div>
        )}
      </Reorder.Group>
    ) : (
      <ul className="space-y-1">
        {sessions.length > 0 ? (
          sessions.map((s) => (
            <li key={s.id} className="w-full">{renderSessionCard(s)}</li>
          ))
        ) : (
          <div className="w-full h-[58px] flex items-center justify-center bg-white/50 rounded-xl border border-dashed border-gray-200">
            <p className="text-sm text-gray-400 font-medium">{t('sidebar.noItems')}</p>
          </div>
        )}
      </ul>
    )
  );

  const renderGroupsList = () => (
    groups.length > 0 ? (
      enableReorder ? (
        <Reorder.Group axis="y" values={groups} onReorder={reorderGroups} className="space-y-1" layout={false}>
          {groups.map((g) => (
            <Reorder.Item key={g.id} value={g} className="w-full" initial={false}>
              {renderGroupCard(g)}
            </Reorder.Item>
          ))}
        </Reorder.Group>
      ) : (
        <div className="space-y-1">
          {groups.map((g) => (
            <div key={g.id}>{renderGroupCard(g)}</div>
          ))}
        </div>
      )
    ) : (
      <div className="w-full h-[58px] flex items-center justify-center bg-white/50 rounded-xl border border-dashed border-gray-200">
        <p className="text-sm text-gray-400 font-medium">{t('sidebar.noItems')}</p>
      </div>
    )
  );

  useEffect(() => {
    if (!sidebarFavoritesLoaded || !sessionsLoaded || !groupsLoaded) return;

    setSidebarFavorites((prev) => {
      const nextAgents = prev.agents.filter((id) => sessions.some((session) => session.id === id));
      const nextGroups = prev.groups.filter((id) => groups.some((group) => group.id === id));
      const allowedKeys = new Set([
        ...nextAgents.map((id) => makeSidebarFavoriteKey('agents', id)),
        ...nextGroups.map((id) => makeSidebarFavoriteKey('groups', id)),
      ]);
      const nextOrder = [
        ...prev.order.filter((key) => allowedKeys.has(key)),
        ...Array.from(allowedKeys).filter((key) => !prev.order.includes(key)),
      ];

      if (
        nextAgents.length === prev.agents.length
        && nextGroups.length === prev.groups.length
        && nextOrder.length === prev.order.length
        && nextOrder.every((key, index) => key === prev.order[index])
      ) {
        return prev;
      }

      return {
        agents: nextAgents,
        groups: nextGroups,
        order: nextOrder,
      };
    });
  }, [groups, groupsLoaded, sessions, sessionsLoaded, sidebarFavoritesLoaded]);

  const renderFavoritesList = () => (
    sidebarFavorites.order.length > 0 ? (
      enableReorder ? (
        <Reorder.Group axis="y" values={sidebarFavorites.order} onReorder={reorderFavorites} className="space-y-1" layout={false}>
          {sidebarFavorites.order.map((favoriteKey) => {
            const parsed = parseSidebarFavoriteKey(favoriteKey);
            if (!parsed) return null;

            if (parsed.type === 'agents') {
              const session = sessions.find((item) => item.id === parsed.id);
              if (!session) return null;
              return (
                <Reorder.Item key={favoriteKey} value={favoriteKey} className="w-full" initial={false}>
                  {renderSessionCard(session)}
                </Reorder.Item>
              );
            }

            const group = groups.find((item) => item.id === parsed.id);
            if (!group) return null;
            return (
              <Reorder.Item key={favoriteKey} value={favoriteKey} className="w-full" initial={false}>
                {renderGroupCard(group)}
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
      ) : (
        <div className="space-y-1">
          {sidebarFavorites.order.map((favoriteKey) => {
            const parsed = parseSidebarFavoriteKey(favoriteKey);
            if (!parsed) return null;

            if (parsed.type === 'agents') {
              const session = sessions.find((item) => item.id === parsed.id);
              return session ? <div key={favoriteKey}>{renderSessionCard(session)}</div> : null;
            }

            const group = groups.find((item) => item.id === parsed.id);
            return group ? <div key={favoriteKey}>{renderGroupCard(group)}</div> : null;
          })}
        </div>
      )
    ) : (
      <div className="w-full h-[58px] flex items-center justify-center bg-white/50 rounded-xl border border-dashed border-gray-200">
        <p className="text-sm text-gray-400 font-medium">{t('sidebar.noFavorites')}</p>
      </div>
    )
  );


  if (currentView === 'settings') {
    return (
      <>
        {/* Mobile Backdrop */}
        {isMobileMenuOpen && (
          <div 
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 md:hidden" 
            onClick={() => navigateTo(currentView, settingsTab, false)} 
          />
        )}
        <aside className={`fixed inset-y-0 left-0 z-50 w-[75vw] md:w-64 flex-shrink-0 flex-col border-r border-gray-200 bg-gray-100 h-full transition-transform duration-300 md:relative md:translate-x-0 md:flex ${isMobileMenuOpen ? 'translate-x-0 flex' : '-translate-x-full hidden'}`}>
          <SidebarHeader
            openclawVersion={appVersionInfo?.openclawVersion || ''}
            appVersion={appVersionInfo?.version || ''}
          />
        <nav className="flex-1 px-4 py-2 space-y-1">
          <button 
            onClick={() => navigateTo('settings', 'gateway', false)}
            className={`w-full min-w-0 flex items-center gap-3 px-4 py-3 rounded-xl text-base transition-all border ${settingsTab === 'gateway' ? 'font-semibold text-gray-600 bg-amber-50 border-orange-300' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
          >
            <Network className="w-5 h-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
              {t('sidebar.gatewaySettings')}
            </span>
          </button>
          <button 
            onClick={() => navigateTo('settings', 'general', false)}
            className={`w-full min-w-0 flex items-center gap-3 px-4 py-3 rounded-xl text-base transition-all border ${settingsTab === 'general' ? 'font-semibold text-gray-600 bg-amber-50 border-orange-300' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
          >
            <Settings className="w-5 h-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
              {t('sidebar.generalSettings')}
            </span>
          </button>
          <button 
            onClick={() => navigateTo('settings', 'models', false)}
            className={`w-full min-w-0 flex items-center gap-3 px-4 py-3 rounded-xl text-base transition-all border ${settingsTab === 'models' ? 'font-semibold text-gray-600 bg-amber-50 border-orange-300' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
          >
            <Cpu className="w-5 h-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
              {t('sidebar.modelsManage')}
            </span>
          </button>
          
          <button 
            onClick={() => navigateTo('settings', 'commands', false)}
            className={`w-full min-w-0 flex items-center gap-3 px-4 py-3 rounded-xl text-base transition-all border ${settingsTab === 'commands' ? 'font-semibold text-gray-600 bg-amber-50 border-orange-300' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
          >
            <Terminal className="w-5 h-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
              {t('sidebar.quickCommands')}
            </span>
          </button>

          <button 
            onClick={() => navigateTo('settings', 'about', false)}
            className={`w-full min-w-0 flex items-center gap-3 px-4 py-3 rounded-xl text-base transition-all border ${settingsTab === 'about' ? 'font-semibold text-gray-600 bg-amber-50 border-orange-300' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
          >
            <Info className="w-5 h-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
              {t('sidebar.about')}
            </span>
          </button>
        </nav>
        <div className="p-4 border-t border-gray-100">
          <button
            onClick={onReturnToConversation}
            className="w-full min-w-0 flex items-center gap-3 px-4 py-3 text-gray-600 hover:bg-gray-200 hover:text-gray-900 hover:font-semibold rounded-xl transition-all font-normal"
          >
            <ArrowLeft className="w-5 h-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left text-sm">
              {t('sidebar.backBtn')}
            </span>
          </button>
        </div>
      </aside>
      </>
    );
  }

  return (
    <>
      {/* Mobile Backdrop */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 md:hidden" 
          onClick={() => navigateTo(currentView, settingsTab, false)} 
        />
      )}
      <aside className={`fixed inset-y-0 left-0 z-50 w-[75vw] md:w-64 flex-shrink-0 flex-col border-r border-gray-200 bg-gray-100 h-full transition-transform duration-300 md:relative md:translate-x-0 md:flex ${isMobileMenuOpen ? 'translate-x-0 flex' : '-translate-x-full hidden'}`}>
        <SidebarHeader
          openclawVersion={appVersionInfo?.openclawVersion || ''}
          appVersion={appVersionInfo?.version || ''}
        />

      {/* + 新建 按钮组 */}
      <div className="px-4 pb-3">
        <div className="flex items-center">
          <span className="flex items-center gap-1 text-sm text-gray-500 flex-shrink-0 mr-2">
            <Plus className="w-4 h-4" />
            {t('sidebar.newBtn')}
          </span>
          <div className="group flex flex-1 border border-gray-300 rounded-xl overflow-hidden bg-white transition-colors hover:border-orange-300">
            <button 
              onClick={async () => {
                await syncGlobalFallbackEnabled();
                setModalMode('create');
                setEditingSessionId(null);
                setSubmitError(null);
                setNewSessionData({ 
                  id: '', 
                  name: '', 
                  model: '', 
                  runtimeMode: 'configured',
                  systemPromptMode: 'system',
                  toolMode: 'full',
                  runtimeMetrics: null,
                  fallbackMode: 'disabled',
                  fallbacks: [],
                  process_start_tag: '',
                  process_end_tag: '',
                  soulContent: '', 
                  userContent: '', 
                  agentsContent: '', 
                  toolsContent: '', 
                  heartbeatContent: '', 
                  identityContent: '' 
                });
                setIsModalOpen(true);
              }}
              className="flex-1 py-2 px-3 text-gray-600 hover:bg-amber-50 hover:text-gray-900 hover:font-semibold transition-colors font-normal text-sm active:scale-95 text-center border-r border-gray-300 hover:border-orange-300 group-hover:border-orange-300"
            >
              {t('sidebar.agentGroup')}
            </button>
            <button
              onClick={() => {
                setGroupModalMode('create');
                setEditingGroupId(null);
                setNewGroupId('');
                setNewGroupName('');
                setNewGroupDesc('');
                setNewGroupSystemPrompt('');
                setNewProcessStartTag('');
                setNewProcessEndTag('');
                setNewMaxChainDepth(6);
                setSelectedGroupMembers([]);
                setGroupSubmitError(null);
                setShowGroupDialog(true);
              }}
              className="flex-1 py-2 px-3 text-gray-600 hover:bg-amber-50 hover:text-gray-900 hover:font-semibold transition-colors font-normal text-sm active:scale-95 text-center hover:border-orange-300"
            >
              {t('sidebar.workGroup')}
            </button>
          </div>
        </div>
      </div>

      {/* 可滚动列表区域 */}
      <div className="flex-1 overflow-y-auto px-4 py-1 min-h-0 scrollbar-hide">
        {renderListTabs()}
        {sidebarListTab === 'agents'
          ? renderAgentsList()
          : sidebarListTab === 'groups'
            ? renderGroupsList()
            : renderFavoritesList()}
      </div>

      <div className="p-4 border-t border-gray-100 bg-gray-100/50 space-y-1">
        <button
          onClick={() => navigateTo('settings')}
          className="flex items-center w-full py-3 px-4 text-gray-600 hover:text-gray-900 hover:font-semibold transition-colors font-normal text-sm rounded-xl hover:bg-gray-200 gap-3"
        >
          <Settings className="w-5 h-5 shrink-0" />
          {t('sidebar.sysSettings')}
        </button>
      </div>

    </aside>

      {/* Create Agent Modal - outside aside to center properly */}
      {isModalOpen && (
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
                  <div className="relative" ref={memberDropdownRef}>
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
      )}

      {/* Session Info Modal */}
      {isInfoModalOpen && viewingSession && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsInfoModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-100 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div>
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-xl font-bold text-gray-900 leading-tight truncate">
                      {viewingSession.name}
                    </h3>
                    {renderFavoriteButton(
                      'agents',
                      viewingSession.id,
                      'flex-shrink-0 p-1.5 rounded-lg text-blue-500 hover:bg-blue-50 hover:text-yellow-600 transition-all'
                    )}
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setIsInfoModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div className="space-y-4">

                {/* ID + Name side by side */}
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.agentId')}</label>
                    <p className="text-sm font-mono text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{viewingSession.agentId || viewingSession.id}</p>
                  </div>
                  <div className="flex-1">
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.agentName')}</label>
                    <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{viewingSession.name}</p>
                  </div>
                </div>

                {/* Model */}
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.independentModel')}</label>
                  <div className="flex items-center gap-2 bg-gray-50 p-3 rounded-xl border border-gray-100 min-h-[46px]">
                    <span className="text-sm font-mono text-gray-900">
                      {viewingSession.model ? (availableModels.find(m => m.id === viewingSession.model)?.alias || viewingSession.model) : t('sidebar.defaultModel')}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {(() => {
                    const runtimeMode = viewingSession.runtimeMode || viewingSession.runtime_mode;
                    const systemPromptMode = viewingSession.systemPromptMode || viewingSession.system_prompt_mode;
                    const toolMode = viewingSession.toolMode || viewingSession.tool_mode;

                    return (
                      <>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.runtimeModeTitle')}</label>
                    <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{getRuntimeModeLabel(runtimeMode)}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.systemPromptModeTitle')}</label>
                    <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{getEffectiveSystemPromptModeLabel(runtimeMode, systemPromptMode)}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.toolModeTitle')}</label>
                    <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{getEffectiveToolModeLabel(runtimeMode, toolMode)}</p>
                  </div>
                      </>
                    );
                  })()}
                </div>

                {/* 输出工作过程 - read-only */}
                <div className="flex items-center gap-4">
                  <span className="text-sm font-semibold text-gray-700">{t('sidebar.outputProcess')}</span>
                  {(() => {
                    const isOn = !!(viewingSession.process_start_tag && viewingSession.process_end_tag);
                    return (
                      <label className="relative inline-flex items-center flex-shrink-0 pointer-events-none opacity-50 grayscale">
                        <input type="checkbox" checked={isOn} readOnly className="sr-only" />
                        <div className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${isOn ? 'bg-blue-600' : 'bg-gray-200'}`}>
                          <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${isOn ? 'translate-x-5' : 'translate-x-0'}`} />
                        </div>
                      </label>
                    );
                  })()}
                </div>

                {/* MD Files tab+editor - read-only */}
                <div className="flex-1 flex flex-col min-h-0 border border-gray-100 rounded-2xl overflow-hidden bg-gray-50/30">
                  <div className="flex p-1 bg-gray-100/50 gap-1 overflow-x-auto no-scrollbar">
                    {[
                      { id: 'soul', name: t('sidebar.tabSoul'), content: viewingSession.soulContent },
                      { id: 'user', name: t('sidebar.tabUser'), content: viewingSession.userContent },
                      { id: 'agents', name: t('sidebar.tabAgents'), content: viewingSession.agentsContent },
                      { id: 'tools', name: t('sidebar.tabTools'), content: viewingSession.toolsContent },
                      { id: 'heartbeat', name: t('sidebar.tabHeartbeat'), content: viewingSession.heartbeatContent },
                      { id: 'identity', name: t('sidebar.tabIdentity'), content: viewingSession.identityContent },
                    ].map(tab => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setInfoActiveTab(tab.id as any)}
                        className={`flex-none px-3 py-1.5 text-sm rounded-lg transition-all whitespace-nowrap border border-gray-200 ${infoActiveTab === tab.id ? 'bg-white text-blue-600 font-bold' : 'font-normal text-gray-500 hover:text-gray-700 hover:bg-white/50'}`}
                      >
                        {tab.name}
                      </button>
                    ))}
                  </div>
                  <div className="p-4 h-36 overflow-y-auto bg-white">
                    {(() => {
                      const tabs = {
                        soul: viewingSession.soulContent,
                        user: viewingSession.userContent,
                        agents: viewingSession.agentsContent,
                        tools: viewingSession.toolsContent,
                        heartbeat: viewingSession.heartbeatContent,
                        identity: viewingSession.identityContent,
                      };
                      const content = tabs[infoActiveTab as keyof typeof tabs] || '';
                      return (
                        <pre className="text-[13px] font-mono text-gray-800 leading-relaxed whitespace-pre-wrap">
                          {content || <span className="text-gray-400">{t('sidebar.noItems')}</span>}
                        </pre>
                      );
                    })()}
                  </div>
                </div>

              </div>

            </div>
            <div className="p-6 border-t border-gray-100 bg-gray-50/50 flex gap-3">
              <button
                type="button"
                onClick={() => setIsInfoModalOpen(false)}
                className="flex-1 flex items-center justify-center px-4 py-2.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-xl font-bold transition-all"
              >
                {t('common.close')}
              </button>
              <button
                onClick={() => handleStartEdit(null, viewingSession)}
                className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-white border border-blue-200 text-blue-600 hover:bg-blue-50 hover:border-blue-300 rounded-xl font-bold transition-all"
              >
                <Edit2 className="hidden sm:block w-4 h-4" />
                {t('common.edit')}
              </button>
              <button
                onClick={(e) => { setIsInfoModalOpen(false); confirmResetSession(e, viewingSession.id); }}
                className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-orange-50 text-orange-600 border border-orange-100 hover:bg-orange-100 hover:border-orange-200 rounded-xl font-bold transition-all"
              >
                <RefreshCw className="hidden sm:block w-4 h-4" />
                {t('common.reset')}
              </button>
              <button
                onClick={(e) => { setIsInfoModalOpen(false); confirmDeleteSession(e, viewingSession.id); }}
                disabled={viewingSession.id === 'main' || viewingSession.agentId === 'main'}
                className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 hover:border-red-200 rounded-xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="hidden sm:block w-4 h-4" />
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal - outside aside to center properly */}
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsDeleteModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{t('sidebar.confirmDeleteAgent')}</h3>
              <p className="text-sm text-gray-500">
                {t('sidebar.warningUndone')}
              </p>
            </div>
            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setIsDeleteModalOpen(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleDeleteSession}
                className="flex-1 px-4 py-2.5 text-white bg-red-600 hover:bg-red-700 rounded-xl font-semibold transition-all"
              >
                {t('common.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Confirmation Modal */}
      {isResetModalOpen && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsResetModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-orange-100 mb-4">
                <RefreshCw className="h-6 w-6 text-orange-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{t('sidebar.confirmResetAgent')}</h3>
              <p className="text-sm text-gray-500">
                {t('sidebar.resetAgentWarning')}
              </p>
            </div>
            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setIsResetModalOpen(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleResetSession}
                className="flex-1 px-4 py-2.5 text-white bg-orange-600 hover:bg-orange-700 rounded-xl font-semibold transition-all"
              >
                {t('common.reset')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Create Group Dialog */}
      {showGroupDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowGroupDialog(false)} />
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 max-h-[calc(100vh-2rem)] flex flex-col" style={MODAL_FORM_FONT_STYLE}>
            <div className="flex items-center justify-between p-6 border-b border-gray-100 bg-gray-50/50">
              <h3 className="text-xl font-bold text-gray-900">{groupModalMode === 'create' ? t('sidebar.newGroupTitle') : t('sidebar.editGroupTitle')}</h3>
              <button onClick={() => setShowGroupDialog(false)} className="p-2 hover:bg-gray-100 rounded-lg"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className={MODAL_FIELD_LABEL_CLASS}>{t('chat.groupId')} <span className="text-red-500">*</span></label>
                  <input
                    value={newGroupId}
                    onChange={e => {
                      setNewGroupId(e.target.value);
                      setGroupSubmitError(null);
                    }}
                    placeholder={t('chat.groupIdPlaceholder')}
                    disabled={groupModalMode === 'edit'}
                    autoFocus={groupModalMode === 'create'}
                    className={`${MODAL_TEXT_INPUT_CLASS} ${
                      groupModalMode === 'edit'
                        ? 'text-gray-500 cursor-not-allowed'
                        : visibleGroupIdError
                          ? 'bg-red-50/50 border-red-300 focus:bg-white focus:ring-2 focus:ring-red-500/15 focus:border-red-400'
                          : ''
                  }`}
                  />
                  {visibleGroupIdError ? (
                    <p className="mt-1.5 text-xs text-red-500">{visibleGroupIdError}</p>
                  ) : null}
                </div>

                <div className="flex-1">
                  <label className={MODAL_FIELD_LABEL_CLASS}>{t('chat.groupName')} <span className="text-red-500">*</span></label>
                  <input
                    value={newGroupName}
                    onChange={e => {
                      setNewGroupName(e.target.value);
                      setGroupSubmitError(null);
                    }}
                    placeholder={t('chat.groupNamePlaceholder')}
                    className={MODAL_TEXT_INPUT_CLASS}
                  />
                </div>
              </div>

              <div>
                <label className={MODAL_FIELD_LABEL_CLASS}>{t('chat.groupSystemPromptOptional')}</label>
                <textarea
                  value={newGroupSystemPrompt}
                  onChange={(e) => setNewGroupSystemPrompt(e.target.value)}
                  placeholder={t('chat.groupSystemPromptPlaceholder')}
                  className={`${MODAL_TEXTAREA_CLASS} h-24`}
                />
              </div>

              <div className="flex items-center justify-between gap-8 mb-1.5">
                <div className="flex items-center gap-4 flex-1">
                  <span className="text-sm font-bold text-gray-700">{t('sidebar.outputProcess')}</span>
                  <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={!!newProcessStartTag}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setNewProcessStartTag('[执行工作_Start]');
                          setNewProcessEndTag('[执行工作_End]');
                        } else {
                          setNewProcessStartTag('');
                          setNewProcessEndTag('');
                        }
                      }}
                    />
                    <div className="w-11 h-6 bg-blue-100 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-200 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                  </label>
                </div>
                <div className="flex items-center gap-4 flex-1 justify-end">
                  <span className="text-sm font-bold text-gray-700">{t('chat.maxChainDepth')}</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={newMaxChainDepth}
                    onChange={e => {
                      const val = parseInt(e.target.value);
                      setNewMaxChainDepth(isNaN(val) ? 0 : val);
                    }}
                    className="w-16 h-10 px-0 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-center text-gray-900 outline-none transition-all focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                </div>
              </div>
              
              <div className="space-y-1.5 mb-6 text-xs text-gray-400 font-normal">
                <div>{t('sidebar.outputProcessHint')}</div>
                <div>{t('sidebar.chainDepthHint')}</div>
              </div>

              <div>
                <label className="block text-sm font-bold text-gray-700 mb-2">
                  {t('chat.selectMembers')} ({selectedGroupMembers.length})
                </label>
                <div className="relative">
                  <div className={`flex items-center w-full px-4 py-2.5 border rounded-xl bg-white transition-colors ${isMemberDropdownOpen ? 'border-blue-400 ring-2 ring-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <Search className="w-4 h-4 text-gray-400 mr-2 flex-shrink-0" />
                    <input
                      value={groupSearchQuery}
                      onChange={e => setGroupSearchQuery(e.target.value)}
                      onFocus={() => setIsMemberDropdownOpen(true)}
                      onBlur={() => setTimeout(() => setIsMemberDropdownOpen(false), 200)}
                      placeholder={t('sidebar.searchAddAgent')}
                      className="flex-1 text-[15px] text-gray-900 placeholder:text-gray-400 outline-none bg-transparent"
                    />
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setIsMemberDropdownOpen((open) => !open)}
                      aria-label={t('chat.selectMembers')}
                      aria-expanded={isMemberDropdownOpen}
                      className="ml-2 -mr-1 p-1 text-gray-400 transition-colors hover:text-gray-600 cursor-pointer"
                    >
                      <ChevronDown className={`w-4 h-4 transition-transform ${isMemberDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>
                  </div>

                  {isMemberDropdownOpen && (
                    <div className="absolute top-[calc(100%+4px)] left-0 right-0 max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-xl z-50 py-1 scrollbar-hide">
                      {sessions.filter(s => s.name.toLowerCase().includes(groupSearchQuery.toLowerCase())).length === 0 ? (
                        <div className="px-4 py-3 text-sm text-gray-400 text-center font-medium">{t('sidebar.noItems')}</div>
                      ) : (
                        sessions.filter(s => s.name.toLowerCase().includes(groupSearchQuery.toLowerCase())).map(s => {
                          const memberAgentId = s.agentId || s.id;
                          const isSelected = selectedGroupMembers.some(m => m.agentId === memberAgentId);
                          return (
                            <button
                              key={s.id}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                toggleGroupMember(memberAgentId, s.name);
                              }}
                              className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center justify-between group transition-colors"
                            >
                              <span className="text-sm font-semibold text-gray-800 group-hover:text-blue-600 transition-colors">{s.name}</span>
                              {isSelected ? (
                                <div className="w-5 h-5 rounded-md bg-blue-500 flex items-center justify-center">
                                  <Check className="w-3.5 h-3.5 text-white" />
                                </div>
                              ) : (
                                <div className="w-5 h-5 rounded-md border-2 border-gray-200 group-hover:border-blue-400 transition-colors flex items-center justify-center" />
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              </div>
              {selectedGroupMembers.length > 0 && (
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">
                    {t('chat.defineRoles')}
                  </label>
                  <p className="text-xs text-gray-400 mb-3">{t('chat.defineRolesDesc')} {t('chat.dragToReorder')}</p>
                  
                  {/* Unified tab+editor — same style as the soul/agents file editor */}
                  <div className="flex-1 flex flex-col min-h-0 border border-gray-100 rounded-2xl overflow-hidden mt-2 bg-gray-50/30">
                    {/* Tab bar */}
                    <div className="flex p-1 bg-gray-100/50 gap-1 overflow-x-auto no-scrollbar">
                      {selectedGroupMembers.map(m => {
                         const activeMember = selectedGroupMembers.find(member => member.agentId === activeRoleTab) || selectedGroupMembers[0];
                         const isActive = activeMember.agentId === m.agentId;
                         return (
                           <div
                             key={m.agentId}
                             draggable={true}
                             onDragStart={(e) => {
                               setDraggedAgentId(m.agentId);
                               e.dataTransfer.effectAllowed = 'move';
                             }}
                             onDragOver={(e) => {
                               e.preventDefault();
                               e.dataTransfer.dropEffect = 'move';
                             }}
                             onDrop={(e) => {
                               e.preventDefault();
                               if (!draggedAgentId || draggedAgentId === m.agentId) return;
                               const oldIndex = selectedGroupMembers.findIndex(x => x.agentId === draggedAgentId);
                               const newIndex = selectedGroupMembers.findIndex(x => x.agentId === m.agentId);
                               if (oldIndex === -1 || newIndex === -1) return;
                               const newMembers = [...selectedGroupMembers];
                               const [removed] = newMembers.splice(oldIndex, 1);
                               newMembers.splice(newIndex, 0, removed);
                               setSelectedGroupMembers(newMembers);
                               setDraggedAgentId(null);
                             }}
                             onDragEnd={() => setDraggedAgentId(null)}
                             className={`flex-none flex items-center rounded-lg border border-gray-200 transition-all ${isActive ? 'bg-white text-blue-600' : 'text-gray-500 hover:bg-white/50 hover:text-gray-700'} ${draggedAgentId === m.agentId ? 'opacity-50' : ''}`}
                           >
                             <button
                               type="button"
                               onClick={() => setActiveRoleTab(m.agentId)}
                               className={`px-3 py-1.5 text-sm whitespace-nowrap transition-colors cursor-grab active:cursor-grabbing ${isActive ? 'font-bold text-blue-600' : 'font-normal text-inherit'}`}
                             >
                               <span>{resolveGroupMemberDisplayName(m)}</span>
                             </button>
                             <button
                               type="button"
                               onClick={(e) => {
                                 e.stopPropagation();
                                 removeGroupMember(m.agentId);
                               }}
                               aria-label={t('chat.removeMember').replace('{{name}}', resolveGroupMemberDisplayName(m))}
                               className={`mr-1 flex h-6 w-6 items-center justify-center rounded-md transition-colors ${isActive ? 'text-blue-400 hover:bg-blue-50 hover:text-blue-600' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
                             >
                               <X className="h-3.5 w-3.5" />
                             </button>
                           </div>
                         );
                      })}
                    </div>
                    {/* Editor area */}
                    <div className="flex-1 relative">
                      {(() => {
                        const activeMember = selectedGroupMembers.find(m => m.agentId === activeRoleTab) || selectedGroupMembers[0];
                        if (!activeMember) return null;
                        return (
                          <textarea
                            key={activeMember.agentId}
                            value={activeMember.roleDescription}
                            onChange={e => updateGroupMemberRole(activeMember.agentId, e.target.value)}
                            placeholder={t('chat.rolePlaceholder').replace('{{name}}', resolveGroupMemberDisplayName(activeMember))}
                            className={MODAL_EDITOR_TEXTAREA_CLASS}
                          />
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )}
              {groupSubmitError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                  {groupSubmitError}
                </div>
              )}
            </div>
            <div className="p-6 border-t border-gray-100 bg-gray-50/50 flex gap-3">
              <button 
                type="button" 
                onClick={() => setShowGroupDialog(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl font-bold transition-all active:scale-[0.98]"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleCreateGroup}
                disabled={!newGroupId.trim() || !newGroupName.trim() || selectedGroupMembers.length === 0 || (groupModalMode === 'create' && !!groupIdError)}
                className="flex-1 px-4 py-2.5 text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-bold transition-all active:scale-[0.98]"
              >
                {groupModalMode === 'create' ? t('chat.newGroupChat') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Group Info Modal */}
      {isGroupInfoOpen && viewingGroup && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIsGroupInfoOpen(false)} />
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-100 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div>
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-xl font-bold text-gray-900 leading-tight truncate">
                      {viewingGroup.name}
                    </h3>
                    {renderFavoriteButton(
                      'groups',
                      viewingGroup.id,
                      'flex-shrink-0 p-1.5 rounded-lg text-blue-500 hover:bg-blue-50 hover:text-yellow-600 transition-all'
                    )}
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setIsGroupInfoOpen(false)} 
                className="text-gray-400 hover:text-gray-600 transition-colors p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('chat.groupId')}</label>
                    <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                      {viewingGroup.id}
                    </p>
                  </div>
                  <div className="flex-1">
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('chat.groupName')}</label>
                    <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                      {viewingGroup.name}
                    </p>
                  </div>
                </div>

                {viewingGroup.system_prompt && (
                  <div className="group">
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('chat.groupSystemPrompt')}</label>
                    <p className="text-sm text-gray-600 bg-gray-50 p-3 rounded-xl border border-gray-100 whitespace-pre-wrap leading-relaxed">
                      {viewingGroup.system_prompt}
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between gap-6">
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-semibold text-gray-700">{t('sidebar.outputProcess')}</span>
                    {/* Read-only toggle switch matching the edit modal style */}
                    {(() => {
                      const isOn = !!(viewingGroup.process_start_tag && viewingGroup.process_end_tag);
                      return (
                        <label className="relative inline-flex items-center flex-shrink-0 pointer-events-none opacity-50 grayscale">
                          <input type="checkbox" checked={isOn} readOnly className="sr-only" />
                          <div className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${isOn ? 'bg-blue-600' : 'bg-gray-200'}`}>
                            <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${isOn ? 'translate-x-5' : 'translate-x-0'}`} />
                          </div>
                        </label>
                      );
                    })()}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-gray-700">{t('chat.maxChainDepth')}</span>
                    <span className="px-3 py-1 rounded-lg text-sm border border-gray-200 bg-gray-50 text-gray-700 font-mono">
                      {viewingGroup.max_chain_depth ?? 5}
                    </span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">{t('chat.members')}</label>
                  <div className="flex-1 flex flex-col min-h-0 border border-gray-100 rounded-2xl overflow-hidden bg-gray-50/30">
                    <div className="flex p-1 bg-gray-100/50 gap-1 overflow-x-auto no-scrollbar">
                      {viewingGroup.members?.map((m: any) => {
                         const activeMember = viewingGroup.members.find((member: any) => member.agent_id === infoActiveRoleTab) || viewingGroup.members[0];
                         const isActive = activeMember.agent_id === m.agent_id;
                         return (
                           <button
                             key={m.agent_id}
                             type="button"
                             onClick={() => setInfoActiveRoleTab(m.agent_id)}
                             className={`flex-none px-3 py-1.5 text-sm rounded-lg transition-all whitespace-nowrap border border-gray-200 ${isActive ? 'bg-white text-blue-600 font-bold' : 'font-normal text-gray-500 hover:text-gray-700 hover:bg-white/50'}`}
                           >
                             {resolveGroupMemberDisplayName(m)}
                           </button>
                         );
                      })}
                    </div>
                    <div className="p-4 min-h-[120px] max-h-[220px] overflow-y-auto bg-white">
                      {(() => {
                        const activeMember = viewingGroup.members?.find((m: any) => m.agent_id === infoActiveRoleTab) || viewingGroup.members?.[0];
                        if (!activeMember) return <p className="text-gray-400 text-sm">{t('sidebar.noItems')}</p>;
                        return (
                          <div className="text-[13px] font-mono text-gray-800 leading-relaxed whitespace-pre-wrap">
                            {activeMember.role_description || <span className="text-gray-400">{t('sidebar.noItems')}</span>}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-100 bg-gray-50/50 flex gap-3">
              <button
                type="button"
                onClick={() => setIsGroupInfoOpen(false)}
                className="flex-1 flex items-center justify-center px-4 py-2.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-xl font-bold transition-all active:scale-[0.98]"
              >
                {t('common.close')}
              </button>
              <button
                onClick={() => {
                  setGroupModalMode('edit');
                  setEditingGroupId(viewingGroup.id);
                  setNewGroupId(viewingGroup.id);
                  setNewGroupName(viewingGroup.name);
                  setNewGroupDesc(viewingGroup.description || '');
                  setNewGroupSystemPrompt(viewingGroup.system_prompt || '');
                  setNewProcessStartTag(viewingGroup.process_start_tag || '');
                  setNewProcessEndTag(viewingGroup.process_end_tag || '');
                  setNewMaxChainDepth(viewingGroup.max_chain_depth ?? 6);
                  setSelectedGroupMembers(
                    viewingGroup.members?.map((m: any) => ({
                      agentId: m.agent_id,
                      displayName: resolveGroupMemberDisplayName(m),
                      roleDescription: m.role_description || ''
                    })) || []
                  );
                  setGroupSubmitError(null);
                  setIsGroupInfoOpen(false);
                  setShowGroupDialog(true);
                }}
                className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-white border border-blue-200 text-blue-600 hover:bg-blue-50 hover:border-blue-300 rounded-xl font-bold transition-all active:scale-[0.98]"
              >
                <Edit2 className="hidden sm:block w-4 h-4" />{t('common.edit')}
              </button>
              <button
                onClick={() => { setIsGroupInfoOpen(false); setIsResetGroupModalOpen(true); }}
                className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-orange-50 text-orange-600 border border-orange-100 hover:bg-orange-100 hover:border-orange-200 rounded-xl font-bold transition-all active:scale-[0.98]"
              >
                <RefreshCw className="hidden sm:block w-4 h-4" />{t('common.reset')}
              </button>
              <button
                onClick={() => { setIsGroupInfoOpen(false); setIsDeleteGroupModalOpen(true); }}
                className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 hover:border-red-200 rounded-xl font-bold transition-all active:scale-[0.98]"
              >
                <Trash2 className="hidden sm:block w-4 h-4" />{t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Group Confirmation */}
      {isDeleteGroupModalOpen && viewingGroup && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIsDeleteGroupModalOpen(false)} />
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{t('common.confirmDelete')}</h3>
              <p className="text-sm text-gray-500">{t('sidebar.confirmDeleteGroup')} {t('sidebar.warningUndone')}</p>
            </div>
            <div className="flex gap-3 p-6 pt-0">
              <button
                onClick={() => setIsDeleteGroupModalOpen(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={async () => {
                  try {
                    await fetch(`/api/groups/${viewingGroup.id}`, { method: 'DELETE' });
                    setIsDeleteGroupModalOpen(false);
                    setViewingGroup(null);
                    if (activeGroupId === viewingGroup.id) {
                      onSelectGroup('');
                      navigateTo('chat', settingsTab, false);
                    }
                    await reloadGroups();
                  } catch {}
                }}
                className="flex-1 px-4 py-2.5 text-white bg-red-600 hover:bg-red-700 rounded-xl font-semibold transition-all"
              >
                {t('common.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Group Confirmation */}
      {isResetGroupModalOpen && viewingGroup && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIsResetGroupModalOpen(false)} />
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-orange-100 mb-4">
                <RefreshCw className="h-6 w-6 text-orange-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{t('sidebar.confirmResetGroup')}</h3>
              <p className="text-sm text-gray-500">{t('sidebar.resetGroupWarning')}</p>
            </div>
            <div className="flex gap-3 p-6 pt-0">
              <button
                onClick={() => setIsResetGroupModalOpen(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={async () => {
                  try {
                    await fetch(`/api/groups/${viewingGroup.id}/reset`, { method: 'POST' });
                    setIsResetGroupModalOpen(false);
                    await reloadGroups();

                    // If currently viewing this group, refresh the group chat view
                    if (activeGroupId === viewingGroup.id && currentView === 'groups') {
                      // Trigger reload by temporarily switching away and back
                      onSelectGroup('');
                      setTimeout(() => onSelectGroup(viewingGroup.id), 50);
                    }
                  } catch (err) {
                    console.error('Failed to reset group:', err);
                  }
                }}
                className="flex-1 px-4 py-2.5 text-white bg-orange-600 hover:bg-orange-700 rounded-xl font-semibold transition-all"
              >
                {t('common.reset')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
