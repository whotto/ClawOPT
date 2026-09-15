import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { requestActiveContextRefresh, type ActiveContextRefreshDetail } from '../utils/contextRefresh';
import {
  NAV_STORAGE_KEYS,
  formatAppPath,
  parseAppPath,
  resolveRouteState,
  shouldReplaceHistory,
  storedSelectionToState,
  type AppRouteState,
  type SettingsTab,
  type ViewType,
} from './routeState';

function readStoredRouteState(): AppRouteState {
  return storedSelectionToState({
    view: localStorage.getItem(NAV_STORAGE_KEYS.currentView),
    settingsTab: localStorage.getItem(NAV_STORAGE_KEYS.settingsTab),
    sessionId: localStorage.getItem(NAV_STORAGE_KEYS.activeSession),
    groupId: localStorage.getItem(NAV_STORAGE_KEYS.activeGroup),
  });
}

/**
 * 视图状态与地址栏双向同步。
 *
 * 状态仍是组件树的直接输入（与改路由前的 App 一致，子组件拿到的永远是一份自洽的状态）；
 * 地址栏变化（首屏、前进后退、手输地址）在渲染期就折算进状态，不会有一帧用旧状态渲染新页面；
 * 状态变化（侧栏点击等）在提交后写回地址栏。
 */
export function useAppNavigation() {
  const location = useLocation();
  const navigate = useNavigate();

  const [initial] = useState<AppRouteState>(() => resolveRouteState(parseAppPath(location.pathname), readStoredRouteState()));
  const [currentView, setCurrentView] = useState<ViewType>(initial.view);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initial.settingsTab);
  const [activeSessionId, setActiveSessionIdState] = useState<string>(initial.sessionId);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(initial.groupId);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [lastConversationView, setLastConversationView] = useState<'chat' | 'groups'>(() => {
    if (initial.view === 'chat' || initial.view === 'groups') {
      return initial.view;
    }
    const saved = localStorage.getItem(NAV_STORAGE_KEYS.lastConversationView);
    return saved === 'groups' ? 'groups' : 'chat';
  });
  const [pendingContextRefresh, setPendingContextRefresh] = useState<ActiveContextRefreshDetail | null>(null);

  // 地址栏 → 状态：渲染期折算（React 的「随 props 调整 state」写法）。
  const [syncedPathname, setSyncedPathname] = useState(location.pathname);
  if (syncedPathname !== location.pathname) {
    setSyncedPathname(location.pathname);
    const next = resolveRouteState(parseAppPath(location.pathname), {
      view: currentView,
      settingsTab,
      sessionId: activeSessionId,
      groupId: activeGroupId,
    });
    setCurrentView(next.view);
    setSettingsTab(next.settingsTab);
    setActiveSessionIdState(next.sessionId);
    if (next.groupId) setActiveGroupId(next.groupId);
    // 改路由前每次 hashchange 都会收起移动端菜单，这里保持一致。
    setIsMobileMenuOpen(false);
  }

  // 状态 → 地址栏。
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const autoSelectionRef = useRef(false);
  useEffect(() => {
    const state: AppRouteState = { view: currentView, settingsTab, sessionId: activeSessionId, groupId: activeGroupId };
    const desired = formatAppPath(state);
    const replace = autoSelectionRef.current || shouldReplaceHistory(parseAppPath(pathnameRef.current), state);
    autoSelectionRef.current = false;
    if (pathnameRef.current !== desired) {
      navigate(desired, { replace });
    }
    localStorage.setItem(NAV_STORAGE_KEYS.currentView, currentView);
    localStorage.setItem(NAV_STORAGE_KEYS.settingsTab, settingsTab);
  }, [currentView, settingsTab, activeSessionId, activeGroupId, navigate]);

  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem(NAV_STORAGE_KEYS.activeSession, activeSessionId);
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (activeGroupId) {
      localStorage.setItem(NAV_STORAGE_KEYS.activeGroup, activeGroupId);
    } else {
      localStorage.removeItem(NAV_STORAGE_KEYS.activeGroup);
    }
  }, [activeGroupId]);

  useEffect(() => {
    if (currentView !== 'chat' && currentView !== 'groups') return;
    setLastConversationView(currentView);
    localStorage.setItem(NAV_STORAGE_KEYS.lastConversationView, currentView);
  }, [currentView]);

  const setActiveSessionId = useCallback((id: string) => {
    setActiveSessionIdState(id);
  }, []);

  /** 会话列表加载后的自动纠偏（记忆的会话已不存在时选第一个）不进浏览历史。 */
  const autoSelectSession = useCallback((pick: (prev: string) => string) => {
    setActiveSessionIdState(prev => {
      const next = pick(prev);
      if (next !== prev) autoSelectionRef.current = true;
      return next;
    });
  }, []);

  const navigateTo = (view: ViewType, tab?: SettingsTab, openMenu?: boolean) => {
    const nextTab = tab || settingsTab;
    const nextOpen = openMenu !== undefined ? openMenu : isMobileMenuOpen;

    if (view !== currentView || nextTab !== settingsTab || nextOpen !== isMobileMenuOpen) {
      setCurrentView(view);
      if (tab) setSettingsTab(tab);
      setIsMobileMenuOpen(nextOpen);
    }
  };

  const openMobileMenu = () => navigateTo(currentView, settingsTab, true);

  const handleReturnToConversation = () => {
    const targetView = lastConversationView === 'groups' ? 'groups' : 'chat';
    const refreshDetail = targetView === 'groups'
      ? (activeGroupId ? { mode: 'group', id: activeGroupId } as const : null)
      : (activeSessionId ? { mode: 'chat', id: activeSessionId } as const : null);

    if (refreshDetail) {
      setPendingContextRefresh(refreshDetail);
    }

    navigateTo(targetView, settingsTab, false);
  };

  useEffect(() => {
    if (!pendingContextRefresh) return;

    const targetView = pendingContextRefresh.mode === 'group' ? 'groups' : 'chat';
    if (currentView !== targetView) return;

    const timer = window.setTimeout(() => {
      requestActiveContextRefresh(pendingContextRefresh);
      setPendingContextRefresh(null);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [currentView, pendingContextRefresh]);

  return {
    currentView,
    settingsTab,
    activeSessionId,
    setActiveSessionId,
    autoSelectSession,
    activeGroupId,
    setActiveGroupId,
    isMobileMenuOpen,
    navigateTo,
    openMobileMenu,
    handleReturnToConversation,
  };
}
