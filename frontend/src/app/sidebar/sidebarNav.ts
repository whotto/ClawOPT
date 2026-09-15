import { Boxes, Cpu, Info, SquareKanban, Network, Settings, Terminal, Webhook, Workflow, type LucideIcon } from 'lucide-react';
import type { AutomationSection, SettingsTab } from '../routeState';

/**
 * 导航分区。规划中的四区是 工作台 / 团队 / 自动化 / 系统；
 * 设置模式下侧栏仍按原顺序平铺、不渲染分区标题；「自动化」有了真实页面（P4a），
 * 在自动化模式下单独渲染分区标题与条目（`AUTOMATION_NAV_ITEMS`）——不要为还不存在的页面加条目。
 */
type SidebarNavZone = 'workspace' | 'team' | 'automation' | 'system';

type SettingsNavItem = {
  tab: SettingsTab;
  icon: LucideIcon;
  labelKey: string;
  zone: SidebarNavZone;
};

/** 设置模式下侧栏的入口，顺序即显示顺序。 */
export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  { tab: 'gateway', icon: Network, labelKey: 'sidebar.gatewaySettings', zone: 'system' },
  { tab: 'general', icon: Settings, labelKey: 'sidebar.generalSettings', zone: 'system' },
  { tab: 'models', icon: Cpu, labelKey: 'sidebar.modelsManage', zone: 'system' },
  { tab: 'presets', icon: Boxes, labelKey: 'sidebar.presetLibrary', zone: 'team' },
  { tab: 'commands', icon: Terminal, labelKey: 'sidebar.quickCommands', zone: 'system' },
  { tab: 'about', icon: Info, labelKey: 'sidebar.about', zone: 'system' },
];

type AutomationNavItem = {
  section: AutomationSection;
  icon: LucideIcon;
  labelKey: string;
  zone: SidebarNavZone;
};

/** 自动化模式下侧栏的入口，顺序即显示顺序。每一项都对应真实路由 `/automation/<section>`。 */
export const AUTOMATION_NAV_ITEMS: readonly AutomationNavItem[] = [
  { section: 'workflows', icon: Workflow, labelKey: 'automation.nav.workflows', zone: 'automation' },
  { section: 'kanban', icon: SquareKanban, labelKey: 'automation.nav.kanban', zone: 'automation' },
  { section: 'webhooks', icon: Webhook, labelKey: 'automation.nav.webhooks', zone: 'automation' },
];
