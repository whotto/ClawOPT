import { Outlet } from 'react-router-dom';
import { useNotificationCenter } from '../features/notifications/useNotificationCenter';
import PendingApprovalsTray from '../features/workflow/components/PendingApprovalsTray';
import { AccessProvider, useAccessLoader } from './access';
import ShellBanners from './onboarding/ShellBanners';
import Sidebar from './sidebar/Sidebar';
import type { ShellContext } from './shellContext';
import { useAppNavigation } from './useAppNavigation';
import { useConnectionStatus } from './useConnectionStatus';
import { useModels } from './useModels';
import { useSessions } from './useSessions';

/** 侧栏 + 主区域。主区域由路由表决定渲染哪一页，页面通过 Outlet context 拿壳层状态。 */
export default function AppShell() {
  const access = useAccessLoader();
  const nav = useAppNavigation(access.capabilities);
  const isConnected = useConnectionStatus();
  const { sessions, sessionsLoaded, reloadSessions, reorderSessions } = useSessions(nav.autoSelectSession);
  const { availableModels, reloadModels, modelsLoaded, modelsConfigReadFailed } = useModels();
  const visibleConversation = nav.currentView === 'chat' && nav.activeSessionId
    ? { kind: 'chat' as const, id: nav.activeSessionId }
    : nav.currentView === 'groups' && nav.activeGroupId ? { kind: 'group' as const, id: nav.activeGroupId } : null;
  const openConversation = (target: { kind: 'chat' | 'group'; id: string }) => {
    if (target.kind === 'group') {
      nav.setActiveGroupId(target.id);
      nav.navigateTo('groups', undefined, false);
    } else {
      nav.setActiveSessionId(target.id);
      nav.navigateTo('chat', undefined, false);
    }
  };
  // 完成 / 审批提醒与侧栏未读点（features/notifications）。
  const { unreadSessionIds } = useNotificationCenter({ sessions, sessionsLoaded, openContext: visibleConversation, onOpen: openConversation });

  const context: ShellContext = {
    isConnected,
    sessions,
    availableModels,
    activeSessionId: nav.activeSessionId,
    activeGroupId: nav.activeGroupId,
    settingsTab: nav.settingsTab,
    automationSection: nav.automationSection,
    activeWorkflowId: nav.activeWorkflowId,
    openAutomation: nav.openAutomation,
    openMobileMenu: nav.openMobileMenu,
    selectGroup: (id) => {
      nav.setActiveGroupId(id);
      nav.navigateTo('groups');
    },
    reloadModels,
    reloadSessions,
  };

  return (
    <AccessProvider value={access}>
      <div
        className="flex fixed inset-0 h-[100dvh] w-full overflow-hidden bg-gray-50 text-gray-900 font-sans antialiased"
      >
        <Sidebar
          currentView={nav.currentView}
          settingsTab={nav.settingsTab}
          activeSessionId={nav.activeSessionId}
          setActiveSessionId={nav.setActiveSessionId}
          isMobileMenuOpen={nav.isMobileMenuOpen}
          sessions={sessions}
          sessionsLoaded={sessionsLoaded}
          reloadSessions={reloadSessions}
          reorderSessions={reorderSessions}
          navigateTo={nav.navigateTo}
          onReturnToConversation={nav.handleReturnToConversation}
          availableModels={availableModels}
          activeGroupId={nav.activeGroupId}
          onSelectGroup={nav.setActiveGroupId}
          automationSection={nav.automationSection}
          onOpenAutomation={nav.openAutomation}
          unreadSessionIds={unreadSessionIds}
        />
        <main className="flex-1 flex flex-col min-w-0 bg-white overflow-hidden md:overflow-visible md:relative md:z-[60]">
          <ShellBanners
            isConnected={isConnected}
            inConversation={nav.currentView === 'chat' || nav.currentView === 'groups'}
            modelsLoaded={modelsLoaded}
            modelCount={availableModels.length}
            modelsConfigReadFailed={modelsConfigReadFailed}
            onOpenModelSettings={() => nav.navigateTo('settings', 'models', false)}
          />
          <Outlet context={context} />
        </main>
        <PendingApprovalsTray
          visibleWorkflowId={nav.currentView === 'automation' && nav.automationSection === 'workflows' ? nav.activeWorkflowId : null}
          onOpen={(workflowId) => nav.openAutomation('workflows', workflowId)}
          visibleConversation={visibleConversation}
          onOpenConversation={openConversation}
        />
      </div>
    </AccessProvider>
  );
}
