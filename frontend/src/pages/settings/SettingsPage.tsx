import { Menu } from 'lucide-react';
import { useShellContext } from '../../app/shellContext';
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
import RuntimesPage from '../team/runtimes/RuntimesPage';
import { useSettingsController } from './useSettingsController';

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

  const headerTitle = settingsTab === 'runtimes'
    ? t('settings.runtimes.headerTitle')
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
        <h2 className="text-xl font-bold text-gray-900">{headerTitle}</h2>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:p-8">
        {/* Agent 运行时（P2）：卡片网格与配置编辑器需要更宽的版心，自己管状态，不经 useSettingsController。 */}
        {settingsTab === 'runtimes' && (
          <div className="max-w-6xl mx-auto">
            <RuntimesPage />
          </div>
        )}
        <div className={`max-w-2xl mx-auto space-y-6 sm:space-y-8 ${settingsTab === 'runtimes' ? 'hidden' : ''}`}>

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
