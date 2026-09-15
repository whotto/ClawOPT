import type { ViewType } from '../routeState';
import type { SidebarFavoriteType, SidebarFavorites, SidebarListTab } from './sidebarTypes';

export const SIDEBAR_FAVORITES_STORAGE_KEY = 'clawopt_sidebar_favorites';
export const SIDEBAR_LIST_TAB_STORAGE_KEY = 'clawopt_sidebar_list_tab';

export function readSidebarListTab(currentView: ViewType): SidebarListTab {
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(SIDEBAR_LIST_TAB_STORAGE_KEY);
      if (raw === 'agents' || raw === 'groups' || raw === 'favorites') {
        return raw;
      }
    } catch {}
  }

  return currentView === 'groups' ? 'groups' : 'agents';
}

export function makeSidebarFavoriteKey(type: SidebarFavoriteType, id: string): string {
  return `${type}:${id}`;
}

export function parseSidebarFavoriteKey(value: string): { type: SidebarFavoriteType; id: string } | null {
  if (!value.startsWith('agents:') && !value.startsWith('groups:')) return null;
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) return null;

  const type = value.slice(0, separatorIndex) as SidebarFavoriteType;
  const id = value.slice(separatorIndex + 1);
  return id ? { type, id } : null;
}

export function readSidebarFavorites(): SidebarFavorites {
  if (typeof window === 'undefined') {
    return { agents: [], groups: [], order: [] };
  }

  try {
    const raw = localStorage.getItem(SIDEBAR_FAVORITES_STORAGE_KEY);
    if (!raw) return { agents: [], groups: [], order: [] };
    const parsed = JSON.parse(raw);
    const normalizeStoredStringArray = (value: unknown): string[] => (
      Array.isArray(value)
        ? Array.from(new Set(value.filter((entry: unknown): entry is string => typeof entry === 'string')))
        : []
    );
    const agents = normalizeStoredStringArray(parsed?.agents);
    const groups = normalizeStoredStringArray(parsed?.groups);
    const fallbackOrder = [
      ...agents.map((id) => makeSidebarFavoriteKey('agents', id)),
      ...groups.map((id) => makeSidebarFavoriteKey('groups', id)),
    ];
    const allowedKeys = new Set(fallbackOrder);
    const parsedOrder = normalizeStoredStringArray(parsed?.order).filter((value) => allowedKeys.has(value));

    return {
      agents,
      groups,
      order: [
        ...parsedOrder,
        ...fallbackOrder.filter((key) => !parsedOrder.includes(key)),
      ],
    };
  } catch {
    return { agents: [], groups: [], order: [] };
  }
}

export function normalizeSidebarFavorites(value: unknown): SidebarFavorites {
  const normalizeStoredStringArray = (input: unknown): string[] => (
    Array.isArray(input)
      ? Array.from(new Set(input.filter((entry: unknown): entry is string => typeof entry === 'string')))
      : []
  );

  const agents = normalizeStoredStringArray((value as { agents?: unknown } | null | undefined)?.agents);
  const groups = normalizeStoredStringArray((value as { groups?: unknown } | null | undefined)?.groups);
  const fallbackOrder = [
    ...agents.map((id) => makeSidebarFavoriteKey('agents', id)),
    ...groups.map((id) => makeSidebarFavoriteKey('groups', id)),
  ];
  const allowedKeys = new Set(fallbackOrder);
  const order = normalizeStoredStringArray((value as { order?: unknown } | null | undefined)?.order)
    .filter((entry) => allowedKeys.has(entry));

  return {
    agents,
    groups,
    order: [
      ...order,
      ...fallbackOrder.filter((entry) => !order.includes(entry)),
    ],
  };
}

/** 收藏 / 取消收藏：取消时从排序里移除，收藏时追加到末尾。 */
export function toggleSidebarFavorite(prev: SidebarFavorites, type: SidebarFavoriteType, id: string): SidebarFavorites {
  const current = prev[type];
  const favoriteKey = makeSidebarFavoriteKey(type, id);
  const isRemoving = current.includes(id);
  const nextItems = isRemoving
    ? current.filter((itemId) => itemId !== id)
    : [...current, id];
  return {
    ...prev,
    [type]: nextItems,
    order: isRemoving
      ? prev.order.filter((key) => key !== favoriteKey)
      : [...prev.order.filter((key) => key !== favoriteKey), favoriteKey],
  };
}

/**
 * 去掉已不存在的会话 / 群的收藏并补齐排序。没有变化时返回原对象（引用不变，避免触发保存）。
 */
export function pruneSidebarFavorites(
  prev: SidebarFavorites,
  sessions: { id: string }[],
  groups: { id: string }[],
): SidebarFavorites {
  const nextAgents = prev.agents.filter((id) => sessions.some((session) => session.id === id));
  const nextGroups = prev.groups.filter((id) => groups.some((group) => group.id === id));
  const allowedKeys = new Set([
    ...nextAgents.map((id) => makeSidebarFavoriteKey('agents', id)),
    ...nextGroups.map((id) => makeSidebarFavoriteKey('groups', id)),
  ]);
  const nextOrder = [
    ...prev.order.filter((key) => allowedKeys.has(key)),
    ...Array.from(allowedKeys).filter((key) => !prev.order.includes(key)),
  ];

  if (
    nextAgents.length === prev.agents.length
    && nextGroups.length === prev.groups.length
    && nextOrder.length === prev.order.length
    && nextOrder.every((key, index) => key === prev.order[index])
  ) {
    return prev;
  }

  return {
    agents: nextAgents,
    groups: nextGroups,
    order: nextOrder,
  };
}

/**
 * 收藏回写服务端的判据：只有和服务端最后一次确认的值**不同**才写。
 * 之前是「状态一变就写」：挂载读到服务端的值、清理一次什么都没删掉，都会原样 POST 回去——
 * 每次打开页面多出好几次写配置。与全局故障转移同一类「加载即写」，同样按值判。
 */
export function createFavoritesSync(save: (favorites: SidebarFavorites) => void) {
  let confirmed: string | null = null;
  return {
    /** 服务端给出的值（挂载读取）：记为已确认，不写。 */
    synced(favorites: SidebarFavorites): void {
      confirmed = JSON.stringify(favorites);
    },
    /** 本地状态变化：还没与服务端对齐时不写；与已确认值相同时不写；否则写并记为已确认。 */
    changed(favorites: SidebarFavorites): boolean {
      if (confirmed === null) return false;
      const next = JSON.stringify(favorites);
      if (next === confirmed) return false;
      confirmed = next;
      save(favorites);
      return true;
    },
  };
}
