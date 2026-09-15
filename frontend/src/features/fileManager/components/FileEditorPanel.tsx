// 文本编辑器：读到时的版本号随保存带回；别处改过（412）提示并可载入最新内容；未保存的改动由页面统一拦截。
import { RotateCcw, Save, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, editorClass, formatNumber, Notice } from '../../../components/control/ControlUi';

export type EditorFile = { path: string; content: string; revision: string; size: number; writable: boolean };

type Props = {
  file: EditorFile;
  draft: string;
  onDraftChange: (value: string) => void;
  saving: boolean;
  saved: boolean;
  conflict: boolean;
  onSave: () => void;
  onReset: () => void;
  onReload: () => void;
  onClose: () => void;
};

export function FileEditorPanel({ file, draft, onDraftChange, saving, saved, conflict, onSave, onReset, onReload, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const dirty = draft !== file.content;
  return (
    <Card className="p-4 space-y-3" >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-sm text-gray-800 truncate flex-1" title={file.path}>{file.path}</span>
        {dirty && <Badge tone="amber">{t('fileManager.editor.unsaved')}</Badge>}
        {!file.writable && <Badge>{t('fileManager.editor.readOnly')}</Badge>}
        <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100" title={t('common.close')}>
          <X className="w-4 h-4" />
        </button>
      </div>
      {conflict && (
        <Notice>
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('control.common.changedElsewhere')}</span>
            <Button size="sm" onClick={onReload}><RotateCcw className="w-3.5 h-3.5" />{t('control.common.reloadLatest')}</Button>
          </div>
        </Notice>
      )}
      <textarea
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        readOnly={!file.writable}
        spellCheck={false}
        rows={20}
        className={`${editorClass} min-h-[360px]`}
        data-testid="file-manager-editor"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-gray-400">{t('fileManager.editor.chars', { count: [...draft].length, formatted: formatNumber([...draft].length, i18n.language) })}</span>
        {file.writable && (
          <div className="flex gap-2">
            {saved && <span className="text-sm text-green-600 self-center">{t('control.common.saved')}</span>}
            <Button disabled={!dirty} onClick={onReset}><RotateCcw className="w-4 h-4" />{t('common.reset')}</Button>
            <Button variant="primary" busy={saving} disabled={!dirty || conflict} onClick={onSave}><Save className="w-4 h-4" />{t('common.save')}</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
