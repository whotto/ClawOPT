import { apiFetch } from './client';

export function getFileCapabilities() {
  return apiFetch('/files/capabilities');
}

export function uploadFiles(form: FormData) {
  return apiFetch('/files/upload', { method: 'POST', body: form });
}

/**
 * 按完整 URL 取文件资源（预览地址、`/uploads/...`、预览数据接口等）。
 * 这些 URL 由调用方按文件来源拼好，已带前缀，所以不经 `apiFetch` 再加 `/api`。
 */
export function fetchResource(url: string, init?: RequestInit) {
  return fetch(url, init);
}
