// 自动化区：/automation/workflows[/:id]、/automation/kanban、/automation/webhooks。
// 页签状态由壳层与地址栏对齐（routeState.ts），这里只挑正文。
import { Menu } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useShellContext } from '../../app/shellContext';
import KanbanPage from './kanban/KanbanPage';
import WebhooksPage from './webhooks/WebhooksPage';
import WorkflowsPage from './workflows/WorkflowsPage';

export default function AutomationPage() {
  const { t } = useTranslation();
  const shell = useShellContext();
  const { automationSection, activeWorkflowId, openAutomation } = shell;
  const selectWorkflow = useCallback((id: string | null) => openAutomation('workflows', id), [openAutomation]);

  return (
    <div className="flex flex-col h-full bg-gray-50/50">
      <header className="h-14 flex items-center px-4 sm:px-6 border-b border-gray-200 bg-white gap-3 shrink-0">
        <button className="md:hidden text-gray-500 hover:text-gray-900 focus:outline-none pr-1" onClick={shell.openMobileMenu} aria-label={t('automation.nav.zone')}>
          <Menu className="w-6 h-6" />
        </button>
        <h2 className="text-xl font-bold text-gray-900">{t(`automation.nav.${automationSection}`)}</h2>
      </header>
      <div className="flex-1 min-h-0">
        {automationSection === 'workflows' && <WorkflowsPage workflowId={activeWorkflowId} onSelectWorkflow={selectWorkflow} />}
        {automationSection === 'kanban' && <KanbanPage />}
        {automationSection === 'webhooks' && <WebhooksPage />}
      </div>
    </div>
  );
}
