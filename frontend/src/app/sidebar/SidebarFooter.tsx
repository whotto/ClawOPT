import { useTranslation } from 'react-i18next';
import { ArrowLeft, Settings, Workflow } from 'lucide-react';
import { useAccess } from '../access';
import { visibleAutomationNav, visibleSettingsNav } from './sidebarNav';

/** 侧栏底部：设置 / 自动化模式是「返回对话」，对话模式是「自动化」与「系统设置」。 */
export default function SidebarFooter(
  props:
    | { mode: 'settings'; onReturnToConversation: () => void }
    | { mode: 'conversation'; onOpenSettings: () => void; onOpenAutomation: () => void },
) {
  const { t } = useTranslation();
  const { capabilities } = useAccess();
  // 能力清单到手后，一个入口都没有的区不给按钮；没到手时照常显示（进去后由路由纠偏兜底）。
  const showAutomation = !capabilities || visibleAutomationNav(capabilities).length > 0;
  const showSettings = !capabilities || visibleSettingsNav(capabilities).length > 0;

  if (props.mode === 'settings') {
    return (
      <div className="p-4 border-t border-gray-100">
        <button
          onClick={props.onReturnToConversation}
          className="w-full min-w-0 flex items-center gap-3 px-4 py-3 text-gray-600 hover:bg-gray-200 hover:text-gray-900 hover:font-semibold rounded-xl transition-all font-normal"
        >
          <ArrowLeft className="w-5 h-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left text-sm">
            {t('sidebar.backBtn')}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 border-t border-gray-100 bg-gray-100/50 space-y-1">
      {showAutomation && <button
        onClick={props.onOpenAutomation}
        className="flex items-center w-full py-3 px-4 text-gray-600 hover:text-gray-900 hover:font-semibold transition-colors font-normal text-sm rounded-xl hover:bg-gray-200 gap-3"
      >
        <Workflow className="w-5 h-5 shrink-0" />
        {t('automation.nav.zone')}
      </button>}
      {showSettings && <button
        onClick={props.onOpenSettings}
        className="flex items-center w-full py-3 px-4 text-gray-600 hover:text-gray-900 hover:font-semibold transition-colors font-normal text-sm rounded-xl hover:bg-gray-200 gap-3"
      >
        <Settings className="w-5 h-5 shrink-0" />
        {t('sidebar.sysSettings')}
      </button>}
    </div>
  );
}
