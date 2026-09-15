// 节点转录侧栏：这个节点在当前运行里的每次执行（循环多轮时可切换），提示词、工具调用、用量与输出；挂起审批时给批准 / 拒绝。
// 节点是运行协调器里的 workflow 会话：运行中订阅 `/ws` 的会话主题看正文增量与工具事件，结束后读落库的转录。
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getRealtimeClient } from '../../../api/ws';
import { formatIterationPath } from '../lib/evidence';
import type { NodeExecution, RunRecord, Transcript, TranscriptSession } from '../lib/types';
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
  const [live, setLive] = useState<{ text: string; tools: Array<{ callId: string; name: string; status: string }> }>({ text: '', tools: [] });
  const liveTopic = execution?.status === 'running' ? transcript?.session?.topic ?? null : null;

  // 运行中：订阅节点会话主题。订阅不到（无权、通道不可用）就只显示落库内容，不影响其余面板。
  useEffect(() => {
    setLive({ text: '', tools: [] });
    if (!liveTopic) return;
    const subscription = getRealtimeClient().subscribe(liveTopic, {
      onEvent: (message) => {
        const payload = message.payload ?? {};
        if (message.event === 'message.delta' && typeof payload.delta === 'string') {
          setLive((current) => ({ ...current, text: current.text + payload.delta }));
        } else if (message.event === 'message.snapshot' && typeof payload.text === 'string') {
          setLive((current) => ({ ...current, text: payload.text }));
        } else if (message.event === 'tool.started') {
          setLive((current) => ({ ...current, tools: [...current.tools, { callId: String(payload.call_id), name: String(payload.name ?? ''), status: 'running' }] }));
        } else if (message.event === 'tool.completed' || message.event === 'tool.failed') {
          const status = message.event === 'tool.failed' ? 'failed' : 'completed';
          setLive((current) => ({ ...current, tools: current.tools.map((tool) => (tool.callId === payload.call_id ? { ...tool, status } : tool)) }));
        }
      },
    });
    return () => subscription.unsubscribe();
  }, [liveTopic]);

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
              <div>{t('automation.transcript.session')}: <span className="font-mono">{transcript.session?.sessionKey ?? transcript.sessionId}</span></div>
              {transcript.session && (
                <div>{t('automation.transcript.runtime')}: {transcript.session.runtime}{transcript.session.endReason ? ` · ${t('automation.transcript.endReason', { reason: transcript.session.endReason })}` : ''}</div>
              )}
              <div>{formatTime(transcript.startedAt)} → {formatTime(transcript.finishedAt)}</div>
              {execution?.remainingTimeoutMsAtStart !== null && execution?.remainingTimeoutMsAtStart !== undefined && (
                <div>{t('automation.transcript.remainingAtStart', { seconds: Math.round(execution.remainingTimeoutMsAtStart / 1000) })}</div>
              )}
            </div>
            <section>
              <h4 className="text-xs font-semibold text-gray-500 mb-1">{t('automation.transcript.prompt')}</h4>
              <pre className="whitespace-pre-wrap break-words text-xs bg-gray-50 border border-gray-100 rounded-xl p-3 max-h-[40vh] overflow-y-auto">{transcript.prompt}</pre>
            </section>
            {transcript.session && <TranscriptSessionDetails session={transcript.session} live={liveTopic ? live : null} />}
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

function TranscriptSessionDetails({ session, live }: {
  session: TranscriptSession;
  live: { text: string; tools: Array<{ callId: string; name: string; status: string }> } | null;
}) {
  const { t } = useTranslation();
  const usage = session.usage.reduce((sum, row) => ({
    input: sum.input + row.inputTokens,
    output: sum.output + row.outputTokens,
    cost: sum.cost + (row.costUsd ?? 0),
  }), { input: 0, output: 0, cost: 0 });
  return (
    <>
      {live && (
        <section>
          <h4 className="text-xs font-semibold text-gray-500 mb-1">{t('automation.transcript.live')}</h4>
          {live.tools.length > 0 && (
            <ul className="mb-2 space-y-1">
              {live.tools.map((tool) => (
                <li key={tool.callId} className="text-xs text-gray-600 flex items-center gap-2">
                  <span className="font-mono">{tool.name}</span>
                  <StatusBadge status={tool.status} />
                </li>
              ))}
            </ul>
          )}
          <pre className="whitespace-pre-wrap break-words text-xs bg-white border border-gray-200 rounded-xl p-3 min-h-[2.5rem]">{live.text}</pre>
        </section>
      )}
      <section>
        <h4 className="text-xs font-semibold text-gray-500 mb-1">{t('automation.transcript.toolCalls', { count: session.toolCalls.length })}</h4>
        {session.toolCalls.length === 0
          ? <p className="text-xs text-gray-400">{t('automation.transcript.noToolCalls')}</p>
          : (
            <ul className="space-y-1.5">
              {session.toolCalls.map((call) => (
                <li key={call.callId}>
                  <details className="rounded-xl border border-gray-100 bg-gray-50">
                    <summary className="px-3 py-2 text-xs cursor-pointer flex items-center gap-2">
                      <span className="font-mono text-gray-800 truncate flex-1">{call.name}</span>
                      {call.status && <StatusBadge status={call.status === 'interrupted' ? 'canceled' : call.status} />}
                    </summary>
                    <div className="px-3 pb-2 space-y-1">
                      <pre className="whitespace-pre-wrap break-words text-[11px] text-gray-600 max-h-40 overflow-y-auto">{call.arguments}</pre>
                      {call.output !== null && <pre className="whitespace-pre-wrap break-words text-[11px] text-gray-800 border-t border-gray-100 pt-1 max-h-60 overflow-y-auto">{call.output}</pre>}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
      </section>
      {session.usage.length > 0 && (
        <p className="text-xs text-gray-500">{t('automation.transcript.usage', { input: usage.input, output: usage.output, cost: usage.cost.toFixed(4) })}</p>
      )}
    </>
  );
}
