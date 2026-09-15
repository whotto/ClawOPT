/**
 * 界面能力清单（`GET /api/auth/me` 的 `capabilities`）：
 * 1. 按角色派生，三个角色的清单逐条钉住（改清单 = 改界面授权面，要显式改这里）；
 * 2. 与路由闸门不分家：每条规则的代表路由，minRole 为 member 的不能挂管理员闸门，其余必须挂；
 * 3. 前端设置页签与自动化页面一一有对应能力（前端只按清单显示，不自己判角色）；
 * 4. `/api/auth/me` 真的回清单（登录关闭时是隐式 super_admin，全部能力）。
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/bootstrap';
import { AUTH_COOKIE_NAME, CAPABILITY_RULES, capabilitiesForRole } from '../src/core/auth';
import { createStubContext } from './helpers/stub-context';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

describe('按角色派生', () => {
  it('member：自己的 Agent、关于、工作流、看板；没有任何管理动作', () => {
    expect(capabilitiesForRole('member')).toEqual(['settings.agents', 'automation.workflows', 'automation.kanban', 'settings.about']);
  });

  it('admin：除用户增删改外全部；super_admin：全部', () => {
    const all = CAPABILITY_RULES.map((rule) => rule.id);
    expect(capabilitiesForRole('admin')).toEqual(all.filter((id) => id !== 'users.manage'));
    expect(capabilitiesForRole('super_admin')).toEqual(all);
  });
});

describe('与路由闸门对照', () => {
  it('代表路由的闸门与能力的最低角色一致', () => {
    const records = buildApp(createStubContext()).routes.list().filter((record) => record.kind === 'route');
    const byLabel = new Map(records.map((record) => [`${record.method.toUpperCase()} ${record.path}`, record]));
    const mismatches: string[] = [];
    for (const rule of CAPABILITY_RULES) {
      if (!rule.route) continue;
      const record = byLabel.get(rule.route);
      if (!record) { mismatches.push(`${rule.id}: 代表路由 ${rule.route} 不存在`); continue; }
      const wantAdminOnly = rule.minRole !== 'member';
      if (record.adminOnly !== wantAdminOnly) mismatches.push(`${rule.id}: ${rule.route} adminOnly=${record.adminOnly}，能力要求 ${rule.minRole}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('前端的每个设置页签与自动化页面都有对应能力', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../frontend/src/app/routeState.ts'), 'utf8');
    const tabs = [...source.match(/export const SETTINGS_TABS[^=]*=\s*\[([^\]]*)\]/)![1].matchAll(/'([a-z]+)'/g)].map((match) => `settings.${match[1]}`);
    const sections = [...source.match(/const AUTOMATION_SECTIONS[^=]*=\s*\[([^\]]*)\]/)![1].matchAll(/'([a-z]+)'/g)].map((match) => `automation.${match[1]}`);
    const ids = new Set(CAPABILITY_RULES.map((rule) => rule.id));
    expect(tabs.length).toBeGreaterThan(10);
    expect([...tabs, ...sections].filter((id) => !ids.has(id))).toEqual([]);
  });
});

describe('GET /api/auth/me', () => {
  let h: AppHarness;
  beforeAll(async () => { h = await startAppHarness(); });
  afterAll(async () => { await h?.close(); });

  it('登录关闭：隐式 super_admin，全部能力；登录开启：按用户角色', async () => {
    const implicit = await (await fetch(`${h.baseUrl}/api/auth/me`)).json() as any;
    expect(implicit.user.capabilities).toEqual(capabilitiesForRole('super_admin'));

    const member = h.ctx.userStore.create({ username: 'member', password: 'member-pass-1234', role: 'member' });
    const token = h.ctx.authStore.issue('web', member.id).token;
    h.ctx.configManager.setConfig({ loginEnabled: true });
    const body = await (await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } })).json() as any;
    expect(body.user).toMatchObject({ role: 'member', capabilities: capabilitiesForRole('member') });
  });
});
