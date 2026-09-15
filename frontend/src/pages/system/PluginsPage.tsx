// 插件清单（系统区）：状态徽标、详情、启停、安装（只接受包规格）、更新、卸载。
import { Download, Eye, Power, PowerOff, RefreshCw, Search, Trash2, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pluginsApi } from '../../api/control';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBanner, inputClass, labelClass, LoadingRow, Modal, Notice, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useCurrentUser, useErrorDisplay } from '../control/useControlApi';

type Plugin = {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
  origin: string | null;
  enabled: boolean;
  status: string | null;
  toolCount: number;
  hookCount: number;
  channelIds: string[];
  providerIds: string[];
  commandCount: number;
  dependenciesMissing: string[];
};

function statusTone(status: string | null): 'green' | 'gray' | 'amber' | 'red' {
  if (status === 'loaded' || status === 'enabled' || status === 'active') return 'green';
  if (status === 'error' || status === 'failed') return 'red';
  if (status === 'disabled' || !status) return 'gray';
  return 'amber';
}

export default function PluginsPage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const { isAdmin } = useCurrentUser();
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [query, setQuery] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; data: unknown } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [spec, setSpec] = useState('');
  const [acknowledgeRisk, setAcknowledgeRisk] = useState(false);
  const [uninstalling, setUninstalling] = useState<Plugin | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async (refresh = false) => {
    setError(null);
    try {
      const result = await readApi<{ plugins: Plugin[] }>(pluginsApi.list(refresh));
      if (result.ok) setPlugins(result.data.plugins);
      else {
        setPlugins([]);
        setError(errors.fromResult(result, 'control.plugins.loadFailed'));
      }
    } catch (exception) {
      setPlugins([]);
      setError(errors.fromException(exception));
    }
  }, [errors]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => (plugins ?? []).filter((plugin) => {
    if (onlyEnabled && !plugin.enabled) return false;
    const needle = query.trim().toLowerCase();
    return !needle || `${plugin.id} ${plugin.name} ${plugin.description ?? ''}`.toLowerCase().includes(needle);
  }), [plugins, onlyEnabled, query]);

  const run = async (key: string, request: () => Promise<Response>, onOk?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await readApi(request());
      if (result.ok) {
        onOk?.();
        await load(true);
      } else setError(errors.fromResult(result));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  const openDetail = async (plugin: Plugin) => {
    setDetail({ id: plugin.id, data: null });
    const result = await readApi<{ plugin: unknown }>(pluginsApi.inspect(plugin.id)).catch(() => null);
    setDetail({ id: plugin.id, data: result?.ok ? result.data.plugin : result?.data ?? null });
  };

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('control.plugins.title')}
        description={t('control.plugins.description')}
        actions={(
          <>
            <Button onClick={() => void load(true)}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>
            {isAdmin && <Button busy={busy === 'update-all'} onClick={() => void run('update-all', pluginsApi.updateAll, () => setNotice(t('control.plugins.updated')))}><UploadCloud className="w-4 h-4" />{t('control.plugins.updateAll')}</Button>}
            {isAdmin && <Button variant="primary" onClick={() => setInstalling(true)}><Download className="w-4 h-4" />{t('control.plugins.install')}</Button>}
          </>
        )}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {notice && <Notice tone="green">{notice}</Notice>}
      <Notice tone="blue">{t('control.plugins.restartHint')}</Notice>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} className={`${inputClass} pl-9`} placeholder={t('control.plugins.search')} />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={onlyEnabled} onChange={(event) => setOnlyEnabled(event.target.checked)} />
          {t('control.plugins.onlyEnabled')}
        </label>
      </div>

      {plugins === null ? <LoadingRow /> : visible.length === 0 ? <EmptyState>{t('control.plugins.empty')}</EmptyState> : (
        <Card className="divide-y divide-gray-100">
          {visible.map((plugin) => (
            <div key={plugin.id} className="p-4 flex flex-col md:flex-row md:items-center gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-gray-900 break-all">{plugin.name}</span>
                  <Badge tone={statusTone(plugin.status)}>{plugin.status ?? t('common.unknown')}</Badge>
                  {plugin.origin && <Badge tone="blue">{plugin.origin}</Badge>}
                  {plugin.version && <span className="text-xs text-gray-400">v{plugin.version}</span>}
                  {plugin.dependenciesMissing.length > 0 && <Badge tone="red">{t('control.plugins.missingDeps', { count: plugin.dependenciesMissing.length })}</Badge>}
                </div>
                {plugin.description && <div className="text-sm text-gray-500 line-clamp-2">{plugin.description}</div>}
                <div className="text-xs text-gray-400 flex flex-wrap gap-x-3">
                  <span>{plugin.id}</span>
                  <span>{t('control.plugins.tools', { count: plugin.toolCount })}</span>
                  <span>{t('control.plugins.hooks', { count: plugin.hookCount })}</span>
                  {plugin.channelIds.length > 0 && <span>{t('control.plugins.channels')}: {plugin.channelIds.join(', ')}</span>}
                  {plugin.providerIds.length > 0 && <span>{t('control.plugins.providers')}: {plugin.providerIds.join(', ')}</span>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void openDetail(plugin)}><Eye className="w-3.5 h-3.5" />{t('control.plugins.inspect')}</Button>
                {isAdmin && (plugin.enabled
                  ? <Button size="sm" busy={busy === `toggle:${plugin.id}`} onClick={() => void run(`toggle:${plugin.id}`, () => pluginsApi.disable(plugin.id))}><PowerOff className="w-3.5 h-3.5" />{t('control.plugins.disable')}</Button>
                  : <Button size="sm" busy={busy === `toggle:${plugin.id}`} onClick={() => void run(`toggle:${plugin.id}`, () => pluginsApi.enable(plugin.id))}><Power className="w-3.5 h-3.5" />{t('control.plugins.enable')}</Button>)}
                {isAdmin && plugin.origin !== 'bundled' && (
                  <>
                    <Button size="sm" busy={busy === `update:${plugin.id}`} onClick={() => void run(`update:${plugin.id}`, () => pluginsApi.update(plugin.id))}><UploadCloud className="w-3.5 h-3.5" />{t('control.plugins.update')}</Button>
                    <Button size="sm" variant="danger" onClick={() => setUninstalling(plugin)}><Trash2 className="w-3.5 h-3.5" />{t('control.plugins.uninstall')}</Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {installing && (
        <Modal
          title={t('control.plugins.installTitle')}
          onClose={() => setInstalling(false)}
          footer={(
            <>
              <Button onClick={() => setInstalling(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" busy={busy === 'install'} disabled={!spec.trim()} onClick={() => void run('install', () => pluginsApi.install({ spec: spec.trim(), acknowledgeRisk }), () => { setInstalling(false); setNotice(t('control.plugins.installed')); })}>{t('control.plugins.install')}</Button>
            </>
          )}
        >
          <label className="block">
            <span className={labelClass}>{t('control.plugins.spec')}</span>
            <input value={spec} onChange={(event) => setSpec(event.target.value)} className={`${inputClass} font-mono`} placeholder="@scope/openclaw-plugin · clawhub:owner/pkg" />
          </label>
          <p className="text-xs text-gray-400">{t('control.plugins.specHint')}</p>
          <label className="flex items-start gap-2 text-sm text-gray-600">
            <input type="checkbox" className="mt-1" checked={acknowledgeRisk} onChange={(event) => setAcknowledgeRisk(event.target.checked)} />
            {t('control.plugins.acknowledgeRisk')}
          </label>
        </Modal>
      )}

      {uninstalling && (
        <ConfirmDialog
          title={t('control.plugins.uninstall')}
          message={t('control.plugins.confirmUninstall', { name: uninstalling.name })}
          confirmLabel={t('control.plugins.uninstall')}
          busy={busy === `uninstall:${uninstalling.id}`}
          onConfirm={() => void run(`uninstall:${uninstalling.id}`, () => pluginsApi.uninstall(uninstalling.id), () => setUninstalling(null))}
          onCancel={() => setUninstalling(null)}
        />
      )}

      {detail && (
        <Modal title={detail.id} onClose={() => setDetail(null)}>
          {detail.data === null ? <LoadingRow /> : <pre className="text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">{JSON.stringify(detail.data, null, 2)}</pre>}
        </Modal>
      )}
    </div>
  );
}
