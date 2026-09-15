import { useTranslation } from 'react-i18next';
import type { SidebarListTab } from './sidebarTypes';

export default function ListTabs({
  sidebarListTab,
  setSidebarListTab,
}: {
  sidebarListTab: SidebarListTab;
  setSidebarListTab: (tab: SidebarListTab) => void;
}) {
  const { t } = useTranslation();
  return (
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
}
