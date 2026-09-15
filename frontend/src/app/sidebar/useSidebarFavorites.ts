import { useEffect, useState } from 'react';
import { getSidebarFavorites, saveSidebarFavorites } from '../../api/sidebar';
import type { ViewType } from '../routeState';
import {
  SIDEBAR_FAVORITES_STORAGE_KEY,
  SIDEBAR_LIST_TAB_STORAGE_KEY,
  normalizeSidebarFavorites,
  pruneSidebarFavorites,
  readSidebarFavorites,
  readSidebarListTab,
  toggleSidebarFavorite,
} from './sidebarFavorites';
import type { SidebarFavoriteType, SidebarFavorites, SidebarListTab } from './sidebarTypes';

/** 侧栏列表页签（智能体 / 工作群 / 收藏），记在 localStorage。 */
export function useSidebarListTab(currentView: ViewType) {
  const [sidebarListTab, setSidebarListTab] = useState<SidebarListTab>(() => readSidebarListTab(currentView));

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_LIST_TAB_STORAGE_KEY, sidebarListTab);
    } catch {}
  }, [sidebarListTab]);

  return { sidebarListTab, setSidebarListTab };
}

/**
 * 收藏：localStorage 先行，挂载后与服务端对齐（服务端为空而本地有时把本地推上去），
 * 对齐完成后每次变化都回写服务端。
 */
export function useSidebarFavorites() {
  const [sidebarFavorites, setSidebarFavorites] = useState<SidebarFavorites>(() => readSidebarFavorites());
  const [sidebarFavoritesLoaded, setSidebarFavoritesLoaded] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_FAVORITES_STORAGE_KEY, JSON.stringify(sidebarFavorites));
    } catch {}
  }, [sidebarFavorites]);

  useEffect(() => {
    let cancelled = false;

    const syncSidebarFavorites = async () => {
      const localFavorites = readSidebarFavorites();

      try {
        const response = await getSidebarFavorites();
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;

        const remoteFavorites = normalizeSidebarFavorites(data?.favorites);
        const hasRemoteFavorites = remoteFavorites.order.length > 0;
        const hasLocalFavorites = localFavorites.order.length > 0;

        if (!hasRemoteFavorites && hasLocalFavorites) {
          setSidebarFavorites(localFavorites);
          await saveSidebarFavorites(localFavorites).catch(() => {});
        } else {
          setSidebarFavorites(remoteFavorites);
        }
      } catch {
        if (!cancelled) {
          setSidebarFavorites(localFavorites);
        }
      } finally {
        if (!cancelled) {
          setSidebarFavoritesLoaded(true);
        }
      }
    };

    void syncSidebarFavorites();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sidebarFavoritesLoaded) return;

    void saveSidebarFavorites(sidebarFavorites).catch(() => {});
  }, [sidebarFavorites, sidebarFavoritesLoaded]);

  const isFavorite = (type: SidebarFavoriteType, id: string) => sidebarFavorites[type].includes(id);

  const toggleFavorite = (type: SidebarFavoriteType, id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setSidebarFavorites((prev) => toggleSidebarFavorite(prev, type, id));
  };

  const reorderFavorites = (nextOrder: string[]) => {
    setSidebarFavorites((prev) => ({
      ...prev,
      order: nextOrder,
    }));
  };

  return { sidebarFavorites, setSidebarFavorites, sidebarFavoritesLoaded, isFavorite, toggleFavorite, reorderFavorites };
}

/** 会话与群都加载完之后，清掉指向已删除对象的收藏。 */
export function usePruneSidebarFavorites(
  favorites: ReturnType<typeof useSidebarFavorites>,
  sessions: { id: string }[],
  sessionsLoaded: boolean,
  groups: { id: string }[],
  groupsLoaded: boolean,
) {
  const { sidebarFavoritesLoaded, setSidebarFavorites } = favorites;
  useEffect(() => {
    if (!sidebarFavoritesLoaded || !sessionsLoaded || !groupsLoaded) return;

    setSidebarFavorites((prev) => pruneSidebarFavorites(prev, sessions, groups));
  }, [groups, groupsLoaded, sessions, sessionsLoaded, sidebarFavoritesLoaded]);
}
