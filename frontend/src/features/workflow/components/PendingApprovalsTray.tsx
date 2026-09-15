// 待办中心：应用级常驻，两个来源——
// - 工作流审批闸门（`approvals:workflows`，列表 GET /api/workflows/pending-approvals），可批准 / 拒绝或跳到画布；
// - 运行审批（`approvals:runs`，列表 GET /api/run-approvals）：Pi、Hermes 这类真审批运行时在单聊 / 群里等人答复的请求，
//   按请求给的选项答复或跳到对话。
// 当前正在看的那个工作流 / 对话里的审批不重复显示（画布侧栏、聊天页输入区上方已经有）。窄屏贴底。
// 两个列表都经 HTTP 按用户过滤；提醒不带内容，订阅不到退回 5 秒轮询。
import { Check, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listPendingWorkflowApprovals, resolveNodeApproval } from '../../../api/automation';
import { requestJson } from '../lib/request';
import { watchPendingApprovals } from '../lib/workflowStream';
import RunApprovalCard from '../../approvals/RunApprovalCard';
import { approvalContext, approvalsOutsideContext, type ApprovalContext } from '../../approvals/runApprovals';
import { useRunApprovals } from '../../approvals/useRunApprovals';

type PendingApproval = { workflowId: string; workflowName: string; runId: string; nodeId: string; nodeTitle: string; executionId: string };


export default function PendingApprovalsTray({ visibleWorkflowId, onOpen, visibleConversation, onOpenConversation }: {
  visibleWorkflowId: string | null;
  onOpen: (workflowId: string) => void;
  /** 正在看的单聊 / 群：它的运行审批在聊天页里显示，这里不重复。 */
  visibleConversation: ApprovalContext | null;
  onOpenConversation: (context: Exclude<ApprovalContext, { kind: 'other' }>) => void;
}) {
  const { t } = useTranslation();
  const runApprovals = useRunApprovals();
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let seq = 0;
    const reload = async () => {
      const current = ++seq;
      const result = await requestJson<{ approvals: PendingApproval[] }>(listPendingWorkflowApprovals());
      // 连续提醒时只收最后一次请求的结果，不让慢回来的旧列表覆盖新的。
      if (!stopped && result.ok && current === seq) setItems(result.data.approvals);
    };
    const stop = watchPendingApprovals(() => { void reload(); });
    return () => {
      stopped = true;
      stop();
    };
  }, []);

  const visible = items.filter((item) => item.workflowId !== visibleWorkflowId);
  const visibleRuns = approvalsOutsideContext(runApprovals.approvals, visibleConversation);
  if (!visible.length && !visibleRuns.length) return null;

  const resolve = async (item: PendingApproval, approved: boolean) => {
    const key = `${item.runId}:${item.executionId}`;
    setBusy(key);
    const result = await requestJson(resolveNodeApproval(item.workflowId, item.runId, item.nodeId, approved, item.executionId));
    setBusy(null);
    if (result.ok) setItems((current) => current.filter((row) => `${row.runId}:${row.executionId}` !== key));
  };

  return (
    <div className="fixed z-[150] bottom-0 inset-x-0 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80 space-y-2 p-2 sm:p-0 max-h-[70dvh] overflow-y-auto">
      {visibleRuns.slice(0, 5).map((approval) => {
        const context = approvalContext(approval);
        return (
          <RunApprovalCard
            key={approval.id}
            approval={approval}
            busy={runApprovals.busyId === approval.id}
            onRespond={(choice) => void runApprovals.respond(approval, choice)}
            onOpen={context.kind === 'other' ? undefined : () => onOpenConversation(context)}
          />
        );
      })}
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
