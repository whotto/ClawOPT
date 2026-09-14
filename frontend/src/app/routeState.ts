// URL ↔ 视图状态的纯函数。路由表（routes.tsx）与壳层（AppShell）共用这里的判据，
// 不在组件里各拼各的路径。
//
// 用 history 路由而不是 hash：后端 `app.get('*')` 已对非 /api、/uploads、/openclaw、/assets
// 的 GET 回 index.html，vite dev / preview 默认也有 SPA 回退。旧版 `#settings/models`
// 这类书签由 legacyHashToPath 一次性换成新路径。

export type ViewType = 'chat' | 'settings' | 'groups';
export type SettingsTab = 'gateway' | 'general' | 'models' | 'presets' | 'commands' | 'about';

export const SETTINGS_TABS: readonly SettingsTab[] = ['gateway', 'general', 'models', 'presets', 'commands', 'about'];
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'gateway';

export const LOGIN_PATH = '/login';

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value);
}

/** 从地址栏读出的原始意图；缺省段为 null，由 resolveRouteState 用当前或记忆状态补齐。 */
export type ParsedAppPath =
  | { view: 'chat'; sessionId: string | null }
  | { view: 'groups'; groupId: string | null }
  | { view: 'settings'; tab: SettingsTab | null };

export type AppRouteState = {
  view: ViewType;
  settingsTab: SettingsTab;
  sessionId: string;
  groupId: string | null;
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

/** `/chat/:sessionId?`、`/groups/:groupId?`、`/settings/:tab?`；其余（含 `/`）返回 null。 */
export function parseAppPath(pathname: string): ParsedAppPath | null {
  const segments = pathname.split('/').filter(Boolean);
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

// ---- localStorage 记忆（键名沿用改路由前，老用户的上次选择继续生效） ----

export const NAV_STORAGE_KEYS = {
  currentView: 'clawopt_current_view',
  settingsTab: 'clawopt_settings_tab',
  activeSession: 'clawopt_active_session',
  activeGroup: 'clawopt_active_group',
  lastConversationView: 'clawopt_last_conversation_view',
} as const;

export type StoredNavSelection = {
  view: string | null;
  settingsTab: string | null;
  sessionId: string | null;
  groupId: string | null;
};

export function storedSelectionToState(stored: StoredNavSelection): AppRouteState {
  return {
    view: stored.view === 'settings' || stored.view === 'groups' ? stored.view : 'chat',
    settingsTab: isSettingsTab(stored.settingsTab) ? stored.settingsTab : DEFAULT_SETTINGS_TAB,
    sessionId: stored.sessionId || '',
    groupId: stored.groupId || null,
  };
}
