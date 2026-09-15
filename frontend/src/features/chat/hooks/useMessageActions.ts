// 消息操作：复制、引用、删除、编辑保存、重新生成，以及附件上传。
import { useCallback } from 'react';
import { deleteMessage, updateMessage } from '../../../api/chat';
import {
  deleteGroupMessage, regenerateGroupMessage, updateGroupMessage,
} from '../../../api/groups';
import { regenerateChatMessage } from '../../../api/stream';
import { uploadFiles as uploadFilesRequest } from '../../../api/files';
import type { ChatMessage } from '../../../utils/message-merge';
import {
  isPersistedMessageId, mapStreamingErrorUpdate, mapHttpErrorResponse,
  createClientStructuredChatError, resolveSubmitError,
} from '../lib/messageMapping';
import type { ChatViewState } from './useChatViewState';
import type { ChatPresence } from './useChatPresence';
import type { MessagePatchQueue } from './useMessagePatchQueue';
import type { ChatHistoryFetch } from './useChatHistoryFetch';
import type { GroupEvents } from './useGroupEvents';

/** 本段读取的、由前面各段产出的值。 */
type MessageActionsContext = Pick<
  ChatViewState & ChatPresence & MessagePatchQueue & ChatHistoryFetch & GroupEvents,
  't' | 'sessions' | 'isChat' | 'isGroup' | 'activeKey' | 'setMessages' | 'isLoading' |
  'setIsLoading' | 'setSubmitError' | 'setActiveLeafId' | 'editingMessageId' |
  'setEditingMessageId' | 'editContent' | 'setEditContent' | 'editExistingAttachments' |
  'setEditExistingAttachments' | 'editPendingFiles' | 'setEditPendingFiles' | 'setCopiedId' |
  'setQuotedMessage' | 'setIsDeleteModalOpen' | 'messageToDelete' | 'setMessageToDelete' |
  'setDeleteErrorMessage' | 'textareaRef' | 'messagesRef' | 'forceAutoScrollRef' | 'currentGroup' |
  'getPreferredLeafId' | 'isGroupBusy' | 'focusMainInput' | 'flushQueuedMessagePatches' |
  'queueMessagePatch' | 'dropQueuedMessagePatch' | 'clearNewerHistoryWindowTrail' |
  'moveQueuedMessagePatch' | 'recoverLatestChatMessages' | 'recoverLatestGroupMessages'
>;

export function useMessageActions(c: MessageActionsContext) {
  const {
    t, sessions, isChat, isGroup, activeKey, setMessages, isLoading, setIsLoading, setSubmitError,
    setActiveLeafId, editingMessageId, setEditingMessageId, editContent, setEditContent,
    editExistingAttachments, setEditExistingAttachments, editPendingFiles, setEditPendingFiles,
    setCopiedId, setQuotedMessage, setIsDeleteModalOpen, messageToDelete, setMessageToDelete,
    setDeleteErrorMessage, textareaRef, messagesRef, forceAutoScrollRef, currentGroup,
    getPreferredLeafId, isGroupBusy, focusMainInput, flushQueuedMessagePatches, queueMessagePatch,
    dropQueuedMessagePatch, clearNewerHistoryWindowTrail, moveQueuedMessagePatch,
    recoverLatestChatMessages, recoverLatestGroupMessages,
  } = c;
  // =============== HANDLERS ===============

  const handleCopy = (text: string, id: string) => {
    const doCopy = (t: string) => {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(t).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); })
          .catch(() => fallbackCopy(t));
      } else fallbackCopy(t);
    };
    const fallbackCopy = (t: string) => {
      const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); } catch {}
      document.body.removeChild(ta);
    };
    doCopy(text);
  };

  const resetEditComposer = useCallback(() => {
    setEditingMessageId(null);
    setEditContent('');
    setEditExistingAttachments([]);
    setEditPendingFiles([]);
  }, []);

  const handleQuote = (msg: ChatMessage) => { setQuotedMessage(msg); textareaRef.current?.focus(); };

  const handleDeleteMessage = (msgId: string) => {
    setDeleteErrorMessage('');
    setMessageToDelete(msgId);
    setIsDeleteModalOpen(true);
  };

  const confirmDeleteMessage = async () => {
    if (!messageToDelete) return;
    let didDelete = false;
    try {
      clearNewerHistoryWindowTrail();
      if (isChat) {
        const res = await deleteMessage(messageToDelete);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data?.error === 'string' ? data.error : '');
        }
        const deletedIds = Array.isArray(data?.deletedIds)
          ? new Set<string>(data.deletedIds.map((id: number | string) => String(id)))
          : new Set<string>([messageToDelete]);
        setMessages(prev => prev.filter(m => !deletedIds.has(m.id)));
        didDelete = true;
      } else if (isGroup && currentGroup) {
        const res = await deleteGroupMessage(currentGroup.id, messageToDelete);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data?.error === 'string' ? data.error : '');
        }
        const deletedIds = Array.isArray(data?.deletedIds)
          ? new Set<string>(data.deletedIds.map((id: number | string) => String(id)))
          : new Set<string>([messageToDelete]);
        const fallbackParentId = typeof data?.fallbackParentId === 'number' || typeof data?.fallbackParentId === 'string'
          ? String(data.fallbackParentId)
          : null;
        setMessages(prev => {
          const nextMessages = prev.filter((message) => !deletedIds.has(message.id));
          setActiveLeafId((prevLeaf) => {
            if (!prevLeaf || !deletedIds.has(prevLeaf)) {
              return prevLeaf;
            }
            if (fallbackParentId && nextMessages.some((message) => message.id === fallbackParentId)) {
              return fallbackParentId;
            }
            return getPreferredLeafId(nextMessages);
          });
          return nextMessages;
        });
        didDelete = true;
      }
    } catch (error: any) {
      const detail = typeof error?.message === 'string' ? error.message.trim() : '';
      setDeleteErrorMessage(detail ? `${t('unifiedChat.deleteMessageFailed')}\n${detail}` : t('unifiedChat.deleteMessageFailed'));
    } finally {
      if (didDelete) {
        setDeleteErrorMessage('');
        setIsDeleteModalOpen(false);
        setMessageToDelete(null);
      }
    }
  };

  const handleSaveEdit = async () => {
    if (!editingMessageId) return;
    const targetMessageId = editingMessageId;
    const currentEditContent = editContent.trim();
    const currentExistingAttachments = [...editExistingAttachments];
    const currentPendingFiles = [...editPendingFiles];
    clearNewerHistoryWindowTrail();

    const serializeAttachmentMarkdown = (attachment: { name?: string; url: string; isImage?: boolean }) => {
      const attachmentName = attachment.name?.trim() || t('common.file');
      return `${attachment.isImage ? '!' : ''}[${attachmentName}](${attachment.url})`;
    };

    const existingAttachmentContent = currentExistingAttachments
      .map((attachment) => serializeAttachmentMarkdown(attachment))
      .join('\n');
    const uploadedAttachmentContent = currentPendingFiles.length > 0
      ? await uploadFiles(currentPendingFiles)
      : '';
    const nextContent = [existingAttachmentContent, uploadedAttachmentContent, currentEditContent]
      .filter(Boolean)
      .join('\n\n');

    if (!nextContent) return;

    // Optimistic UI Update
    setMessages(prev => prev.map(m => m.id === targetMessageId ? { ...m, content: nextContent } : m));

    const currentMessages = messagesRef.current;
    const editedMsg = currentMessages.find(m => m.id === targetMessageId);

    resetEditComposer();
    focusMainInput();

    if (isChat) {
      try {
        await updateMessage(targetMessageId, { content: nextContent });
        
        // Auto-regenerate if it's a user message
        if (editedMsg && editedMsg.role === 'user') {
          const latestReply = [...currentMessages].reverse().find(message =>
            (message.role === 'assistant' || message.role === 'system')
            && message.parentId === targetMessageId
          );
          const regenerateTarget = latestReply ?? ({ id: `dummy-${Date.now()}`, role: 'assistant', parentId: targetMessageId } as ChatMessage);
          await handleRegenerate(
            regenerateTarget,
            nextContent,
            {
              explicitParentId: targetMessageId,
              targetMessageId: latestReply && isPersistedMessageId(latestReply.id)
                ? latestReply.id
                : targetMessageId,
            },
          );
        }
      } catch {}
    } else if (isGroup && currentGroup) {
      try {
        const response = await updateGroupMessage(currentGroup.id, targetMessageId, { content: nextContent });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(typeof data?.error === 'string' ? data.error : '');
        }
      } catch {
        await recoverLatestGroupMessages(true);
      }
    }
  };

  const handleRegenerate = async (
    msg: ChatMessage,
    customParentContent?: string,
    options?: {
      explicitParentId?: string;
      targetMessageId?: string;
    },
  ) => {
    if (isChat) {
      const tempId = `temp-${Date.now()}`;
      let resolvedId = tempId;
      const assistantTargetIds = new Set<string>([tempId]);
      const queueAssistantPatch = (patch: Partial<ChatMessage>, flush = false) => {
        assistantTargetIds.forEach((messageId) => queueMessagePatch(messageId, patch));
        if (flush) flushQueuedMessagePatches();
      };
      const dropAssistantPatches = () => {
        assistantTargetIds.forEach((messageId) => dropQueuedMessagePatch(messageId));
      };
      const updateAssistantMessages = (updater: (message: ChatMessage) => ChatMessage) => {
        setMessages(prev => prev.map(message => assistantTargetIds.has(message.id) ? updater(message) : message));
      };
      const currentMessages = messagesRef.current;
      let parentId = options?.explicitParentId || msg.parentId;
      const requestTargetMessageId = options?.targetMessageId || msg.id;
      if (!parentId) { const idx = currentMessages.findIndex(m => m.id === msg.id); if (idx > 0) parentId = currentMessages[idx - 1]?.id; }
      if (isLoading || !activeKey || !parentId) return;
      clearNewerHistoryWindowTrail();
      setIsLoading(true);
      try {
        const parentUserMsg = currentMessages.find(m => m.id === parentId);
        const contentStr = customParentContent || parentUserMsg?.content || 'Continue';
        const currentSession = sessions.find(s => s.id === activeKey);
        const shouldShowProcessPlaceholder = !!(currentSession?.process_start_tag && currentSession?.process_end_tag);
        forceAutoScrollRef.current = true;
        setMessages(prev => [
          ...prev.filter(message => message.id !== msg.id),
          { id: tempId, role: 'assistant', content: '', processStreaming: shouldShowProcessPlaceholder, timestamp: new Date(), model: currentSession?.model || msg.model, agentName: currentSession?.name || msg.agentName, parentId },
        ]);
        setActiveLeafId(tempId);
        const response = await regenerateChatMessage({
            message: contentStr,
            sessionId: activeKey,
            parentId,
            ...(isPersistedMessageId(requestTargetMessageId) ? { targetMessageId: requestTargetMessageId } : {}),
          });
        if (!response.ok || !response.body) {
          dropAssistantPatches();
          const fallbackContent = `❌ ${t('common.error')}: ${t('unifiedChat.requestFailed')}`;
          const errorUpdate = await mapHttpErrorResponse(response, fallbackContent);
          updateAssistantMessages(message => ({ ...message, ...errorUpdate }));
          return;
        }
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        let receivedFinal = false;
        let receivedError = false;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'ids' && evt.assistantMsgId) {
                const previousResolvedId = resolvedId;
                moveQueuedMessagePatch(resolvedId, String(evt.assistantMsgId));
                setMessages(prev => prev.map(m => m.id === resolvedId ? { ...m, id: String(evt.assistantMsgId) } : m));
                setActiveLeafId(prev => prev === resolvedId ? String(evt.assistantMsgId) : prev);
                resolvedId = String(evt.assistantMsgId);
                assistantTargetIds.add(previousResolvedId);
                assistantTargetIds.add(resolvedId);
              } else if (evt.type === 'delta' || evt.type === 'final') {
                if (evt.type === 'final') {
                  receivedFinal = true;
                }
                const patch: Partial<ChatMessage> = {
                  content: typeof evt.text === 'string' ? evt.text : '',
                };
                if (typeof evt.process_content === 'string') {
                  patch.processContent = evt.process_content;
                }
                if (typeof evt.process_streaming === 'boolean') {
                  patch.processStreaming = evt.process_streaming;
                } else if (evt.type === 'final') {
                  patch.processStreaming = false;
                }
                if (typeof evt.modelUsed === 'string') {
                  patch.model = evt.modelUsed;
                } else if (typeof evt.model_used === 'string') {
                  patch.model = evt.model_used;
                }
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
        }
        flushQueuedMessagePatches();
        if (!receivedError && receivedFinal) {
          queueAssistantPatch({ processStreaming: false }, true);
        }
        if (!receivedFinal && !receivedError) {
          const recovered = await recoverLatestChatMessages(true);
          if (!recovered) setSubmitError(t('unifiedChat.replyMayBeIncomplete'));
        }
      } catch (error: any) {
        if (error?.name !== 'AbortError') {
          dropAssistantPatches();
          const detail = typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : t('unifiedChat.requestFailed');
          const structuredError = createClientStructuredChatError(detail);
          updateAssistantMessages(message => ({ ...message, ...structuredError }));
        }
      } finally { flushQueuedMessagePatches(); setIsLoading(false); }
    } else if (isGroup && currentGroup) {
      if (isLoading || isGroupBusy) return;
      clearNewerHistoryWindowTrail();
      setIsLoading(true);
      try {
        await regenerateGroupMessage(currentGroup.id, { msgId: Number(msg.id) });
        // Wait a moment for the SSE stream to deliver the new message, then reload
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch {} finally { setIsLoading(false); }
    }
  };

  // ---- Upload files helper ----
  const uploadFiles = async (filesToUpload: {file: File, preview: string}[]): Promise<string> => {
    if (filesToUpload.length === 0) return '';
    const fd = new FormData();
    if (isChat) {
      fd.append('contextType', 'session');
      fd.append('sessionId', activeKey);
    } else {
      fd.append('contextType', 'group');
      fd.append('groupId', activeKey);
    }
    filesToUpload.forEach(f => fd.append('files', f.file));
    const upRes = await uploadFilesRequest(fd);
    const upData = await upRes.json().catch(() => null);
    if (upData?.success && upData.files) {
      return upData.files.map((f: any) => {
        const isImage = f.mimeType?.startsWith('image/');
        const name = f.name || f.originalname || t('common.file');
        return isImage ? `![${name}](${f.url})` : `[${name}](${f.url})`;
      }).join('\n');
    }
    // 上传失败必须抛，不能返回空串。返回空串的后果是：附件被静默丢掉，
    // 消息照发——用户以为文件发出去了，模型那头什么也没收到。
    throw new Error(resolveSubmitError(upData || {}, t, 'unifiedChat.uploadFailed'));
  };

  return {
    handleCopy, resetEditComposer, handleQuote, handleDeleteMessage, confirmDeleteMessage,
    handleSaveEdit, handleRegenerate, uploadFiles,
  };
}

export type MessageActions = ReturnType<typeof useMessageActions>;
