// 网关服务状态卡：`openclaw gateway status` 的「旧数据先回、后台刷新」视图，轮询 15 秒。
// 重启沿用本页已有的重启流程（带状态机与失败提示），这里不另起一个按钮。
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { observabilityApi } from '../../../api/control';
import { Badge, Button, formatTime } from '../../../components/control/ControlUi';
import { readApi } from '../../control/useControlApi';

type Summary = {
  cliVersion: string | null;
  gatewayVersion: string | null;
  bindMode: string | null;
  port: number | null;
  serviceLoaded: boolean | null;
  serviceRuntime: string | null;
  rpcOk: boolean | null;
  rpcCapability: string | null;
  portBusy: boolean | null;
};
type Snapshot = { summary: Summary | null; errorCode: string | null; updatedAt: number | null; refreshing: boolean };

const POLL_MS = 15_000;

export default function GatewayServiceCard() {
  const { t, i18n } = useTranslation();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    const result = await readApi<Snapshot>(observabilityApi.gatewayServiceStatus(refresh)).catch(() => null);
    if (result?.ok) setSnapshot(result.data);
  }, []);

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(false); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const summary = snapshot?.summary;
  const flag = (value: boolean | null | undefined, yes: string, no: string) => (value === null || value === undefined ? <Badge>{t('common.unknown')}</Badge> : <Badge tone={value ? 'green' : 'red'}>{value ? yes : no}</Badge>);

  return (
    <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-gray-900">{t('control.gateway.serviceTitle')}</div>
          <div className="text-xs text-gray-400">
            {snapshot?.updatedAt ? t('control.gateway.updatedAt', { time: formatTime(snapshot.updatedAt, i18n.language) }) : t('control.common.loading')}
            {snapshot?.refreshing ? ` · ${t('control.gateway.refreshing')}` : ''}
          </div>
        </div>
        <Button size="sm" onClick={() => void load(true)}><RefreshCw className={`w-3.5 h-3.5 ${snapshot?.refreshing ? 'animate-spin' : ''}`} />{t('control.common.refresh')}</Button>
      </div>
      {snapshot?.errorCode && <div className="text-xs text-amber-700">{t(snapshot.errorCode)}</div>}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <div className="flex items-center justify-between gap-2"><span className="text-gray-500">{t('control.gateway.rpc')}</span>{flag(summary.rpcOk, t('control.gateway.reachable'), t('control.gateway.unreachable'))}</div>
          <div className="flex items-center justify-between gap-2"><span className="text-gray-500">{t('control.gateway.service')}</span>{flag(summary.serviceLoaded, t('control.gateway.loaded'), t('control.gateway.notLoaded'))}</div>
          <div className="flex items-center justify-between gap-2"><span className="text-gray-500">{t('control.gateway.version')}</span><span className="font-mono text-xs text-gray-700">{summary.gatewayVersion ?? '—'} / CLI {summary.cliVersion ?? '—'}</span></div>
          <div className="flex items-center justify-between gap-2"><span className="text-gray-500">{t('control.gateway.listen')}</span><span className="font-mono text-xs text-gray-700">{summary.bindMode ?? '—'}:{summary.port ?? '—'}</span></div>
          {summary.rpcCapability && <div className="flex items-center justify-between gap-2"><span className="text-gray-500">{t('control.gateway.capability')}</span><span className="font-mono text-xs text-gray-700">{summary.rpcCapability}</span></div>}
          {summary.serviceRuntime && <div className="flex items-center justify-between gap-2"><span className="text-gray-500">{t('control.gateway.runtime')}</span><span className="font-mono text-xs text-gray-700">{summary.serviceRuntime}</span></div>}
        </div>
      )}
    </div>
  );
}
