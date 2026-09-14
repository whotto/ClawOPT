import { apiFetch, jsonInit } from './client';

export function listEndpoints() {
  return apiFetch('/endpoints');
}

export function saveEndpoint(body: unknown) {
  return apiFetch('/endpoints', jsonInit('POST', body));
}

export function deleteEndpoint(body: unknown) {
  return apiFetch('/endpoints/manage', jsonInit('DELETE', body));
}

export function testEndpoint(body: unknown) {
  return apiFetch('/endpoints/test', jsonInit('POST', body));
}
