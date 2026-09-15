/**
 * 全局快捷键判定（纯函数，带单测）。spec 08 §1.4：
 * - Ctrl/Cmd+K：打开会话搜索；输入框里同样生效（搜索入口本来就是给正在打字的人用的）；
 * - Ctrl/Cmd+,：打开设置；
 * - Ctrl/Cmd+N：新建对话；**在可编辑元素里不抢**（macOS 上 Ctrl+N 是文本框的「下一行」，其余平台也不该吞掉输入）；
 * - Esc：只在搜索面板打开时处理（关闭它），其余 Esc 留给各自的弹窗。
 *
 * 一律忽略：输入法组合中（`isComposing` / keyCode 229）、按住不放的重复事件、带 Alt 或 Shift 的组合。
 * 修饰键按平台：macOS 认 Cmd（metaKey），其余平台认 Ctrl——macOS 上的 Ctrl+K 是文本框「删到行尾」，不能抢。
 */
export type GlobalShortcutAction = 'openSearch' | 'newChat' | 'openSettings' | 'closeSearch';

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export interface ShortcutContext {
  isMac: boolean;
  /** 事件目标是否是可编辑元素（input / textarea / select / contenteditable）。 */
  targetEditable: boolean;
  searchOpen: boolean;
}

export function matchGlobalShortcut(event: ShortcutKeyEvent, context: ShortcutContext): GlobalShortcutAction | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.key === 'Escape') {
    return context.searchOpen && !event.metaKey && !event.ctrlKey && !event.altKey ? 'closeSearch' : null;
  }
  if (event.repeat || event.altKey || event.shiftKey) return null;
  const mod = context.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  const key = event.key.toLowerCase();
  if (key === 'k') return 'openSearch';
  if (key === ',') return 'openSettings';
  if (key === 'n') return context.targetEditable ? null : 'newChat';
  return null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return Boolean(element.isContentEditable);
}

export function detectMacPlatform(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const source = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(source);
}

/** 快捷键提示文字（⌘K / Ctrl+K）。 */
export function shortcutLabel(key: string, isMac: boolean): string {
  return isMac ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}
