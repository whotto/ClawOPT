// 任务抽屉：编辑字段、按当前状态给出可用动作（派活 / 完成 / 阻塞 / 解除 / 收回 / 归档 / 移动）、运行记录、评论、依赖、事件。
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addTaskComment, getTask, linkTasks, taskAction, unlinkTasks, updateTask } from '../../../api/automationKanban';
import { agentKey } from '../../../features/workflow/components/canvasContext';
import { ErrorBanner, Field, StatusBadge, formatTime, iconButton, inputClass, primaryButton, secondaryButton, selectClass } from '../../../features/workflow/components/ui';
import { describeError, requestJson, type ApiError } from '../../../features/workflow/lib/request';
import type { AgentEntry } from '../../../features/workflow/lib/types';
import type { KanbanStatus, Task } from './useKanban';

type Detail = {
  task: Task;
  comments: Array<{ id: string; author: string; body: string; createdAt: number }>;
  events: Array<{ id: string; kind: string; payload: Record<string, unknown>; createdAt: number }>;
  runs: Array<{ id: string; agentId: string; status: string; output: string | null; error: string | null; startedAt: number; endedAt: number | null }>;
  parents: string[];
  children: string[];
};

// 与服务端 kanban-service.ts 的守卫一致：只显示当前状态下允许的动作（服务端仍会再判一次）。
const MOVE: Record<KanbanStatus, KanbanStatus[]> = {
  triage: ['todo', 'ready'], todo: ['triage', 'scheduled', 'ready'], scheduled: ['todo', 'ready'], ready: ['todo', 'scheduled'],
  running: [], blocked: ['todo'], review: ['ready'], done: ['ready'], archived: ['todo'],
};

export default function TaskDrawer({ taskId, agents, tasks, onChanged, onClose }: {
  taskId: string;
  agents: AgentEntry[];
  tasks: Task[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const [summary, setSummary] = useState('');
  const [parentPick, setParentPick] = useState('');
  const [edit, setEdit] = useState<{ title: string; body: string; priority: string; assignee: string; workspace: string } | null>(null);

  const load = useCallback(async () => {
    const result = await requestJson<Detail>(getTask(taskId));
    if (result.ok) setDetail(result.data);
    else setError(result.error);
  }, [taskId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (request: Promise<Response>) => {
    const result = await requestJson(request);
    if (!result.ok) setError(result.error);
    else setError(null);
    await load();
    onChanged();
    return result.ok;
  };

  if (!detail) return null;
  const { task } = detail;
  const status = task.status;
  const titleOf = (id: string) => tasks.find((item) => item.id === id)?.title ?? id;

  return (
    <aside className="fixed inset-0 sm:inset-y-0 sm:left-auto sm:right-0 z-[120] w-full sm:w-[440px] bg-white border-l border-gray-200 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <StatusBadge status={status === 'done' ? 'completed' : status === 'blocked' ? 'failed' : status === 'running' ? 'running' : 'queued'} label={t(`automation.kanban.statuses.${status}`)} />
        <span dir="auto" className="flex-1 min-w-0 truncate text-sm font-semibold text-gray-900">{task.title}</span>
        <button className={iconButton} title={t('common.close')} onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {error && <ErrorBanner message={describeError(t, error)} detail={error.detail} onDismiss={() => setError(null)} />}

        <section className="space-y-2">
          <h4 className="text-xs font-semibold text-gray-500">{t('automation.kanban.actionsTitle')}</h4>
          <div className="flex flex-wrap gap-2">
            {status === 'ready' && <button className={primaryButton} disabled={!task.assignee} title={!task.assignee ? t('automation.kanban.needAssignee') : undefined} onClick={() => void act(taskAction(task.id, { action: 'dispatch' }))}>{t('automation.kanban.actions.dispatch')}</button>}
            {['blocked', 'scheduled'].includes(status) && <button className={secondaryButton} onClick={() => void act(taskAction(task.id, { action: 'unblock' }))}>{t('automation.kanban.actions.unblock')}</button>}
            {status === 'running' && <button className={secondaryButton} onClick={() => void act(taskAction(task.id, { action: 'reclaim' }))}>{t('automation.kanban.actions.reclaim')}</button>}
            {MOVE[status].map((to) => (
              <button key={to} className={secondaryButton} onClick={() => void act(taskAction(task.id, { action: 'move', status: to }))}>{t('automation.kanban.moveTo', { status: t(`automation.kanban.statuses.${to}`) })}</button>
            ))}
            {!['running', 'archived'].includes(status) && <button className={secondaryButton} onClick={() => void act(taskAction(task.id, { action: 'archive' }))}>{t('automation.kanban.actions.archive')}</button>}
          </div>
          {['running', 'ready', 'blocked', 'review'].includes(status) && (
            <div className="flex gap-2">
              <input className={inputClass} placeholder={t('automation.kanban.summaryPlaceholder')} value={summary} onChange={(event) => setSummary(event.target.value)} />
              <button className={secondaryButton} onClick={() => void act(taskAction(task.id, { action: 'complete', summary })).then((ok) => ok && setSummary(''))}>{t('automation.kanban.actions.complete')}</button>
            </div>
          )}
          {['running', 'ready', 'todo', 'review'].includes(status) && (
            <div className="flex gap-2">
              <input className={inputClass} placeholder={t('automation.kanban.reasonPlaceholder')} value={reason} onChange={(event) => setReason(event.target.value)} />
              <button className={secondaryButton} disabled={!reason.trim()} onClick={() => void act(taskAction(task.id, { action: 'block', reason })).then((ok) => ok && setReason(''))}>{t('automation.kanban.actions.block')}</button>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-gray-500">{t('automation.kanban.detailsTitle')}</h4>
            {!edit && status !== 'running' && (
              <button className="text-xs text-blue-600" onClick={() => setEdit({ title: task.title, body: task.body, priority: String(task.priority), assignee: task.assignee ? agentKey(task.assignee) : '', workspace: task.workspacePath ?? '' })}>{t('common.edit')}</button>
            )}
          </div>
          {edit ? (
            <div className="space-y-2">
              <Field label={t('automation.kanban.fields.title')}><input className={inputClass} value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.target.value })} /></Field>
              <Field label={t('automation.kanban.fields.body')}><textarea className={`${inputClass} min-h-[100px]`} value={edit.body} onChange={(event) => setEdit({ ...edit, body: event.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('automation.kanban.fields.assignee')}>
                  <select className={selectClass} value={edit.assignee} onChange={(event) => setEdit({ ...edit, assignee: event.target.value })}>
                    <option value="">{t('automation.kanban.unassigned')}</option>
                    {agents.map((entry) => <option key={agentKey(entry.ref)} value={agentKey(entry.ref)} disabled={!entry.available}>{entry.name}</option>)}
                  </select>
                </Field>
                <Field label={t('automation.kanban.fields.priority')}><input className={inputClass} type="number" value={edit.priority} onChange={(event) => setEdit({ ...edit, priority: event.target.value })} /></Field>
              </div>
              <Field label={t('automation.kanban.fields.workspace')} hint={t('automation.kanban.fields.workspaceHint')}><input className={inputClass} value={edit.workspace} onChange={(event) => setEdit({ ...edit, workspace: event.target.value })} /></Field>
              <div className="flex gap-2 justify-end">
                <button className={secondaryButton} onClick={() => setEdit(null)}>{t('common.cancel')}</button>
                <button className={primaryButton} onClick={async () => {
                  const ref = agents.find((entry) => agentKey(entry.ref) === edit.assignee)?.ref;
                  const ok = await act(updateTask(task.id, { title: edit.title, body: edit.body, priority: Number(edit.priority), workspace_path: edit.workspace || null, assignee: ref ? { kind: ref.kind, id: ref.id } : null }));
                  if (ok) setEdit(null);
                }}>{t('common.save')}</button>
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-700 space-y-1">
              <p dir="auto" className="whitespace-pre-wrap break-words">{task.body || t('automation.kanban.noBody')}</p>
              <p className="text-xs text-gray-500">{t('automation.kanban.fields.assignee')}: {task.assignee ? agents.find((entry) => agentKey(entry.ref) === agentKey(task.assignee!))?.name ?? task.assignee.id : t('automation.kanban.unassigned')} · P{task.priority}</p>
              {task.workspacePath && <p className="text-xs text-gray-500 font-mono break-all">{task.workspacePath}</p>}
              {task.result && <pre className="text-xs whitespace-pre-wrap break-words bg-gray-50 border border-gray-100 rounded-xl p-2">{task.result}</pre>}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h4 className="text-xs font-semibold text-gray-500">{t('automation.kanban.runsTitle')}</h4>
          {detail.runs.length === 0 && <p className="text-xs text-gray-400">{t('automation.kanban.noRuns')}</p>}
          {detail.runs.map((run) => (
            <div key={run.id} className="p-2 rounded-xl border border-gray-200 text-xs space-y-1">
              <div className="flex items-center gap-2"><StatusBadge status={run.status === 'canceled' ? 'canceled' : run.status} /><span className="text-gray-600">{run.agentId}</span><span className="text-gray-400">{formatTime(run.startedAt)}</span></div>
              {run.error && <div className="text-red-600 break-words">{run.error}</div>}
            </div>
          ))}
        </section>

        <section className="space-y-2">
          <h4 className="text-xs font-semibold text-gray-500">{t('automation.kanban.linksTitle')}</h4>
          {[...detail.parents.map((id) => ({ id, parent: true })), ...detail.children.map((id) => ({ id, parent: false }))].map((link) => (
            <div key={`${link.parent}:${link.id}`} className="flex items-center justify-between text-xs text-gray-600">
              <span>{link.parent ? t('automation.kanban.parent') : t('automation.kanban.child')}: {titleOf(link.id)}</span>
              <button className="text-red-600" onClick={() => void act(link.parent ? unlinkTasks(link.id, task.id) : unlinkTasks(task.id, link.id))}>{t('common.delete')}</button>
            </div>
          ))}
          <div className="flex gap-2">
            <select className={selectClass} value={parentPick} onChange={(event) => setParentPick(event.target.value)}>
              <option value="">{t('automation.kanban.pickParent')}</option>
              {tasks.filter((item) => item.id !== task.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            <button className={secondaryButton} disabled={!parentPick} onClick={() => void act(linkTasks(parentPick, task.id)).then(() => setParentPick(''))}>{t('automation.kanban.addParent')}</button>
          </div>
        </section>

        <section className="space-y-2">
          <h4 className="text-xs font-semibold text-gray-500">{t('automation.kanban.commentsTitle')}</h4>
          {detail.comments.map((row) => (
            <div key={row.id} className="text-xs"><span className="font-medium text-gray-800">{row.author}</span> <span className="text-gray-400">{formatTime(row.createdAt)}</span><p dir="auto" className="text-gray-700 whitespace-pre-wrap">{row.body}</p></div>
          ))}
          <div className="flex gap-2">
            <input className={inputClass} value={comment} placeholder={t('automation.kanban.commentPlaceholder')} onChange={(event) => setComment(event.target.value)} />
            <button className={secondaryButton} disabled={!comment.trim()} onClick={() => void act(addTaskComment(task.id, comment)).then((ok) => ok && setComment(''))}>{t('automation.kanban.addComment')}</button>
          </div>
        </section>

        <section className="space-y-1">
          <h4 className="text-xs font-semibold text-gray-500">{t('automation.kanban.eventsTitle')}</h4>
          {detail.events.map((row) => (
            <div key={row.id} className="text-[11px] text-gray-500">{formatTime(row.createdAt)} · {t(`automation.kanban.events.${row.kind}`, { defaultValue: row.kind })}</div>
          ))}
        </section>
      </div>
    </aside>
  );
}
