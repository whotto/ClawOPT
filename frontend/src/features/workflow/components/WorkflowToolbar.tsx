// 画布顶部工具栏：名称、加节点、撤销、保存、运行，以及定时 / 钩子 / 导入导出 / 设置 / 运行面板开关。
import { CalendarClock, FileJson, History, Loader2, Play, Plus, Save, Settings2, Undo2, Webhook } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { iconButton, primaryButton, secondaryButton } from './ui';

export type ToolbarModal = 'schedules' | 'hooks' | 'io' | 'settings';

export default function WorkflowToolbar({ name, onName, replay, canManage, dirty, saving, canUndo, runBusy, savedAt, onAddNode, onUndo, onSave, onRun, onModal, runsOpen, onToggleRuns, onExitReplay }: {
  name: string;
  onName: (value: string) => void;
  replay: boolean;
  /** 改定义、定时、钩子、导入导出、运行设置是管理员的（workflows.manage）；运行与看运行记录不是。 */
  canManage: boolean;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  runBusy: boolean;
  savedAt: number | null;
  onAddNode: () => void;
  onUndo: () => void;
  onSave: () => void;
  onRun: () => void;
  onModal: (modal: ToolbarModal) => void;
  runsOpen: boolean;
  onToggleRuns: () => void;
  onExitReplay: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-3 py-2 border-b border-gray-200 bg-white flex flex-wrap items-center gap-2">
      <input
        className="min-w-0 flex-1 basis-40 px-2 py-1.5 text-sm font-semibold text-gray-900 rounded-lg border border-transparent hover:border-gray-200 focus:border-gray-200 focus:outline-none bg-transparent disabled:text-gray-500"
        value={name}
        disabled={replay || !canManage}
        onChange={(event) => onName(event.target.value)}
        aria-label={t('automation.toolbar.name')}
      />
      {replay ? (
        <button className={secondaryButton} onClick={onExitReplay}>{t('automation.toolbar.exitReplay')}</button>
      ) : (
        <>
          {canManage && (
            <>
              <button className={iconButton} title={t('automation.toolbar.addNode')} onClick={onAddNode}><Plus className="w-4 h-4" /></button>
              <button className={iconButton} title={t('automation.toolbar.undo')} disabled={!canUndo} onClick={onUndo}><Undo2 className="w-4 h-4" /></button>
              <button className={secondaryButton} disabled={saving || !dirty} onClick={onSave}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                <span className="hidden sm:inline">{dirty ? t('automation.toolbar.save') : savedAt ? t('automation.toolbar.saved') : t('automation.toolbar.save')}</span>
              </button>
            </>
          )}
          <button className={primaryButton} disabled={runBusy || dirty} title={dirty ? t('automation.toolbar.saveBeforeRun') : undefined} onClick={onRun}>
            <Play className="w-4 h-4" />
            <span className="hidden sm:inline">{t('automation.toolbar.run')}</span>
          </button>
        </>
      )}
      <div className="flex items-center gap-0.5">
        {canManage && (
          <>
            <button className={iconButton} title={t('automation.toolbar.schedules')} onClick={() => onModal('schedules')}><CalendarClock className="w-4 h-4" /></button>
            <button className={iconButton} title={t('automation.toolbar.hooks')} onClick={() => onModal('hooks')}><Webhook className="w-4 h-4" /></button>
            <button className={iconButton} title={t('automation.toolbar.importExport')} onClick={() => onModal('io')}><FileJson className="w-4 h-4" /></button>
            <button className={iconButton} title={t('automation.toolbar.settings')} onClick={() => onModal('settings')}><Settings2 className="w-4 h-4" /></button>
          </>
        )}
        <button className={`${iconButton} ${runsOpen ? 'bg-amber-50 text-gray-900' : ''}`} title={t('automation.toolbar.runs')} onClick={onToggleRuns}><History className="w-4 h-4" /></button>
      </div>
    </div>
  );
}
