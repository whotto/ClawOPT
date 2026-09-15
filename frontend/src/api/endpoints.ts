import { apiFetch, jsonInit } from './client';

export function listEndpoints() {
  return apiFetch('/endpoints');
}

/** 保存服务商。编辑已有服务商必须带版本号（If-Match），不符 412 + 当前视图；apiKey 空串 = 保持原值。 */
export function saveEndpoint(body: unknown, revision: string | null) {
  const init = jsonInit('POST', body);
  return apiFetch('/endpoints', revision
    ? { ...init, headers: { ...(init.headers as Record<string, string>), 'If-Match': `"${revision}"` } }
    : init);
}

export function deleteEndpoint(body: unknown) {
  return apiFetch('/endpoints/manage', jsonInit('DELETE', body));
}

export function testEndpoint(body: unknown) {
  return apiFetch('/endpoints/test', jsonInit('POST', body));
}
