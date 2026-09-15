// 主题运行时（React 侧）：把服务端的每用户主题缓存到本机、交给首帧脚本同一个实现去应用。
// 「主题 → <html> 属性与变量」只在 public/theme-boot.js 里实现一次（首帧前就要跑，不能等打包后的模块），这里只调用它。
export type ThemeMode = 'light' | 'dark' | 'system';

export type UserTheme = {
  mode: ThemeMode;
  accentColor: string | null;
  textColor: string | null;
  fontSize: number | null;
  background: { mime: string; size: number; revision: string } | null;
  revision: string;
  updatedAt: number | null;
};

export const DEFAULT_USER_THEME: UserTheme = {
  mode: 'light',
  accentColor: null,
  textColor: null,
  fontSize: null,
  background: null,
  revision: 'default',
  updatedAt: null,
};

export const THEME_FONT_SIZE_MIN = 12;
export const THEME_FONT_SIZE_MAX = 20;
export const THEME_BACKGROUND_MAX_BYTES = 5 * 1024 * 1024;
/** 与 public/theme-boot.js 的 CACHE_KEY 同值（themeBoot.test.ts 钉住）。 */
export const THEME_CACHE_KEY = 'clawopt.theme.v1';

type ApplyFn = (theme: unknown, win?: Window) => { resolvedMode: 'light' | 'dark' } | null;

function bootApply(): ApplyFn | null {
  const fn = (window as unknown as { __clawoptApplyTheme?: ApplyFn }).__clawoptApplyTheme;
  return typeof fn === 'function' ? fn : null;
}

/** 立即应用（预览或保存后）。首帧脚本没加载（例如被拦截）时什么都不做，界面保持默认主题。 */
export function applyTheme(theme: Pick<UserTheme, 'mode' | 'accentColor' | 'textColor' | 'fontSize' | 'background'>): void {
  bootApply()?.(theme, window);
}

export function cacheTheme(userKey: string, theme: UserTheme): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ userKey, theme }));
  } catch {
    // 隐私模式写不进：下次首帧用默认主题，挂载后照样同步。
  }
}

export function readCachedTheme(): { userKey: string; theme: UserTheme } | null {
  try {
    const raw = window.localStorage.getItem(THEME_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && typeof parsed.userKey === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** 退出登录：清掉本机缓存并回到默认主题（下一个登录的人首帧不带上一个人的主题）。 */
export function clearThemeCache(): void {
  try {
    window.localStorage.removeItem(THEME_CACHE_KEY);
  } catch {
    // 同上。
  }
  applyTheme(DEFAULT_USER_THEME);
}

export function themeUserKey(user: { id: number | null } | null): string {
  return user && typeof user.id === 'number' ? `u:${user.id}` : 'implicit';
}

/** 背景图的读回地址：带版本号，换图不吃浏览器缓存。 */
export function themeBackgroundUrl(revision: string): string {
  return `/api/theme/background?v=${encodeURIComponent(revision)}`;
}
