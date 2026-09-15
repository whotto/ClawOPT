// 控制面页面的请求小工具：读 JSON、把结构化错误本地化、拿当前用户角色。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '../../api/control';
import type { ErrorDisplay } from '../../components/control/ControlUi';
import { resolveStructuredErrorDisplay } from '../settings/shared/settingsHelpers';

export type ApiResult<T> = { ok: boolean; status: number; data: T & { success?: boolean; errorCode?: string; current?: { revision: string; value: unknown } } };

export async function readApi<T = Record<string, unknown>>(request: Promise<Response>): Promise<ApiResult<T>> {
  const response = await request;
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && (data as { success?: boolean }).success !== false, status: response.status, data: data as ApiResult<T>['data'] };
}

/** 统一的错误展示：errorCode 本地化为主句，errorDetail 作诊断信息；网络错误走通用文案。 */
export function useErrorDisplay() {
  const { t } = useTranslation();
  const fromResult = useCallback((result: ApiResult<unknown>, fallbackKey = 'control.common.requestFailed'): ErrorDisplay => (
    resolveStructuredErrorDisplay(result.data as never, t, fallbackKey)
  ), [t]);
  const fromException = useCallback((error: unknown): ErrorDisplay => ({
    message: t('control.common.networkError'),
    detail: error instanceof Error ? error.message : '',
  }), [t]);
  // 返回稳定引用：页面会把它放进 useCallback 依赖，每次渲染换新对象会让加载 effect 反复触发。
  return useMemo(() => ({ fromResult, fromException }), [fromResult, fromException]);
}

export type CurrentUser = {
  id: number | null;
  username: string | null;
  role: 'super_admin' | 'admin' | 'member';
  implicit: boolean;
  mustChangePassword: boolean;
  agentIds: string[] | null;
};

/** 当前用户：只用来隐藏做不了的按钮，真正的授权永远在后端。 */
export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  useEffect(() => {
    let cancelled = false;
    readApi<{ user: CurrentUser }>(authApi.me())
      .then((result) => {
        if (!cancelled && result.ok) setUser(result.data.user);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  // 还没拿到身份时按「能操作」渲染，免得按钮闪一下；越权操作后端会拒绝并给出 errorCode。
  const isAdmin = !user || user.role === 'admin' || user.role === 'super_admin';
  return { user, isAdmin, isSuperAdmin: !user || user.role === 'super_admin' };
}
