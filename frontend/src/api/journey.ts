import { apiFetch } from './client';

// 成长轨迹（P6）。只返回原始 Response。
export const journeyApi = {
  graph: (agentId: string) => apiFetch(`/agents/${encodeURIComponent(agentId)}/journey`),
};
