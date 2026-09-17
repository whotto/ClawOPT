import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation, type Location } from 'react-router-dom';
import { getAuthCheck } from '../api/auth';
import { AUTH_CHECK_POLL_MS, BOOTSTRAP_REQUEST_TIMEOUT_MS, isPageVisible } from './bootstrap';
import { LOGIN_PATH } from './routeState';
import { clearThemeCache } from '../theme/themeRuntime';

type AuthState = {
  /** null = 首次探测中；探测中照常渲染应用，与改路由前一致。 */
  isAuthenticated: boolean | null;
  markAuthenticated: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // 会话令牌在 httpOnly cookie 里，同源请求自动携带：既不用拼查询串
        // （会进访问日志与浏览器历史），JS 也读不到（XSS 偷不走）。
        const data = await getAuthCheck(BOOTSTRAP_REQUEST_TIMEOUT_MS);
        // 已退出登录（或令牌失效）：清掉本机的用户主题缓存，登录页与下一个登录的人不带上一个人的主题（P6）。
        if (data.loginRequired) clearThemeCache();
        setIsAuthenticated(!data.loginRequired);
      } catch {
        // 探测失败不再默认放行：后端够不着时前端解锁没有意义，
        // 真正的拦截在后端，这里放行只会让人误以为已登录。
        setIsAuthenticated(prev => prev === null ? false : prev);
      }
    };
    checkAuth();

    // Periodically poll auth to log out on password change; skip while the tab is hidden,
    // and re-check as soon as the user comes back.
    const tokenTimer = setInterval(() => { if (isPageVisible()) void checkAuth(); }, AUTH_CHECK_POLL_MS);
    const handleVisible = () => { if (isPageVisible()) void checkAuth(); };
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      clearInterval(tokenTimer);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, []);

  const markAuthenticated = useCallback(() => setIsAuthenticated(true), []);
  const value = useMemo(() => ({ isAuthenticated, markAuthenticated }), [isAuthenticated, markAuthenticated]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

type LoginRedirectState = { from?: Pick<Location, 'pathname' | 'search' | 'hash'> };

/** 登录成功后回到被拦下时的地址；没有记录或记录的就是登录页时回根路径。 */
export function readLoginRedirectTarget(state: unknown): string {
  const from = (state as LoginRedirectState | null)?.from;
  if (!from || typeof from.pathname !== 'string' || from.pathname === LOGIN_PATH) return '/';
  return `${from.pathname}${from.search || ''}${from.hash || ''}`;
}

/** 已确认未登录时把受保护页面换成登录页，并记下原地址。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (isAuthenticated === false) {
    return <Navigate to={LOGIN_PATH} replace state={{ from: location }} />;
  }
  return <>{children}</>;
}
