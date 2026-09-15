import { apiFetch, apiJsonWithTimeout, jsonInit } from './client';

/** 探测是否需要登录。令牌在 httpOnly cookie 里，同源请求自动携带。 */
export function getAuthCheck(timeoutMs: number) {
  return apiJsonWithTimeout<{ loginRequired?: boolean }>('/auth/check', timeoutMs);
}

export function login(password: string) {
  return apiFetch('/auth/login', jsonInit('POST', { password }));
}
