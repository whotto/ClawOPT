// 助手消息下方「N 个工具 · 名字1 · 名字2 · +k」摘要卡：一轮里完成的工具调用收成一张卡，有失败 / 中断标出来；
// 展开看每个调用（状态、耗时、参数预览），再展开看参数与结果（服务端已按 JSON 结构截断），「复制完整内容」按调用 id 取整份。
import { Check, ChevronDown, ChevronRight, Copy, Loader2, Wrench, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getToolCallFull } from '../../../api/chat';
import { summarizeToolRun, type ToolTraceCall, type ToolTraceRun } from '../lib/toolTrace';

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function PayloadBlock({ label, payload }: { label: string; payload: ToolTraceCall['arguments'] | null }) {
  const { t } = useTranslation();
  if (!payload || !payload.text) return null;
  return (
    <div>
      <div className="mb-0.5 flex items-center gap-2 text-[11px] font-semibold text-gray-500">
        {label}
        {payload.truncated && <span className="font-normal text-amber-700">{t('toolTrace.truncated', { count: payload.originalLength })}</span>}
      </div>
      <pre className={`max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-gray-200 bg-gray-50 p-2 font-mono text-[11.5px] leading-5 ${payload.format === 'diff' ? 'text-gray-700' : 'text-gray-800'}`}>{payload.text}</pre>
    </div>
  );
}

function ToolCallRow({ sessionId, call }: { sessionId: string; call: ToolTraceCall }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const failed = call.status === 'failed' || call.status === 'interrupted';

  const copyFull = async () => {
    setCopyState('copying');
    try {
      const response = await getToolCallFull(sessionId, call.id);
      const payload = await response.json();
      if (!response.ok || !payload?.call) throw new Error('not found');
      await navigator.clipboard.writeText(`${payload.call.name}\n\n${payload.call.arguments}\n\n${payload.call.output ?? ''}`);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 1500);
  };

  return (
    <li className="border-t border-gray-100 first:border-t-0">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
        {failed ? <X className="h-3.5 w-3.5 shrink-0 text-red-500" /> : <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />}
        <span className="shrink-0 font-mono text-[12px] font-semibold text-gray-800">{call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-gray-500" dir="ltr">{call.preview}</span>
        {call.status === 'interrupted' && <span className="shrink-0 text-[11px] text-gray-500">{t('toolTrace.interrupted')}</span>}
        <span className="shrink-0 text-[11px] text-gray-400">{formatDuration(call.durationMs)}</span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-2.5 pl-9">
          <PayloadBlock label={t('toolTrace.arguments')} payload={call.arguments} />
          <PayloadBlock label={t('toolTrace.result')} payload={call.output} />
          <button type="button" onClick={() => void copyFull()} className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50" disabled={copyState === 'copying'}>
            {copyState === 'copying' ? <Loader2 className="h-3 w-3 animate-spin" /> : copyState === 'copied' ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
            {copyState === 'copied' ? t('common.copied') : copyState === 'failed' ? t('toolTrace.copyFailed') : t('toolTrace.copyFull')}
          </button>
        </div>
      )}
    </li>
  );
}

export function ToolRunSummaryCard({ sessionId, runs }: { sessionId: string; runs: ToolTraceRun[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const calls = runs.flatMap((run) => run.calls);
  if (calls.length === 0) return null;
  const summary = summarizeToolRun(calls, 3);
  return (
    <div className="ml-11 sm:ml-12 mr-4 -mt-3 mb-4 max-w-2xl rounded-xl border border-gray-200 bg-white" data-testid="tool-run-summary-card">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 rounded-xl">
        <Wrench className="h-4 w-4 shrink-0 text-gray-400" />
        <span className="shrink-0 text-[13px] font-medium text-gray-700">{t('toolTrace.count', { count: summary.total })}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-gray-500">
          {summary.names.join(' · ')}{summary.more > 0 ? ` · +${summary.more}` : ''}
        </span>
        {summary.failed > 0 && <span className="shrink-0 rounded border border-red-200 bg-red-50 px-1.5 text-[11px] text-red-600">{t('toolTrace.failedBadge', { count: summary.failed })}</span>}
        {summary.interrupted > 0 && <span className="shrink-0 rounded border border-gray-200 bg-gray-50 px-1.5 text-[11px] text-gray-500">{t('toolTrace.interruptedBadge', { count: summary.interrupted })}</span>}
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
      </button>
      {expanded && (
        <ul className="border-t border-gray-100">
          {calls.map((call) => <ToolCallRow key={call.id} sessionId={sessionId} call={call} />)}
        </ul>
      )}
    </div>
  );
}
