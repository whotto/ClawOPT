// URL ↔ 视图状态的纯函数。路由表（routes.tsx）与壳层（AppShell）共用这里的判据，
// 不在组件里各拼各的路径。
//
// 用 history 路由而不是 hash：后端 `app.get('*')` 已对非 /api、/uploads、/openclaw、/assets
// 的 GET 回 index.html，vite dev / preview 默认也有 SPA 回退。旧版 `#settings/models`
// 这类书签由 legacyHashToPath 一次性换成新路径。

export type ViewType = 'chat' | 'settings' | 'groups' | 'automation';
// P5a 起设置页签分三区（团队 / 自动化 / 系统），控制面页面也挂在 `/settings/:tab` 下：
// 共用同一个壳层与侧栏，深链形状不变，老书签照常可用。
// P2：团队区的「Agent 运行时」页挂在 `/settings/runtimes`（每运行时配置页用查询串 `?runtime=<id>`，不改路径形状）。
export type SettingsTab =
  | 'gateway' | 'general' | 'models' | 'presets' | 'commands' | 'about'
  | 'agents' | 'skills' | 'mcp' | 'runtimes' | 'users'
  | 'cron'
  | 'channels' | 'plugins' | 'usage' | 'logs'
  // P6：团队区的记忆与成长轨迹；系统区的性能、文件、终端、语音、ClawOPT MCP 服务、主题。
  | 'memory' | 'journey'
  | 'performance' | 'files' | 'terminal' | 'voice' | 'mcpserver' | 'theme';
/** 自动化区的页面：`/automation/workflows[/:id]`、`/automation/kanban`、`/automation/webhooks`。 */
export type AutomationSection = 'workflows' | 'kanban' | 'webhooks';

export const AUTOMATION_SECTIONS: readonly AutomationSection[] = ['workflows', 'kanban', 'webhooks'];
const DEFAULT_AUTOMATION_SECTION: AutomationSection = 'workflows';

function isAutomationSection(value: unknown): value is AutomationSection {
  return typeof value === 'string' && (AUTOMATION_SECTIONS as readonly string[]).includes(value);
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  'gateway', 'general', 'models', 'presets', 'commands', 'about',
  'agents', 'skills', 'mcp', 'runtimes', 'users',
  'cron',
  'channels', 'plugins', 'usage', 'logs',
  'memory', 'journey',
  'performance', 'files', 'terminal', 'voice', 'mcpserver', 'theme',
];
const DEFAULT_SETTINGS_TAB: SettingsTab = 'gateway';

export const LOGIN_PATH = '/login';

function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value);
}

/** 从地址栏读出的原始意图；缺省段为 null，由 resolveRouteState 用当前或记忆状态补齐。 */
type ParsedAppPath =
  | { view: 'chat'; sessionId: string | null }
  | { view: 'groups'; groupId: string | null }
  | { view: 'settings'; tab: SettingsTab | null }
  | { view: 'automation'; section: AutomationSection | null; workflowId: string | null };

export type AppRouteState = {
  view: ViewType;
  settingsTab: SettingsTab;
  sessionId: string;
  groupId: string | null;
  /** 自动化区当前页；不在自动化区时保留上次的值，回来时补齐缺段用。 */
  automationSection?: AutomationSection;
  /** 工作流画布上选中的工作流（仅 `workflows` 页）。 */
  workflowId?: string | null;
};

function decodeSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded || null;
  } catch {
    return null;
  }
}

/** `/chat/:sessionId?`、`/groups/:groupId?`、`/settings/:tab?`、`/automation/:section?/:workflowId?`；其余（含 `/`）返回 null。 */
export function parseAppPath(pathname: string): ParsedAppPath | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] === 'automation') {
    if (segments.length > 3) return null;
    const section = decodeSegment(segments[1]);
    if (segments.length === 3 && section !== 'workflows') return null;
    return {
      view: 'automation',
      section: isAutomationSection(section) ? section : null,
      workflowId: section === 'workflows' ? decodeSegment(segments[2]) : null,
    };
  }
  if (segments.length === 0 || segments.length > 2) return null;
  const [head, param] = segments;
  if (head === 'chat') return { view: 'chat', sessionId: decodeSegment(param) };
  if (head === 'groups') return { view: 'groups', groupId: decodeSegment(param) };
  if (head === 'settings') {
    const tab = decodeSegment(param);
    return { view: 'settings', tab: isSettingsTab(tab) ? tab : null };
  }
  return null;
}

export function formatAppPath(state: AppRouteState): string {
  if (state.view === 'settings') return `/settings/${state.settingsTab}`;
  if (state.view === 'automation') {
    const section = state.automationSection ?? DEFAULT_AUTOMATION_SECTION;
    return section === 'workflows' && state.workflowId
      ? `/automation/workflows/${encodeURIComponent(state.workflowId)}`
      : `/automation/${section}`;
  }
  if (state.view === 'groups') return state.groupId ? `/groups/${encodeURIComponent(state.groupId)}` : '/groups';
  return state.sessionId ? `/chat/${encodeURIComponent(state.sessionId)}` : '/chat';
}

/**
 * 地址栏意图 + 兜底状态 → 完整视图状态。地址栏里有的段一律以地址栏为准；
 * 没有的段取兜底（首屏是 localStorage 记忆，之后是当前状态）。
 * 非设置页的 settingsTab 归位为 gateway，与改路由前的 hash 解析一致。
 */
export function resolveRouteState(parsed: ParsedAppPath | null, fallback: AppRouteState): AppRouteState {
  if (!parsed) {
    return {
      view: fallback.view,
      settingsTab: fallback.view === 'settings' ? fallback.settingsTab : DEFAULT_SETTINGS_TAB,
      sessionId: fallback.sessionId,
      groupId: fallback.groupId,
    };
  }
  if (parsed.view === 'settings') {
    return { ...fallback, view: 'settings', settingsTab: parsed.tab ?? DEFAULT_SETTINGS_TAB };
  }
  if (parsed.view === 'automation') {
    const section = parsed.section ?? fallback.automationSection ?? DEFAULT_AUTOMATION_SECTION;
    const workflowId = section !== 'workflows' ? null : parsed.section ? parsed.workflowId : (fallback.workflowId ?? null);
    return { ...fallback, view: 'automation', settingsTab: DEFAULT_SETTINGS_TAB, automationSection: section, workflowId };
  }
  if (parsed.view === 'groups') {
    return { ...fallback, view: 'groups', settingsTab: DEFAULT_SETTINGS_TAB, groupId: parsed.groupId ?? fallback.groupId };
  }
  return { ...fallback, view: 'chat', settingsTab: DEFAULT_SETTINGS_TAB, sessionId: parsed.sessionId ?? fallback.sessionId };
}

/**
 * 状态变化写回地址栏时用 push 还是 replace。
 * 只有「换了页面 / 换了设置页签 / 从一个会话切到另一个会话」才留历史；
 * 补齐缺省段（`/` → `/chat/x`、`/settings/bad` → `/settings/gateway`）、
 * 以及选中项经过空值的过渡（重置会话时先置空再选回）都用 replace，免得后退键卡在中间态。
 */
export function shouldReplaceHistory(current: ParsedAppPath | null, next: AppRouteState): boolean {
  if (!current || current.view !== next.view) return !current;
  if (current.view === 'settings') return current.tab === null;
  if (current.view === 'automation') {
    if (current.section === null) return true;
    return current.section === next.automationSection && current.workflowId !== null && !next.workflowId;
  }
  if (current.view === 'groups') return !current.groupId || !next.groupId;
  return !current.sessionId || !next.sessionId;
}

/** 旧 hash 地址（`#chat`、`#groups`、`#group/<id>`、`#settings`、`#settings/<tab>`）→ 新路径；认不出返回 null。 */
export function legacyHashToPath(hash: string): string | null {
  const value = hash.replace(/^#/, '');
  if (!value) return null;
  if (value === 'chat') return '/chat';
  if (value === 'groups') return '/groups';
  if (value === 'settings') return `/settings/${DEFAULT_SETTINGS_TAB}`;
  const [head, param] = value.split('/');
  if (head === 'group' && param) return `/groups/${param}`;
  if (head === 'settings' && param) return `/settings/${param}`;
  return null;
}

// ---- 能力清单（`GET /api/auth/me` 的 `capabilities`，服务端按角色算） ----

/** 已加载的能力 id；null = 还没拿到，不做任何纠偏。 */
export type RouteCapabilities = ReadonlySet<string> | null;

export const settingsTabCapability = (tab: SettingsTab) => `settings.${tab}`;
export const automationSectionCapability = (section: AutomationSection) => `automation.${section}`;

/**
 * 按能力清单纠偏视图状态：进了没有入口的设置页签 / 自动化页面，换到第一个有入口的
 * （`tabOrder` 传侧栏的显示顺序）；整个区一个入口都没有就回对话。能力未加载时原样返回。
 * 这里只管「给不给入口」；真正的授权在后端，越权请求照样 403。
 */
export function enforceRouteCapabilities(
  state: AppRouteState,
  capabilities: RouteCapabilities,
  tabOrder: readonly SettingsTab[] = SETTINGS_TABS,
): AppRouteState {
  if (!capabilities) return state;
  if (state.view === 'settings' && !capabilities.has(settingsTabCapability(state.settingsTab))) {
    const firstTab = tabOrder.find((tab) => capabilities.has(settingsTabCapability(tab)));
    return firstTab ? { ...state, settingsTab: firstTab } : { ...state, view: 'chat', settingsTab: DEFAULT_SETTINGS_TAB };
  }
  if (state.view === 'automation') {
    const section = state.automationSection ?? DEFAULT_AUTOMATION_SECTION;
    if (capabilities.has(automationSectionCapability(section))) return state;
    const firstSection = AUTOMATION_SECTIONS.find((item) => capabilities.has(automationSectionCapability(item)));
    return firstSection
      ? { ...state, automationSection: firstSection, workflowId: null }
      : { ...state, view: 'chat' };
  }
  return state;
}

// ---- localStorage 记忆（键名沿用改路由前，老用户的上次选择继续生效） ----

export const NAV_STORAGE_KEYS = {
  currentView: 'clawopt_current_view',
  settingsTab: 'clawopt_settings_tab',
  activeSession: 'clawopt_active_session',
  activeGroup: 'clawopt_active_group',
  lastConversationView: 'clawopt_last_conversation_view',
  automationSection: 'clawopt_automation_section',
  activeWorkflow: 'clawopt_active_workflow',
} as const;

type StoredNavSelection = {
  view: string | null;
  settingsTab: string | null;
  sessionId: string | null;
  groupId: string | null;
  automationSection?: string | null;
  workflowId?: string | null;
};

export function storedSelectionToState(stored: StoredNavSelection): AppRouteState {
  return {
    view: stored.view === 'settings' || stored.view === 'groups' || stored.view === 'automation' ? stored.view : 'chat',
    settingsTab: isSettingsTab(stored.settingsTab) ? stored.settingsTab : DEFAULT_SETTINGS_TAB,
    sessionId: stored.sessionId || '',
    groupId: stored.groupId || null,
    automationSection: isAutomationSection(stored.automationSection) ? stored.automationSection : DEFAULT_AUTOMATION_SECTION,
    workflowId: stored.workflowId || null,
  };
}
