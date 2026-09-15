/**
 * 界面能力清单：`GET /api/auth/me` 按角色在服务端算出来交给前端，前端据此显示侧栏分区、页签与按钮，
 * **不在客户端硬编码「哪个角色能看哪个页签」**。它只决定「给不给入口」，真正的授权永远在路由闸门与
 * `resource-access.ts`——所以每条规则可以带一条代表路由，`test/capabilities.test.ts` 对照路由登记表校验
 * 「给了入口的角色，代表路由的闸门确实放行；没给入口的，闸门确实拦」，两边分家会红。
 *
 * 能力 id：
 * - `settings.<页签>`：设置区页签（与前端 `SETTINGS_TABS` 同名）；
 * - `automation.<页面>`：自动化区页面；
 * - `<资源>.manage`：页面里的管理按钮（新建 / 编辑 / 删除等）。
 */
import { roleAtLeast, type AuthRole } from './user-store';

export type CapabilityRule = {
  id: string;
  /** 拥有这个能力的最低角色。 */
  minRole: AuthRole;
  /** 代表路由（`方法 路径`，与登记表同形）：minRole 为 member 时它不能是 adminOnly，否则必须是。 */
  route?: string;
};

export const CAPABILITY_RULES: readonly CapabilityRule[] = [
  // 团队
  { id: 'settings.agents', minRole: 'member', route: 'GET /api/engine/agents' },
  { id: 'settings.presets', minRole: 'admin', route: 'POST /api/presets/:presetId/install' },
  { id: 'settings.skills', minRole: 'admin', route: 'POST /api/skills/install' },
  { id: 'settings.mcp', minRole: 'admin', route: 'PUT /api/mcp/servers/:name' },
  // Agent 运行时管理（安装 / 升级 / 原生配置 / MCP / 运行时目录）：全部管理员。
  { id: 'settings.runtimes', minRole: 'admin', route: 'GET /api/runtime/runtimes' },
  // 自动化
  { id: 'settings.cron', minRole: 'admin', route: 'POST /api/cron/jobs' },
  { id: 'automation.workflows', minRole: 'member', route: 'GET /api/workflows' },
  { id: 'automation.kanban', minRole: 'member', route: 'GET /api/kanban/boards/:boardId/tasks' },
  { id: 'automation.webhooks', minRole: 'admin', route: 'GET /api/webhooks/endpoints' },
  // 系统
  { id: 'settings.gateway', minRole: 'admin', route: 'POST /api/config/restart' },
  { id: 'settings.models', minRole: 'admin', route: 'PUT /api/models/fallbacks' },
  { id: 'settings.channels', minRole: 'admin', route: 'POST /api/channels' },
  { id: 'settings.plugins', minRole: 'admin', route: 'POST /api/plugins/:id/enable' },
  // 用户页：admin 能解锁登录 IP；用户列表与增删改只给 super_admin（users.manage）。
  { id: 'settings.users', minRole: 'admin', route: 'GET /api/auth/locked-ips' },
  { id: 'settings.usage', minRole: 'admin', route: 'GET /api/usage/summary' },
  { id: 'settings.logs', minRole: 'admin', route: 'GET /api/logs' },
  { id: 'settings.general', minRole: 'admin', route: 'POST /api/config' },
  { id: 'settings.commands', minRole: 'admin', route: 'POST /api/commands' },
  { id: 'settings.about', minRole: 'member' },
  // 页面内的管理动作
  { id: 'agents.manage', minRole: 'admin', route: 'POST /api/sessions' },
  { id: 'users.manage', minRole: 'super_admin', route: 'GET /api/users' },
  { id: 'workflows.manage', minRole: 'admin', route: 'POST /api/workflows' },
  { id: 'kanban.manage', minRole: 'admin', route: 'POST /api/kanban/boards' },
];

/** 角色 → 能力 id（按规则表顺序）。 */
export function capabilitiesForRole(role: AuthRole): string[] {
  return CAPABILITY_RULES.filter((rule) => roleAtLeast(role, rule.minRole)).map((rule) => rule.id);
}
