import { apiFetch } from './client';

export function listCharacters() {
  return apiFetch('/characters');
}
