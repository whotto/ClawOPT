import { apiFetch } from './client';

// 性能监控（P6，super_admin）。只返回原始 Response。
export const performanceApi = {
  snapshot: () => apiFetch('/performance/runtime'),
};
