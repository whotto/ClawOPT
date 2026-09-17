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
import type { ChatRunControl } from './useChatRunControl';
import { createClientTurnId } from '../run/chatRunState';
import { buildQuotedMessage, quotableContent } from '../lib/composerCommands';
import { isSilentFailure, shouldSendOnEnter } from '../lib/composerPrefs';
import { attachmentNotesMarkdown, extractVideoFrames, pastedFileName, withoutDuplicates, type PendingAttachment } from '../lib/composerAttachments';
import { swapMessageIds } from '../lib/messageIds';

/** 本段读取的、由前面各段产出的值。 */
type ComposerActionsContext = Pick<
  ChatViewState & ChatPresence & MessagePatchQueue & HistoryScroll & ChatHistoryFetch & GroupEvents & MessageActions & ChatRunControl,
  't' | 'sessions' | 'isChat' | 'isGroup' | 'activeKey' | 'setMessages' | 'input' | 'setInput' |
  'isLoading' | 'setIsLoading' | 'setSubmitError' | 'setSubmitNotice' | 'currentLocale' | 'setActiveLeafId' | 'editingMessageId' |
  'pendingFiles' | 'setPendingFiles' | 'pendingFilesRef' | 'frameJobsRef' | 'isDragging' | 'setIsDragging' | 'quotedMessage' |
  'setQuotedMessage' | 'setFileErrorModalOpen' | 'setFileErrorMessage' | 'currentModel' |
  'showCommands' | 'setShowCommands' | 'filteredCommands' | 'commandIndex' | 'setCommandIndex' |
  'setTypingAgents' | 'setGroupRunState' | 'showMentionPopup' | 'setShowMentionPopup' |
  'mentionFilter' | 'setMentionFilter' | 'mentionIndex' | 'setMentionIndex' | 'textareaRef' |
  'abortControllerRef' | 'justSelectedFileRef' | 'dragCounter' | 'forceAutoScrollRef' |
  'currentGroup' | 'activeSessionName' | 'resolveGroupMemberDisplayName' | 'isGroupBusy' |
  'flushQueuedMessagePatches' | 'queueMessagePatch' | 'dropQueuedMessagePatch' |
  'moveQueuedMessagePatch' | 'scrollToLatestBottom' | 'prepareLatestHistoryWindowForSubmit' |
  'recoverLatestChatMessages' | 'recoverGroupActiveRun' | 'recoverLatestGroupMessages' |
  'uploadFiles' | 'locallyStreamedRefsRef' | 'refreshRunState' | 'requestAttach' | 'waitForRunTerminal'
>;

export function useComposerActions(c: ComposerActionsContext) {
  const mentionRangesRef = React.useRef<MentionRange[]>([]);
  const {
    t, sessions, isChat, isGroup, activeKey, setMessages, input, setInput, isLoading, setIsLoading,
    setSubmitError, setSubmitNotice, currentLocale, setActiveLeafId, editingMessageId, pendingFiles, setPendingFiles, pendingFilesRef, frameJobsRef, isDragging,
    setIsDragging, quotedMessage, setQuotedMessage, setFileErrorModalOpen, setFileErrorMessage,
    currentModel, showCommands, setShowCommands, filteredCommands, commandIndex, setCommandIndex,
    setTypingAgents, setGroupRunState, showMentionPopup, setShowMentionPopup, mentionFilter,
    setMentionFilter, mentionIndex, setMentionIndex, textareaRef, abortControllerRef,
    justSelectedFileRef, dragCounter, forceAutoScrollRef, currentGroup, activeSessionName,
    resolveGroupMemberDisplayName, flushQueuedMessagePatches,
    queueMessagePatch, dropQueuedMessagePatch, moveQueuedMessagePatch, scrollToLatestBottom,
    prepareLatestHistoryWindowForSubmit, recoverLatestChatMessages, recoverGroupActiveRun,
    recoverLatestGroupMessages, uploadFiles, locallyStreamedRefsRef, refreshRunState, requestAttach, waitForRunTerminal,
  } = c;
  /** 用户点了停止：这一轮之后空着的气泡不是「静默失败」。 */
  const userStoppedRef = React.useRef(false);
  // ---- File handling ----
  const handleFileChange = async (incomingFiles: File[], source: 'picker' | 'paste' | 'drop' = 'picker') => {
    if (!incomingFiles.length) return;

    const IMAGE_TARGET_SIZE = 4_500_000; // 4.5MB target for images

    const processedFiles: PendingAttachment[] = [];
    const errors: string[] = [];
    // 粘贴的图片名字都是 image.png 这类通用名：改名，免得一条消息里几张图同名。
    const taken = new Set(pendingFilesRef.current.map((item) => item.file.name));
    const files = incomingFiles.map((file) => {
      if (source !== 'paste') return file;
      const name = pastedFileName(file, taken);
      taken.add(name);
      return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
    });

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
    const fresh = withoutDuplicates(pendingFilesRef.current, processedFiles);
    if (fresh.length > 0) {
      justSelectedFileRef.current = true;
      setTimeout(() => { justSelectedFileRef.current = false; }, 500);
      setPendingFiles(prev => [...prev, ...withoutDuplicates(prev, fresh)]);
      // 视频：保留原视频，另在浏览器里抽最多 3 张代表帧作为隐藏附件（看不了视频的模型也能看到画面）。
      for (const item of fresh.filter((entry) => entry.file.type.startsWith('video/'))) {
        const videoName = item.file.name;
        const job = extractVideoFrames(item.file).then((frames) => {
          if (frames.length === 0) return;
          setPendingFiles(prev => prev.some((entry) => entry.file.name === videoName && !entry.frameOf)
            ? [...prev, ...frames.map((frame) => ({ file: frame, preview: '', frameOf: videoName }))]
            : prev);
        }).finally(() => { frameJobsRef.current.delete(videoName); });
        frameJobsRef.current.set(videoName, job);
      }
    }
  };
  const removePendingFile = (index: number) => {
    setPendingFiles(prev => {
      const target = prev[index];
      if (!target) return prev;
      if (target.preview) URL.revokeObjectURL(target.preview);
      // 删视频连同它的代表帧一起删。
      return prev.filter((entry, i) => i !== index && entry.frameOf !== target.file.name);
    });
  };
  const setPendingFileNote = (index: number, note: string) => {
    setPendingFiles(prev => prev.map((entry, i) => (i === index ? { ...entry, note } : entry)));
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
    if (e.dataTransfer.files?.length > 0) handleFileChange(Array.from(e.dataTransfer.files), 'drop');
  };
  const handlePaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData?.files.length > 0) { e.preventDefault(); handleFileChange(Array.from(e.clipboardData.files), 'paste'); }
  };

  /**
   * 发出去的正文：附件链接 + 输入；有引用时整条包进 `<quoted_message sender="…">…</quoted_message>` 之后（包裹必须在最前面，
   * 气泡才认得出来）。命令（以 / 开头）从不带引用。
   */
  const composeOutgoingMessage = (uploadedContent: string, currentInput: string, currentQuote: ChatMessage | null, files: PendingAttachment[] = []): string => {
    const body = [uploadedContent, attachmentNotesMarkdown(files), currentInput].filter(Boolean).join('\n\n');
    if (!currentQuote) return body;
    const sender = currentQuote.role === 'user' ? String(t('common.you')) : (currentQuote.agentName || String(t('common.ai')));
    return buildQuotedMessage({ sender, content: quotableContent(currentQuote.content, currentQuote.role) }, body);
  };

  // ---- Send message ----
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    // 单聊回复中：不挡，排进服务端队列（P1b）；群聊有人在跑也不挡，服务端按每个 Agent 排队（P3）。
    if ((!input.trim() && pendingFiles.length === 0 && !quotedMessage) || (isLoading && !isChat && !isGroup)) return;
    setSubmitError('');
    setSubmitNotice('');
    // 结构化 @ 要按未裁剪的原文核对区间（裁掉前导空白会让区间错位）。
    const structuredMentions = isGroup ? buildStructuredMentions(input, mentionRangesRef.current) : undefined;
    const currentRanges = mentionRangesRef.current;
    mentionRangesRef.current = [];
    // 视频抽帧还没完成：等它（抽帧失败也会结束），再读最新的待发列表。
    if (frameJobsRef.current.size > 0) await Promise.all([...frameJobsRef.current.values()]);
    const currentInput = input.trim(); const currentFiles = [...pendingFilesRef.current]; const currentQuote = quotedMessage;

    if (isChat && isLoading) {
      // 正在回复：不打断，排进服务端队列（队列面板里可取消、可立即插入）。出队时由会话实时通道补进时间线。
      setInput(''); setPendingFiles([]); setQuotedMessage(null);
      const restoreDraft = () => { setInput(currentInput); setPendingFiles(currentFiles); setQuotedMessage(currentQuote); };
      try {
        const uploadedContent = await uploadFiles(currentFiles);
        const fullMessage = composeOutgoingMessage(uploadedContent, currentInput, currentQuote, currentFiles);
        if (!fullMessage) return;
        const response = await postChatMessage({ sessionId: activeKey, message: fullMessage, queue: true, clientTurnId: createClientTurnId() });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          restoreDraft();
          setSubmitError(resolveSubmitError(payload || {}, t, 'chatQueue.queueFailed'));
          return;
        }
        // 判忙与提交之间上一轮刚好结束：这一条直接开始了，接回它的流。
        if (payload?.started) requestAttach();
      } catch (error: any) {
        restoreDraft();
        setSubmitError(error?.message || String(t('chatQueue.queueFailed')));
      } finally {
        void refreshRunState();
      }
      return;
    }

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
        const fullMessage = composeOutgoingMessage(uploadedContent, currentInput, currentQuote, currentFiles);
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
        const clientTurnId = createClientTurnId();
        locallyStreamedRefsRef.current.add(clientTurnId);
        const stream = await openChatTurnStream({
          transport: readChatStreamTransport(),
          sessionId: activeKey,
          client: getRealtimeClient,
          // 带 queue：万一另一个标签页刚开始了一轮，这一条排队而不是把那一轮打断。
          post: (headers) => postChatMessage({ sessionId: activeKey, message: fullMessage, queue: true, clientTurnId }, controller.signal, headers),
          signal: controller.signal,
        });
        if (stream.ok === 'queued') {
          locallyStreamedRefsRef.current.delete(clientTurnId);
          dropAssistantPatches();
          setMessages(prev => prev.filter(message => message.id !== userMessageId && !assistantTargetIds.has(message.id)));
          void refreshRunState();
          return;
        }
        if (!stream.ok) {
          dropAssistantPatches();
          const fallbackContent = `❌ ${t('common.error')}: ${t('unifiedChat.requestFailed')}`;
          const errorUpdate = await mapHttpErrorResponse(stream.response, fallbackContent);
          updateAssistantMessages(message => ({ ...message, ...errorUpdate }));
          return;
        }
        let receivedFinal = false;
        let receivedError = false;
        let finalFrame: any = null;
        let accumulatedText = '';
        let accumulatedProcess = '';
        userStoppedRef.current = false;
        for await (const evt of stream.events) {
          try {
            if (evt.type === 'ids') {
              // Replace temp IDs with real DB IDs
              const previousAssistantId = resolvedAssistantId;
              const realUserId = String(evt.userMsgId);
              const realAssistantId = String(evt.assistantMsgId);
              const previousUserId = resolvedUserMsgId;
              moveQueuedMessagePatch(previousUserId, realUserId);
              moveQueuedMessagePatch(previousAssistantId, realAssistantId);
              // 旧 id 先取成常量：更新函数稍后才执行，那时 resolved* 已经是真 id 了（见 lib/messageIds.ts）。
              setMessages(prev => swapMessageIds(prev, [
                { from: previousUserId, to: realUserId },
                { from: previousAssistantId, to: realAssistantId, parentId: realUserId },
              ]));
              setActiveLeafId(prev => prev === previousAssistantId ? realAssistantId : prev);
              resolvedUserMsgId = realUserId;
              resolvedAssistantId = realAssistantId;
              assistantTargetIds.add(previousAssistantId);
              assistantTargetIds.add(realAssistantId);
            } else if (evt.type === 'delta' || evt.type === 'final') {
              if (evt.type === 'final') {
                receivedFinal = true;
                finalFrame = evt;
              }
              if (typeof evt.text === 'string' && evt.text.trim()) accumulatedText = evt.text;
              if (typeof evt.process_content === 'string' && evt.process_content.trim()) accumulatedProcess = evt.process_content;
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
        const assistantDbId = Number(resolvedAssistantId);
        if (
          receivedFinal && !receivedError && Number.isFinite(assistantDbId)
          && isSilentFailure({ role: finalFrame?.role, messageCode: finalFrame?.messageCode, content: accumulatedText, processContent: accumulatedProcess }, { stopped: userStoppedRef.current || !!abortControllerRef.current?.signal.aborted })
          && await waitForRunTerminal(assistantDbId, 1500) === 'run.completed'
        ) {
          // 正常收尾却什么都没说：不留空气泡，说清楚可能的原因（密钥、模型不支持、上下文超长）。
          dropAssistantPatches();
          updateAssistantMessages(message => ({ ...message, role: 'system', content: String(t('chat.emptyOutput')), messageCode: 'chat.emptyOutput', processStreaming: false }));
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
        const fullMessage = composeOutgoingMessage(uploadedContent, currentInput, currentQuote, currentFiles);
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
    userStoppedRef.current = true;
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
    if (shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: (e.nativeEvent as KeyboardEvent).isComposing, keyCode: e.keyCode })) {
      if (justSelectedFileRef.current) { justSelectedFileRef.current = false; e.preventDefault(); return; }
      e.preventDefault(); handleSubmit();
    }
  };

  return {
    handleFileChange, removePendingFile, setPendingFileNote, handleDrag, handleDrop, handlePaste, handleSubmit,
    handleStop, handleGroupInputChange, getFilteredMembers, insertMention, handleKeyDown,
  };
}
