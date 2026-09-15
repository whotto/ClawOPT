// 当前用户与界面能力清单：壳层挂载时拉一次 `GET /api/auth/me`，侧栏、路由纠偏与页面按钮共用。
// 能力清单由服务端按角色算（backend/src/core/auth/capabilities.ts），这里不判角色、不写「哪个角色看哪个页签」。
// 它只决定给不给入口；真正的授权永远在后端，越权请求照样 403。
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi } from '../api/control';

export type CurrentUser = {
  id: number | null;
  username: string | null;
  role: 'super_admin' | 'admin' | 'member';
  implicit: boolean;
  mustChangePassword: boolean;
  agentIds: string[] | null;
  capabilities: string[];
};

export type AccessState = {
  user: CurrentUser | null;
  /** 能力 id 集合；null = 还没拿到（侧栏与路由纠偏在此期间不动）。 */
  capabilities: ReadonlySet<string> | null;
  /** 能力未加载时为 false：管理按钮等拿到清单再出现，不先给再收。 */
  can: (capability: string) => boolean;
};

const UNKNOWN: AccessState = { user: null, capabilities: null, can: () => false };
const AccessContext = createContext<AccessState>(UNKNOWN);
export const AccessProvider = AccessContext.Provider;

/** 壳层调用一次；子树经 `useAccess` 读。 */
export function useAccessLoader(): AccessState {
  const [user, setUser] = useState<CurrentUser | null>(null);
  useEffect(() => {
    let cancelled = false;
    authApi.me()
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body?.user) setUser({ ...body.user, capabilities: Array.isArray(body.user.capabilities) ? body.user.capabilities : [] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const capabilities = useMemo(() => (user ? new Set(user.capabilities) : null), [user]);
  const can = useCallback((capability: string) => capabilities?.has(capability) ?? false, [capabilities]);
  return useMemo(() => ({ user, capabilities, can }), [user, capabilities, can]);
}

export function useAccess(): AccessState {
  return useContext(AccessContext);
}
