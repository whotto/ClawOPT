import { Menu } from 'lucide-react';
import type { ComponentType } from 'react';
import { useShellContext } from '../../app/shellContext';
import type { SettingsTab } from '../../app/routeState';
import CronPage from '../automation/CronPage';
import ChannelsPage from '../system/ChannelsPage';
import LogsPage from '../system/LogsPage';
import PluginsPage from '../system/PluginsPage';
import UsagePage from '../system/UsagePage';
import UsersPage from '../system/UsersPage';
import AgentsPage from '../team/AgentsPage';
import McpPage from '../team/McpPage';
import SkillsPage from '../team/SkillsPage';
import AboutTab from './tabs/AboutTab';
import CommandsTab from './tabs/CommandsTab';
import GatewayTab from './tabs/GatewayTab';
import GeneralTab from './tabs/GeneralTab';
import ModelsTab from './tabs/ModelsTab';
import AddModelModal from './modals/AddModelModal';
import DeleteConfirmModal from './modals/DeleteConfirmModal';
import EndpointModal from './modals/EndpointModal';
import PermissionModals from './modals/PermissionModals';
import RestartModals from './modals/RestartModals';
import SettingsErrorModal from './modals/SettingsErrorModal';
import UpdateModals from './modals/UpdateModals';
import PresetLibrary from './presets/PresetLibrary';
import { useSettingsController } from './useSettingsController';

/** P5a 控制面页面：各自管状态、需要更宽的版心，不经 useSettingsController。 */
const CONTROL_PAGES: Partial<Record<SettingsTab, ComponentType>> = {
  agents: AgentsPage,
  skills: SkillsPage,
  mcp: McpPage,
  users: UsersPage,
  cron: CronPage,
  channels: ChannelsPage,
  plugins: PluginsPage,
  usage: UsagePage,
  logs: LogsPage,
};

/**
 * /settings/:tab 所有页签共用一个挂载实例：切页签不丢未保存的输入与进行中的弹窗，与改路由前一致。
 * 状态全部在 useSettingsController；这里只负责页头、按页签挑正文、以及页面级弹窗的摆放位置。
 */
export default function SettingsPage() {
  const shell = useShellContext();
  const ctx = useSettingsController({
    isConnected: shell.isConnected,
    settingsTab: shell.settingsTab,
    onMenuClick: shell.openMobileMenu,
    onModelsChanged: shell.reloadModels,
    onAgentsChanged: shell.reloadSessions,
  });
  const { t, settingsTab, onMenuClick, onAgentsChanged } = ctx;
  const ControlPage = CONTROL_PAGES[settingsTab];

  const headerTitle = ControlPage
    ? t(`control.headerTitle.${settingsTab}`)
    : settingsTab === 'gateway'
      ? t('settings.gateway.headerTitle')
      : settingsTab === 'general'
        ? t('settings.general.headerTitle')
        : settingsTab === 'presets'
          ? t('settings.presets.headerTitle')
        : settingsTab === 'commands'
          ? t('settings.commands.headerTitle')
          : settingsTab === 'models'
            ? t('settings.models.headerTitle')
            : t('settings.about.headerTitle');

  return (
    <div className="flex flex-col h-full bg-gray-50/50">
      <header className="h-14 flex items-center px-4 sm:px-8 border-b border-gray-200 bg-white sticky top-0 z-10 gap-3">
        <button
          className="md:hidden text-gray-500 hover:text-gray-900 focus:outline-none pr-1"
          onClick={onMenuClick}
        >
          <Menu className="w-6 h-6" />
        </button>
        <h2 className="text-xl font-bold text-gray-900 truncate">{headerTitle}</h2>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:p-8">
        {ControlPage ? (
          <div className="max-w-6xl mx-auto">
            <ControlPage />
          </div>
        ) : (
        <div className="max-w-2xl mx-auto space-y-6 sm:space-y-8">

          {/* Gateway Settings Tab */}
          {settingsTab === 'gateway' && (
            <GatewayTab ctx={ctx} />
          )}

          {/* General Settings Tab */}
          {settingsTab === 'general' && (
            <GeneralTab ctx={ctx} />
          )}

          {/* Preset Library Tab */}
          {settingsTab === 'presets' && (
            <PresetLibrary onAgentsChanged={onAgentsChanged} />
          )}

          {/* Quick Commands Management Tab */}
          {settingsTab === 'commands' && (
            <CommandsTab ctx={ctx} />
          )}

          {/* Model Management Tab */}
          {settingsTab === 'models' && (
            <ModelsTab ctx={ctx} />
          )}

          {/* About System Tab */}
          {settingsTab === 'about' && (
            <AboutTab ctx={ctx} />
          )}

        </div>
        )}
      </div>

      <PermissionModals ctx={ctx} />

      <RestartModals ctx={ctx} />

      <UpdateModals ctx={ctx} />

      <DeleteConfirmModal ctx={ctx} />

      <EndpointModal ctx={ctx} />

      <AddModelModal ctx={ctx} />

      <SettingsErrorModal ctx={ctx} />
    </div>
  );
}
