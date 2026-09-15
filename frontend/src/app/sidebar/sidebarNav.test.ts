import { describe, expect, it } from 'vitest';
import { SETTINGS_TABS } from '../routeState';
import { navItemsMissingFromRoutes, SETTINGS_NAV_ITEMS, SETTINGS_NAV_ZONES, visibleAutomationNav, visibleSettingsNav } from './sidebarNav';

describe('设置侧栏导航', () => {
  it('每个路由页签都有侧栏入口，且不重复', () => {
    expect(navItemsMissingFromRoutes()).toEqual([]);
    const tabs = SETTINGS_NAV_ITEMS.map((item) => item.tab);
    expect(new Set(tabs).size).toBe(tabs.length);
    expect(tabs.every((tab) => SETTINGS_TABS.includes(tab))).toBe(true);
  });

  it('每个分区都有真实入口（不为不存在的页面画标题）', () => {
    for (const { zone } of SETTINGS_NAV_ZONES) {
      expect(SETTINGS_NAV_ITEMS.some((item) => item.zone === zone), zone).toBe(true);
    }
  });
});

describe('按能力清单显示入口', () => {
  // 与后端 capabilitiesForRole('member') 同形的清单：前端只认清单，不认角色。
  const member = new Set(['settings.agents', 'automation.workflows', 'automation.kanban', 'settings.about']);

  it('member：团队区只有 Agents、系统区只有关于；自动化区（设置侧栏里的 cron）整个不画', () => {
    const zones = visibleSettingsNav(member);
    expect(zones.map((group) => [group.zone, group.items.map((item) => item.tab)])).toEqual([
      ['team', ['agents']],
      ['system', ['about']],
    ]);
    expect(visibleAutomationNav(member).map((item) => item.section)).toEqual(['workflows', 'kanban']);
  });

  it('Agent 运行时管理（/settings/runtimes）在团队区、紧跟 MCP；只有带 settings.runtimes 能力（admin 及以上）才画，member 不画', () => {
    const admin = new Set([...member, 'settings.presets', 'settings.skills', 'settings.mcp', 'settings.runtimes']);
    expect(visibleSettingsNav(admin)[0]).toMatchObject({ zone: 'team' });
    expect(visibleSettingsNav(admin)[0].items.map((item) => item.tab)).toEqual(['agents', 'presets', 'skills', 'mcp', 'runtimes']);
    expect(visibleSettingsNav(member).flatMap((group) => group.items).some((item) => item.tab === 'runtimes')).toBe(false);
    expect(visibleSettingsNav(new Set([...admin].filter((id) => id !== 'settings.runtimes')))[0].items.map((item) => item.tab)).not.toContain('runtimes');
  });

  it('全部能力：与完整导航一致；能力未加载：什么都不画', () => {
    const all = new Set([...SETTINGS_TABS.map((tab) => `settings.${tab}`), 'automation.workflows', 'automation.kanban', 'automation.webhooks']);
    expect(visibleSettingsNav(all).flatMap((group) => group.items)).toEqual(SETTINGS_NAV_ITEMS);
    expect(visibleAutomationNav(all)).toHaveLength(3);
    expect(visibleSettingsNav(null)).toEqual([]);
    expect(visibleAutomationNav(null)).toEqual([]);
  });
});
