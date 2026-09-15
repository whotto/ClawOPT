import { useTranslation } from 'react-i18next';
import type { SettingsTab, ViewType } from '../routeState';
import { SETTINGS_NAV_ITEMS, SETTINGS_NAV_ZONES } from './sidebarNav';

export default function SettingsNav({
  settingsTab,
  navigateTo,
}: {
  settingsTab: SettingsTab;
  navigateTo: (view: ViewType, tab?: SettingsTab, openMenu?: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-4">
      {SETTINGS_NAV_ZONES.map(({ zone, labelKey: zoneLabelKey }) => (
        <div key={zone} className="space-y-1">
          <div className="px-4 pb-1 text-xs font-semibold text-gray-400">{t(zoneLabelKey)}</div>
          {SETTINGS_NAV_ITEMS.filter((item) => item.zone === zone).map(({ tab, icon: Icon, labelKey }) => (
            <button
              key={tab}
              onClick={() => navigateTo('settings', tab, false)}
              className={`w-full min-w-0 flex items-center gap-3 px-4 py-2.5 rounded-xl text-base transition-all border ${settingsTab === tab ? 'font-semibold text-gray-600 bg-amber-50 border-orange-300' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
            >
              <Icon className="w-5 h-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
                {t(labelKey)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
