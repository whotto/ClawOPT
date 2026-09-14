// 历史翻页的边缘提示与翻页完成通知。
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { ChatController } from '../hooks/useChatController';

type HistoryPagingPromptsProps = Pick<ChatController, 't' | 'historyPageRounds' | 'historyEdgePrompt' | 'historyPageNotice'> & { canShowHistoryPagingUi: boolean };

export function HistoryPagingPrompts(c: HistoryPagingPromptsProps) {
  const { t, historyPageRounds, historyEdgePrompt, historyPageNotice, canShowHistoryPagingUi } = c;
  const promptHistoryPageRounds = historyPageRounds;
  const historyPromptShellClass = 'pointer-events-none absolute inset-x-0 z-20 px-4 sm:px-8';
  const historyPromptRowClass = 'mx-auto flex w-full max-w-5xl justify-center';
  const historyPromptBubbleClass = 'inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-full py-2 sm:py-2.5 pl-2.5 pr-5 sm:pl-3 sm:pr-6 text-sm sm:text-base font-medium text-gray-700';
  const historyEdgePromptText = historyEdgePrompt === 'older'
    ? t('unifiedChat.historyPagePromptOlder', { count: promptHistoryPageRounds })
    : historyEdgePrompt === 'newer'
      ? t('unifiedChat.historyPagePromptNewer', { count: promptHistoryPageRounds })
      : '';
  const historyPageNoticeText = historyPageNotice?.direction === 'older'
    ? t('unifiedChat.historyPageNoticeOlder', { count: promptHistoryPageRounds })
    : historyPageNotice?.direction === 'newer'
      ? t('unifiedChat.historyPageNoticeNewer', { count: promptHistoryPageRounds })
      : '';

  return (
    <>
      {canShowHistoryPagingUi && historyPageNoticeText && (
        <div className={`${historyPromptShellClass} top-5`}>
          <div className={historyPromptRowClass}>
            <div className={`${historyPromptBubbleClass} border border-gray-200 bg-white`}>
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              <span className="min-w-0 truncate whitespace-nowrap">{historyPageNoticeText}</span>
            </div>
          </div>
        </div>
      )}

      {canShowHistoryPagingUi && historyEdgePrompt === 'older' && (
        <div className={`${historyPromptShellClass} top-5`}>
          <div className={historyPromptRowClass}>
            <div className={`${historyPromptBubbleClass} border border-orange-300 bg-[#fff8ee]`}>
              <ChevronUp className="w-4 h-4 text-orange-500 shrink-0" />
              <span className="min-w-0 truncate whitespace-nowrap">{historyEdgePromptText}</span>
            </div>
          </div>
        </div>
      )}

      {canShowHistoryPagingUi && historyEdgePrompt === 'newer' && (
        <div className={`${historyPromptShellClass} bottom-5`}>
          <div className={historyPromptRowClass}>
            <div className={`${historyPromptBubbleClass} border border-orange-300 bg-[#fff8ee]`}>
              <ChevronDown className="w-4 h-4 text-orange-500 shrink-0" />
              <span className="min-w-0 truncate whitespace-nowrap">{historyEdgePromptText}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
