import { Outlet } from 'react-router-dom';
import PendingApprovalsTray from '../features/workflow/components/PendingApprovalsTray';
import Sidebar from './sidebar/Sidebar';
import type { ShellContext } from './shellContext';
import { useAppNavigation } from './useAppNavigation';
import { useConnectionStatus } from './useConnectionStatus';
import { useModels } from './useModels';
import { useSessions } from './useSessions';

/** 侧栏 + 主区域。主区域由路由表决定渲染哪一页，页面通过 Outlet context 拿壳层状态。 */
export default function AppShell() {
  const nav = useAppNavigation();
  const isConnected = useConnectionStatus();
  const { sessions, sessionsLoaded, reloadSessions, reorderSessions } = useSessions(nav.autoSelectSession);
  const { availableModels, reloadModels } = useModels();

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
      />
      <main className="flex-1 flex flex-col min-w-0 bg-white overflow-hidden md:overflow-visible md:relative md:z-[60]">
        <Outlet context={context} />
      </main>
      <PendingApprovalsTray
        visibleWorkflowId={nav.currentView === 'automation' && nav.automationSection === 'workflows' ? nav.activeWorkflowId : null}
        onOpen={(workflowId) => nav.openAutomation('workflows', workflowId)}
      />
    </div>
  );
}
