import { apiFetch } from './client';

export function getDiagnostics() {
  return apiFetch('/diagnostics');
}
