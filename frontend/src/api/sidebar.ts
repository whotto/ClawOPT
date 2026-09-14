import { apiFetch, jsonInit } from './client';

export function getSidebarFavorites() {
  return apiFetch('/sidebar/favorites');
}

export function saveSidebarFavorites(favorites: unknown) {
  return apiFetch('/sidebar/favorites', jsonInit('POST', { favorites }));
}
