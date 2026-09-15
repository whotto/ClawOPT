// 助手消息下方的任务计划卡：标题 +「已完成 x / y」、每步状态（未开始 / 进行中 / 已完成）、结局横幅。
import { CheckCircle2, Circle, ListChecks, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { planProgress, type TaskPlan } from '../lib/taskPlans';

export function TaskPlanCard({ plans }: { plans: TaskPlan[] }) {
  const { t } = useTranslation();
  const plan = [...plans].sort((a, b) => b.revision - a.revision)[0];
  if (!plan || plan.steps.length === 0) return null;
  const progress = planProgress(plan);
  const bannerTone = progress.banner === 'failed' ? 'text-red-600' : progress.banner === 'running' ? 'text-blue-600' : 'text-gray-500';
  return (
    <div className="ml-11 sm:ml-12 mr-4 -mt-3 mb-4 max-w-2xl rounded-xl border border-gray-200 bg-white" data-testid="task-plan-card">
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <ListChecks className="h-4 w-4 text-gray-400" />
        <span className="flex-1 text-[13px] font-medium text-gray-700">{t('taskPlan.title')}</span>
        <span className="text-[12px] text-gray-500">{t('taskPlan.progress', { completed: progress.completed, total: progress.total })}</span>
      </div>
      <ol className="space-y-1 px-3 py-2">
        {plan.steps.map((step, index) => (
          <li key={index} className="flex items-start gap-2 text-[13px]">
            {step.status === 'completed'
              ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" aria-label={t('taskPlan.status.completed')} />
              : step.status === 'in_progress'
                ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-blue-600" aria-label={t('taskPlan.status.in_progress')} />
                : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-300" aria-label={t('taskPlan.status.pending')} />}
            <span className={step.status === 'completed' ? 'text-gray-400 line-through' : 'text-gray-700'}>{step.text}</span>
          </li>
        ))}
      </ol>
      {progress.banner && (
        <div className={`border-t border-gray-100 px-3 py-1.5 text-[11px] ${bannerTone}`}>{t(`taskPlan.banner.${progress.banner}`)}</div>
      )}
    </div>
  );
}
