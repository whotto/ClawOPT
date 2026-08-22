import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import UnifiedChatView from './components/UnifiedChatView';
import SettingsView from './components/SettingsView';
import LoginScreen from './components/LoginScreen';
import { requestActiveContextRefresh, type ActiveContextRefreshDetail } from './utils/contextRefresh';

export type ViewType = 'chat' | 'settings' | 'groups';
export type SettingsTab = 'gateway' | 'general' | 'models' | 'presets' | 'commands' | 'about';
const LAST_CONVERSATION_VIEW_STORAGE_KEY = 'clawopt_last_conversation_view';
const CONNECTION_STATUS_STORAGE_KEY = 'clawopt_connection_status';
const CONNECTION_STATUS_STORAGE_TTL_MS = 30 * 1000;
const BOOTSTRAP_REQUEST_TIMEOUT_MS = 8000;
const CONNECTION_STATUS_POLL_CONNECTED_MS = 10000;
const CONNECTION_STATUS_POLL_DISCONNECTED_MS = 2000;
const CONNECTION_STATUS_REFRESH_EVENT = 'clawopt:refresh-connection-status';

type SessionSummary = {
  id: string;
  name: string;
  agentId?: string;
  characterId?: string;
  model?: string;
  process_start_tag?: string;
  process_end_tag?: string;
};

async function fetchJsonWithTimeout<T>(input: RequestInfo | URL, init?: RequestInit, timeoutMs = BOOTSTRAP_REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export default function App() {
  const connectionFailureCountRef = useRef(0);
  const connectionRetryTimerRef = useRef<number | null>(null);
  const latestIsConnectedRef = useRef(false);
  const getInitialConnectionState = () => {
    try {
      const raw = window.sessionStorage.getItem(CONNECTION_STATUS_STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { connected?: unknown; checkedAt?: unknown };
      const connected = parsed?.connected === true;
      const checkedAt = typeof parsed?.checkedAt === 'number' ? parsed.checkedAt : 0;
      if ((Date.now() - checkedAt) > CONNECTION_STATUS_STORAGE_TTL_MS) {
        return false;
      }
      return connected;
    } catch {
      return false;
    }
  };

  const getHashState = () => {
    const hash = window.location.hash.replace('#', '');
    if (!hash) {
      const savedView = localStorage.getItem('clawopt_current_view') as ViewType | null;
      const savedTab = localStorage.getItem('clawopt_settings_tab') as SettingsTab | null;
      const savedGroupId = localStorage.getItem('clawopt_active_group');
      return {
        view: savedView === 'settings' || savedView === 'groups' ? savedView : 'chat' as ViewType,
        tab: savedTab === 'general' || savedTab === 'models' || savedTab === 'presets' || savedTab === 'commands' || savedTab === 'about' ? savedTab : 'gateway' as SettingsTab,
        groupId: savedGroupId || null,
      };
    }
    
    if (hash === 'settings') return { view: 'settings' as ViewType, tab: 'gateway' as SettingsTab, groupId: null as string | null };
    if (hash.startsWith('settings/')) {
      const tab = hash.split('/')[1] as SettingsTab;
      return { view: 'settings' as ViewType, tab, groupId: null as string | null };
    }
    if (hash.startsWith('group/')) {
      const groupId = hash.split('/')[1];
      return { view: 'groups' as ViewType, tab: 'gateway' as SettingsTab, groupId };
    }
    if (hash === 'groups') return { view: 'groups' as ViewType, tab: 'gateway' as SettingsTab, groupId: localStorage.getItem('clawopt_active_group') };
    return { view: 'chat' as ViewType, tab: 'gateway' as SettingsTab, groupId: null as string | null };
  };

  const initialState = getHashState();

  const [currentView, setCurrentView] = useState<ViewType>(initialState.view);
  const [isConnected, setIsConnected] = useState<boolean>(() => getInitialConnectionState());
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialState.tab);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null); // null = checking
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    return localStorage.getItem('clawopt_active_session') || '';
  });
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(() => {
    return initialState.groupId || localStorage.getItem('clawopt_active_group') || null;
  });
  const [lastConversationView, setLastConversationView] = useState<'chat' | 'groups'>(() => {
    if (initialState.view === 'chat' || initialState.view === 'groups') {
      return initialState.view;
    }

    const saved = localStorage.getItem(LAST_CONVERSATION_VIEW_STORAGE_KEY);
    return saved === 'groups' ? 'groups' : 'chat';
  });
  const [pendingContextRefresh, setPendingContextRefresh] = useState<ActiveContextRefreshDetail | null>(null);

  // --- Hash Routing Integration for Back Gesture & Deep Linking ---
  useEffect(() => {
    const handleHashChange = () => {
      const { view, tab, groupId } = getHashState();
      setCurrentView(view);
      setSettingsTab(tab);
      if (groupId) setActiveGroupId(groupId);
      setIsMobileMenuOpen(false);
    };

    window.addEventListener('hashchange', handleHashChange);
    
    // Set initial hash if it's empty to normalize URL
    if (!window.location.hash) {
      window.location.hash = currentView === 'settings' ? `settings/${settingsTab}` : 'chat';
    }

    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Sync view state to hash and localStorage
  useEffect(() => {
    let newHash: string;
    if (currentView === 'settings') {
      newHash = `settings/${settingsTab}`;
    } else if (currentView === 'groups') {
      newHash = activeGroupId ? `group/${activeGroupId}` : 'groups';
    } else {
      newHash = 'chat';
    }
    if (window.location.hash.replace('#', '') !== newHash) {
      window.location.hash = newHash;
    }
    localStorage.setItem('clawopt_current_view', currentView);
    localStorage.setItem('clawopt_settings_tab', settingsTab);
  }, [currentView, settingsTab, activeGroupId]);

  // Sync activeSessionId to localStorage
  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem('clawopt_active_session', activeSessionId);
    }
  }, [activeSessionId]);

  // Sync activeGroupId to localStorage
  useEffect(() => {
    if (activeGroupId) {
      localStorage.setItem('clawopt_active_group', activeGroupId);
    } else {
      localStorage.removeItem('clawopt_active_group');
    }
  }, [activeGroupId]);

  useEffect(() => {
    if (currentView !== 'chat' && currentView !== 'groups') return;
    setLastConversationView(currentView);
    localStorage.setItem(LAST_CONVERSATION_VIEW_STORAGE_KEY, currentView);
  }, [currentView]);

  // Wrapper for view/tab changes
  const navigateTo = (view: ViewType, tab?: SettingsTab, openMenu?: boolean) => {
    const nextTab = tab || settingsTab;
    const nextOpen = openMenu !== undefined ? openMenu : isMobileMenuOpen;
    
    if (view !== currentView || nextTab !== settingsTab || nextOpen !== isMobileMenuOpen) {
      setCurrentView(view);
      if (tab) setSettingsTab(tab);
      setIsMobileMenuOpen(nextOpen);
      // Hash is updated automatically by the useEffect above
    }
  };

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

  const reloadSessions = async () => {
    try {
      const data = await fetchJsonWithTimeout<SessionSummary[]>('/api/sessions');
      setSessions(data);
      // Auto-select first session if currently active is not in the list or empty
      if (data.length > 0) {
        setActiveSessionId(prev => {
          const exists = data.find((s: any) => s.id === prev);
          return exists ? prev : data[0].id;
        });
      }
    } catch (err) {
      console.error('Failed to reload sessions:', err);
    } finally {
      setSessionsLoaded(true);
    }
  };

  const reorderSessions = async (newSessions: {id: string, name: string}[]) => {
    // Optimistic update
    setSessions(newSessions);
    try {
      await fetch('/api/sessions/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: newSessions.map(s => s.id) }),
      });
    } catch (err) {
      console.error('Failed to save session order:', err);
      // Fallback on failure
      reloadSessions();
    }
  };

  // Check if login is required on mount and periodically
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const token = localStorage.getItem('clawopt_auth_token');
        const url = token ? `/api/auth/check?token=${encodeURIComponent(token)}` : '/api/auth/check';
        const data = await fetchJsonWithTimeout<{ loginRequired?: boolean }>(url);
        if (data.loginRequired) {
          localStorage.removeItem('clawopt_auth_token');
          setIsAuthenticated(false);
        } else {
          setIsAuthenticated(true);
        }
      } catch {
        // If can't reach server, allow access (offline mode)
        setIsAuthenticated(prev => prev === null ? true : prev);
      }
    };
    checkAuth();
    
    // Periodically poll auth to log out instantly on password change
    const tokenTimer = setInterval(checkAuth, 3000);
    return () => clearInterval(tokenTimer);
  }, []);

  useEffect(() => {
    reloadSessions();
  }, []);

  useEffect(() => {
    latestIsConnectedRef.current = isConnected;
    try {
      window.sessionStorage.setItem(CONNECTION_STATUS_STORAGE_KEY, JSON.stringify({
        connected: isConnected,
        checkedAt: Date.now(),
      }));
    } catch {}
  }, [isConnected]);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const data = await fetchJsonWithTimeout<{ connected?: boolean }>('/api/gateway/status');
        if (data.connected) {
          connectionFailureCountRef.current = 0;
          if (connectionRetryTimerRef.current !== null) {
            window.clearTimeout(connectionRetryTimerRef.current);
            connectionRetryTimerRef.current = null;
          }
          setIsConnected(true);
          return;
        }
      } catch (e) {}

      if (!latestIsConnectedRef.current) {
        connectionFailureCountRef.current = 0;
        setIsConnected(false);
        return;
      }

      connectionFailureCountRef.current += 1;
      if (connectionFailureCountRef.current >= 2) {
        connectionFailureCountRef.current = 0;
        if (connectionRetryTimerRef.current !== null) {
          window.clearTimeout(connectionRetryTimerRef.current);
          connectionRetryTimerRef.current = null;
        }
        setIsConnected(false);
        return;
      }

      if (connectionRetryTimerRef.current === null) {
        connectionRetryTimerRef.current = window.setTimeout(() => {
          connectionRetryTimerRef.current = null;
          void checkStatus();
        }, 1500);
      }
    };

    const handleImmediateCheck = () => {
      void checkStatus();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkStatus();
      }
    };

    void checkStatus();
    const timer = window.setInterval(() => {
      void checkStatus();
    }, isConnected ? CONNECTION_STATUS_POLL_CONNECTED_MS : CONNECTION_STATUS_POLL_DISCONNECTED_MS);
    window.addEventListener('focus', handleImmediateCheck);
    window.addEventListener('online', handleImmediateCheck);
    window.addEventListener(CONNECTION_STATUS_REFRESH_EVENT, handleImmediateCheck as EventListener);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      if (connectionRetryTimerRef.current !== null) {
        window.clearTimeout(connectionRetryTimerRef.current);
        connectionRetryTimerRef.current = null;
      }
      window.removeEventListener('focus', handleImmediateCheck);
      window.removeEventListener('online', handleImmediateCheck);
      window.removeEventListener(CONNECTION_STATUS_REFRESH_EVENT, handleImmediateCheck as EventListener);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isConnected]);

  const reloadModels = async () => {
    try {
      const data = await fetchJsonWithTimeout<{ success?: boolean; models?: any[] }>('/api/models');
      if (data.success && Array.isArray(data.models)) setAvailableModels(data.models);
    } catch (err) {
      console.error('Failed to reload models:', err);
    }
  };

  useEffect(() => {
    reloadModels();
    const modelTimer = setInterval(reloadModels, 30000);
    return () => clearInterval(modelTimer);
  }, []);

  // Show login screen if not authenticated (and auth check is done)
  if (isAuthenticated === false) {
    return <LoginScreen onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  return (
    <div
      className="flex fixed inset-0 h-[100dvh] w-full overflow-hidden bg-gray-50 text-gray-900 font-sans antialiased"
    >
      <Sidebar 
        currentView={currentView} 
        settingsTab={settingsTab} 
        activeSessionId={activeSessionId}
        setActiveSessionId={setActiveSessionId}
        isMobileMenuOpen={isMobileMenuOpen}
        sessions={sessions}
        sessionsLoaded={sessionsLoaded}
        reloadSessions={reloadSessions}
        reorderSessions={reorderSessions}
        navigateTo={navigateTo}
        onReturnToConversation={handleReturnToConversation}
        availableModels={availableModels}
        activeGroupId={activeGroupId}
        onSelectGroup={setActiveGroupId}
      />
      <main className="flex-1 flex flex-col min-w-0 bg-white overflow-hidden md:overflow-visible md:relative md:z-[60]">
        {currentView === 'chat' ? (
          <UnifiedChatView
            mode="chat"
            isConnected={isConnected}
            activeSessionId={activeSessionId}
            onMenuClick={() => navigateTo(currentView, settingsTab, true)}
            sessions={sessions}
            availableModels={availableModels}
          />
        ) : currentView === 'groups' ? (
          <UnifiedChatView
            mode="group"
            isConnected={isConnected}
            onMenuClick={() => navigateTo(currentView, settingsTab, true)}
            sessions={sessions}
            availableModels={availableModels}
            activeGroupId={activeGroupId}
            onSelectGroup={(id) => {
              setActiveGroupId(id);
              navigateTo('groups');
            }}
          />
        ) : (
          <SettingsView 
            isConnected={isConnected} 
            settingsTab={settingsTab} 
            onMenuClick={() => navigateTo(currentView, settingsTab, true)}
            onModelsChanged={reloadModels}
            onAgentsChanged={reloadSessions}
          />
        )}
      </main>
    </div>
  );
}
