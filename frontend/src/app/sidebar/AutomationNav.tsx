import { useTranslation } from 'react-i18next';
import type { AutomationSection } from '../routeState';
import { AUTOMATION_NAV_ITEMS } from './sidebarNav';

/** 自动化模式下的侧栏导航：分区标题 + 工作流 / 看板 / Webhook，样式与设置导航一致。 */
export default function AutomationNav({
  section,
  onOpen,
}: {
  section: AutomationSection;
  onOpen: (section: AutomationSection) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="flex-1 px-4 py-2 space-y-1">
      <p className="px-4 pt-1 pb-2 text-xs font-semibold text-gray-400">{t('automation.nav.zone')}</p>
      {AUTOMATION_NAV_ITEMS.map(({ section: item, icon: Icon, labelKey }) => (
        <button
          key={item}
          onClick={() => onOpen(item)}
          className={`w-full min-w-0 flex items-center gap-3 px-4 py-3 rounded-xl text-base transition-all border ${section === item ? 'font-semibold text-gray-600 bg-amber-50 border-orange-300' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
        >
          <Icon className="w-5 h-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{t(labelKey)}</span>
        </button>
      ))}
    </nav>
  );
}
