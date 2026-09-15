import { apiFetch, jsonInit } from './client';

// 记忆浏览（管理员）：只返回原始 Response，解析与错误本地化在页面里经 useControlApi。

const enc = encodeURIComponent;

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const memoryApi = {
  profiles: () => apiFetch('/memory/profiles'),
  list: (params: { profileId?: string | null; q?: string; status?: string; limit?: number; offset?: number }) => apiFetch(`/memory/cards${query(params)}`),
  detail: (id: string) => apiFetch(`/memory/cards/${enc(id)}`),
  graph: (profileId: string, includeDeleted: boolean) => apiFetch(`/memory/graph${query({ profileId, includeDeleted: includeDeleted ? 1 : null })}`),
  remember: (body: { profileId: string; kind: string; itemKey?: string; title: string; content: string; scope?: unknown }) => apiFetch('/memory/cards', jsonInit('POST', body)),
  update: (id: string, body: { expectedRevision: number; title?: string; content?: string; tags?: string[] }) => apiFetch(`/memory/cards/${enc(id)}`, jsonInit('PATCH', body)),
  remove: (id: string, expectedRevision: number) => apiFetch(`/memory/cards/${enc(id)}`, jsonInit('DELETE', { expectedRevision })),
  audit: (profileId: string | null) => apiFetch(`/memory/audit${query({ profileId, limit: 100 })}`),
};
