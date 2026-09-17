// 群里等人答复的审批 / 澄清（P3 任务 5）：审批只给 Agent 的主人、澄清只给管理员（服务端按身份过滤后返回）。
// 桌面端是输入区上方的卡片；手机端是底部弹层（可收起成一条提示），不挡输入框之外的消息。
import { ChevronDown, ChevronUp, MessageCircleQuestion, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RoomInteraction } from './api';

export function RoomInteractions({ interactions, onRespond, busyId }: {
  interactions: RoomInteraction[];
  onRespond: (interaction: RoomInteraction, response: { choice?: string; text?: string }) => void;
  busyId: string | null;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  if (interactions.length === 0) return null;
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 md:static md:z-auto px-0 md:px-4 md:pt-2"
      data-testid="room-interactions"
    >
      <div className="md:max-w-4xl md:mx-auto rounded-t-2xl md:rounded-2xl border-t md:border border-orange-300 bg-white shadow-[0_-8px_24px_rgba(0,0,0,0.08)] md:shadow-none">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="md:hidden w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-amber-700"
        >
          <span>{t('rooms.interactions.pending', { count: interactions.length })}</span>
          {collapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        <div className={`${collapsed ? 'hidden md:block' : 'block'} max-h-[60vh] md:max-h-none overflow-y-auto p-3 space-y-2`}>
          {interactions.map((interaction) => (
            <InteractionCard key={interaction.id} interaction={interaction} busy={busyId === interaction.id} onRespond={(response) => onRespond(interaction, response)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function InteractionCard({ interaction, busy, onRespond }: {
  interaction: RoomInteraction;
  busy: boolean;
  onRespond: (response: { choice?: string; text?: string }) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const minutes = interaction.remainingTimeoutMs === null ? null : Math.max(1, Math.round(interaction.remainingTimeoutMs / 60000));
  const isApproval = interaction.kind === 'approval';
  const choices = interaction.choices && interaction.choices.length > 0 ? interaction.choices : (isApproval ? ['once', 'deny'] : []);
  return (
    <div className="rounded-xl border border-gray-200 p-3 space-y-2 bg-white" data-testid="room-interaction-card">
      <div className="flex items-center gap-2">
        {isApproval ? <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" /> : <MessageCircleQuestion className="w-4 h-4 text-blue-600 shrink-0" />}
        <span className="text-sm font-medium text-gray-900 truncate flex-1">
          {t(isApproval ? 'rooms.interactions.approvalHeading' : 'rooms.interactions.clarifyHeading', { agent: interaction.agentName })}
        </span>
        {minutes !== null && <span className="text-[11px] text-gray-400 shrink-0">{t('runApprovals.remaining', { minutes })}</span>}
      </div>
      <p className="text-sm text-gray-800 break-words">{interaction.question || interaction.title}</p>
      {interaction.command && <pre className="text-xs font-mono bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 whitespace-pre-wrap break-all max-h-24 overflow-auto">{interaction.command}</pre>}
      {interaction.description && interaction.description !== interaction.title && <p className="text-xs text-gray-500 break-words">{interaction.description}</p>}
      {!isApproval && (
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('rooms.interactions.answerPlaceholder')}
            className="flex-1 min-w-0 rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
          />
          <button type="button" disabled={busy || !text.trim()} onClick={() => onRespond({ text })} className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white disabled:opacity-50">
            {t('common.send')}
          </button>
        </div>
      )}
      {choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={busy}
              onClick={() => onRespond({ choice })}
              className={`flex-1 min-w-[5.5rem] px-2 py-2 md:py-1.5 text-xs rounded-xl disabled:opacity-50 ${choice === 'deny'
                ? 'border border-red-200 text-red-600 hover:bg-red-50'
                : choice === 'once' ? 'bg-blue-600 text-white hover:bg-blue-700' : 'border border-gray-200 text-gray-700 hover:bg-gray-50'}`}
            >
              {t(`runApprovals.choice.${choice}`, { defaultValue: choice })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
