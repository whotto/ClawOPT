import { apiFetch, jsonInit } from './client';

export function listCommands() {
  return apiFetch('/commands');
}

export function createCommand(body: unknown) {
  return apiFetch('/commands', jsonInit('POST', body));
}

export function updateCommand(commandId: number, body: unknown) {
  return apiFetch(`/commands/${commandId}`, jsonInit('PUT', body));
}

export function deleteCommand(commandId: number) {
  return apiFetch(`/commands/${commandId}`, { method: 'DELETE' });
}
