// 流式增量的批量合并队列：40ms 攒一批再落 state，合并走 mergeMessagePreservingContent（正文只增不减）。
import { useCallback } from 'react';
import {
  type ChatMessage, mergeMessagePreservingContent, mergeMessagePatchPreservingContent,
} from '../../../utils/message-merge';
import { STREAM_UPDATE_BATCH_MS } from '../lib/constants';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type MessagePatchQueueContext = Pick<
  ChatViewState,
  'setMessages' | 'queuedMessagePatchesRef' | 'queuedMessagePatchTimerRef' |
  'newerHistoryPagesRef'
>;

export function useMessagePatchQueue(c: MessagePatchQueueContext) {
  const {
    setMessages, queuedMessagePatchesRef, queuedMessagePatchTimerRef, newerHistoryPagesRef,
  } = c;
  const flushQueuedMessagePatches = useCallback(() => {
    if (queuedMessagePatchTimerRef.current !== null) {
      window.clearTimeout(queuedMessagePatchTimerRef.current);
      queuedMessagePatchTimerRef.current = null;
    }

    const queuedEntries = Array.from(queuedMessagePatchesRef.current.entries());
    if (queuedEntries.length === 0) return;

    queuedMessagePatchesRef.current.clear();
    const queuedMap = new Map(queuedEntries);

    setMessages(prev => {
      let hasChanges = false;
      const next = prev.map(message => {
        const patch = queuedMap.get(message.id);
        if (!patch) return message;
        const merged = mergeMessagePreservingContent(message, patch);
        if (merged !== message) {
          hasChanges = true;
        }
        return merged;
      });
      return hasChanges ? next : prev;
    });
  }, []);

  const scheduleQueuedMessagePatchFlush = useCallback(() => {
    if (queuedMessagePatchTimerRef.current !== null) return;
    queuedMessagePatchTimerRef.current = window.setTimeout(() => {
      queuedMessagePatchTimerRef.current = null;
      flushQueuedMessagePatches();
    }, STREAM_UPDATE_BATCH_MS);
  }, [flushQueuedMessagePatches]);

  const queueMessagePatch = useCallback((messageId: string, patch: Partial<ChatMessage>) => {
    const existing = queuedMessagePatchesRef.current.get(messageId) || {};
    queuedMessagePatchesRef.current.set(messageId, mergeMessagePatchPreservingContent(existing, patch));
    scheduleQueuedMessagePatchFlush();
  }, [scheduleQueuedMessagePatchFlush]);

  const clearQueuedMessagePatches = useCallback(() => {
    if (queuedMessagePatchTimerRef.current !== null) {
      window.clearTimeout(queuedMessagePatchTimerRef.current);
      queuedMessagePatchTimerRef.current = null;
    }
    queuedMessagePatchesRef.current.clear();
  }, []);

  const dropQueuedMessagePatch = useCallback((messageId: string) => {
    queuedMessagePatchesRef.current.delete(messageId);
  }, []);

  const clearNewerHistoryWindowTrail = useCallback(() => {
    newerHistoryPagesRef.current = [];
  }, []);

  const moveQueuedMessagePatch = useCallback((fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return;
    const fromPatch = queuedMessagePatchesRef.current.get(fromId);
    if (!fromPatch) return;
    const existingTargetPatch = queuedMessagePatchesRef.current.get(toId) || {};
    queuedMessagePatchesRef.current.set(toId, mergeMessagePatchPreservingContent(existingTargetPatch, fromPatch));
    queuedMessagePatchesRef.current.delete(fromId);
  }, []);

  return {
    flushQueuedMessagePatches, scheduleQueuedMessagePatchFlush, queueMessagePatch,
    clearQueuedMessagePatches, dropQueuedMessagePatch, clearNewerHistoryWindowTrail,
    moveQueuedMessagePatch,
  };
}

export type MessagePatchQueue = ReturnType<typeof useMessagePatchQueue>;
