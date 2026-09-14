import SettingsView from '../../components/SettingsView';
import { useShellContext } from '../../app/shellContext';

/** /settings/:tab 所有页签共用一个挂载实例：切页签不丢未保存的输入与进行中的弹窗，与改路由前一致。 */
export default function SettingsPage() {
  const shell = useShellContext();
  return (
    <SettingsView
      isConnected={shell.isConnected}
      settingsTab={shell.settingsTab}
      onMenuClick={shell.openMobileMenu}
      onModelsChanged={shell.reloadModels}
      onAgentsChanged={shell.reloadSessions}
    />
  );
}
