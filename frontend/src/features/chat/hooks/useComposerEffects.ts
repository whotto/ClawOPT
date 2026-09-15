// 输入框自适应高度与「/」命令面板（快捷命令 + 这个会话的运行时支持的会话命令）。
import { useEffect, useMemo } from 'react';
import { useRuntimeCapabilityStore } from '../../sessions/runtimeCapabilityStore';
import { filterSlashCommands, mergeSlashCommands } from '../lib/composerCommands';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type ComposerEffectsContext = Pick<
  ChatViewState,
  't' | 'isChat' | 'input' | 'showCommands' | 'setShowCommands' | 'allCommands' | 'setFilteredCommands' |
  'setCommandIndex' | 'textareaRef' | 'commandListRef' | 'currentSession'
>;

export function useComposerEffects(c: ComposerEffectsContext) {
  const {
    t, isChat, input, showCommands, setShowCommands, allCommands, setFilteredCommands,
    setCommandIndex, textareaRef, commandListRef, currentSession,
  } = c;
  const { runtimes, ensureLoaded } = useRuntimeCapabilityStore();
  const externalRuntime = (currentSession as { externalRuntime?: string } | null)?.externalRuntime ?? null;
  useEffect(() => { if (isChat) ensureLoaded(); }, [ensureLoaded, isChat]);

  const slashCommands = useMemo(() => mergeSlashCommands(
    allCommands,
    { externalRuntime, nativeCompact: externalRuntime ? runtimes[externalRuntime]?.nativeCompact === true : true },
    (command) => String(t(`slashCommands.${command.slice(1)}`)),
  ), [allCommands, externalRuntime, runtimes, t]);

  // ---- Textarea auto-resize（高度上限跟着用户拖拽的高度走，见 Composer） + command filtering ----
  useEffect(() => {
    if (isChat && input.startsWith('/') && !input.includes(' ')) {
      const filtered = filterSlashCommands(slashCommands, input);
      setFilteredCommands(filtered);
      setShowCommands(filtered.length > 0);
      setCommandIndex(0);
    } else if (isChat) {
      setShowCommands(false);
    }
  }, [input, slashCommands, isChat]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const maxHeight = Number(textarea.dataset.maxHeight) || 200;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, [input]);

  // Click outside commands
  useEffect(() => {
    if (!showCommands) return;
    const handle = (e: MouseEvent) => { if (commandListRef.current && !commandListRef.current.contains(e.target as Node)) setShowCommands(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showCommands]);

  return { slashCommands };
}
