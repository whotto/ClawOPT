// 输入区：附件选择与拖放、发送（含单聊读流）、停止、@ 成员、键盘。
import React from 'react';
import { compressImage, getFileCategory, formatFileSize } from '../../../utils/imageCompression';
import { stopChat } from '../../../api/chat';
import { postGroupMessage, stopGroupRun } from '../../../api/groups';
import { postChatMessage } from '../../../api/stream';
import type { ChatMessage } from '../../../utils/message-merge';
import { getRealtimeClient } from '../../../api/ws';
import { readChatStreamTransport } from '../../../utils/chatStreamTransport';
import { openChatTurnStream } from '../lib/chatStream';
import {
  mapStreamingContentPatch, mapStreamingErrorUpdate, mapHttpErrorResponse, createClientStructuredChatError,
  resolveGroupSendNotice,
  resolveSubmitError,
} from '../lib/messageMapping';
import type { ChatViewState } from './useChatViewState';
import type { ChatPresence } from './useChatPresence';
import type { MessagePatchQueue } from './useMessagePatchQueue';
import type { HistoryScroll } from './useHistoryScroll';
import type { ChatHistoryFetch } from './useChatHistoryFetch';
import type { GroupEvents } from './useGroupEvents';
import { buildStructuredMentions, insertMentionAt, type MentionRange, rebaseMentionRanges } from '../../rooms/mentionRanges';
import { loadRoomDraft, roomQueueCapability, saveRoomDraft, sweepRoomDrafts } from '../../rooms/roomStorage';
import type { MessageActions } from './useMessageActions';

/** 本段读取的、由前面各段产出的值。 */
type ComposerActionsContext = Pick<
  ChatViewState & ChatPresence & MessagePatchQueue & HistoryScroll & ChatHistoryFetch & GroupEvents & MessageActions,
  't' | 'sessions' | 'isChat' | 'isGroup' | 'activeKey' | 'setMessages' | 'input' | 'setInput' |
  'isLoading' | 'setIsLoading' | 'setSubmitError' | 'setSubmitNotice' | 'currentLocale' | 'setActiveLeafId' | 'editingMessageId' |
  'pendingFiles' | 'setPendingFiles' | 'isDragging' | 'setIsDragging' | 'quotedMessage' |
  'setQuotedMessage' | 'setFileErrorModalOpen' | 'setFileErrorMessage' | 'currentModel' |
  'showCommands' | 'setShowCommands' | 'filteredCommands' | 'commandIndex' | 'setCommandIndex' |
  'setTypingAgents' | 'setGroupRunState' | 'showMentionPopup' | 'setShowMentionPopup' |
  'mentionFilter' | 'setMentionFilter' | 'mentionIndex' | 'setMentionIndex' | 'textareaRef' |
  'abortControllerRef' | 'justSelectedFileRef' | 'dragCounter' | 'forceAutoScrollRef' |
  'currentGroup' | 'activeSessionName' | 'resolveGroupMemberDisplayName' | 'isGroupBusy' |
  'formatQuoteTime' | 'flushQueuedMessagePatches' | 'queueMessagePatch' | 'dropQueuedMessagePatch' |
  'moveQueuedMessagePatch' | 'scrollToLatestBottom' | 'prepareLatestHistoryWindowForSubmit' |
  'recoverLatestChatMessages' | 'recoverGroupActiveRun' | 'recoverLatestGroupMessages' |
  'uploadFiles'
>;

export function useComposerActions(c: ComposerActionsContext) {
  const mentionRangesRef = React.useRef<MentionRange[]>([]);
  const {
    t, sessions, isChat, isGroup, activeKey, setMessages, input, setInput, isLoading, setIsLoading,
    setSubmitError, setSubmitNotice, currentLocale, setActiveLeafId, editingMessageId, pendingFiles, setPendingFiles, isDragging,
    setIsDragging, quotedMessage, setQuotedMessage, setFileErrorModalOpen, setFileErrorMessage,
    currentModel, showCommands, setShowCommands, filteredCommands, commandIndex, setCommandIndex,
    setTypingAgents, setGroupRunState, showMentionPopup, setShowMentionPopup, mentionFilter,
    setMentionFilter, mentionIndex, setMentionIndex, textareaRef, abortControllerRef,
    justSelectedFileRef, dragCounter, forceAutoScrollRef, currentGroup, activeSessionName,
    resolveGroupMemberDisplayName, isGroupBusy, formatQuoteTime, flushQueuedMessagePatches,
    queueMessagePatch, dropQueuedMessagePatch, moveQueuedMessagePatch, scrollToLatestBottom,
    prepareLatestHistoryWindowForSubmit, recoverLatestChatMessages, recoverGroupActiveRun,
    recoverLatestGroupMessages, uploadFiles,
  } = c;
  // ---- File handling ----
  const handleFileChange = async (files: File[]) => {
    if (!files.length) return;

    const IMAGE_TARGET_SIZE = 4_500_000; // 4.5MB target for images

    const processedFiles: {file: File, preview: string}[] = [];
    const errors: string[] = [];

    for (const file of files) {
      const category = getFileCategory(file);

      if (category === 'image') {
        try {
          const compressed = await compressImage(file, IMAGE_TARGET_SIZE);
          if (compressed.size > IMAGE_TARGET_SIZE) {
            errors.push(t('unifiedChat.imageTooLargeAfterCompression', {
              name: file.name,
              originalSize: formatFileSize(file.size),
              limit: formatFileSize(IMAGE_TARGET_SIZE),
            }));
          } else {
            const preview = URL.createObjectURL(compressed);
            processedFiles.push({ file: compressed, preview });
          }
        } catch (err) {
          errors.push(t('unifiedChat.imageCompressionFailed', {
            name: file.name,
            message: err instanceof Error ? err.message : t('common.unknownError'),
          }));
        }
      } else {
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
        processedFiles.push({ file, preview });
      }
    }

    // Show errors if any
    if (errors.length > 0) {
      setFileErrorMessage(errors.join('\n'));
      setFileErrorModalOpen(true);
    }

    // Add successfully processed files
    if (processedFiles.length > 0) {
      justSelectedFileRef.current = true;
      setTimeout(() => { justSelectedFileRef.current = false; }, 500);
      setPendingFiles(prev => [...prev, ...processedFiles]);
    }
  };
  const removePendingFile = (index: number) => {
    setPendingFiles(prev => { const t = prev[index]; if (t.preview) URL.revokeObjectURL(t.preview); return prev.filter((_, i) => i !== index); });
  };
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (editingMessageId) {
      if (isDragging) {
        setIsDragging(false);
      }
      dragCounter.current = 0;
      return;
    }
    if (e.type === 'dragenter') { dragCounter.current++; setIsDragging(true); }
    else if (e.type === 'dragleave') { dragCounter.current--; if (dragCounter.current <= 0) setIsDragging(false); }
    else if (e.type === 'dragover') { if (!isDragging) setIsDragging(true); }
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false); dragCounter.current = 0;
    if (editingMessageId) return;
    if (e.dataTransfer.files?.length > 0) handleFileChange(Array.from(e.dataTransfer.files));
  };
  const handlePaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData?.files.length > 0) { e.preventDefault(); handleFileChange(Array.from(e.clipboardData.files)); }
  };

  // ---- Send message ----
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    // P3：群聊不再因为「有人在跑」挡发送——服务端按每个 Agent 排队。单聊照旧。
    if ((!input.trim() && pendingFiles.length === 0 && !quotedMessage) || isLoading || (isGroupBusy && !isGroup)) return;
    setSubmitError('');
    setSubmitNotice('');
    // 结构化 @ 要按未裁剪的原文核对区间（裁掉前导空白会让区间错位）。
    const structuredMentions = isGroup ? buildStructuredMentions(input, mentionRangesRef.current) : undefined;
    const currentRanges = mentionRangesRef.current;
    mentionRangesRef.current = [];
    const currentInput = input.trim(); const currentFiles = [...pendingFiles]; const currentQuote = quotedMessage;
    const submitLeafId = prepareLatestHistoryWindowForSubmit();
    setInput(''); setPendingFiles([]); setQuotedMessage(null); setIsLoading(true);
    scrollToLatestBottom();

    if (isChat) {
      const controller = new AbortController(); abortControllerRef.current = controller;
      const userMessageId = `temp-user-${Date.now()}`;
      const assistantId = `temp-asst-${Date.now() + 1}`;
      let resolvedAssistantId = assistantId;
      let resolvedUserMsgId = userMessageId;
      const assistantTargetIds = new Set<string>([assistantId]);
      const queueAssistantPatch = (patch: Partial<ChatMessage>, flush = false) => {
        assistantTargetIds.forEach((messageId) => queueMessagePatch(messageId, patch));
        if (flush) flushQueuedMessagePatches();
      };
      const dropAssistantPatches = () => {
        assistantTargetIds.forEach((messageId) => dropQueuedMessagePatch(messageId));
      };
      const updateAssistantMessages = (updater: (message: ChatMessage) => ChatMessage) => {
        setMessages(prev => {
          const hasTarget = prev.some(message => assistantTargetIds.has(message.id));
          if (!hasTarget) return prev;
          return prev.map(message => assistantTargetIds.has(message.id) ? updater(message) : message);
        });
      };
      try {
        const uploadedContent = await uploadFiles(currentFiles);
        let textContent = currentInput;
        if (currentQuote) {
          const author = currentQuote.role === 'user' ? t('common.you') : (currentQuote.agentName || t('common.ai'));
          const time = formatQuoteTime(currentQuote.timestamp);
          textContent = `[引用开始 author="${author}" time="${time}"]\n${currentQuote.content}\n[引用结束]\n\n${currentInput}`.trim();
        }
        const fullMessage = [uploadedContent, textContent].filter(Boolean).join('\n\n');
        if (!fullMessage) { setIsLoading(false); return; }
        const parentForUser = submitLeafId || undefined;
        const currentSession = sessions.find(s => s.id === activeKey);
        const snapshotModel = currentSession?.model || currentModel || undefined;
        const snapshotAgentName = currentSession?.name || activeSessionName || undefined;
        const shouldShowProcessPlaceholder = !!(currentSession?.process_start_tag && currentSession?.process_end_tag);
        forceAutoScrollRef.current = true;
        setMessages(prev => [...prev,
          { id: userMessageId, role: 'user', content: fullMessage, timestamp: new Date(), parentId: parentForUser },
          { id: assistantId, role: 'assistant', content: '', processStreaming: shouldShowProcessPlaceholder, timestamp: new Date(), model: snapshotModel, agentName: snapshotAgentName, parentId: userMessageId },
        ]);
        setActiveLeafId(assistantId);
        const stream = await openChatTurnStream({
          transport: readChatStreamTransport(),
          sessionId: activeKey,
          client: getRealtimeClient,
          post: (headers) => postChatMessage({ sessionId: activeKey, message: fullMessage }, controller.signal, headers),
          signal: controller.signal,
        });
        if (!stream.ok) {
          dropAssistantPatches();
          const fallbackContent = `❌ ${t('common.error')}: ${t('unifiedChat.requestFailed')}`;
          const errorUpdate = await mapHttpErrorResponse(stream.response, fallbackContent);
          updateAssistantMessages(message => ({ ...message, ...errorUpdate }));
          return;
        }
        let receivedFinal = false;
        let receivedError = false;
        for await (const evt of stream.events) {
          try {
            if (evt.type === 'ids') {
              // Replace temp IDs with real DB IDs
              const previousAssistantId = resolvedAssistantId;
              const realUserId = String(evt.userMsgId);
              const realAssistantId = String(evt.assistantMsgId);
              moveQueuedMessagePatch(resolvedUserMsgId, realUserId);
              moveQueuedMessagePatch(resolvedAssistantId, realAssistantId);
              setMessages(prev => prev.map(m => {
                if (m.id === resolvedUserMsgId) return { ...m, id: realUserId };
                if (m.id === resolvedAssistantId) return { ...m, id: realAssistantId, parentId: realUserId };
                return m;
              }));
              setActiveLeafId(prev => prev === resolvedAssistantId ? realAssistantId : prev);
              resolvedUserMsgId = realUserId;
              resolvedAssistantId = realAssistantId;
              assistantTargetIds.add(previousAssistantId);
              assistantTargetIds.add(realAssistantId);
            } else if (evt.type === 'delta' || evt.type === 'final') {
              if (evt.type === 'final') {
                receivedFinal = true;
              }
              const patch = mapStreamingContentPatch(evt);
              queueAssistantPatch(patch, evt.type === 'final');
            } else if (evt.type === 'error') {
              receivedError = true;
              dropAssistantPatches();
              const errorUpdate = mapStreamingErrorUpdate(evt, `❌ ${t('common.error')}: ${evt.error || t('common.unknownError')}`);
              updateAssistantMessages(message => ({
                ...message,
                ...errorUpdate,
              }));
            }
          } catch {}
        }
        flushQueuedMessagePatches();
        if (!receivedError) {
          queueAssistantPatch({ processStreaming: false }, true);
        }
        if (!receivedFinal && !receivedError && !abortControllerRef.current?.signal.aborted) {
          // 没有终态事件 = 这轮回复没有正常收尾。先回历史对账，
          // 对账也拿不到完整版就必须说出来——静默展示半截内容是最伤信任的做法。
          const recovered = await recoverLatestChatMessages(true);
          if (!recovered) {
            setSubmitError(t('unifiedChat.replyMayBeIncomplete'));
          }
        }
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          dropAssistantPatches();
          const detail = typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : t('common.unknownError');
          const structuredError = createClientStructuredChatError(detail);
          setMessages(prev => {
            const hasTarget = prev.some(m => assistantTargetIds.has(m.id));
            if (hasTarget) {
              return prev.map(m => assistantTargetIds.has(m.id) ? { ...m, ...structuredError } : m);
            }
            return [...prev, { id: (Date.now() + 1).toString(), role: 'system', content: String(structuredError.content || ''), messageCode: structuredError.messageCode, rawDetail: structuredError.rawDetail, timestamp: new Date() }];
          });
        }
      } finally { flushQueuedMessagePatches(); abortControllerRef.current = null; setIsLoading(false); }
    } else if (isGroup) {
      try {
        const uploadedContent = await uploadFiles(currentFiles);
        let finalContent = currentInput;
        if (currentQuote) {
          const author = currentQuote.role === 'user' ? t('common.you') : (currentQuote.agentName || t('common.ai'));
          const time = formatQuoteTime(currentQuote.timestamp);
          finalContent = `[引用开始 author="${author}" time="${time}"]\n${currentQuote.content}\n[引用结束]\n\n${finalContent}`;
        }
        const fullMessage = [uploadedContent, finalContent].filter(Boolean).join('\n\n');
        if (!fullMessage) return;
        const response = await postGroupMessage(activeKey, {
            content: fullMessage,
            ...(structuredMentions ? { mentions: structuredMentions } : {}),
            queueCapability: roomQueueCapability(activeKey),
          });
        if (response.ok) saveRoomDraft(activeKey, '', []);
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          setInput(currentInput);
          mentionRangesRef.current = currentInput === input ? currentRanges : [];
          setPendingFiles(currentFiles);
          setQuotedMessage(currentQuote);
          setSubmitError(resolveSubmitError(payload || {}, t, 'unifiedChat.sendFailed'));
          if (payload?.runState) {
            setGroupRunState({
              active: !!payload.runState.active,
              agentId: typeof payload.runState.agentId === 'string' ? payload.runState.agentId : null,
              runId: typeof payload.runState.runId === 'string' ? payload.runState.runId : null,
              startedAt: typeof payload.runState.startedAt === 'number' ? payload.runState.startedAt : null,
            });
          }
          return;
        }
        setSubmitNotice(resolveGroupSendNotice(await response.json().catch(() => null), t, currentLocale));
      } catch (error: any) {
        setInput(currentInput);
        setPendingFiles(currentFiles);
        setQuotedMessage(currentQuote);
        setSubmitError(error?.message || t('unifiedChat.sendFailed'));
      } finally { setIsLoading(false); }
    }
  };

  const handleStop = async () => {
    if (isChat && activeKey) {
      try {
        const response = await stopChat(activeKey);
        if (response.ok) {
          await recoverLatestChatMessages(true);
        }
      } catch {}
      setIsLoading(false);
      return;
    }

    if (isGroup && activeKey) {
      try {
        const response = await stopGroupRun(activeKey);
        if (response.ok) {
          setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
          setTypingAgents(new Map());
          await recoverLatestGroupMessages(true);
          const recovery = await recoverGroupActiveRun();
          if (recovery.runState) {
            setGroupRunState(recovery.runState);
          } else {
            setGroupRunState({ active: false, agentId: null, runId: null, startedAt: null });
          }
          if (!recovery.active) {
            setTypingAgents(new Map());
          }
        }
      } catch {}
      return;
    }
  };

  // ---- Group mention input ----
  const handleGroupInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    mentionRangesRef.current = rebaseMentionRanges(input, val, mentionRangesRef.current);
    setInput(val);
    const cursorPos = e.target.selectionStart || 0;
    const atMatch = val.slice(0, cursorPos).match(/@([^\s@]*)$/);
    if (atMatch && currentGroup) { setMentionFilter(atMatch[1]); setShowMentionPopup(true); setMentionIndex(0); }
    else setShowMentionPopup(false);
  };
  const getFilteredMembers = () => currentGroup ? currentGroup.members.filter(m => resolveGroupMemberDisplayName(m).toLowerCase().includes(mentionFilter.toLowerCase())) : [];
  const insertMention = (name: string) => {
    const pos = textareaRef.current?.selectionStart || 0;
    // P3：选中的 @ 记成结构化区间（成员行 id），发送时变成结构化 @，改名 / 重名都不影响路由。
    const member = currentGroup?.members.find((m) => resolveGroupMemberDisplayName(m) === name);
    const inserted = insertMentionAt(input, pos, { memberId: member?.id ?? '', name }, mentionRangesRef.current);
    mentionRangesRef.current = member ? inserted.ranges : inserted.ranges.filter((range) => range.memberId);
    setInput(inserted.text);
    setShowMentionPopup(false); textareaRef.current?.focus();
    window.setTimeout(() => { const ta = textareaRef.current; if (ta) ta.selectionStart = ta.selectionEnd = inserted.cursor; }, 0);
  };

  // P3：每群草稿（30 天）。切群时先存上一个群的，再恢复这个群的；输入变化时防抖保存。
  const draftRoomRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const roomKey = isGroup ? activeKey : null;
    if (draftRoomRef.current === roomKey) return;
    draftRoomRef.current = roomKey;
    if (!roomKey) return;
    sweepRoomDrafts();
    const draft = loadRoomDraft(roomKey);
    mentionRangesRef.current = draft?.ranges ?? [];
    setInput(draft?.text ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, isGroup]);
  React.useEffect(() => {
    if (!isGroup || !activeKey || draftRoomRef.current !== activeKey) return;
    const timer = window.setTimeout(() => saveRoomDraft(activeKey, input, mentionRangesRef.current), 400);
    return () => window.clearTimeout(timer);
  }, [activeKey, input, isGroup]);

  // ---- Keyboard ----
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isGroup && showMentionPopup) {
      const filtered = getFilteredMembers();
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (filtered[mentionIndex]) insertMention(resolveGroupMemberDisplayName(filtered[mentionIndex])); }
      else if (e.key === 'Escape') setShowMentionPopup(false);
      return;
    }
    if (isChat && showCommands && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCommandIndex(prev => (prev + 1) % filteredCommands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCommandIndex(prev => (prev - 1 + filteredCommands.length) % filteredCommands.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); setInput(filteredCommands[commandIndex].command + ' '); setShowCommands(false); return; }
      if (e.key === 'Escape') { setShowCommands(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (justSelectedFileRef.current) { justSelectedFileRef.current = false; e.preventDefault(); return; }
      e.preventDefault(); handleSubmit();
    }
  };

  return {
    handleFileChange, removePendingFile, handleDrag, handleDrop, handlePaste, handleSubmit,
    handleStop, handleGroupInputChange, getFilteredMembers, insertMention, handleKeyDown,
  };
}
