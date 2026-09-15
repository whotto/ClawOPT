import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { requestActiveContextRefresh, type ActiveContextRefreshDetail } from '../utils/contextRefresh';
import { SETTINGS_NAV_TAB_ORDER } from './sidebar/sidebarNav';
import {
  NAV_STORAGE_KEYS,
  enforceRouteCapabilities,
  formatAppPath,
  parseAppPath,
  resolveRouteState,
  shouldReplaceHistory,
  storedSelectionToState,
  type AppRouteState,
  type AutomationSection,
  type RouteCapabilities,
  type SettingsTab,
  type ViewType,
} from './routeState';

function readStoredRouteState(): AppRouteState {
  return storedSelectionToState({
    view: localStorage.getItem(NAV_STORAGE_KEYS.currentView),
    settingsTab: localStorage.getItem(NAV_STORAGE_KEYS.settingsTab),
    sessionId: localStorage.getItem(NAV_STORAGE_KEYS.activeSession),
    groupId: localStorage.getItem(NAV_STORAGE_KEYS.activeGroup),
    automationSection: localStorage.getItem(NAV_STORAGE_KEYS.automationSection),
    workflowId: localStorage.getItem(NAV_STORAGE_KEYS.activeWorkflow),
  });
}

/**
 * 视图状态与地址栏双向同步。
 *
 * 状态仍是组件树的直接输入（与改路由前的 App 一致，子组件拿到的永远是一份自洽的状态）；
 * 地址栏变化（首屏、前进后退、手输地址）在渲染期就折算进状态，不会有一帧用旧状态渲染新页面；
 * 状态变化（侧栏点击等）在提交后写回地址栏。
 */
export function useAppNavigation(capabilities: RouteCapabilities = null) {
  const location = useLocation();
  const navigate = useNavigate();

  const [initial] = useState<AppRouteState>(() => resolveRouteState(parseAppPath(location.pathname), readStoredRouteState()));
  const [currentView, setCurrentView] = useState<ViewType>(initial.view);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initial.settingsTab);
  const [activeSessionId, setActiveSessionIdState] = useState<string>(initial.sessionId);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(initial.groupId);
  const [automationSection, setAutomationSection] = useState<AutomationSection>(initial.automationSection ?? 'workflows');
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(initial.workflowId ?? null);
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
      automationSection,
      workflowId: activeWorkflowId,
    });
    setCurrentView(next.view);
    if (next.view === 'automation') {
      setAutomationSection(next.automationSection ?? 'workflows');
      setActiveWorkflowId(next.workflowId ?? null);
    }
    setSettingsTab(next.settingsTab);
    setActiveSessionIdState(next.sessionId);
    if (next.groupId) setActiveGroupId(next.groupId);
    // 改路由前每次 hashchange 都会收起移动端菜单，这里保持一致。
    setIsMobileMenuOpen(false);
  }

  // 能力清单 → 状态：进了没有入口的页签 / 自动化页面（深链、旧书签、记忆的上次页签），渲染期就换到第一个有入口的，
  // 不先挂一帧没权限的页面；改写地址栏用 replace，后退键不会回到被纠偏掉的地址。
  const autoSelectionRef = useRef(false);
  const enforced = enforceRouteCapabilities({
    view: currentView,
    settingsTab,
    sessionId: activeSessionId,
    groupId: activeGroupId,
    automationSection,
    workflowId: activeWorkflowId,
  }, capabilities, SETTINGS_NAV_TAB_ORDER);
  if (enforced.view !== currentView || enforced.settingsTab !== settingsTab || (enforced.automationSection ?? automationSection) !== automationSection) {
    autoSelectionRef.current = true;
    setCurrentView(enforced.view);
    setSettingsTab(enforced.settingsTab);
    if (enforced.automationSection && enforced.automationSection !== automationSection) {
      setAutomationSection(enforced.automationSection);
      setActiveWorkflowId(enforced.workflowId ?? null);
    }
  }

  // 状态 → 地址栏。
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  useEffect(() => {
    const state: AppRouteState = { view: currentView, settingsTab, sessionId: activeSessionId, groupId: activeGroupId, automationSection, workflowId: activeWorkflowId };
    const desired = formatAppPath(state);
    const replace = autoSelectionRef.current || shouldReplaceHistory(parseAppPath(pathnameRef.current), state);
    autoSelectionRef.current = false;
    if (pathnameRef.current !== desired) {
      navigate(desired, { replace });
    }
    localStorage.setItem(NAV_STORAGE_KEYS.currentView, currentView);
    localStorage.setItem(NAV_STORAGE_KEYS.settingsTab, settingsTab);
    localStorage.setItem(NAV_STORAGE_KEYS.automationSection, automationSection);
    if (activeWorkflowId) localStorage.setItem(NAV_STORAGE_KEYS.activeWorkflow, activeWorkflowId);
    else localStorage.removeItem(NAV_STORAGE_KEYS.activeWorkflow);
  }, [currentView, settingsTab, activeSessionId, activeGroupId, automationSection, activeWorkflowId, navigate]);

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

  /** 进入自动化区的某一页；`workflowId` 只对工作流页有意义，缺省保留当前选中。 */
  const openAutomation = useCallback((section: AutomationSection, workflowId?: string | null) => {
    setAutomationSection(section);
    if (workflowId !== undefined) setActiveWorkflowId(workflowId);
    setCurrentView('automation');
    setIsMobileMenuOpen(false);
  }, []);

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
    automationSection,
    activeWorkflowId,
    openAutomation,
    isMobileMenuOpen,
    navigateTo,
    openMobileMenu,
    handleReturnToConversation,
  };
}
