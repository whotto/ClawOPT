import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Cpu, RefreshCw } from 'lucide-react';
import { useShellContext } from '../../../app/shellContext';
import {
  checkRuntimeUpdate,
  installRuntime,
  listRuntimes,
  refreshRuntimes,
  setRuntimeAutoUpdate,
  uninstallRuntime,
  updateRuntime,
} from '../../../api/runtime';
import DiagnoseDialog from './DiagnoseDialog';
import RuntimeCard from './RuntimeCard';
import RuntimeConfigPage from './RuntimeConfigPage';
import RuntimeHomesCard from './RuntimeHomesCard';
import {
  buildDiagnosePrompt,
  parseRuntimeQuery,
  resolveApiErrorMessage,
  type ErrorDisplay,
  type HostCapabilities,
  type RuntimeCardAction,
  type RuntimeStatus,
  readJson,
} from './runtimeLogic';
import { Badge, Button, Card, ErrorBanner } from '../../../components/control/ControlUi';

/**
 * 团队 → Agent 运行时（`/settings/runtimes`）：每个外部运行时一张卡；`?runtime=<id>` 进它的配置页。
 * 首屏用服务端缓存的探测快照，「刷新」才全部重探。
 */
export default function RuntimesPage() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const shell = useShellContext();
  const { runtimeId, section } = parseRuntimeQuery(location.search);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [host, setHost] = useState<HostCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pageError, setPageError] = useState<ErrorDisplay | null>(null);
  const [busy, setBusy] = useState<Record<string, RuntimeCardAction | 'autoUpdate' | null>>({});
  const [errors, setErrors] = useState<Record<string, ErrorDisplay | null>>({});
  const [diagnose, setDiagnose] = useState<{ prompt: string } | null>(null);

  const apply = (data: any) => {
    if (Array.isArray(data?.runtimes)) setRuntimes(data.runtimes);
    if (data?.host) setHost(data.host);
  };

  const load = useCallback(async (refresh: boolean) => {
    const setFlag = refresh ? setRefreshing : setLoading;
    setFlag(true);
    try {
      const res = await (refresh ? refreshRuntimes() : listRuntimes());
      const data = await readJson(res);
      if (!res.ok) setPageError(resolveApiErrorMessage(data, t, 'runtimes.loadFailed'));
      else {
        setPageError(null);
        apply(data);
      }
    } catch {
      setPageError({ message: t('sidebar.netError'), detail: '' });
    } finally {
      setFlag(false);
    }
  }, [t]);

  useEffect(() => {
    if (!runtimeId) void load(false);
  }, [runtimeId, load]);

  const patchStatus = (status: RuntimeStatus | undefined) => {
    if (!status) return;
    setRuntimes((prev) => prev.map((item) => (item.id === status.id ? { ...item, ...status } : item)));
  };

  const runAction = async (status: RuntimeStatus, action: RuntimeCardAction) => {
    if (action === 'settings') {
      navigate(`/settings/runtimes?runtime=${encodeURIComponent(status.id)}`);
      return;
    }
    setBusy((prev) => ({ ...prev, [status.id]: action }));
    setErrors((prev) => ({ ...prev, [status.id]: null }));
    try {
      const request = action === 'install' ? installRuntime : action === 'update' ? updateRuntime : action === 'uninstall' ? uninstallRuntime : checkRuntimeUpdate;
      const res = await request(status.id);
      const data = await readJson(res);
      if (!res.ok) {
        setErrors((prev) => ({ ...prev, [status.id]: resolveApiErrorMessage(data, t, 'runtimes.operationFailed') }));
        if (data.operation) patchStatus({ ...status, lastOperation: data.operation });
        return;
      }
      if (data.status) patchStatus({ ...data.status, lastOperation: data.operation ?? null, adapterRegistered: status.adapterRegistered });
      if (data.update) patchStatus({ ...status, update: data.update });
    } catch {
      setErrors((prev) => ({ ...prev, [status.id]: { message: t('sidebar.netError'), detail: '' } }));
    } finally {
      setBusy((prev) => ({ ...prev, [status.id]: null }));
    }
  };

  const toggleAutoUpdate = async (status: RuntimeStatus, next: boolean) => {
    setBusy((prev) => ({ ...prev, [status.id]: 'autoUpdate' }));
    try {
      const res = await setRuntimeAutoUpdate(status.id, next);
      const data = await readJson(res);
      if (!res.ok) setErrors((prev) => ({ ...prev, [status.id]: resolveApiErrorMessage(data, t, 'runtimes.saveFailed') }));
      else patchStatus({ ...status, autoUpdate: next });
    } finally {
      setBusy((prev) => ({ ...prev, [status.id]: null }));
    }
  };

  const openDiagnose = (status: RuntimeStatus) => {
    const error = errors[status.id];
    setDiagnose({
      prompt: buildDiagnosePrompt({ status, operation: status.lastOperation, errorMessage: error?.message ?? '', host, locale: i18n.resolvedLanguage || i18n.language }),
    });
  };

  if (runtimeId) {
    return <RuntimeConfigPage runtimeId={runtimeId} section={section} onBack={() => navigate('/settings/runtimes')} />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('runtimes.title')}</h3>
          <p className="text-sm text-gray-500">{t('runtimes.intro')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button busy={refreshing} disabled={loading} onClick={() => void load(true)}>
            <RefreshCw className="w-4 h-4" />{t('runtimes.refresh')}
          </Button>
        </div>
      </div>

      <ErrorBanner error={pageError} onClose={() => setPageError(null)} />

      {host && (
        <Card className="p-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
          <Cpu className="w-4 h-4 text-gray-400" />
          <span>{t('runtimes.host.memory', { free: host.memory.freeMb, total: host.memory.totalMb })}</span>
          {(['npm', 'uv', 'python3', 'git', 'pnpm'] as const).map((tool) => (
            <Badge key={tool} tone={host.tools[tool] ? 'green' : 'gray'}>{host.tools[tool] ? `${tool} ${host.tools[tool]}` : t('runtimes.host.missing', { tool })}</Badge>
          ))}
          <Badge tone={host.modules.nodePty ? 'green' : 'gray'}>{host.modules.nodePty ? 'node-pty' : t('runtimes.host.missing', { tool: 'node-pty' })}</Badge>
          <Badge tone={host.modules.sharp ? 'green' : 'gray'}>{host.modules.sharp ? 'sharp' : t('runtimes.host.missing', { tool: 'sharp' })}</Badge>
          {!host.gates.runtimeInstall.allowed && host.gates.runtimeInstall.reason && <span className="text-amber-700">{t(host.gates.runtimeInstall.reason)}</span>}
        </Card>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">{t('runtimes.loading')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {runtimes.map((status) => (
            <RuntimeCard
              key={status.id}
              status={status}
              host={host}
              busy={busy[status.id] ?? null}
              error={errors[status.id] ?? null}
              onAction={(action) => void runAction(status, action)}
              onAutoUpdate={(next) => void toggleAutoUpdate(status, next)}
              onDiagnose={() => openDiagnose(status)}
              onDismissError={() => setErrors((prev) => ({ ...prev, [status.id]: null }))}
            />
          ))}
        </div>
      )}

      <RuntimeHomesCard />

      {diagnose && (
        <DiagnoseDialog
          agents={shell.sessions.map((session) => ({ id: session.id, name: session.name }))}
          onSessionsChanged={shell.reloadSessions}
          prompt={diagnose.prompt}
          onClose={() => setDiagnose(null)}
        />
      )}
    </div>
  );
}
