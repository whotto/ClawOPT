import { apiFetch, jsonInit } from './client';

// 每用户主题（P6）。只返回原始 Response。
export const themeApi = {
  get: () => apiFetch('/theme'),
  save: (body: { mode: string; accentColor: string | null; textColor: string | null; fontSize: number | null }) => apiFetch('/theme', jsonInit('PUT', body)),
  reset: () => apiFetch('/theme', { method: 'DELETE' }),
  uploadBackground: (file: Blob) => apiFetch('/theme/background', { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }),
  removeBackground: () => apiFetch('/theme/background', { method: 'DELETE' }),
};
