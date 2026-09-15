// 运行面板：历史列表 ↔ 选中运行详情（状态、预算倒计时、证据三页签：实际路径 / 其他判定 / 循环）。
import { ArrowLeft, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessProjection, currentEpoch, evidenceTabs, formatIterationPath, isRunLive, type EvidenceRow } from '../lib/evidence';
import { describeError } from '../lib/request';
import type { RunEvidence, RunRecord, WfEdge, WfNode } from '../lib/types';
import { StatusBadge, formatDuration, formatTime, iconButton } from './ui';

type Tab = 'actual' | 'other' | 'loops';

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export default function RunPanel({ runs, selectedRun, evidence, nodes, edges, onSelect, onStop, onDelete, onOpenExecution }: {
  runs: RunRecord[];
  selectedRun: RunRecord | null;
  evidence: RunEvidence;
  nodes: WfNode[];
  edges: WfEdge[];
  onSelect: (runId: string | null) => void;
  onStop: (runId: string) => void;
  onDelete: (runId: string) => void;
  onOpenExecution: (nodeId: string, executionId: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('actual');
  const [expanded, setExpanded] = useState<string | null>(null);
  const live = selectedRun ? isRunLive(selectedRun.status) : false;
  const now = useNow(live);
  const epoch = useMemo(() => (selectedRun ? currentEpoch(selectedRun, evidence) : evidence), [selectedRun, evidence]);
  const tabs = useMemo(() => evidenceTabs(epoch), [epoch]);
  const titleOf = (id: string) => nodes.find((node) => node.id === id)?.data.title ?? id;
  const loopTitle = (loopId: string) => {
    const loop = selectedRun?.compiledLoops.find((item) => item.id === loopId);
    return loop ? titleOf(loop.headerNodeId) : loopId;
  };
  const pathText = (path: RunEvidence['nodeExecutions'][number]['iterationPath']) => formatIterationPath(path, loopTitle, t('automation.runs.rerunScope'));

  if (!selectedRun) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">{t('automation.runs.history')}</div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {runs.length === 0 && <p className="p-3 text-sm text-gray-500">{t('automation.runs.empty')}</p>}
          {runs.map((run) => (
            <button key={run.id} onClick={() => onSelect(run.id)} className="w-full text-left p-3 rounded-xl border border-transparent hover:bg-gray-50 hover:border-gray-200 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <StatusBadge status={run.status} />
                <span className="text-xs text-gray-500">{t(`automation.runs.triggers.${run.triggerSource}`)}</span>
              </div>
              <div className="text-xs text-gray-500">{formatTime(run.startedAt)} · {formatDuration((run.finishedAt ?? Date.now()) - run.startedAt)}</div>
              <div className="text-xs text-gray-400">
                {run.requestedTimeoutMs ? t('automation.runs.budgetMinutes', { count: Math.round(run.requestedTimeoutMs / 60_000) }) : t('automation.budget.unlimited')}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const rows: EvidenceRow[] = tabs[tab];
  const remaining = selectedRun.deadlineAt ? selectedRun.deadlineAt - now : null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
        <button className={iconButton} title={t('automation.runs.back')} onClick={() => onSelect(null)}><ArrowLeft className="w-4 h-4" /></button>
        <StatusBadge status={selectedRun.status} />
        <span className="flex-1" />
        {live && <button className={iconButton} title={t('automation.runs.stop')} onClick={() => onStop(selectedRun.id)}><Square className="w-4 h-4" /></button>}
        {!live && <button className={iconButton} title={t('common.delete')} onClick={() => onDelete(selectedRun.id)}><Trash2 className="w-4 h-4" /></button>}
      </div>
      <div className="px-4 py-3 border-b border-gray-100 space-y-1 text-xs text-gray-600">
        <div>{t('automation.runs.started')}: {formatTime(selectedRun.startedAt)}</div>
        <div>{t('automation.runs.elapsed')}: {formatDuration((selectedRun.finishedAt ?? now) - selectedRun.startedAt)}</div>
        <div>
          {t('automation.runs.budget')}: {selectedRun.requestedTimeoutMs ? formatDuration(selectedRun.requestedTimeoutMs) : t('automation.budget.unlimited')}
          {live && remaining !== null && ` · ${t('automation.runs.remaining')}: ${formatDuration(remaining)}`}
        </div>
        {selectedRun.errorCode && <div className={selectedRun.status === 'completed_with_failures' ? 'text-amber-700' : 'text-red-600'}>{describeError(t, { code: selectedRun.errorCode })}</div>}
        {selectedRun.error && selectedRun.status !== 'completed_with_failures' && <div className="text-red-500 break-words">{selectedRun.error}</div>}
      </div>
      <div className="px-2 pt-2 flex gap-1 border-b border-gray-100">
        {(['actual', 'other', 'loops'] as Tab[]).map((item) => (
          <button key={item} onClick={() => setTab(item)} className={`px-3 py-1.5 text-xs rounded-t-lg border-b-2 ${tab === item ? 'border-orange-400 text-gray-900 font-semibold' : 'border-transparent text-gray-500'}`}>
            {t(`automation.runs.tabs.${item}`)} ({tabs[item].length})
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {rows.length === 0 && <p className="p-3 text-xs text-gray-400">{t('automation.runs.noEvidence')}</p>}
        {rows.map((entry) => {
          const key = `${entry.kind}:${entry.row.id}`;
          const open = expanded === key;
          if (entry.kind === 'edge') {
            const row = entry.row;
            const edge = edges.find((item) => item.id === row.edgeId);
            const projection = row.conditionEvaluation ? businessProjection(row.conditionEvaluation.actual) : null;
            return (
              <div key={key} className="rounded-xl border border-gray-200 bg-white">
                <button className="w-full text-left p-2 space-y-0.5" onClick={() => setExpanded(open ? null : key)}>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`w-2 h-2 rounded-full ${row.status === 'taken' ? (row.sourceOutcome === 'failure' ? 'bg-red-500' : 'bg-green-500') : 'bg-gray-300'}`} />
                    <span className="font-medium text-gray-800 truncate">{titleOf(row.sourceNodeId)} → {titleOf(row.targetNodeId)}</span>
                    {entry.consumed && <span className="text-[10px] text-blue-600">{t('automation.runs.consumed')}</span>}
                  </div>
                  <div className="text-[11px] text-gray-500">
                    {t(`automation.runs.decision.${row.status}`)}{row.reason ? ` · ${t(`automation.runs.reasons.${row.reason}`)}` : ''}
                    {pathText(row.iterationPath) && ` · ${pathText(row.iterationPath)}`}
                  </div>
                  {projection?.decision && <div className={`text-[11px] font-medium ${projection.decision === 'BLOCKED' || projection.gate ? 'text-red-600' : 'text-gray-700'}`}>{projection.decision}{projection.gate ? ` · ${projection.gate}` : ''}</div>}
                </button>
                {open && (
                  <div className="px-2 pb-2 text-[11px] text-gray-600 space-y-0.5 border-t border-gray-100 pt-1">
                    <div>{t('automation.edge.route')}: {t(`automation.edge.routes.${row.route}`)} · {t('automation.runs.sourceOutcome')}: {t(`automation.runs.outcomes.${row.sourceOutcome}`)}</div>
                    {row.orchestration.condition && (
                      <>
                        <div className="font-mono break-all">{row.orchestration.condition.path} {row.orchestration.condition.operator} {JSON.stringify(row.orchestration.condition.value)}</div>
                        <div className="font-mono break-all">{t('automation.runs.actual')}: {JSON.stringify(row.conditionEvaluation?.actual)?.slice(0, 400) ?? '—'}</div>
                      </>
                    )}
                    {projection?.reason && <div>{projection.reason}</div>}
                    {!edge && <div className="text-gray-400">{row.edgeId}</div>}
                  </div>
                )}
              </div>
            );
          }
          if (entry.kind === 'node') {
            const row = entry.row;
            return (
              <button key={key} className="w-full text-left p-2 rounded-xl border border-red-100 bg-red-50/40" onClick={() => onOpenExecution(row.nodeId, row.executionId)}>
                <div className="flex items-center gap-2 text-xs"><StatusBadge status={row.status} /><span className="font-medium text-gray-800 truncate">{titleOf(row.nodeId)}</span></div>
                {row.error && <div className="text-[11px] text-red-600 line-clamp-2">{row.error}</div>}
                {pathText(row.iterationPath) && <div className="text-[11px] text-gray-500">{pathText(row.iterationPath)}</div>}
              </button>
            );
          }
          const row = entry.row;
          return (
            <div key={key} className="p-2 rounded-xl border border-violet-100 bg-white text-xs">
              <div className="flex items-center gap-2"><span className="font-medium text-gray-800">{loopTitle(row.loopId)}#{row.iteration + 1}</span><StatusBadge status={row.status === 'timed_out' ? 'failed' : row.status} label={t(`automation.runs.epochStatus.${row.status}`)} /></div>
              {row.exitReason && <div className="text-[11px] text-gray-500 break-words">{row.exitReason === 'feedback_taken' || row.exitReason === 'condition_not_matched' || row.exitReason === 'iteration_limit_reached' || row.exitReason === 'route_not_matched' ? t(`automation.runs.reasons.${row.exitReason}`) : row.exitReason}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
