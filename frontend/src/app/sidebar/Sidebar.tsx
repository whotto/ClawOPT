import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsTab, ViewType } from '../routeState';
import AgentEditorModal from './AgentEditorModal';
import AgentInfoModal from './AgentInfoModal';
import AgentList from './AgentList';
import FavoritesList from './FavoritesList';
import { DeleteGroupModal, ResetGroupModal } from './GroupConfirmModals';
import GroupEditorModal from './GroupEditorModal';
import GroupInfoModal from './GroupInfoModal';
import GroupList from './GroupList';
import ListTabs from './ListTabs';
import NewButtons from './NewButtons';
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
  usePruneSidebarFavorites(favorites, sessions, sessionsLoaded, groups, groupsLoaded);

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
          <SettingsNav settingsTab={settingsTab} navigateTo={navigateTo} />
          <SidebarFooter mode="settings" onReturnToConversation={onReturnToConversation} />
        </aside>
      </>
    );
  }

  const { isInfoModalOpen, viewingSession, isDeleteModalOpen, isResetModalOpen, handleShowInfo } = sessionActions;
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

        {/* + 新建 按钮组 */}
        <NewButtons editor={agentEditor} groupEditor={groupEditor} />

        {/* 可滚动列表区域 */}
        <div className="flex-1 overflow-y-auto px-4 py-1 min-h-0 scrollbar-hide">
          <ListTabs sidebarListTab={sidebarListTab} setSidebarListTab={setSidebarListTab} />
          {sidebarListTab === 'agents'
            ? <AgentList sidebar={props} enableReorder={enableReorder} onShowInfo={handleShowInfo} />
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

        <SidebarFooter mode="conversation" onOpenSettings={() => navigateTo('settings')} />
      </aside>

      {/* Create Agent Modal - outside aside to center properly */}
      {agentEditor.isModalOpen && (
        <AgentEditorModal editor={agentEditor} availableModels={availableModels} memberDropdownRef={groupEditor.memberDropdownRef} />
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
