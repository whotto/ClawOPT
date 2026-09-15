// 输入区上方的排队浮层：回复进行中发出的消息排在服务端队列里，可取消、可「立即插入」。
import { ArrowUpToLine, ListOrdered, Loader2, X } from 'lucide-react';
import type { ChatController } from '../hooks/useChatController';
import { canInsertQueuedItem } from '../run/chatRunState';

type QueuePanelProps = Pick<ChatController, 't' | 'isChat' | 'runState' | 'cancelQueued' | 'insertQueued' | 'insertPendingQueueId'>;

export function QueuePanel({ t, isChat, runState, cancelQueued, insertQueued, insertPendingQueueId }: QueuePanelProps) {
  if (!isChat || runState.queue.length === 0) return null;
  const insertion = runState.insertion;
  const insertAllowed = canInsertQueuedItem(runState) && !insertPendingQueueId;
  return (
    <div className="max-w-5xl mx-auto w-full px-4 sm:px-6" data-testid="chat-queue-panel">
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 text-xs font-semibold text-gray-500">
          <ListOrdered className="w-3.5 h-3.5" />
          <span>{t('chatQueue.title', { count: runState.queue.length })}</span>
          {insertion && (
            <span className="ml-auto flex items-center gap-1 text-blue-600">
              <Loader2 className="w-3 h-3 animate-spin" />
              {t(`chatQueue.phase.${insertion.phase}`)}
            </span>
          )}
        </div>
        <ul className="max-h-40 overflow-y-auto divide-y divide-gray-100">
          {runState.queue.map((item) => {
            const inserting = insertion?.queueId === item.queueId || insertPendingQueueId === item.queueId;
            return (
              <li key={item.queueId} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="w-5 text-center text-xs text-gray-400 flex-shrink-0">{item.position}</span>
                <span className="flex-1 min-w-0 truncate text-gray-700" title={item.display ?? ''}>{item.display || t('chatQueue.hiddenItem')}</span>
                <button
                  type="button"
                  onClick={() => void insertQueued(item.queueId)}
                  disabled={!insertAllowed || inserting}
                  className="h-7 px-2 flex items-center gap-1 rounded-lg text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:text-gray-300 disabled:hover:bg-transparent transition-colors"
                  title={runState.activeRun ? t('chatQueue.sendNowHint') : t('chatQueue.sendNowIdleHint')}
                >
                  {inserting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpToLine className="w-3.5 h-3.5" />}
                  <span className="hidden sm:inline">{t('chatQueue.sendNow')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void cancelQueued(item.queueId)}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  title={t('chatQueue.cancel')}
                  aria-label={t('chatQueue.cancel')}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
