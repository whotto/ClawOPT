// 输入框自适应高度与快捷指令候选。
import { useEffect } from 'react';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type ComposerEffectsContext = Pick<
  ChatViewState,
  'isChat' | 'input' | 'showCommands' | 'setShowCommands' | 'allCommands' | 'setFilteredCommands' |
  'setCommandIndex' | 'textareaRef' | 'commandListRef'
>;

export function useComposerEffects(c: ComposerEffectsContext) {
  const {
    isChat, input, showCommands, setShowCommands, allCommands, setFilteredCommands,
    setCommandIndex, textareaRef, commandListRef,
  } = c;
  // ---- Textarea auto-resize + command filtering ----
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
    if (isChat && input.startsWith('/') && !input.includes(' ')) {
      const filter = input.split(' ')[0].toLowerCase();
      const filtered = allCommands.filter(c => c.command.toLowerCase().includes(filter));
      setFilteredCommands(filtered);
      setShowCommands(filtered.length > 0);
      setCommandIndex(0);
    } else if (isChat) {
      setShowCommands(false);
    }
  }, [input, allCommands, isChat]);

  // Click outside commands
  useEffect(() => {
    if (!showCommands) return;
    const handle = (e: MouseEvent) => { if (commandListRef.current && !commandListRef.current.contains(e.target as Node)) setShowCommands(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showCommands]);
}
