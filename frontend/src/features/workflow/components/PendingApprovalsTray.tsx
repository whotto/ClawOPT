// 待办中心（工作流审批来源）：应用级常驻，列出所有工作流里挂起的审批，可直接批准 / 拒绝或跳到画布。
// 当前正在看的那个工作流的审批不重复显示（画布侧栏里已经有）。窄屏贴底。
import { Check, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listPendingWorkflowApprovals, resolveNodeApproval } from '../../../api/automation';
import { requestJson } from '../lib/request';

type PendingApproval = { workflowId: string; workflowName: string; runId: string; nodeId: string; nodeTitle: string; executionId: string };

const POLL_MS = 5000;

export default function PendingApprovalsTray({ visibleWorkflowId, onOpen }: { visibleWorkflowId: string | null; onOpen: (workflowId: string) => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      const result = await requestJson<{ approvals: PendingApproval[] }>(listPendingWorkflowApprovals());
      if (!stopped && result.ok) setItems(result.data.approvals);
      if (!stopped) timer.current = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const visible = items.filter((item) => item.workflowId !== visibleWorkflowId);
  if (!visible.length) return null;

  const resolve = async (item: PendingApproval, approved: boolean) => {
    const key = `${item.runId}:${item.executionId}`;
    setBusy(key);
    const result = await requestJson(resolveNodeApproval(item.workflowId, item.runId, item.nodeId, approved, item.executionId));
    setBusy(null);
    if (result.ok) setItems((current) => current.filter((row) => `${row.runId}:${row.executionId}` !== key));
  };

  return (
    <div className="fixed z-[150] bottom-0 inset-x-0 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80 space-y-2 p-2 sm:p-0">
      {visible.slice(0, 5).map((item) => {
        const key = `${item.runId}:${item.executionId}`;
        return (
          <div key={key} className="rounded-2xl border border-orange-300 bg-white p-3 space-y-2">
            <button className="w-full flex items-center gap-2 text-left" onClick={() => onOpen(item.workflowId)}>
              <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0" />
              <span className="min-w-0 flex-1 text-sm font-medium text-gray-900 truncate">{item.workflowName} · {item.nodeTitle}</span>
              <ExternalLink className="w-3.5 h-3.5 text-gray-400" />
            </button>
            <p className="text-xs text-gray-500">{t('automation.pending.description')}</p>
            <div className="flex gap-2">
              <button disabled={busy === key} onClick={() => void resolve(item, true)} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                <Check className="w-3.5 h-3.5" />{t('automation.transcript.approve')}
              </button>
              <button disabled={busy === key} onClick={() => void resolve(item, false)} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded-xl border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">
                <X className="w-3.5 h-3.5" />{t('automation.transcript.reject')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
