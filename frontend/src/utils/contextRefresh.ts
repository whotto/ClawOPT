export const ACTIVE_CONTEXT_REFRESH_EVENT = 'clawopt:refresh-active-context';

export type ActiveContextRefreshDetail = {
  mode: 'chat' | 'group';
  id: string;
};

export function requestActiveContextRefresh(detail: ActiveContextRefreshDetail) {
  if (typeof window === 'undefined' || !detail.id) return;

  window.dispatchEvent(new CustomEvent<ActiveContextRefreshDetail>(ACTIVE_CONTEXT_REFRESH_EVENT, {
    detail,
  }));
}
