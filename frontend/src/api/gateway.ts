import { apiJsonWithTimeout } from './client';

export function getGatewayStatus(timeoutMs: number) {
  return apiJsonWithTimeout<{ connected?: boolean }>('/gateway/status', timeoutMs);
}
