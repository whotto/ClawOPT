// 单聊进入时接回仍在运行的 run 并继续读流。
import { useEffect } from 'react';
import { attachChatRun } from '../../../api/stream';
import { getRealtimeClient } from '../../../api/ws';
import { readChatStreamTransport } from '../../../utils/chatStreamTransport';
import { openChatAttachStream } from '../lib/chatStream';
import type { ChatMessage } from '../../../utils/message-merge';
import { mapStreamingContentPatch, mapStreamingErrorUpdate, createClientStructuredChatError } from '../lib/messageMapping';
import type { ChatViewState } from './useChatViewState';
import type { MessagePatchQueue } from './useMessagePatchQueue';
import type { ChatHistoryFetch } from './useChatHistoryFetch';

/** 本段读取的、由前面各段产出的值。 */
type ChatAttachRunContext = Pick<
  ChatViewState & MessagePatchQueue & ChatHistoryFetch,
  't' | 'isChat' | 'activeKey' | 'setMessages' | 'setIsLoading' | 'setSubmitError' |
  'isInitialLoading' | 'attachedRunControllerRef' | 'messagesRef' | 'activeLeafIdRef' |
  'flushQueuedMessagePatches' | 'queueMessagePatch' | 'dropQueuedMessagePatch' |
  'recoverLatestChatMessages'
>;

export function useChatAttachRun(c: ChatAttachRunContext) {
  const {
    t, isChat, activeKey, setMessages, setIsLoading, setSubmitError, isInitialLoading,
    attachedRunControllerRef, messagesRef, activeLeafIdRef, flushQueuedMessagePatches,
    queueMessagePatch, dropQueuedMessagePatch, recoverLatestChatMessages,
  } = c;
  useEffect(() => {
    if (!isChat || !activeKey || isInitialLoading) return;

    attachedRunControllerRef.current?.abort();
    const controller = new AbortController();
    attachedRunControllerRef.current = controller;

    let attachedMessageId: string | null = null;

    const resolveAttachedMessageId = (rawMessageId: unknown): string | null => {
      if (rawMessageId !== null && rawMessageId !== undefined) {
        return String(rawMessageId);
      }

      const activeLeafId = activeLeafIdRef.current;
      if (activeLeafId) {
        const activeLeafMessage = messagesRef.current.find((message) => message.id === activeLeafId);
        if (activeLeafMessage && activeLeafMessage.role !== 'user') {
          return activeLeafId;
        }
      }

      const latestAssistantMessage = [...messagesRef.current]
        .reverse()
        .find((message) => message.role !== 'user');

      return latestAssistantMessage?.id || null;
    };

    const queueAttachedPatch = (patch: Partial<ChatMessage>, flush = false) => {
      if (!attachedMessageId) return;
      queueMessagePatch(attachedMessageId, patch);
      if (flush) flushQueuedMessagePatches();
    };

    const updateAttachedMessage = (updater: (message: ChatMessage) => ChatMessage) => {
      if (!attachedMessageId) return;
      setMessages((prev) => prev.map((message) => (
        message.id === attachedMessageId ? updater(message) : message
      )));
    };

    const attachActiveRun = async () => {
      try {
        const attached = await openChatAttachStream({
          transport: readChatStreamTransport(),
          sessionId: activeKey,
          client: getRealtimeClient,
          attachOverHttp: () => attachChatRun(activeKey, controller.signal),
          signal: controller.signal,
        });

        if (attached.kind === 'inactive') {
          const latestAssistantMessage = [...messagesRef.current]
            .reverse()
            .find((message) => message.role !== 'user');
          if (latestAssistantMessage && !String(latestAssistantMessage.content || '').trim()) {
            await recoverLatestChatMessages(true);
          }
          setIsLoading(false);
          return;
        }

        if (attached.kind === 'failed') {
          return;
        }

        setIsLoading(true);
        let receivedFinal = false;
        let receivedError = false;

        for await (const evt of attached.events) {
          try {
            if (evt.type === 'attached') {
              attachedMessageId = resolveAttachedMessageId(evt.messageId);
              if (attachedMessageId) {
                queueAttachedPatch({
                  agentId: typeof evt.agentId === 'string' ? evt.agentId : undefined,
                  agentName: typeof evt.agentName === 'string' ? evt.agentName : undefined,
                  model: typeof evt.modelUsed === 'string' ? evt.modelUsed : undefined,
                }, true);
              }
            } else if (evt.type === 'delta' || evt.type === 'final') {
              if (evt.type === 'final') {
                receivedFinal = true;
              }
              const patch = mapStreamingContentPatch(evt);
              queueAttachedPatch(patch, evt.type === 'final');
            } else if (evt.type === 'error') {
              receivedError = true;
              if (!attachedMessageId) continue;
              dropQueuedMessagePatch(attachedMessageId);
              const errorUpdate = mapStreamingErrorUpdate(evt, `❌ ${t('common.error')}: ${t('common.unknownError')}`);
              updateAttachedMessage((message) => ({ ...message, ...errorUpdate }));
            }
          } catch {}
        }

        flushQueuedMessagePatches();
        if (!controller.signal.aborted && !receivedFinal && !receivedError) {
          const recovered = await recoverLatestChatMessages(true);
          if (!recovered) setSubmitError(t('unifiedChat.replyMayBeIncomplete'));
        }
      } catch (error: any) {
        if (error?.name !== 'AbortError' && attachedMessageId) {
          dropQueuedMessagePatch(attachedMessageId);
          const detail = typeof error?.message === 'string' && error.message.trim()
            ? error.message
            : t('common.unknownError');
          const structuredError = createClientStructuredChatError(detail);
          updateAttachedMessage((message) => ({ ...message, ...structuredError }));
        }
      } finally {
        flushQueuedMessagePatches();
        if (attachedRunControllerRef.current === controller) {
          attachedRunControllerRef.current = null;
        }
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void attachActiveRun();

    return () => {
      controller.abort();
      if (attachedRunControllerRef.current === controller) {
        attachedRunControllerRef.current = null;
      }
    };
  }, [activeKey, dropQueuedMessagePatch, flushQueuedMessagePatches, isChat, isInitialLoading, queueMessagePatch, recoverLatestChatMessages, t]);
}
