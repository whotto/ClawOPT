// 服务商模型目录：刷新（移除要确认、先看差异）、一步撤销、挑选器可见性白名单、上下文长度覆盖（写引擎 contextWindow，带版本号）。
import { History, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { providersApi } from '../../../api/control';
import { Badge, Button, ErrorBanner, formatTime, inputClass, LoadingRow, Modal, Notice, type ErrorDisplay } from '../../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../../control/useControlApi';

type Catalog = { models: string[]; unavailableModels: string[]; updatedAt: number; restoreAvailable: boolean } | null;
type CatalogResponse = { catalog: Catalog; configured: string[]; custom: string[]; visibility: { mode: 'all' | 'include'; models: string[] } };
type Diff = { added: string[]; removed: string[]; unchanged: string[]; keptUnavailable: string[] };

export default function ProviderCatalogModal({ providerId, revision, contextLengths, onClose, onChanged }: {
  providerId: string;
  revision: string | null;
  contextLengths: Record<string, number>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [pendingDiff, setPendingDiff] = useState<Diff | null>(null);
  const [visibleSet, setVisibleSet] = useState<Set<string> | null>(null);
  const [contexts, setContexts] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(contextLengths).map(([model, value]) => [model, String(value)])));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async () => {
    const result = await readApi<CatalogResponse>(providersApi.catalog(providerId)).catch(() => null);
    if (result?.ok) {
      setData(result.data);
      setVisibleSet(result.data.visibility.mode === 'include' ? new Set(result.data.visibility.models) : null);
    } else if (result) setError(errors.fromResult(result));
  }, [providerId, errors]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async (confirm: boolean) => {
    setBusy('refresh');
    setError(null);
    try {
      const result = await readApi<{ requiresConfirmation: boolean; diff: Diff }>(providersApi.refreshCatalog(providerId, confirm));
      if (!result.ok) setError(errors.fromResult(result, 'control.models.refreshFailed'));
      else if (result.data.requiresConfirmation) setPendingDiff(result.data.diff);
      else {
        setPendingDiff(null);
        setNotice(t('control.models.refreshed', { added: result.data.diff.added.length, removed: result.data.diff.removed.length }));
        await load();
      }
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  const allModels = [...new Set([...(data?.catalog?.models ?? []), ...(data?.catalog?.unavailableModels ?? []), ...(data?.configured ?? [])])].sort();

  const saveVisibility = async () => {
    setBusy('visibility');
    setError(null);
    const body = visibleSet ? { mode: 'include' as const, models: [...visibleSet] } : { mode: 'all' as const, models: [] };
    const result = await readApi(providersApi.setVisibility(providerId, body)).catch(() => null);
    if (result && !result.ok) setError(errors.fromResult(result));
    else {
      setNotice(t('control.common.saved'));
      onChanged();
    }
    setBusy(null);
  };

  const saveContexts = async () => {
    if (!revision) return;
    setBusy('contexts');
    setError(null);
    const patch: Record<string, number | null> = {};
    for (const model of new Set([...Object.keys(contextLengths), ...Object.keys(contexts)])) {
      const raw = (contexts[model] ?? '').trim();
      const next = raw ? Number(raw) : null;
      if ((contextLengths[model] ?? null) !== next) patch[model] = next;
    }
    try {
      const result = await readApi(providersApi.setContextLengths(providerId, patch, revision));
      if (result.ok) {
        setNotice(t('control.common.saved'));
        onChanged();
      } else if (result.status === 412) setConflict(true);
      else setError(errors.fromResult(result));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title={t('control.models.catalogTitle', { provider: providerId })} onClose={onClose} width="max-w-3xl">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {notice && <Notice tone="green">{notice}</Notice>}
      {conflict && <Notice>{t('control.common.changedElsewhere')}</Notice>}
      {!data ? <LoadingRow /> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-600">{data.catalog ? t('control.models.catalogUpdated', { time: formatTime(data.catalog.updatedAt, i18n.language), count: data.catalog.models.length }) : t('control.models.catalogNever')}</span>
            <span className="ml-auto flex gap-2">
              {data.catalog?.restoreAvailable && <Button size="sm" busy={busy === 'restore'} onClick={() => { setBusy('restore'); void readApi(providersApi.restoreCatalog(providerId)).then((result) => { if (!result.ok) setError(errors.fromResult(result)); else setNotice(t('control.models.restored')); void load(); }).finally(() => setBusy(null)); }}><History className="w-3.5 h-3.5" />{t('control.models.restore')}</Button>}
              <Button size="sm" variant="primary" busy={busy === 'refresh'} onClick={() => void refresh(false)}><RefreshCw className="w-3.5 h-3.5" />{t('control.models.refreshCatalog')}</Button>
            </span>
          </div>

          {pendingDiff && (
            <Notice>
              <div className="space-y-2">
                <div>{t('control.models.confirmRemoval', { removed: pendingDiff.removed.length, added: pendingDiff.added.length })}</div>
                <div className="text-xs font-mono break-all">- {pendingDiff.removed.join(', ')}</div>
                {pendingDiff.added.length > 0 && <div className="text-xs font-mono break-all">+ {pendingDiff.added.join(', ')}</div>}
                {pendingDiff.keptUnavailable.length > 0 && <div className="text-xs">{t('control.models.keptUnavailable', { list: pendingDiff.keptUnavailable.join(', ') })}</div>}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setPendingDiff(null)}>{t('common.cancel')}</Button>
                  <Button size="sm" variant="danger" busy={busy === 'refresh'} onClick={() => void refresh(true)}>{t('control.models.applyRefresh')}</Button>
                </div>
              </div>
            </Notice>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-gray-900">{t('control.models.visibility')}</div>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={visibleSet !== null} onChange={(event) => setVisibleSet(event.target.checked ? new Set(allModels) : null)} />
              {t('control.models.limitVisible')}
            </label>
          </div>
          <p className="text-xs text-gray-400">{t('control.models.visibilityHint')}</p>

          <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-[40vh] overflow-y-auto">
            {allModels.length === 0 ? <div className="p-4 text-sm text-gray-400">{t('control.models.catalogEmpty')}</div> : allModels.map((model) => {
              const unavailable = data.catalog?.unavailableModels.includes(model);
              const custom = data.custom.includes(model);
              return (
                <div key={model} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  {visibleSet !== null && (
                    <input type="checkbox" checked={visibleSet.has(model)} onChange={(event) => {
                      const next = new Set(visibleSet);
                      if (event.target.checked) next.add(model);
                      else next.delete(model);
                      setVisibleSet(next);
                    }} />
                  )}
                  <span className={`font-mono text-xs break-all flex-1 min-w-[160px] ${unavailable ? 'text-gray-400' : 'text-gray-800'}`}>{model}</span>
                  {data.configured.includes(model) && <Badge tone="blue">{t('control.models.configured')}</Badge>}
                  {custom && <Badge tone="amber">{t('control.models.custom')}</Badge>}
                  {unavailable && <Badge tone="red">{t('control.models.unavailable')}</Badge>}
                  {data.configured.includes(model) && (
                    <input
                      value={contexts[model] ?? ''}
                      onChange={(event) => setContexts({ ...contexts, [model]: event.target.value.replace(/[^0-9]/g, '') })}
                      className={`${inputClass} !w-32 !py-1.5 text-xs`}
                      placeholder={t('control.models.contextPlaceholder')}
                      inputMode="numeric"
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button busy={busy === 'visibility'} onClick={() => void saveVisibility()}><Save className="w-4 h-4" />{t('control.models.saveVisibility')}</Button>
            <Button variant="primary" busy={busy === 'contexts'} disabled={!revision || conflict} onClick={() => void saveContexts()}><Save className="w-4 h-4" />{t('control.models.saveContexts')}</Button>
          </div>
        </>
      )}
    </Modal>
  );
}
