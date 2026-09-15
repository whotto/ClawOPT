import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  detectMacPlatform,
  isEditableTarget,
  matchGlobalShortcut,
} from './lib/shortcuts';
import { NEW_CHAT_SHORTCUT_EVENT, OPEN_SESSION_SEARCH_EVENT } from './lib/searchLib';

const SessionSearchPalette = lazy(() => import('./SessionSearchPalette'));

/**
 * 壳层里的全局搜索与快捷键（只挂在登录后的壳层里，登录页天然不响应）。
 * - Ctrl/Cmd+K 或侧栏搜索按钮（`OPEN_SESSION_SEARCH_EVENT`）打开搜索面板；
 * - Ctrl/Cmd+,：设置；Ctrl/Cmd+N：新建对话（发 `NEW_CHAT_SHORTCUT_EVENT`，侧栏按能力决定能不能开新建弹窗）；
 * - Esc：关闭搜索面板。
 * 注意：部分浏览器把 Ctrl/Cmd+N 保留给「新窗口」，页面拦不住，这时快捷键不生效（侧栏按钮照常可用）。
 */
export default function GlobalSearch({ onOpenSession, onOpenSettings }: {
  onOpenSession: (sessionId: string) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isMac = useMemo(() => detectMacPlatform(), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = matchGlobalShortcut(event, { isMac, targetEditable: isEditableTarget(event.target), searchOpen: open });
      if (!action) return;
      event.preventDefault();
      if (action === 'openSearch') setOpen(true);
      else if (action === 'closeSearch') setOpen(false);
      else if (action === 'openSettings') { setOpen(false); onOpenSettings(); }
      else if (action === 'newChat') { setOpen(false); window.dispatchEvent(new CustomEvent(NEW_CHAT_SHORTCUT_EVENT)); }
    };
    const handleOpen = () => setOpen(true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(OPEN_SESSION_SEARCH_EVENT, handleOpen);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(OPEN_SESSION_SEARCH_EVENT, handleOpen);
    };
  }, [isMac, onOpenSettings, open]);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <SessionSearchPalette isMac={isMac} onClose={() => setOpen(false)} onOpenSession={onOpenSession} />
    </Suspense>
  );
}
