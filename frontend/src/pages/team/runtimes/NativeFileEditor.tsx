import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getRuntimeFile, saveRuntimeFile } from '../../../api/runtime';
import { resolveApiErrorMessage, type ErrorDisplay } from './runtimeLogic';
import { Badge, Button, Card, ErrorBanner, editorClass, readJson } from './runtimeUi';

type FileView = { path: string; language: string; exists: boolean; content: string; revision: string; redactedCount: number };

/**
 * 原生偏好 / 配置文件编辑器。凭据值在服务端就换成了 `<clawopt:redacted:N>`，保存时服务端按序号换回；
 * 版本号不符（别处改过）412 → 提示重新加载；过期的加载结果按序号丢弃。
 */
export default function NativeFileEditor({ runtimeId, fileKey, title }: { runtimeId: string; fileKey: 'preference' | 'config'; title: string }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<FileView | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const loadSeq = useRef(0);

  const load = async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await getRuntimeFile(runtimeId, fileKey);
      const data = await readJson(res);
      if (seq !== loadSeq.current) return;
      if (!res.ok) {
        setFile(null);
        setError(resolveApiErrorMessage(data, t, 'runtimes.loadFailed'));
        return;
      }
      setFile(data.file);
      setDraft(data.file.content);
    } catch {
      if (seq === loadSeq.current) setError({ message: t('sidebar.netError'), detail: '' });
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [runtimeId, fileKey]);

  const dirty = file !== null && draft !== file.content;

  const save = async () => {
    if (!file || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await saveRuntimeFile(runtimeId, fileKey, draft, file.revision);
      const data = await readJson(res);
      if (!res.ok) {
        setError(res.status === 412
          ? { message: t('runtimes.config.conflict'), detail: '' }
          : resolveApiErrorMessage(data, t, 'runtimes.saveFailed'));
        return;
      }
      setFile(data.file);
      setDraft(data.file.content);
      setSaved(true);
    } catch {
      setError({ message: t('sidebar.netError'), detail: '' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-gray-900">{title}</h4>
            {file && !file.exists && <Badge tone="amber">{t('runtimes.config.notCreated')}</Badge>}
            {file && file.redactedCount > 0 && <Badge tone="blue">{t('runtimes.config.redacted', { count: file.redactedCount })}</Badge>}
          </div>
          {file && <div className="text-xs text-gray-500 font-mono truncate mt-0.5" title={file.path}>{file.path}</div>}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={loading || saving} onClick={() => void load()}>{t('runtimes.config.reload')}</Button>
          <Button size="sm" variant="primary" busy={saving} disabled={!dirty || loading} onClick={() => void save()}>{t('common.save')}</Button>
        </div>
      </div>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {saved && !dirty && <div className="text-xs text-green-700">{t('runtimes.config.saved')}</div>}
      <textarea
        className={editorClass}
        spellCheck={false}
        disabled={loading || file === null}
        value={draft}
        placeholder={loading ? t('runtimes.loading') : ''}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); }}
      />
    </Card>
  );
}
