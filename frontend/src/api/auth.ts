import { apiFetch, apiJsonWithTimeout, jsonInit } from './client';

/** 探测是否需要登录。令牌在 httpOnly cookie 里，同源请求自动携带。 */
export function getAuthCheck(timeoutMs: number) {
  return apiJsonWithTimeout<{ loginRequired?: boolean }>('/auth/check', timeoutMs);
}

/** 用户名可省略：后端按 `admin` 处理（多用户之前只填口令的登录方式照常可用）。 */
export function login(password: string, username?: string) {
  return apiFetch('/auth/login', jsonInit('POST', username ? { username, password } : { password }));
}

export function changePassword(currentPassword: string, newPassword: string) {
  return apiFetch('/auth/change-password', jsonInit('POST', { currentPassword, newPassword }));
}
