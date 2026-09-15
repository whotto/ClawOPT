import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderX } from 'lucide-react';
import { getRuntimeHomes, saveRuntimeHomesSettings, sweepRuntimeHomes } from '../../../api/runtime';
import { resolveApiErrorMessage, type ErrorDisplay } from './runtimeLogic';
import { Button, Card, ErrorBanner, inputClass, readJson } from './runtimeUi';

/** 运行时目录回收：空闲多少天回收（0 = 只在会话 / 成员删除时回收）与立即清扫。 */
export default function RuntimeHomesCard() {
  const { t } = useTranslation();
  const [idleDays, setIdleDays] = useState('');
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState<'save' | 'sweep' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<ErrorDisplay | null>(null);

  const load = async () => {
    const res = await getRuntimeHomes();
    const data = await readJson(res);
    if (!res.ok) return setError(resolveApiErrorMessage(data, t, 'runtimes.loadFailed'));
    setIdleDays(String(data.settings?.idleDays ?? 30));
    setTotal(typeof data.total === 'number' ? data.total : 0);
  };

  useEffect(() => { void load(); }, []);

  const save = async () => {
    setBusy('save');
    setError(null);
    setNotice('');
    try {
      const res = await saveRuntimeHomesSettings(Number(idleDays));
      const data = await readJson(res);
      if (!res.ok) setError(resolveApiErrorMessage(data, t, 'runtimes.saveFailed'));
      else setNotice(t('runtimes.homes.saved'));
    } finally {
      setBusy(null);
    }
  };

  const sweep = async () => {
    setBusy('sweep');
    setError(null);
    setNotice('');
    try {
      const res = await sweepRuntimeHomes();
      const data = await readJson(res);
      if (!res.ok) setError(resolveApiErrorMessage(data, t, 'runtimes.saveFailed'));
      else setNotice(t('runtimes.homes.swept', { count: Array.isArray(data.removed) ? data.removed.length : 0 }));
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start gap-3">
        <FolderX className="w-5 h-5 text-gray-400 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-gray-900">{t('runtimes.homes.title')}</h4>
          <p className="text-xs text-gray-500 mt-0.5">{t('runtimes.homes.description')}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-gray-700 mb-1">{t('runtimes.homes.idleDays')}</span>
          <input className={`${inputClass} w-28`} type="number" min={0} max={3650} value={idleDays} onChange={(event) => setIdleDays(event.target.value)} />
        </label>
        <Button size="sm" variant="primary" busy={busy === 'save'} disabled={busy !== null || idleDays === ''} onClick={save}>{t('common.save')}</Button>
        <Button size="sm" busy={busy === 'sweep'} disabled={busy !== null} onClick={sweep}>{t('runtimes.homes.sweep')}</Button>
        {total !== null && <span className="text-xs text-gray-500">{t('runtimes.homes.total', { count: total })}</span>}
      </div>
      {notice && <div className="text-xs text-green-700">{notice}</div>}
      <ErrorBanner error={error} onClose={() => setError(null)} />
    </Card>
  );
}
