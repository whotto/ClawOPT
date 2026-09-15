// 节点转录侧栏：这个节点在当前运行里的每次执行（循环多轮时可切换），提示词与输出；挂起审批时给批准 / 拒绝。
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatIterationPath } from '../lib/evidence';
import type { NodeExecution, RunRecord, Transcript } from '../lib/types';
import { StatusBadge, formatTime, iconButton, primaryButton, dangerButton } from './ui';

const WIDTH_KEY = 'clawopt_workflow_transcript_width';

export default function TranscriptPanel({ run, nodeTitle, executions, initialExecutionId, loadTranscript, onApprove, onClose, loopTitle }: {
  run: RunRecord;
  nodeTitle: string;
  executions: NodeExecution[];
  initialExecutionId: string | null;
  loadTranscript: (runId: string, executionId: string) => Promise<Transcript | null>;
  onApprove: (executionId: string, approved: boolean) => Promise<boolean>;
  onClose: () => void;
  loopTitle: (loopId: string) => string;
}) {
  const { t } = useTranslation();
  const [executionId, setExecutionId] = useState(initialExecutionId ?? executions[executions.length - 1]?.executionId ?? null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || 420;
    } catch {
      return 420;
    }
  });
  const execution = executions.find((item) => item.executionId === executionId) ?? null;

  useEffect(() => {
    if (!executionId) return;
    let cancelled = false;
    void loadTranscript(run.id, executionId).then((result) => {
      if (!cancelled) setTranscript(result);
    });
    return () => { cancelled = true; };
  }, [run.id, executionId, execution?.status, loadTranscript]);

  const startResize = (event: React.PointerEvent) => {
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent) => setWidth(Math.min(760, Math.max(300, startWidth + (startX - moveEvent.clientX))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidth((current) => {
        try { localStorage.setItem(WIDTH_KEY, String(current)); } catch { /* 只是偏好 */ }
        return current;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside className="fixed md:absolute inset-x-0 bottom-0 md:inset-y-0 md:left-auto md:right-0 z-30 h-[70dvh] md:h-auto bg-white border-t md:border-t-0 md:border-l border-gray-200 flex flex-col" style={{ width: window.innerWidth > 768 ? width : undefined }}>
      <div className="hidden md:block absolute left-0 inset-y-0 w-1 cursor-col-resize hover:bg-orange-200" onPointerDown={startResize} />
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-900 truncate flex-1">{nodeTitle}</span>
        {execution && <StatusBadge status={execution.status} />}
        <button className={iconButton} title={t('common.close')} onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      {executions.length > 1 && (
        <div className="px-4 py-2 border-b border-gray-100">
          <select className="w-full px-2 py-1.5 text-xs rounded-lg border border-gray-200 bg-gray-50" value={executionId ?? ''} onChange={(event) => setExecutionId(event.target.value)}>
            {executions.map((item) => (
              <option key={item.executionId} value={item.executionId}>
                {formatIterationPath(item.iterationPath, loopTitle, t('automation.runs.rerunScope')) || t('automation.transcript.single')} · {t(`automation.status.${item.status}`)}
              </option>
            ))}
          </select>
        </div>
      )}
      {execution?.status === 'pending_approval' && (
        <div className="px-4 py-3 border-b border-orange-200 bg-amber-50 space-y-2">
          <p className="text-sm text-gray-800">{t('automation.transcript.approvalPrompt')}</p>
          <div className="flex gap-2">
            <button className={primaryButton} onClick={() => void onApprove(execution.executionId, true)}><Check className="w-4 h-4" />{t('automation.transcript.approve')}</button>
            <button className={dangerButton} onClick={() => void onApprove(execution.executionId, false)}><X className="w-4 h-4" />{t('automation.transcript.reject')}</button>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
        {!execution && <p className="text-gray-500">{t('automation.transcript.neverRan')}</p>}
        {transcript && (
          <>
            <div className="text-xs text-gray-500 space-y-0.5">
              <div>{t('automation.transcript.agent')}: {transcript.agent.id}</div>
              <div>{t('automation.transcript.session')}: <span className="font-mono">{transcript.sessionId}</span></div>
              <div>{formatTime(transcript.startedAt)} → {formatTime(transcript.finishedAt)}</div>
              {execution?.remainingTimeoutMsAtStart !== null && execution?.remainingTimeoutMsAtStart !== undefined && (
                <div>{t('automation.transcript.remainingAtStart', { seconds: Math.round(execution.remainingTimeoutMsAtStart / 1000) })}</div>
              )}
            </div>
            <section>
              <h4 className="text-xs font-semibold text-gray-500 mb-1">{t('automation.transcript.prompt')}</h4>
              <pre className="whitespace-pre-wrap break-words text-xs bg-gray-50 border border-gray-100 rounded-xl p-3 max-h-[40vh] overflow-y-auto">{transcript.prompt}</pre>
            </section>
            <section>
              <h4 className="text-xs font-semibold text-gray-500 mb-1">{t('automation.transcript.output')}</h4>
              {transcript.output
                ? <pre className="whitespace-pre-wrap break-words text-xs bg-white border border-gray-200 rounded-xl p-3">{transcript.output}</pre>
                : <p className="text-xs text-gray-400">{t('automation.transcript.noOutput')}</p>}
            </section>
            {transcript.error && <p className="text-xs text-red-600 break-words">{transcript.error}</p>}
          </>
        )}
      </div>
    </aside>
  );
}
