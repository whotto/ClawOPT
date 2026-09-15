// 输入框自适应高度与「/」命令面板（快捷命令 + 这个会话的运行时支持的会话命令）。
import { useEffect, useMemo, useRef } from 'react';
import { consumeComposerPrefill } from '../../../utils/composerPrefill';
import { readDraft, writeDraft } from '../lib/composerPrefs';
import { useRuntimeCapabilityStore } from '../../sessions/runtimeCapabilityStore';
import { filterSlashCommands, mergeSlashCommands } from '../lib/composerCommands';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type ComposerEffectsContext = Pick<
  ChatViewState,
  't' | 'isChat' | 'input' | 'showCommands' | 'setShowCommands' | 'allCommands' | 'setFilteredCommands' |
  'setCommandIndex' | 'textareaRef' | 'commandListRef' | 'currentSession' | 'mode' | 'activeKey' | 'setInput'
>;

export function useComposerEffects(c: ComposerEffectsContext) {
  const {
    t, isChat, input, showCommands, setShowCommands, allCommands, setFilteredCommands,
    setCommandIndex, textareaRef, commandListRef, currentSession, mode, activeKey, setInput,
  } = c;

  // ---- 每会话草稿（按浏览器）：切换会话时载入那个会话的草稿；运行时管理页交来的一次性预填优先。 ----
  const draftKey = activeKey ? `${mode}:${activeKey}` : '';
  const loadedDraftKeyRef = useRef('');
  useEffect(() => {
    if (!draftKey) return;
    const prefill = mode === 'chat' ? consumeComposerPrefill(activeKey) : null;
    let draft = '';
    try { draft = readDraft(window.localStorage, draftKey); } catch {}
    loadedDraftKeyRef.current = draftKey;
    setInput(prefill || draft);
  }, [draftKey]);
  useEffect(() => {
    if (!draftKey || loadedDraftKeyRef.current !== draftKey) return;
    const timer = window.setTimeout(() => {
      try { writeDraft(window.localStorage, draftKey, input); } catch {}
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draftKey, input]);
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
