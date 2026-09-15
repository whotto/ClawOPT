import {
  Activity,
  Blocks,
  Bot,
  Boxes,
  CalendarClock,
  Cpu,
  Info,
  MessagesSquare,
  Network,
  Plug,
  ScrollText,
  Settings,
  Sparkles,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { SETTINGS_TABS, type SettingsTab } from '../routeState';

/**
 * 导航分区：团队 / 自动化 / 系统（工作台就是对话本身，不在设置侧栏里）。
 * 分区按下面的顺序渲染标题；每个页签只属于一个分区。
 */
export type SidebarNavZone = 'team' | 'automation' | 'system';

export type SettingsNavItem = {
  tab: SettingsTab;
  icon: LucideIcon;
  labelKey: string;
  zone: SidebarNavZone;
};

export const SETTINGS_NAV_ZONES: readonly { zone: SidebarNavZone; labelKey: string }[] = [
  { zone: 'team', labelKey: 'sidebar.zoneTeam' },
  { zone: 'automation', labelKey: 'sidebar.zoneAutomation' },
  { zone: 'system', labelKey: 'sidebar.zoneSystem' },
];

/** 设置模式下侧栏的入口，分区内顺序即显示顺序。 */
export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  { tab: 'agents', icon: Bot, labelKey: 'sidebar.agentsManage', zone: 'team' },
  { tab: 'presets', icon: Boxes, labelKey: 'sidebar.presetLibrary', zone: 'team' },
  { tab: 'skills', icon: Sparkles, labelKey: 'sidebar.skills', zone: 'team' },
  { tab: 'mcp', icon: Plug, labelKey: 'sidebar.mcp', zone: 'team' },
  { tab: 'cron', icon: CalendarClock, labelKey: 'sidebar.cron', zone: 'automation' },
  { tab: 'gateway', icon: Network, labelKey: 'sidebar.gatewaySettings', zone: 'system' },
  { tab: 'models', icon: Cpu, labelKey: 'sidebar.modelsManage', zone: 'system' },
  { tab: 'channels', icon: MessagesSquare, labelKey: 'sidebar.channels', zone: 'system' },
  { tab: 'plugins', icon: Blocks, labelKey: 'sidebar.plugins', zone: 'system' },
  { tab: 'users', icon: Users, labelKey: 'sidebar.users', zone: 'system' },
  { tab: 'usage', icon: Activity, labelKey: 'sidebar.usage', zone: 'system' },
  { tab: 'logs', icon: ScrollText, labelKey: 'sidebar.logs', zone: 'system' },
  { tab: 'general', icon: Settings, labelKey: 'sidebar.generalSettings', zone: 'system' },
  { tab: 'commands', icon: Terminal, labelKey: 'sidebar.quickCommands', zone: 'system' },
  { tab: 'about', icon: Info, labelKey: 'sidebar.about', zone: 'system' },
];

/** 路由表里有、侧栏里没有的页签（应为空，由 sidebarNav.test.ts 校验）。 */
export function navItemsMissingFromRoutes(): SettingsTab[] {
  const listed = new Set(SETTINGS_NAV_ITEMS.map((item) => item.tab));
  return SETTINGS_TABS.filter((tab) => !listed.has(tab));
}
