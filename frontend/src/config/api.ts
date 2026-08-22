// API configuration
// Simple config without import.meta.env to avoid TS errors

const API_BASE = '/api';

export function apiFetch(path: string, options?: RequestInit) {
  return fetch(`${API_BASE}${path}`, options);
}

export default { apiFetch };
