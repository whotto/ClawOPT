// 原生看板：九列状态、看板切换、状态筹码（带计数、兼作过滤）、负责人与关键字过滤、批量操作、任务抽屉。
// 状态变化走显式动作（服务端守卫），不做跨列拖拽。
import { CheckSquare, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '../../../app/access';
import { ErrorBanner, Field, Modal, fieldClass, inputClass, primaryButton, secondaryButton, selectClass } from '../../../features/workflow/components/ui';
import { agentKey } from '../../../features/workflow/components/canvasContext';
import { describeError } from '../../../features/workflow/lib/request';
import TaskDrawer from './TaskDrawer';
import { KANBAN_STATUSES, useKanban, type KanbanStatus, type Task } from './useKanban';

function age(ms: number, t: (key: string, options?: Record<string, unknown>) => string) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 60) return t('automation.kanban.ageMinutes', { count: Math.max(1, minutes) });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t('automation.kanban.ageHours', { count: hours }) : t('automation.kanban.ageDays', { count: Math.round(hours / 24) });
}

export default function KanbanPage() {
  const { t } = useTranslation();
  // 看板管理、建任务、批量是管理员的（kanban.manage）；member 只看分给自己 Agent 的任务，能评论、完成、阻塞、派活。
  const canManage = useAccess().can('kanban.manage');
  const kanban = useKanban();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: '', body: '', assignee: '', priority: '0', status: 'todo' });
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkReason, setBulkReason] = useState('');
  const [boardName, setBoardName] = useState<string | null>(null);
  const board = kanban.boards.find((item) => item.id === kanban.boardId);
  const agentName = (assignee: Task['assignee']) => (assignee ? kanban.agents.find((entry) => agentKey(entry.ref) === agentKey(assignee))?.name ?? assignee.id : t('automation.kanban.unassigned'));
  const columns = useMemo(() => KANBAN_STATUSES.map((status) => ({ status, tasks: kanban.tasks.filter((task) => task.status === status) })), [kanban.tasks]);

  const submitTask = async () => {
    const assignee = kanban.agents.find((entry) => agentKey(entry.ref) === draft.assignee)?.ref;
    const created = await kanban.createTask({ title: draft.title, body: draft.body, priority: Number(draft.priority), status: draft.status, assignee: assignee ? { kind: assignee.kind, id: assignee.id } : null });
    if (created) {
      setCreating(false);
      setDraft({ title: '', body: '', assignee: '', priority: '0', status: 'todo' });
    }
  };

  const toggleStatus = (status: KanbanStatus) => kanban.setStatusFilter(kanban.statusFilter.includes(status) ? kanban.statusFilter.filter((item) => item !== status) : [...kanban.statusFilter, status]);

  const runBulk = async (body: Record<string, unknown>) => {
    const result = await kanban.bulk({ ids: selected, ...body });
    if (result) {
      const failed = result.results.filter((row) => !row.ok);
      if (failed.length) kanban.setError({ code: failed[0].errorCode ?? 'kanban.bulkFailed', params: { count: failed.length }, detail: null, status: 409 });
      setSelected([]);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 sm:px-4 py-3 border-b border-gray-200 bg-white space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <select className={`${fieldClass} w-auto`} value={kanban.boardId} onChange={(event) => kanban.setBoardId(event.target.value)}>
            {kanban.boards.map((item) => <option key={item.id} value={item.id}>{item.id === 'default' ? t('automation.kanban.defaultBoard') : item.name}</option>)}
          </select>
          {!canManage ? null : boardName === null ? (
            <button className={secondaryButton} onClick={() => setBoardName('')}>
              <Plus className="w-4 h-4" />{t('automation.kanban.newBoard')}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1">
              <input autoFocus className={`${fieldClass} w-36`} value={boardName} placeholder={t('automation.kanban.boardNamePlaceholder')} onChange={(event) => setBoardName(event.target.value)} />
              <button className={primaryButton} disabled={!boardName.trim()} onClick={async () => {
                const created = await kanban.createBoard(boardName.trim());
                if (created) kanban.setBoardId(created.board.id);
                setBoardName(null);
              }}>{t('automation.kanban.create')}</button>
              <button className={secondaryButton} onClick={() => setBoardName(null)}>{t('common.cancel')}</button>
            </span>
          )}
          <input className={`${fieldClass} w-40 flex-1 sm:flex-none`} placeholder={t('automation.kanban.search')} value={kanban.query} onChange={(event) => kanban.setQuery(event.target.value)} />
          <select className={`${fieldClass} w-auto`} value={kanban.assigneeFilter} onChange={(event) => kanban.setAssigneeFilter(event.target.value)}>
            <option value="">{t('automation.kanban.allAssignees')}</option>
            {kanban.agents.map((entry) => <option key={agentKey(entry.ref)} value={entry.ref.id}>{entry.name}</option>)}
          </select>
          <span className="flex-1" />
          {canManage && <button className={secondaryButton} onClick={() => { setSelecting(!selecting); setSelected([]); }}><CheckSquare className="w-4 h-4" />{t('automation.kanban.bulk')}</button>}
          {canManage && <button className={primaryButton} onClick={() => setCreating(true)}><Plus className="w-4 h-4" />{t('automation.kanban.newTask')}</button>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {KANBAN_STATUSES.map((status) => (
            <button key={status} onClick={() => toggleStatus(status)} className={`px-2 py-1 text-xs rounded-lg border ${kanban.statusFilter.includes(status) ? 'bg-amber-50 border-orange-300 text-gray-800 font-semibold' : 'bg-white border-gray-200 text-gray-600'}`}>
              {t(`automation.kanban.statuses.${status}`)} {board?.counts[status] ?? 0}
            </button>
          ))}
        </div>
        {selecting && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-600">{t('automation.list.selected', { count: selected.length })}</span>
            <button className={secondaryButton} disabled={!selected.length} onClick={() => void runBulk({ status: 'ready' })}>{t('automation.kanban.actions.markReady')}</button>
            <button className={secondaryButton} disabled={!selected.length} onClick={() => void runBulk({ status: 'done' })}>{t('automation.kanban.actions.complete')}</button>
            <input className={`${fieldClass} w-40`} placeholder={t('automation.kanban.reasonPlaceholder')} value={bulkReason} onChange={(event) => setBulkReason(event.target.value)} />
            <button className={secondaryButton} disabled={!selected.length || !bulkReason.trim()} onClick={() => void runBulk({ status: 'blocked', reason: bulkReason })}>{t('automation.kanban.actions.block')}</button>
            <button className={secondaryButton} disabled={!selected.length} onClick={() => void runBulk({ archive: true })}>{t('automation.kanban.actions.archive')}</button>
          </div>
        )}
        {kanban.error && <ErrorBanner message={describeError(t, kanban.error)} detail={kanban.error.detail} onDismiss={() => kanban.setError(null)} />}
      </div>
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <div className="flex gap-3 p-3 sm:p-4 h-full min-w-max">
          {columns.map((column) => (
            <section key={column.status} className="w-[82vw] sm:w-64 shrink-0 flex flex-col rounded-2xl border border-gray-200 bg-gray-100/60">
              <header className="px-3 py-2 flex items-center justify-between border-b border-gray-200">
                <span className="text-sm font-semibold text-gray-800">{t(`automation.kanban.statuses.${column.status}`)}</span>
                <span className="text-xs text-gray-500">{column.tasks.length}</span>
              </header>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {column.tasks.map((task) => (
                  <button
                    key={task.id}
                    onClick={() => (selecting ? setSelected(selected.includes(task.id) ? selected.filter((id) => id !== task.id) : [...selected, task.id]) : setOpenTaskId(task.id))}
                    className={`w-full text-left p-3 rounded-xl border bg-white space-y-1 ${selected.includes(task.id) ? 'border-orange-400' : 'border-gray-200 hover:border-gray-300'}`}
                  >
                    <div className="flex items-start gap-2">
                      {selecting && <input type="checkbox" readOnly checked={selected.includes(task.id)} className="mt-1" />}
                      <span dir="auto" className="text-sm font-medium text-gray-900 line-clamp-2 flex-1">{task.title}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500">
                      <span className="truncate">{agentName(task.assignee)}</span>
                      <span className="whitespace-nowrap">{task.priority !== 0 && `P${task.priority} · `}{age(task.createdAt, t)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      {creating && (
        <Modal title={t('automation.kanban.newTask')} onClose={() => setCreating(false)} width="max-w-lg" footer={(
          <>
            <button className={secondaryButton} onClick={() => setCreating(false)}>{t('common.cancel')}</button>
            <button className={primaryButton} disabled={!draft.title.trim()} onClick={() => void submitTask()}>{t('automation.kanban.create')}</button>
          </>
        )}>
          <Field label={t('automation.kanban.fields.title')} required><input className={inputClass} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
          <Field label={t('automation.kanban.fields.body')}><textarea className={`${inputClass} min-h-[100px]`} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Field label={t('automation.kanban.fields.assignee')}>
              <select className={selectClass} value={draft.assignee} onChange={(event) => setDraft({ ...draft, assignee: event.target.value })}>
                <option value="">{t('automation.kanban.unassigned')}</option>
                {kanban.agents.map((entry) => <option key={agentKey(entry.ref)} value={agentKey(entry.ref)} disabled={!entry.available}>{entry.name}</option>)}
              </select>
            </Field>
            <Field label={t('automation.kanban.fields.priority')}><input className={inputClass} type="number" min={-100} max={100} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })} /></Field>
            <Field label={t('automation.kanban.fields.status')}>
              <select className={selectClass} value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
                {(['triage', 'todo', 'scheduled', 'ready'] as const).map((status) => <option key={status} value={status}>{t(`automation.kanban.statuses.${status}`)}</option>)}
              </select>
            </Field>
          </div>
        </Modal>
      )}
      {openTaskId && <TaskDrawer taskId={openTaskId} canManage={canManage} agents={kanban.agents} tasks={kanban.allTasks} onChanged={() => void kanban.reload()} onClose={() => setOpenTaskId(null)} />}
    </div>
  );
}
