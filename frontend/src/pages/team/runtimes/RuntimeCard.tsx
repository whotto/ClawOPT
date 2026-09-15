import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Settings2, Stethoscope } from 'lucide-react';
import { runtimeCardActions, type ErrorDisplay, type HostCapabilities, type RuntimeCardAction, type RuntimeStatus } from './runtimeLogic';
import { Badge, Button, Card, ErrorBanner, Toggle } from '../../../components/control/ControlUi';

export type RuntimeCardProps = {
  status: RuntimeStatus;
  host: HostCapabilities | null;
  busy: RuntimeCardAction | 'autoUpdate' | null;
  error: ErrorDisplay | null;
  onAction: (action: RuntimeCardAction) => void;
  onAutoUpdate: (next: boolean) => void;
  onDiagnose: () => void;
  onDismissError: () => void;
};

/** 一个运行时一张卡：装没装、版本、路径、有无新版、自动升级、安装 / 升级 / 卸载 / 设置。 */
export default function RuntimeCard({ status, host, busy, error, onAction, onAutoUpdate, onDiagnose, onDismissError }: RuntimeCardProps) {
  const { t } = useTranslation();
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const { actions, installBlockedReason } = runtimeCardActions(status, host);
  const anyBusy = busy !== null || status.locked;
  const update = status.update;

  const sourceBadge = status.source === 'npm-global'
    ? <Badge tone="blue">{t('runtimes.source.npm')}</Badge>
    : status.source === 'managed-venv'
      ? <Badge tone="blue">{t('runtimes.source.venv')}</Badge>
      : status.source === 'external'
        ? <Badge tone="gray">{t('runtimes.source.external')}</Badge>
        : null;

  return (
    <Card className="p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-10 h-10 rounded-xl border border-gray-200 bg-gray-50 flex items-center justify-center shrink-0">
          <Bot className="w-5 h-5 text-gray-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-base font-semibold text-gray-900 truncate">{status.name}</h4>
            {status.vendor && <Badge>{status.vendor}</Badge>}
            {status.kind === 'remote'
              ? <Badge tone="blue">{t('runtimes.kind.remote')}</Badge>
              : status.installed
                ? <Badge tone="green">{t('runtimes.installed')}</Badge>
                : <Badge tone="amber">{t('runtimes.notInstalled')}</Badge>}
          </div>
          <div className="mt-1 text-sm text-gray-500">
            {status.kind === 'remote'
              ? t('runtimes.remoteDescription')
              : status.version ? `v${status.version}` : t(`runtimes.description.${status.installKind}`)}
          </div>
        </div>
      </div>

      {status.kind !== 'remote' && status.installed && (
        <div className="space-y-1.5 text-xs text-gray-500 min-w-0">
          {status.path && <div className="font-mono truncate" title={status.path}>{status.path}</div>}
          <div className="flex items-center gap-2 flex-wrap">
            {sourceBadge}
            {!status.managed && <span>{t('runtimes.notManagedHint')}</span>}
            {update.state === 'available' && update.latestVersion && <Badge tone="blue">{t('runtimes.updateAvailable', { version: update.latestVersion })}</Badge>}
            {update.state === 'waiting' && <Badge tone="amber">{t('runtimes.updateWaiting')}</Badge>}
            {update.state === 'current' && <Badge tone="green">{t('runtimes.upToDate')}</Badge>}
            {update.state === 'failed' && <Badge tone="red">{t('runtimes.checkFailed')}</Badge>}
            {status.locked && <Badge tone="amber">{t('runtimes.updating')}</Badge>}
            {status.probeError && <span className="text-red-500 truncate" title={status.probeError}>{t('runtimes.probeFailed')}</span>}
          </div>
        </div>
      )}

      {!status.adapterRegistered && status.kind !== 'remote' && (
        <div className="text-xs text-gray-400">{t('runtimes.adapterPending')}</div>
      )}

      {installBlockedReason && actions.includes('install') && (
        <div className="text-xs text-amber-700">{t(installBlockedReason)}</div>
      )}

      <ErrorBanner
        error={error}
        onClose={onDismissError}
        action={(
          <Button size="sm" onClick={onDiagnose}>
            <Stethoscope className="w-3.5 h-3.5" />{t('runtimes.askAi')}
          </Button>
        )}
      />

      {status.kind !== 'remote' && (
        <div className="mt-auto flex flex-wrap items-center gap-2">
          {actions.includes('install') && (
            <Button variant="primary" size="sm" busy={busy === 'install'} disabled={anyBusy || Boolean(installBlockedReason)} onClick={() => onAction('install')}>
              {t('runtimes.install')}
            </Button>
          )}
          {actions.includes('update') && (
            <Button variant="primary" size="sm" busy={busy === 'update'} disabled={anyBusy} onClick={() => onAction('update')}>
              {t('runtimes.updateTo', { version: update.latestVersion ?? '' })}
            </Button>
          )}
          {actions.includes('checkUpdate') && (
            <Button size="sm" busy={busy === 'checkUpdate'} disabled={anyBusy} onClick={() => onAction('checkUpdate')}>
              {t('runtimes.checkUpdate')}
            </Button>
          )}
          {actions.includes('uninstall') && (confirmUninstall ? (
            <span className="inline-flex items-center gap-1.5">
              <Button variant="danger" size="sm" busy={busy === 'uninstall'} disabled={anyBusy} onClick={() => { setConfirmUninstall(false); onAction('uninstall'); }}>
                {t('runtimes.confirmUninstall')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmUninstall(false)}>{t('common.cancel')}</Button>
            </span>
          ) : (
            <Button variant="danger" size="sm" disabled={anyBusy} onClick={() => setConfirmUninstall(true)}>{t('runtimes.uninstall')}</Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => onAction('settings')}>
            <Settings2 className="w-3.5 h-3.5" />{t('runtimes.settings')}
          </Button>
        </div>
      )}

      {status.kind !== 'remote' && status.installed && (
        <div className="border-t border-gray-100 pt-2">
          <label className={`inline-flex items-center gap-2 text-xs text-gray-600 ${!status.managed ? 'opacity-50' : ''}`}>
            <Toggle
              checked={status.autoUpdate}
              disabled={!status.managed || busy === 'autoUpdate'}
              onChange={onAutoUpdate}
              label={status.managed ? t('runtimes.autoUpdate') : t('runtimes.autoUpdateUnavailable')}
            />
            {status.managed ? t('runtimes.autoUpdate') : t('runtimes.autoUpdateUnavailable')}
          </label>
        </div>
      )}
    </Card>
  );
}
