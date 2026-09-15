// 执行队列（P3 任务 2）：每个 Agent 各自一条 FIFO，显示「在跑 / 排第几」；自己发的、所有目标都还在排队的消息可以撤回。
// 停止的交接链卡片（任务 3）：转交在深度上限处停下 → 管理员点「继续一跳」。
import { CornerDownRight, Loader2, PlayCircle, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { HandoffChain, QueueSnapshot } from './api';

export function RoomQueueStrip({ queue, memberNames, canRetract, onRetract, busyAction }: {
  queue: QueueSnapshot;
  memberNames: Map<string, string>;
  canRetract: (messageId: number, requesterKind: string, requesterUserId: number | null) => boolean;
  onRetract: (messageId: number) => void;
  busyAction: string | null;
}) {
  const { t } = useTranslation();
  if (queue.items.length === 0 && queue.busyMembers.length === 0) return null;
  const members = [...new Set([...queue.busyMembers, ...queue.items.map((item) => item.memberId)])];
  return (
    <div className="px-4 pt-2 max-w-5xl w-full mx-auto" data-testid="room-queue">
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {members.map((memberId) => {
          const items = queue.items.filter((item) => item.memberId === memberId);
          const running = queue.busyMembers.includes(memberId);
          const name = memberNames.get(memberId) || items[0]?.targetName || memberId;
          return (
            <div key={memberId} className="shrink-0 min-w-[11rem] max-w-[16rem] rounded-xl border border-gray-200 bg-gray-50/70 px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
                {running ? <Loader2 className="w-3.5 h-3.5 animate-spin text-green-600" /> : <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />}
                <span className="truncate">{name}</span>
                <span className="ml-auto text-[11px] font-normal text-gray-400">{running ? t('rooms.queue.running') : t('rooms.queue.idle')}</span>
              </div>
              {items.map((item) => (
                <div key={item.id} className="mt-1.5 flex items-center gap-1.5 text-[12px] text-gray-600" data-testid="room-queue-item">
                  <span className="shrink-0 rounded-md bg-white border border-gray-200 px-1.5 text-[11px] text-gray-500">{t('rooms.queue.position', { position: item.position })}</span>
                  <span className="truncate flex-1" title={item.textSummary}>{item.textSummary || t('rooms.queue.noText')}</span>
                  {canRetract(item.messageId, item.requesterKind, item.requesterUserId) && (
                    <button
                      type="button"
                      disabled={busyAction === `retract:${item.messageId}`}
                      onClick={() => onRetract(item.messageId)}
                      className="shrink-0 p-1 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                      title={t('rooms.queue.retract')}
                      aria-label={t('rooms.queue.retract')}
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function StoppedChainCards({ chains, canContinue, onContinue, busyAction }: {
  chains: HandoffChain[];
  canContinue: boolean;
  onContinue: (chain: HandoffChain) => void;
  busyAction: string | null;
}) {
  const { t } = useTranslation();
  const visible = chains.filter((chain) => chain.status === 'stopped' || chain.status === 'outcome_unknown' || chain.status === 'claimed');
  if (visible.length === 0) return null;
  return (
    <div className="px-4 pt-2 max-w-5xl w-full mx-auto space-y-2" data-testid="room-stopped-chains">
      {visible.slice(-3).map((chain) => (
        <div key={chain.chainId} className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2" data-testid="room-stopped-chain">
          <CornerDownRight className="w-4 h-4 text-amber-600 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-amber-900 break-words">
              {chain.status === 'outcome_unknown'
                ? t('rooms.handoff.outcomeUnknown', { agent: chain.targetName })
                : chain.status === 'claimed'
                  ? t('rooms.handoff.continuing', { agent: chain.targetName })
                  : t('rooms.handoff.stopped', { agent: chain.targetName, depth: chain.currentDepth, max: chain.maxDepth })}
            </p>
            {chain.lastError && <p className="text-[11px] text-amber-700/80 truncate">{chain.lastError}</p>}
            {chain.continueUsed && chain.status === 'stopped' && <p className="text-[11px] text-amber-700/80">{t('rooms.handoff.continueUsed')}</p>}
          </div>
          {canContinue && chain.actionable && (
            <button
              type="button"
              disabled={busyAction === `continue:${chain.chainId}`}
              onClick={() => onContinue(chain)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              data-testid="room-continue-chain"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              {t('rooms.handoff.continue')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
