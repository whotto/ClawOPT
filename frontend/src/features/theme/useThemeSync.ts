// 壳层挂载后同步一次当前用户的主题：服务端为准，写进本机缓存（下一次首帧用），换了人就立刻换主题。
// 只读不写：加载不许写（AGENTS.md「加载不许写」），保存只发生在主题页的用户操作里。
import { useEffect } from 'react';
import { themeApi } from '../../api/theme';
import type { CurrentUser } from '../../app/access';
import { applyTheme, cacheTheme, readCachedTheme, themeUserKey, type UserTheme } from '../../theme/themeRuntime';

export function useThemeSync(user: CurrentUser | null): void {
  const userKey = user ? themeUserKey(user) : null;
  useEffect(() => {
    if (!userKey) return;
    let cancelled = false;
    const cached = readCachedTheme();
    // 缓存是别人的（同一浏览器换了账号）：先别带着上一个人的颜色，等服务端结果。
    if (cached && cached.userKey !== userKey) applyTheme({ mode: 'light', accentColor: null, textColor: null, fontSize: null, background: null });
    themeApi.get()
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { theme?: UserTheme } | null) => {
        if (cancelled || !body?.theme) return;
        cacheTheme(userKey, body.theme);
        applyTheme(body.theme);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userKey]);
}
