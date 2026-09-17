import { apiFetch, jsonInit } from './client';

// 文件管理器 `/api/fs/*`。只返回原始 Response；解析与错误本地化在页面（pages/control/useControlApi.ts）。

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const fileManagerApi = {
  roots: () => apiFetch('/fs/roots'),
  list: (root: string, path: string) => apiFetch(`/fs/list?${qs({ root, path })}`),
  read: (root: string, path: string) => apiFetch(`/fs/read?${qs({ root, path })}`),
  previewLink: (root: string, path: string) => apiFetch(`/fs/preview-link?${qs({ root, path })}`),
  /** 浏览器直接下载（同源 cookie 带鉴权）：给 `<a href download>` 用的地址，不经 fetch。 */
  downloadUrl: (root: string, path: string) => `/api/fs/download?${qs({ root, path })}`,
  write: (root: string, path: string, content: string, revision: string) => {
    const init = jsonInit('PUT', { root, path, content });
    return apiFetch('/fs/write', { ...init, headers: { ...(init.headers as Record<string, string>), 'If-Match': `"${revision}"` } });
  },
  mkdir: (root: string, path: string) => apiFetch('/fs/mkdir', jsonInit('POST', { root, path })),
  rename: (root: string, from: string, to: string) => apiFetch('/fs/rename', jsonInit('POST', { root, from, to })),
  copy: (root: string, from: string, to: string) => apiFetch('/fs/copy', jsonInit('POST', { root, from, to })),
  remove: (root: string, path: string, recursive: boolean) => apiFetch('/fs/delete', jsonInit('POST', { root, path, recursive })),

  beginUpload: (body: { root: string; dir: string; name: string; size: number; overwrite?: boolean }) => apiFetch('/fs/uploads', jsonInit('POST', body)),
  uploadStatus: (uploadId: string) => apiFetch(`/fs/uploads/${encodeURIComponent(uploadId)}`),
  uploadChunk: (uploadId: string, offset: number, chunk: Blob, signal?: AbortSignal) => apiFetch(`/fs/uploads/${encodeURIComponent(uploadId)}/chunks?offset=${offset}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: chunk,
    signal,
  }),
  completeUpload: (uploadId: string) => apiFetch(`/fs/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST' }),
  abortUpload: (uploadId: string) => apiFetch(`/fs/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }),

  config: () => apiFetch('/fs/config'),
  addExtraRoot: (body: { name: string; path: string }) => apiFetch('/fs/extra-roots', jsonInit('POST', body)),
  removeExtraRoot: (id: string) => apiFetch(`/fs/extra-roots/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createConnection: (body: Record<string, unknown>) => apiFetch('/fs/connections', jsonInit('POST', body)),
  updateConnection: (id: string, body: Record<string, unknown>) => apiFetch(`/fs/connections/${encodeURIComponent(id)}`, jsonInit('PUT', body)),
  removeConnection: (id: string) => apiFetch(`/fs/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testConnection: (id: string) => apiFetch(`/fs/connections/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  scanHostKeys: (host: string, port: number) => apiFetch('/fs/known-hosts/scan', jsonInit('POST', { host, port })),
  trustHostKeys: (scanId: string, fingerprints: string[]) => apiFetch('/fs/known-hosts/trust', jsonInit('POST', { scanId, fingerprints })),
  removeHostKey: (hostPattern: string, fingerprint: string) => apiFetch('/fs/known-hosts/remove', jsonInit('POST', { hostPattern, fingerprint })),
};
