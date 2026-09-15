// 提醒偏好：按浏览器记在 localStorage（与「对话实时通道」同一类显示偏好），设置 → 通用里切换。
// 缺省全部关闭：声音与系统通知都是打扰，要用户自己打开；未读点不受开关影响。
// 读取不写回（加载不许写）；只有用户在设置里切换才写，并广播给同一标签页里的提醒中心。

export type NotificationPrefs = {
  completionSound: boolean;
  completionOs: boolean;
  approvalSound: boolean;
  approvalOs: boolean;
};

export const NOTIFICATION_PREFS_STORAGE_KEY = 'clawopt_notification_prefs';
export const NOTIFICATION_PREFS_CHANGED_EVENT = 'clawopt:notification-prefs-changed';

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  completionSound: false,
  completionOs: false,
  approvalSound: false,
  approvalOs: false,
};

export function normalizeNotificationPrefs(value: unknown): NotificationPrefs {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    completionSound: source.completionSound === true,
    completionOs: source.completionOs === true,
    approvalSound: source.approvalSound === true,
    approvalOs: source.approvalOs === true,
  };
}

export function readNotificationPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): NotificationPrefs {
  try {
    const raw = storage?.getItem(NOTIFICATION_PREFS_STORAGE_KEY);
    return normalizeNotificationPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

export function persistNotificationPrefs(prefs: NotificationPrefs, storage: Pick<Storage, 'setItem'> | null = safeStorage()): NotificationPrefs {
  const next = normalizeNotificationPrefs(prefs);
  try {
    storage?.setItem(NOTIFICATION_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {}
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NOTIFICATION_PREFS_CHANGED_EVENT, { detail: next }));
  }
  return next;
}

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
