// 工作区身份文件编辑器：七个 md 文件，带字数 / token 估算；保存带版本号，别处改过就提示并载入最新内容。
import { RotateCcw, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rosterApi } from '../../api/control';
import { Badge, Button, ErrorBanner, formatNumber, formatTime, LoadingRow, Notice, textareaClass, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../control/useControlApi';

type FileSummary = { name: string; exists: boolean; size: number; chars: number; estimatedTokens: number; mtimeMs: number | null; revision: string };
type FileContent = FileSummary & { content: string };

export default function WorkspaceFilesEditor({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [active, setActive] = useState('SOUL.md');
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadList = useCallback(async () => {
    const result = await readApi<{ files: FileSummary[] }>(rosterApi.workspaceFiles(agentId)).catch(() => null);
    if (result?.ok) setFiles(result.data.files);
    else {
      setFiles([]);
      if (result) setError(errors.fromResult(result, 'control.agents.filesLoadFailed'));
    }
  }, [agentId, errors]);

  const loadFile = useCallback(async (name: string) => {
    setFile(null);
    setConflict(false);
    const result = await readApi<{ file: FileContent }>(rosterApi.workspaceFile(agentId, name)).catch(() => null);
    if (result?.ok) {
      setFile(result.data.file);
      setDraft(result.data.file.content);
    } else if (result) setError(errors.fromResult(result, 'control.agents.filesLoadFailed'));
  }, [agentId, errors]);

  useEffect(() => {
    setError(null);
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadFile(active);
  }, [active, loadFile]);

  const dirty = file !== null && draft !== file.content;
  const chars = [...draft].length;
  const tokens = [...draft].reduce((sum, ch) => sum + (/[　-鿿가-힯]/.test(ch) ? 1 : 0.25), 0);

  const save = async () => {
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      const result = await readApi<{ revision: string }>(rosterApi.saveWorkspaceFile(agentId, file.name, draft, file.revision));
      if (result.ok) {
        setFile({ ...file, content: draft, revision: result.data.revision, exists: true });
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2000);
        void loadList();
      } else if (result.status === 412) {
        setConflict(true);
      } else {
        setError(errors.fromResult(result, 'control.agents.fileSaveFailed'));
      }
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {files === null ? <LoadingRow /> : (
        <div className="flex flex-wrap gap-2">
          {files.map((entry) => (
            <button
              key={entry.name}
              type="button"
              // 有未保存的改动时不切换文件（不用浏览器原生确认框），界面给出提示。
              onClick={() => { if (!dirty) setActive(entry.name); }}
              title={dirty && active !== entry.name ? t('control.agents.saveOrResetFirst') : undefined}
              className={`px-3 h-8 rounded-lg text-xs font-medium border ${active === entry.name ? 'bg-amber-50 border-orange-300 text-gray-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'} ${entry.exists ? '' : 'opacity-60'}`}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      {conflict && (
        <Notice>
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('control.common.changedElsewhere')}</span>
            <Button size="sm" onClick={() => void loadFile(active)}><RotateCcw className="w-3.5 h-3.5" />{t('control.common.reloadLatest')}</Button>
          </div>
        </Notice>
      )}
      {!file ? <LoadingRow /> : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            {!file.exists && <Badge tone="amber">{t('control.agents.fileMissing')}</Badge>}
            <span>{t('control.agents.chars', { count: chars })}</span>
            <span>≈ {formatNumber(Math.ceil(tokens), i18n.language)} tokens</span>
            <span>{t('control.agents.modified')}: {formatTime(file.mtimeMs, i18n.language)}</span>
          </div>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} readOnly={!canEdit} rows={18} spellCheck={false} className={`${textareaClass} text-xs min-h-[320px]`} />
          {canEdit && (
            <div className="flex justify-end gap-2">
              {saved && <span className="text-sm text-green-600 self-center">{t('control.common.saved')}</span>}
              <Button disabled={!dirty} onClick={() => setDraft(file.content)}><RotateCcw className="w-4 h-4" />{t('common.reset')}</Button>
              <Button variant="primary" busy={saving} disabled={!dirty || conflict} onClick={save}><Save className="w-4 h-4" />{t('common.save')}</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
