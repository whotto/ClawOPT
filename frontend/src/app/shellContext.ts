import { useOutletContext } from 'react-router-dom';
import type { AutomationSection, SettingsTab } from './routeState';
import type { SessionSummary } from './useSessions';

/** 壳层交给页面的状态与动作。页面不直接读地址栏，统一从这里拿已经与地址栏对齐的状态。 */
export type ShellContext = {
  isConnected: boolean;
  sessions: SessionSummary[];
  availableModels: any[];
  activeSessionId: string;
  activeGroupId: string | null;
  settingsTab: SettingsTab;
  automationSection: AutomationSection;
  activeWorkflowId: string | null;
  openAutomation: (section: AutomationSection, workflowId?: string | null) => void;
  openMobileMenu: () => void;
  selectGroup: (id: string) => void;
  reloadModels: () => Promise<void>;
  reloadSessions: () => Promise<void>;
};

export function useShellContext(): ShellContext {
  return useOutletContext<ShellContext>();
}
