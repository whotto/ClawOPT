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
  SquareKanban,
  Terminal,
  TerminalSquare,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import {
  SETTINGS_TABS,
  automationSectionCapability,
  settingsTabCapability,
  type AutomationSection,
  type RouteCapabilities,
  type SettingsTab,
} from '../routeState';

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
  { tab: 'runtimes', icon: TerminalSquare, labelKey: 'sidebar.runtimesManage', zone: 'team' },
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

/** 侧栏里的设置页签顺序（路由纠偏「第一个有入口的页签」按它取）。 */
export const SETTINGS_NAV_TAB_ORDER: readonly SettingsTab[] = SETTINGS_NAV_ITEMS.map((item) => item.tab);

/** 按服务端给的能力清单挑出有入口的设置页签；分区里一个都没有就整个分区不画。能力未加载时什么都不画。 */
export function visibleSettingsNav(capabilities: RouteCapabilities): { zone: SidebarNavZone; labelKey: string; items: SettingsNavItem[] }[] {
  if (!capabilities) return [];
  return SETTINGS_NAV_ZONES
    .map(({ zone, labelKey }) => ({ zone, labelKey, items: SETTINGS_NAV_ITEMS.filter((item) => item.zone === zone && capabilities.has(settingsTabCapability(item.tab))) }))
    .filter((group) => group.items.length > 0);
}

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

/** 按能力清单挑出有入口的自动化页面；能力未加载时为空。 */
export function visibleAutomationNav(capabilities: RouteCapabilities): AutomationNavItem[] {
  if (!capabilities) return [];
  return AUTOMATION_NAV_ITEMS.filter((item) => capabilities.has(automationSectionCapability(item.section)));
}
