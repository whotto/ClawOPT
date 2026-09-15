import { Bot, Boxes, Cpu, Info, Network, Settings, Terminal, type LucideIcon } from 'lucide-react';
import type { SettingsTab } from '../routeState';

/**
 * 导航分区。规划中的四区是 工作台 / 团队 / 自动化 / 系统；
 * 目前只有「团队」（角色预设库）和「系统」有真实页面，所以侧栏仍按原顺序平铺、不渲染分区标题。
 * 等某个分区有了真实入口，再按 zone 分组渲染标题——不要为还不存在的页面加条目。
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
  { tab: 'runtimes', icon: Bot, labelKey: 'sidebar.runtimesManage', zone: 'team' },
  { tab: 'commands', icon: Terminal, labelKey: 'sidebar.quickCommands', zone: 'system' },
  { tab: 'about', icon: Info, labelKey: 'sidebar.about', zone: 'system' },
];
