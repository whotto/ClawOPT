import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '../access';
import type { AutomationSection, SettingsTab, ViewType } from '../routeState';
import AutomationNav from './AutomationNav';
import AgentEditorModal from './AgentEditorModal';
import AgentInfoModal from './AgentInfoModal';
import AgentList from './AgentList';
import { OrganizedSessionList } from '../../features/sessions/OrganizedSessionList';
import ExternalAgentDialog, { type ExternalSessionSummary } from './ExternalAgentDialog';
import FavoritesList from './FavoritesList';
import { DeleteGroupModal, ResetGroupModal } from './GroupConfirmModals';
import GroupEditorModal from './GroupEditorModal';
import GroupInfoModal from './GroupInfoModal';
import GroupList from './GroupList';
import ListTabs from './ListTabs';
import NewButtons, { openNewAgentEditor } from './NewButtons';
import { NEW_CHAT_SHORTCUT_EVENT, OPEN_SESSION_SEARCH_EVENT } from '../../features/search/lib/searchLib';
import { Search } from 'lucide-react';
import { DeleteSessionModal, ResetSessionModal } from './SessionConfirmModals';
import SettingsNav from './SettingsNav';
import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import { useAgentEditor } from './useAgentEditor';
import { useAppVersionInfo } from './useAppVersionInfo';
import { useGroupDetails } from './useGroupDetails';
import { useGroupEditor } from './useGroupEditor';
import { useSessionActions } from './useSessionActions';
import { usePruneSidebarFavorites, useSidebarFavorites, useSidebarListTab } from './useSidebarFavorites';
import { useSidebarGroups } from './useSidebarGroups';

export interface SidebarProps {
  currentView: ViewType;
  settingsTab?: SettingsTab;
  activeSessionId: string;
  setActiveSessionId: (id: string) => void;
  isMobileMenuOpen: boolean;
  sessions: {id: string, name: string, agentId?: string, externalRuntime?: string}[];
  sessionsLoaded: boolean;
  reloadSessions: () => Promise<void>;
  reorderSessions: (newSessions: {id: string, name: string}[]) => Promise<void>;
  navigateTo: (view: ViewType, tab?: SettingsTab, openMenu?: boolean) => void;
  onReturnToConversation: () => void;
  availableModels: any[];
  activeGroupId: string | null;
  onSelectGroup: (id: string) => void;
  automationSection: AutomationSection;
  onOpenAutomation: (section: AutomationSection) => void;
  /** 在后台完成、还没打开看过的单聊（features/notifications）。 */
  unreadSessionIds?: ReadonlySet<string>;
}

/**
 * 侧栏容器：设置模式渲染设置导航；对话模式渲染新建按钮、智能体 / 工作群 / 收藏列表与各弹窗。
 * 所有状态都在这里调用的 hooks 里，子组件只收 props——弹窗开关的挂载时机与拆分前一致。
 */
export default function Sidebar(props: SidebarProps) {
  const {
    currentView,
    settingsTab = 'gateway',
    activeSessionId,
    setActiveSessionId,
    isMobileMenuOpen,
    sessions,
    sessionsLoaded,
    reloadSessions,
    navigateTo,
    onReturnToConversation,
    availableModels,
    activeGroupId,
    onSelectGroup,
    automationSection,
    onOpenAutomation,
  } = props;
  const { t, i18n } = useTranslation();
  const appVersionInfo = useAppVersionInfo();

  // On first render, use a plain static list (no Framer Motion).
  // After mount, switch to Reorder for drag support.
  const [enableReorder, setEnableReorder] = useState(false);
  useEffect(() => {
    // Use requestAnimationFrame to ensure the first paint has completed
    requestAnimationFrame(() => {
      setEnableReorder(true);
    });
  }, []);

  const sessionActions = useSessionActions({ reloadSessions, activeSessionId, setActiveSessionId, currentView });
  const agentEditor = useAgentEditor({
    t,
    language: i18n.language || '',
    availableModels,
    reloadSessions,
    activeSessionId,
    setActiveSessionId,
    navigateTo,
    currentView,
    closeSessionInfo: () => sessionActions.setIsInfoModalOpen(false),
  });
  const { sidebarListTab, setSidebarListTab } = useSidebarListTab(currentView);
  const favorites = useSidebarFavorites();
  const groupDetails = useGroupDetails();
  const { groups, groupsLoaded, reloadGroups, reorderGroups } = useSidebarGroups();
  const groupEditor = useGroupEditor({ t, groups, reloadGroups, onSelectGroup, navigateTo, settingsTab, activeGroupId, currentView });
  // 只有看得到全部会话与群的角色（能管理 Agent）才按列表清理收藏；member 的列表是过滤过的。
  const listsComplete = useAccess().can('agents.manage');
  // Ctrl/Cmd+N：与「新建智能体」按钮同一个入口，没有 agents.manage 能力时什么也不做。
  useEffect(() => {
    const handleNewChat = () => {
      if (!listsComplete) return;
      navigateTo('chat', undefined, false);
      void openNewAgentEditor(agentEditor);
    };
    window.addEventListener(NEW_CHAT_SHORTCUT_EVENT, handleNewChat);
    return () => window.removeEventListener(NEW_CHAT_SHORTCUT_EVENT, handleNewChat);
  }, [agentEditor, listsComplete, navigateTo]);
  usePruneSidebarFavorites(favorites, sessions, sessionsLoaded, groups, groupsLoaded, listsComplete);
  // 外部运行时单聊的新建 / 编辑弹窗：null = 关；{} = 新建；带 externalRuntime 的会话 = 编辑。
  const [externalDialog, setExternalDialog] = useState<ExternalSessionSummary | null>(null);

  if (currentView === 'settings' || currentView === 'automation') {
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
          {currentView === 'automation'
            ? <AutomationNav section={automationSection} onOpen={onOpenAutomation} />
            : <SettingsNav settingsTab={settingsTab} navigateTo={navigateTo} />}
          <SidebarFooter mode="settings" onReturnToConversation={onReturnToConversation} />
        </aside>
      </>
    );
  }

  const { isInfoModalOpen, viewingSession, isDeleteModalOpen, isResetModalOpen } = sessionActions;
  // 外部运行时会话没有 OpenClaw 侧的文件可看：详情按钮打开它自己的编辑弹窗（改 / 删是管理员的，member 不打开）。
  const handleShowInfo = (e: React.MouseEvent, session: { id: string; name: string }) => {
    const external = session as ExternalSessionSummary;
    if (external.externalRuntime) {
      e.stopPropagation();
      if (listsComplete) setExternalDialog(external);
      return;
    }
    void sessionActions.handleShowInfo(e, session);
  };
  const { isGroupInfoOpen, viewingGroup, isDeleteGroupModalOpen, isResetGroupModalOpen } = groupDetails;

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

        {/* 会话搜索入口（与 Ctrl/Cmd+K 同一个面板） */}
        <div className="px-4 pb-2">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SESSION_SEARCH_EVENT))}
            className="w-full h-9 px-3 flex items-center gap-2 rounded-xl border border-gray-300 bg-white text-sm text-gray-400 hover:border-orange-300 hover:text-gray-600 transition-colors"
            data-testid="sidebar-search-button"
          >
            <Search className="w-4 h-4" />
            <span className="flex-1 text-left">{t('sessionSearch.sidebarButton')}</span>
            <span className="text-[11px] text-gray-400">{/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl+K'}</span>
          </button>
        </div>

        {/* + 新建 按钮组 */}
        <NewButtons editor={agentEditor} groupEditor={groupEditor} onNewExternal={() => setExternalDialog({ id: '', name: '' })} />

        {/* 可滚动列表区域 */}
        <div className="flex-1 overflow-y-auto px-4 py-1 min-h-0 scrollbar-hide">
          <ListTabs sidebarListTab={sidebarListTab} setSidebarListTab={setSidebarListTab} />
          {sidebarListTab === 'agents'
            ? (
              <OrganizedSessionList
                sidebar={props}
                onShowInfo={handleShowInfo}
                renderFlat={(renderRowAction) => <AgentList sidebar={props} enableReorder={enableReorder} onShowInfo={handleShowInfo} renderRowAction={renderRowAction} />}
              />
            )
            : sidebarListTab === 'groups'
              ? <GroupList sidebar={props} enableReorder={enableReorder} groups={groups} reorderGroups={reorderGroups} groupDetails={groupDetails} />
              : (
                <FavoritesList
                  sidebar={props}
                  enableReorder={enableReorder}
                  groups={groups}
                  sidebarFavorites={favorites.sidebarFavorites}
                  reorderFavorites={favorites.reorderFavorites}
                  groupDetails={groupDetails}
                  onShowInfo={handleShowInfo}
                />
              )}
        </div>

        <SidebarFooter mode="conversation" onOpenSettings={() => navigateTo('settings')} onOpenAutomation={() => onOpenAutomation(automationSection)} />
      </aside>

      {/* Create Agent Modal - outside aside to center properly */}
      {agentEditor.isModalOpen && (
        <AgentEditorModal editor={agentEditor} availableModels={availableModels} />
      )}

      {externalDialog && (
        <ExternalAgentDialog
          session={externalDialog.externalRuntime ? externalDialog : null}
          onClose={() => setExternalDialog(null)}
          onSaved={async (sessionId) => {
            setExternalDialog(null);
            await reloadSessions();
            if (sessionId) { setActiveSessionId(sessionId); onSelectGroup(''); navigateTo('chat', settingsTab, false); }
          }}
          onDeleted={async () => { setExternalDialog(null); await reloadSessions(); }}
        />
      )}

      {/* Session Info Modal */}
      {isInfoModalOpen && viewingSession && (
        <AgentInfoModal sidebar={props} actions={sessionActions} editor={agentEditor} favorites={favorites} />
      )}

      {/* Delete Confirmation Modal - outside aside to center properly */}
      {isDeleteModalOpen && <DeleteSessionModal actions={sessionActions} />}

      {/* Reset Confirmation Modal */}
      {isResetModalOpen && <ResetSessionModal actions={sessionActions} />}

      {/* Create Group Dialog */}
      {groupEditor.showGroupDialog && <GroupEditorModal groupEditor={groupEditor} sessions={sessions} />}

      {/* Group Info Modal */}
      {isGroupInfoOpen && viewingGroup && (
        <GroupInfoModal sidebar={props} groupDetails={groupDetails} groupEditor={groupEditor} favorites={favorites} />
      )}

      {/* Delete Group Confirmation */}
      {isDeleteGroupModalOpen && viewingGroup && (
        <DeleteGroupModal sidebar={props} groupDetails={groupDetails} reloadGroups={reloadGroups} />
      )}

      {/* Reset Group Confirmation */}
      {isResetGroupModalOpen && viewingGroup && (
        <ResetGroupModal sidebar={props} groupDetails={groupDetails} reloadGroups={reloadGroups} />
      )}
    </>
  );
}
