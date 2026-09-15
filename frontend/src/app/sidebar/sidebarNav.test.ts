import { describe, expect, it } from 'vitest';
import { SETTINGS_TABS } from '../routeState';
import { navItemsMissingFromRoutes, SETTINGS_NAV_ITEMS, SETTINGS_NAV_ZONES } from './sidebarNav';

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
