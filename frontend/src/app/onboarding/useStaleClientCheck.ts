import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '../../api/update';
import { isPageVisible } from '../bootstrap';
import { type BuildIdentity, isClientStale, shouldRunStaleCheck, STALE_CHECK_POLL_MS } from './onboardingState';

function readClientBuildIdentity(): BuildIdentity | null {
  return typeof __CLAWOPT_BUILD_IDENTITY__ === 'undefined' ? null : __CLAWOPT_BUILD_IDENTITY__ ?? null;
}

/**
 * 页面加载的前端产物与服务端构建不一致（升级、重新部署之后老标签页还开着）时给出刷新提示。
 *
 * 检查时机有界：挂载时一次；切回标签页 / 浏览器恢复联网最多每 10 分钟一次；后台可见时每 15 分钟一次；
 * 与后端的连接从断开恢复（服务重启通常就是升级）时强制一次。只读不写。
 */
export function useStaleClientCheck(isConnected: boolean) {
  const [serverBuild, setServerBuild] = useState<BuildIdentity | null>(null);
  const [dismissedBuild, setDismissedBuild] = useState<string | null>(null);
  const lastCheckedAtRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const wasConnectedRef = useRef(isConnected);

  const check = useCallback(async (force: boolean) => {
    if (inFlightRef.current || !shouldRunStaleCheck(lastCheckedAtRef.current, Date.now(), force)) return;
    inFlightRef.current = true;
    lastCheckedAtRef.current = Date.now();
    try {
      const response = await getVersion();
      if (!response.ok) return;
      const data = await response.json() as { version?: unknown; buildTime?: unknown };
      setServerBuild({
        version: typeof data.version === 'string' ? data.version : null,
        buildTime: typeof data.buildTime === 'string' ? data.buildTime : null,
      });
    } catch {
      // 查不到就当不知道，不提示。
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void check(true);
    const onFocus = () => { void check(false); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void check(false); };
    const timer = window.setInterval(() => { if (isPageVisible()) void check(true); }, STALE_CHECK_POLL_MS);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [check]);

  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) void check(true);
    wasConnectedRef.current = isConnected;
  }, [isConnected, check]);

  const stale = isClientStale(readClientBuildIdentity(), serverBuild, { dev: import.meta.env.DEV });
  const serverBuildKey = serverBuild ? `${serverBuild.version ?? ''}@${serverBuild.buildTime ?? ''}` : null;
  return {
    showReloadPrompt: stale && serverBuildKey !== dismissedBuild,
    dismiss: () => setDismissedBuild(serverBuildKey),
    reload: () => window.location.reload(),
  };
}
