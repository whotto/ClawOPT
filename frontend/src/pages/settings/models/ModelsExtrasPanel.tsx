// 模型页附加区：模型别名（openclaw models aliases）与服务商审计日志。
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { providersApi } from '../../../api/control';
import { Badge, Button, Card, ErrorBanner, formatTime, inputClass, type ErrorDisplay } from '../../../components/control/ControlUi';
import { readApi, useCurrentUser, useErrorDisplay } from '../../control/useControlApi';

type Alias = { alias: string; model: string };
type AuditEntry = { id: number; ts: number; actor: { username: string | null; role: string | null }; providerId: string; action: string; fields: string[]; result: string };

export default function ModelsExtrasPanel({ modelIds }: { modelIds: string[] }) {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const { isAdmin } = useCurrentUser();
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [alias, setAlias] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [aliasResult, auditResult] = await Promise.all([
      readApi<{ aliases: Alias[] }>(providersApi.aliases()).catch(() => null),
      isAdmin ? readApi<{ entries: AuditEntry[] }>(providersApi.audit(50)).catch(() => null) : Promise.resolve(null),
    ]);
    if (aliasResult?.ok) setAliases(aliasResult.data.aliases);
    else if (aliasResult) setError(errors.fromResult(aliasResult));
    if (auditResult?.ok) setAudit(auditResult.data.entries);
  }, [errors, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (request: Promise<Response>) => {
    setBusy(true);
    setError(null);
    const result = await readApi(request).catch(() => null);
    if (result && !result.ok) setError(errors.fromResult(result));
    setBusy(false);
    if (result?.ok) {
      setAlias('');
      setModel('');
    }
    void load();
  };

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-gray-900">{t('control.models.aliasesTitle')}</div>
            <p className="text-xs text-gray-400">{t('control.models.aliasesHint')}</p>
          </div>
          <Button size="sm" onClick={() => void load()}><RefreshCw className="w-3.5 h-3.5" /></Button>
        </div>
        {aliases.length === 0 ? <div className="text-sm text-gray-400">{t('control.models.aliasesEmpty')}</div> : (
          <div className="divide-y divide-gray-100">
            {aliases.map((entry) => (
              <div key={entry.alias} className="flex items-center gap-3 py-2 text-sm">
                <span className="font-mono text-gray-900">{entry.alias}</span>
                <span className="text-gray-400">→</span>
                <span className="font-mono text-gray-600 break-all flex-1">{entry.model}</span>
                {isAdmin && <Button size="sm" variant="ghost" busy={busy} onClick={() => void mutate(providersApi.removeAlias(entry.alias))}><Trash2 className="w-3.5 h-3.5" /></Button>}
              </div>
            ))}
          </div>
        )}
        {isAdmin && (
          <div className="flex flex-col sm:flex-row gap-2">
            <input value={alias} onChange={(event) => setAlias(event.target.value)} className={inputClass} placeholder={t('control.models.aliasPlaceholder')} />
            <select value={model} onChange={(event) => setModel(event.target.value)} className={inputClass}>
              <option value="">{t('control.models.aliasModelPlaceholder')}</option>
              {modelIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <Button variant="primary" busy={busy} disabled={!alias.trim() || !model} onClick={() => void mutate(providersApi.setAlias(alias.trim(), model))}><Plus className="w-4 h-4" />{t('common.add')}</Button>
          </div>
        )}
      </Card>

      {isAdmin && audit && (
        <Card className="p-4 space-y-3">
          <div className="text-sm font-semibold text-gray-900">{t('control.models.auditTitle')}</div>
          {audit.length === 0 ? <div className="text-sm text-gray-400">{t('control.models.auditEmpty')}</div> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[560px]">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-100">
                    <th className="py-2 pr-3 font-medium">{t('control.models.auditTime')}</th>
                    <th className="py-2 pr-3 font-medium">{t('control.models.auditActor')}</th>
                    <th className="py-2 pr-3 font-medium">{t('control.models.auditProvider')}</th>
                    <th className="py-2 pr-3 font-medium">{t('control.models.auditAction')}</th>
                    <th className="py-2 font-medium">{t('control.models.auditResult')}</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((entry) => (
                    <tr key={entry.id} className="border-b border-gray-50">
                      <td className="py-2 pr-3 text-gray-500 whitespace-nowrap">{formatTime(entry.ts, i18n.language)}</td>
                      <td className="py-2 pr-3 text-gray-700">{entry.actor.username ?? t('control.models.auditOwner')}</td>
                      <td className="py-2 pr-3 font-mono text-gray-700">{entry.providerId}</td>
                      <td className="py-2 pr-3 text-gray-700">{entry.action}{entry.fields.length ? ` (${entry.fields.join(', ')})` : ''}</td>
                      <td className="py-2"><Badge tone={entry.result === 'success' ? 'green' : entry.result === 'conflict' ? 'amber' : 'red'}>{entry.result}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
