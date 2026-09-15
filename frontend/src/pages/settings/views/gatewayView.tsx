// 网关页由权限、浏览器、重启状态派生出的展示值。纯计算，每次渲染重算，与拆分前一致。
import { Activity, Loader2, Wrench } from 'lucide-react';
import { BROWSER_CHECK_PHASE_VISUALS, BROWSER_REPAIR_PHASE_VISUALS } from '../shared/phaseVisuals';
import type { useGatewaySettings } from '../hooks/useGatewaySettings';
import type { useHostAccessSettings } from '../hooks/useHostAccessSettings';
import type { useSettingsShared } from '../hooks/useSettingsShared';
import type { deriveUpdateView } from './updateView';
import type { useUpdateSettings } from '../hooks/useUpdateSettings';

export function deriveGatewayView(deps: Pick<ReturnType<typeof useGatewaySettings> & ReturnType<typeof useHostAccessSettings> & ReturnType<typeof useSettingsShared> & ReturnType<typeof deriveUpdateView> & ReturnType<typeof useUpdateSettings>, 'browserHeadedModeModalStage' | 'browserHeadedModePendingEnabled' | 'browserHealth' | 'browserHealthError' | 'browserTaskInfo' | 'devicePairingStatus' | 'gatewayRestartModalStage' | 'hasLoadedMaxPermissionsState' | 'hostTakeoverStatus' | 'isCheckingBrowserHealth' | 'isLoading' | 'isRestarting' | 'isSelfHealingBrowser' | 'maxPermissions' | 'secondaryActionButtonClass' | 't' | 'updateRestartModalStage' | 'url'>) {
  const { browserHeadedModeModalStage, browserHeadedModePendingEnabled, browserHealth, browserHealthError, browserTaskInfo, devicePairingStatus, gatewayRestartModalStage, hasLoadedMaxPermissionsState, hostTakeoverStatus, isCheckingBrowserHealth, isLoading, isRestarting, isSelfHealingBrowser, maxPermissions, secondaryActionButtonClass, t, updateRestartModalStage, url } = deps;

  const browserHeadedModeConfirmingEnable = browserHeadedModePendingEnabled === true;
  const browserHeadedModeModalTitle = browserHeadedModeModalStage === 'confirm'
    ? browserHeadedModeConfirmingEnable
      ? t('settings.gateway.browserHeadedModeConfirmEnableTitle')
      : t('settings.gateway.browserHeadedModeConfirmDisableTitle')
    : browserHeadedModeModalStage === 'restarting'
      ? t('settings.gateway.browserHeadedModeRestartingTitle')
      : browserHeadedModeModalStage === 'success'
        ? t('settings.gateway.browserHeadedModeRestartSuccessTitle')
        : browserHeadedModeModalStage === 'failure'
          ? t('settings.gateway.browserHeadedModeRestartFailedTitle')
          : '';
  const browserHeadedModeModalMessage = browserHeadedModeModalStage === 'confirm'
    ? browserHeadedModeConfirmingEnable
      ? t('settings.gateway.browserHeadedModeConfirmEnableMessage')
      : t('settings.gateway.browserHeadedModeConfirmDisableMessage')
    : browserHeadedModeModalStage === 'restarting'
      ? t('settings.gateway.browserHeadedModeRestartingMessage')
      : browserHeadedModeModalStage === 'success'
        ? browserHeadedModeConfirmingEnable
          ? t('settings.gateway.browserHeadedModeRestartSuccessEnableMessage')
          : t('settings.gateway.browserHeadedModeRestartSuccessDisableMessage')
        : browserHeadedModeModalStage === 'failure'
          ? browserHeadedModeConfirmingEnable
            ? t('settings.gateway.browserHeadedModeRestartFailedEnableMessage')
            : t('settings.gateway.browserHeadedModeRestartFailedDisableMessage')
          : '';
  const gatewayRestartModalTitle = gatewayRestartModalStage === 'confirm'
    ? t('settings.gateway.restartGatewayConfirmTitle')
    : gatewayRestartModalStage === 'restarting'
      ? t('settings.gateway.restartGatewayRestartingTitle')
      : gatewayRestartModalStage === 'success'
        ? t('settings.gateway.restartGatewayRestartSuccessTitle')
        : gatewayRestartModalStage === 'failure'
          ? t('settings.gateway.restartGatewayRestartFailedTitle')
          : '';
  const gatewayRestartModalMessage = gatewayRestartModalStage === 'confirm'
    ? t('settings.gateway.restartGatewayConfirmMessage')
    : gatewayRestartModalStage === 'restarting'
      ? t('settings.gateway.restartGatewayRestartingMessage')
      : gatewayRestartModalStage === 'success'
        ? t('settings.gateway.restartGatewayRestartSuccessMessage')
        : gatewayRestartModalStage === 'failure'
          ? t('settings.gateway.restartGatewayRestartFailedMessage')
          : '';
  const canRestartGateway = !isRestarting
    && gatewayRestartModalStage === null
    && browserHeadedModeModalStage !== 'restarting'
    && updateRestartModalStage !== 'restarting';
  const canSaveGateway = !isLoading && !!url.trim();
  const browserProgressToneClasses = {
    container: 'border-blue-200 bg-blue-50',
    text: 'text-[#2563eb]',
    icon: 'text-[#2563eb]',
    fill: 'bg-blue-200/90',
  };
  const activeBrowserTaskInfo = browserTaskInfo && ['checking', 'repairing'].includes(browserTaskInfo.status)
    ? browserTaskInfo
    : null;
  const activeBrowserTaskPhaseVisual = activeBrowserTaskInfo
    ? (activeBrowserTaskInfo.status === 'repairing'
      ? (BROWSER_REPAIR_PHASE_VISUALS[activeBrowserTaskInfo.phase || 'inspect-current'] || BROWSER_REPAIR_PHASE_VISUALS['inspect-current'])
      : (BROWSER_CHECK_PHASE_VISUALS[activeBrowserTaskInfo.phase || 'read-config'] || BROWSER_CHECK_PHASE_VISUALS['read-config']))
    : null;
  const activeBrowserTaskLabel = activeBrowserTaskPhaseVisual
    ? t(activeBrowserTaskPhaseVisual.labelKey)
    : '';
  const canSelfHealBrowser = browserHealth?.healthy === false
    && !isCheckingBrowserHealth
    && !isSelfHealingBrowser
    && !isLoading
    && !activeBrowserTaskInfo;
  const browserHealthNotCheckedText = t('settings.gateway.browserHealthStates.notChecked');
  const browserHealthValueFallback = browserHealth ? t('common.unknown') : browserHealthNotCheckedText;
  const browserHealthConfig = browserHealth?.config ?? null;
  const browserHealthRuntime = browserHealth?.runtime ?? null;
  const browserHealthFacts = [
    {
      label: t('settings.gateway.browserHealthPermissionsLabel'),
      value: browserHealth?.maxPermissionsEnabled === null || !browserHealth
        ? browserHealthValueFallback
        : browserHealth.maxPermissionsEnabled
          ? t('settings.gateway.browserHealthStates.permissionsEnabled')
          : t('settings.gateway.browserHealthStates.permissionsDisabled'),
    },
    {
      label: t('settings.gateway.browserHealthEnabledLabel'),
      value: browserHealthConfig?.enabled === null || browserHealthConfig?.enabled === undefined || !browserHealth
        ? browserHealthValueFallback
        : browserHealthConfig.enabled
          ? t('settings.gateway.browserHealthStates.enabled')
          : t('settings.gateway.browserHealthStates.disabled'),
    },
    {
      label: t('settings.gateway.browserHealthRunningLabel'),
      value: browserHealthRuntime?.running === null || browserHealthRuntime?.running === undefined || !browserHealth
        ? browserHealthValueFallback
        : browserHealthRuntime.running
          ? t('settings.gateway.browserHealthStates.running')
          : t('settings.gateway.browserHealthStates.stopped'),
    },
    {
      label: t('settings.gateway.browserHealthTransportLabel'),
      value: browserHealthRuntime?.transport || browserHealthValueFallback,
    },
    {
      label: t('settings.gateway.browserHealthModeLabel'),
      value: browserHealthRuntime?.headless === null || browserHealthRuntime?.headless === undefined || !browserHealth
        ? browserHealthValueFallback
        : browserHealthRuntime.headless
          ? t('settings.gateway.browserHealthStates.headless')
          : t('settings.gateway.browserHealthStates.windowed'),
    },
    {
      label: t('settings.gateway.browserHealthBrowserLabel'),
      value: browserHealthRuntime?.detectedBrowser || browserHealthRuntime?.chosenBrowser || browserHealthValueFallback,
    },
    {
      label: t('settings.gateway.browserHealthProfileLabel'),
      value: browserHealthRuntime?.profile || browserHealthConfig?.profile || browserHealth?.profile || browserHealthValueFallback,
    },
  ];
  const browserHealthDetail = activeBrowserTaskInfo?.rawDetail
    || (activeBrowserTaskInfo ? activeBrowserTaskLabel : '')
    || browserHealth?.validationDetail
    || browserHealth?.rawDetail
    || browserHealthRuntime?.detectError
    || browserHealth?.detectError
    || browserHealthError.detail
    || browserHealthError.message
    || '';
  const browserHealthDetailText = browserHealthDetail
    || (browserHealthError.message
      ? t('settings.gateway.browserHealthButtonNeedsAttention')
      : browserHealth
        ? browserHealth.healthy
          ? t('settings.gateway.browserHealthButtonHealthy')
          : t('settings.gateway.browserHealthButtonNeedsAttention')
        : browserHealthNotCheckedText);
  const renderBrowserTaskActionButton = (
    mode: 'checking' | 'repairing',
    onClick: () => void,
    defaultLabel: string,
    defaultIcon: 'activity' | 'wrench',
  ) => {
    const isActive = activeBrowserTaskInfo?.status === mode && activeBrowserTaskPhaseVisual;
    if (!isActive || !activeBrowserTaskPhaseVisual) {
      const disabled = mode === 'repairing'
        ? !canSelfHealBrowser
        : isCheckingBrowserHealth || isSelfHealingBrowser || isLoading || !!activeBrowserTaskInfo;
      return (
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={`${secondaryActionButtonClass} flex-1 min-w-0 ${disabled && mode === 'repairing' ? 'border-gray-200 bg-gray-100 text-gray-400 hover:bg-gray-100' : ''}`}
        >
          {defaultIcon === 'wrench'
            ? <Wrench className="hidden sm:block w-4 h-4 shrink-0" />
            : <Activity className="hidden sm:block w-4 h-4 shrink-0" />}
          <span className="min-w-0 text-center leading-snug">{defaultLabel}</span>
        </button>
      );
    }

    return (
      <button
        type="button"
        disabled
        className={`relative overflow-hidden rounded-xl border text-left transition-colors flex-1 min-w-0 ${browserProgressToneClasses.container} cursor-default opacity-90`}
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-l-xl transition-[width] duration-500 ease-out ${browserProgressToneClasses.fill}`}
          style={{ width: `${Math.min(Math.max(activeBrowserTaskPhaseVisual.progress, 0), 100)}%` }}
        />
        <div className="relative z-10 flex items-center justify-center gap-2 px-4 py-2.5 text-center">
          <Loader2 className={`h-4 w-4 shrink-0 animate-spin ${browserProgressToneClasses.icon}`} />
          <span className={`truncate whitespace-nowrap text-sm font-semibold leading-5 ${browserProgressToneClasses.text}`}>
            {t(activeBrowserTaskPhaseVisual.labelKey)}
          </span>
        </div>
      </button>
    );
  };
  const hostTakeoverMode = hostTakeoverStatus?.mode || 'disabled';
  const hostTakeoverToneClass = hostTakeoverMode === 'ready'
    ? 'border-green-200 bg-green-50 text-green-700'
    : hostTakeoverMode === 'broken'
      ? 'border-red-200 bg-red-50 text-red-700'
      : hostTakeoverMode === 'needs_install'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-gray-200 bg-gray-50 text-gray-600';
  const hostTakeoverPathVisible = !!hostTakeoverStatus?.hostRootPath && (maxPermissions || hostTakeoverMode !== 'disabled');
  const hostTakeoverManualInstallVisible = !!hostTakeoverStatus?.manualInstallCommand
    && hostTakeoverMode !== 'ready'
    && hostTakeoverMode !== 'disabled'
    && hostTakeoverStatus?.autoInstallSupported === false;
  const latestDevicePairing = devicePairingStatus?.latestPending ?? null;
  const devicePairingPairedCount = devicePairingStatus?.pairedCount ?? null;
  const devicePairingMode = !hasLoadedMaxPermissionsState
    ? 'loading'
    : latestDevicePairing
      ? 'pending'
      : devicePairingPairedCount === null
        ? 'unavailable'
        : devicePairingPairedCount > 0
          ? 'paired'
          : 'idle';
  const devicePairingToneClass = devicePairingMode === 'pending'
    ? 'border-amber-200 bg-amber-50 text-amber-700'
    : devicePairingMode === 'paired'
      ? 'border-green-200 bg-green-50 text-green-700'
      : devicePairingMode === 'unavailable'
        ? 'border-red-200 bg-red-50 text-red-700'
        : 'border-gray-200 bg-gray-50 text-gray-600';
  const latestDevicePairingRoleText = latestDevicePairing
    ? (latestDevicePairing.role
      || latestDevicePairing.roles.join(', ')
      || t('common.unknown'))
    : '';
  const latestDevicePairingScopeText = latestDevicePairing?.scopes.join(', ') || '';

  return {
    browserHeadedModeConfirmingEnable,
    browserHeadedModeModalTitle,
    browserHeadedModeModalMessage,
    gatewayRestartModalTitle,
    gatewayRestartModalMessage,
    canRestartGateway,
    canSaveGateway,
    browserProgressToneClasses,
    activeBrowserTaskInfo,
    activeBrowserTaskPhaseVisual,
    activeBrowserTaskLabel,
    canSelfHealBrowser,
    browserHealthNotCheckedText,
    browserHealthValueFallback,
    browserHealthConfig,
    browserHealthRuntime,
    browserHealthFacts,
    browserHealthDetail,
    browserHealthDetailText,
    renderBrowserTaskActionButton,
    hostTakeoverMode,
    hostTakeoverToneClass,
    hostTakeoverPathVisible,
    hostTakeoverManualInstallVisible,
    latestDevicePairing,
    devicePairingPairedCount,
    devicePairingMode,
    devicePairingToneClass,
    latestDevicePairingRoleText,
    latestDevicePairingScopeText,
  };
}
