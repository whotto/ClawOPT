// 工作流列表：新建、选择、批量选择删除。宽屏在画布左侧，窄屏收成顶部下拉。
import { CheckSquare, Plus, Trash2, Workflow } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowSummary } from '../lib/types';
import { iconButton, inputClass, primaryButton } from './ui';

export default function WorkflowListPanel({ workflows, activeId, canManage, onSelect, onCreate, onDelete }: {
  workflows: WorkflowSummary[];
  /** 新建与批量删除是管理员的（workflows.manage）。 */
  canManage: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim());
    setName('');
    setCreating(false);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-1">
        <span className="flex-1 text-sm font-semibold text-gray-900">{t('automation.list.title')}</span>
        {canManage && <button className={iconButton} title={t('automation.list.batch')} onClick={() => { setSelecting(!selecting); setSelected([]); }}><CheckSquare className="w-4 h-4" /></button>}
        {canManage && <button className={iconButton} title={t('automation.list.create')} onClick={() => setCreating(true)}><Plus className="w-4 h-4" /></button>}
      </div>
      {creating && (
        <div className="p-3 border-b border-gray-100 space-y-2">
          <input autoFocus className={inputClass} value={name} placeholder={t('automation.list.namePlaceholder')} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && submit()} />
          <div className="flex gap-2">
            <button className={primaryButton} onClick={submit}>{t('automation.list.create')}</button>
            <button className="text-sm text-gray-500" onClick={() => setCreating(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      {selecting && (
        <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between text-xs text-gray-600">
          <span>{t('automation.list.selected', { count: selected.length })}</span>
          <button disabled={!selected.length} className="inline-flex items-center gap-1 text-red-600 disabled:opacity-40" onClick={() => { onDelete(selected); setSelected([]); setSelecting(false); }}>
            <Trash2 className="w-3.5 h-3.5" />{t('common.delete')}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {workflows.length === 0 && <p className="p-3 text-sm text-gray-500">{t('automation.list.empty')}</p>}
        {workflows.map((workflow) => (
          <button
            key={workflow.id}
            onClick={() => (selecting ? setSelected(selected.includes(workflow.id) ? selected.filter((id) => id !== workflow.id) : [...selected, workflow.id]) : onSelect(workflow.id))}
            className={`w-full text-left px-3 py-2 rounded-xl border flex items-center gap-2 text-sm ${activeId === workflow.id && !selecting ? 'bg-amber-50 border-orange-300 font-semibold text-gray-700' : 'border-transparent text-gray-600 hover:bg-gray-100'}`}
          >
            {selecting ? <input type="checkbox" readOnly checked={selected.includes(workflow.id)} /> : <Workflow className="w-4 h-4 shrink-0 text-gray-400" />}
            <span className="min-w-0 flex-1 truncate">{workflow.name}</span>
            <span className="text-[11px] text-gray-400">{t('automation.list.nodeCount', { count: workflow.nodeCount })}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
