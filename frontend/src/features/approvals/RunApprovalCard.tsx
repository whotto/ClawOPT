// 一张运行审批卡：谁（Agent · 运行时）要做什么、命令、剩余时间、按请求给的选项答复。待办中心与聊天页共用。
import { ExternalLink, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { orderedChoices, type RunApproval, type RunApprovalChoice } from './runApprovals';

export default function RunApprovalCard({ approval, busy, onRespond, onOpen }: {
  approval: RunApproval;
  busy: boolean;
  onRespond: (choice: RunApprovalChoice) => void;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const minutes = approval.remainingTimeoutMs === null ? null : Math.max(1, Math.round(approval.remainingTimeoutMs / 60000));
  const header = (
    <>
      <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
      <span className="min-w-0 flex-1 text-sm font-medium text-gray-900 truncate">
        {t('runApprovals.heading', { agent: approval.agentName || approval.agentId, runtime: t(`externalAgent.runtimeName.${approval.runtime}`, { defaultValue: approval.runtime }) })}
      </span>
      {onOpen && <ExternalLink className="w-3.5 h-3.5 text-gray-400" />}
    </>
  );
  return (
    <div className="rounded-2xl border border-orange-300 bg-white p-3 space-y-2" data-testid="run-approval-card">
      {onOpen ? <button className="w-full flex items-center gap-2 text-left" onClick={onOpen}>{header}</button> : <div className="flex items-center gap-2">{header}</div>}
      <p className="text-sm text-gray-800 break-words">{approval.title}</p>
      {approval.command && <pre className="text-xs font-mono bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 whitespace-pre-wrap break-all max-h-24 overflow-auto">{approval.command}</pre>}
      {approval.description && approval.description !== approval.title && <p className="text-xs text-gray-500 break-words">{approval.description}</p>}
      {minutes !== null && <p className="text-[11px] text-gray-400">{t('runApprovals.remaining', { minutes })}</p>}
      <div className="flex flex-wrap gap-2">
        {orderedChoices(approval.choices).map((choice) => (
          <button
            key={choice}
            disabled={busy}
            onClick={() => onRespond(choice)}
            className={`flex-1 min-w-[5.5rem] inline-flex items-center justify-center px-2 py-1.5 text-xs rounded-xl disabled:opacity-50 ${choice === 'deny'
              ? 'border border-red-200 text-red-600 hover:bg-red-50'
              : choice === 'once' ? 'bg-blue-600 text-white hover:bg-blue-700' : 'border border-gray-200 text-gray-700 hover:bg-gray-50'}`}
          >
            {t(`runApprovals.choice.${choice}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
