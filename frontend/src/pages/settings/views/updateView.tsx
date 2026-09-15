// 关于页由升级状态派生出的展示值（进度、文案、按钮）。纯计算，每次渲染重算，与拆分前一致。
import { Activity, Check, Loader2, X } from 'lucide-react';
import { OPENCLAW_UPDATE_PHASE_VISUALS, UPDATE_PHASE_VISUALS } from '../shared/phaseVisuals';
import { joinDistinctLines } from '../shared/settingsHelpers';
import { UPDATE_RESTART_STEP_IDS } from '../shared/updateRestart';
import type { UpdateProgressLayout, UpdateProgressTone, UpdateRestartStepStatus } from '../shared/settingsTypes';
import type { useUpdateSettings } from '../hooks/useUpdateSettings';
import type { useSettingsShared } from '../hooks/useSettingsShared';

export function deriveUpdateView(deps: Pick<ReturnType<typeof useUpdateSettings> & ReturnType<typeof useSettingsShared>, 'appVersionInfo' | 'detectedOpenClawVersion' | 'isCheckingLatestVersion' | 'isCheckingOpenClawLatestVersion' | 'isStartingOpenClawUpdate' | 'latestVersionError' | 'latestVersionInfo' | 'openClawLatestVersionError' | 'openClawLatestVersionInfo' | 'openClawUpdateStatusInfo' | 't' | 'updateRestartModalStage' | 'updateRestartStepSnapshot' | 'updateStatusInfo'>) {
  const { appVersionInfo, detectedOpenClawVersion, isCheckingLatestVersion, isCheckingOpenClawLatestVersion, isStartingOpenClawUpdate, latestVersionError, latestVersionInfo, openClawLatestVersionError, openClawLatestVersionInfo, openClawUpdateStatusInfo, t, updateRestartModalStage, updateRestartStepSnapshot, updateStatusInfo } = deps;

  const openClawCurrentVersion = detectedOpenClawVersion
    || appVersionInfo?.openclawVersion
    || openClawLatestVersionInfo?.currentVersion
    || '';
  const isAppUpdateFlowActive = isCheckingLatestVersion
    || ['checking', 'updating', 'stopping', 'restarting'].includes(updateStatusInfo?.status || '');
  const isOpenClawUpdateFlowActive = isCheckingOpenClawLatestVersion
    || isStartingOpenClawUpdate
    || ['checking', 'updating', 'stopping'].includes(openClawUpdateStatusInfo?.status || '');
  const isAppUpdateBlockedByOpenClaw = !isAppUpdateFlowActive && isOpenClawUpdateFlowActive;
  const isOpenClawUpdateBlockedByApp = !isOpenClawUpdateFlowActive && isAppUpdateFlowActive;
  const openClawEffectiveLatestVersion = openClawLatestVersionInfo?.latestVersion || openClawUpdateStatusInfo?.latestVersion || null;
  const effectiveLatestVersion = latestVersionInfo?.latestVersion || updateStatusInfo?.latestVersion || null;
  const updatePhaseVisual = updateStatusInfo?.phase && UPDATE_PHASE_VISUALS[updateStatusInfo.phase]
    ? UPDATE_PHASE_VISUALS[updateStatusInfo.phase]
    : { progress: 8, labelKey: 'settings.about.updateProgressPreparing' };
  const openClawPhaseVisual = openClawUpdateStatusInfo?.phase && OPENCLAW_UPDATE_PHASE_VISUALS[openClawUpdateStatusInfo.phase]
    ? OPENCLAW_UPDATE_PHASE_VISUALS[openClawUpdateStatusInfo.phase]
    : { progress: 8, labelKey: 'settings.openclawUpdate.progressChecking' };
  const updateFailureDetail = joinDistinctLines([
    updateStatusInfo?.rawDetail,
    updateStatusInfo?.message,
  ]);
  const updateRestartSteps = UPDATE_RESTART_STEP_IDS.map((id) => {
    const matched = (updateStatusInfo?.restartSteps || updateRestartStepSnapshot || []).find((step) => step.id === id) || null;
    return matched || {
      id,
      status: 'pending' as UpdateRestartStepStatus,
      detail: null,
      updatedAt: null,
    };
  });
  const updateRestartStepItems = updateRestartSteps.map((step) => ({
    ...step,
    label: step.id === 'restart_openclaw'
      ? t('settings.about.restartStepRestartOpenClaw')
      : step.id === 'restart_project'
        ? t('settings.about.restartStepRestartProject')
        : t('settings.about.restartStepWarmupBrowser'),
    statusLabel: step.status === 'completed'
      ? t('settings.about.restartStepStatusCompleted')
      : step.status === 'skipped'
        ? t('settings.about.restartStepStatusSkipped')
        : step.status === 'failed'
          ? t('settings.about.restartStepStatusFailed')
          : step.status === 'running'
            ? t('settings.about.restartStepStatusRunning')
            : t('settings.about.restartStepStatusPending'),
    // 跳过时把「为什么跳过」翻成人话，原始 reason 是给日志看的
    skipReason: step.status === 'skipped'
      ? t(`settings.about.restartSkipReason.${step.detail || 'unknown'}`, { defaultValue: step.detail || '' })
      : '',
  }));
  const openClawUpdateFailureDetail = joinDistinctLines([
    openClawUpdateStatusInfo?.rawDetail,
    openClawUpdateStatusInfo?.message,
  ]);
  const openClawUpdateLatestLog = openClawUpdateStatusInfo?.logs?.length
    ? openClawUpdateStatusInfo.logs[openClawUpdateStatusInfo.logs.length - 1]
    : '';
  const openClawUpdateActiveDetail = ['checking', 'updating', 'stopping'].includes(openClawUpdateStatusInfo?.status || '')
    ? joinDistinctLines([
      openClawUpdateLatestLog,
      openClawUpdateStatusInfo?.message,
    ])
    : '';
  const updateCheckDetail = joinDistinctLines([
    latestVersionError.detail,
    latestVersionError.message,
  ]);
  const openClawCheckDetail = joinDistinctLines([
    openClawLatestVersionError.detail,
    openClawLatestVersionError.message,
  ]);
  const applyMutualExclusionToVisual = <T extends {
    clickable: boolean;
    muted?: boolean;
  }>(visual: T, blocked: boolean): T => (
    blocked
      ? {
        ...visual,
        clickable: false,
        muted: true,
      }
      : {
        ...visual,
        muted: false,
      }
  );
  const updateProgressVisual = applyMutualExclusionToVisual((() => {
    const baseProgress = updatePhaseVisual.progress;
    const clickableIdle = !isCheckingLatestVersion;

    if (updateStatusInfo?.status === 'checking') {
      return {
        progress: Math.max(baseProgress, 12),
        label: t('settings.about.updateProgressChecking'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'updating') {
      return {
        progress: Math.max(baseProgress, 10),
        label: `${t(updatePhaseVisual.labelKey)}${t('settings.about.updateProgressClickToStopSuffix')}`,
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'stopping') {
      return {
        progress: Math.max(baseProgress, 15),
        label: t('settings.about.updateProgressStopping'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'update_succeeded') {
      return {
        progress: 100,
        label: t('settings.about.updateSucceededButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (updateStatusInfo?.status === 'update_failed') {
      return {
        progress: Math.max(baseProgress, 12),
        label: t('settings.about.updateFailedButton'),
        detail: updateFailureDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    if (updateStatusInfo?.status === 'restarting') {
      return {
        progress: Math.max(baseProgress, 99),
        label: t(updatePhaseVisual.labelKey),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'restart_failed') {
      return {
        progress: 100,
        label: t('settings.about.restartFailedButton'),
        detail: updateFailureDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    if (updateStatusInfo?.status === 'has_update' || latestVersionInfo?.status === 'update_available') {
      return {
        progress: 0,
        label: t('settings.about.checkUpdateAvailableButton', {
          version: effectiveLatestVersion || t('settings.about.unavailable'),
        }),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'activity' as const,
      };
    }

    if (isCheckingLatestVersion) {
      return {
        progress: 12,
        label: t('settings.about.updateProgressChecking'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (latestVersionInfo?.status === 'up_to_date') {
      return {
        progress: 100,
        label: t('settings.about.checkUpToDateButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: clickableIdle,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (latestVersionInfo?.status === 'no_release') {
      return {
        progress: 0,
        label: t('settings.about.checkNoReleaseButton'),
        detail: '',
        tone: 'neutral' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: clickableIdle,
        showSpinner: false,
        icon: 'activity' as const,
      };
    }

    if (latestVersionError.message) {
      return {
        progress: 0,
        label: t('settings.about.checkRetryButton'),
        detail: updateCheckDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: clickableIdle,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    return {
      progress: 0,
      label: t('settings.about.checkNewVersion'),
      detail: '',
      tone: 'neutral' as UpdateProgressTone,
      layout: 'compact' as UpdateProgressLayout,
      clickable: clickableIdle,
      showSpinner: false,
      icon: 'activity' as const,
    };
  })(), isAppUpdateBlockedByOpenClaw);
  const openClawUpdateProgressVisual = applyMutualExclusionToVisual((() => {
    if (isStartingOpenClawUpdate) {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 18),
        label: t(openClawPhaseVisual.labelKey),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'checking') {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 18),
        label: openClawUpdateStatusInfo.canCancel
          ? `${t(openClawPhaseVisual.labelKey)}${t('settings.openclawUpdate.progressClickToStopSuffix')}`
          : t(openClawPhaseVisual.labelKey),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: openClawUpdateStatusInfo.canCancel,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'updating') {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 18),
        label: openClawUpdateStatusInfo.canCancel
          ? `${t(openClawPhaseVisual.labelKey)}${t('settings.openclawUpdate.progressClickToStopSuffix')}`
          : t(openClawPhaseVisual.labelKey),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: openClawUpdateStatusInfo.canCancel,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'stopping') {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 24),
        label: t('settings.openclawUpdate.progressStopping'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'update_succeeded') {
      return {
        progress: 100,
        label: t('settings.openclawUpdate.updateSucceededButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'update_failed') {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 12),
        label: t('settings.openclawUpdate.updateFailedButton'),
        detail: openClawUpdateFailureDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    if (isCheckingOpenClawLatestVersion) {
      return {
        progress: 12,
        label: t('settings.openclawUpdate.progressChecking'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawLatestVersionInfo?.status === 'update_available') {
      return {
        progress: 0,
        label: t('settings.openclawUpdate.checkUpdateAvailableButton', {
          version: openClawEffectiveLatestVersion || t('settings.about.unavailable'),
        }),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'activity' as const,
      };
    }

    if (openClawLatestVersionInfo?.status === 'up_to_date') {
      return {
        progress: 100,
        label: t('settings.openclawUpdate.checkUpToDateButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (openClawLatestVersionError.message) {
      return {
        progress: 0,
        label: t('settings.openclawUpdate.checkRetryButton'),
        detail: openClawCheckDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    return {
      progress: 0,
      label: t('settings.openclawUpdate.checkNewVersion'),
      detail: '',
      tone: 'neutral' as UpdateProgressTone,
      layout: 'compact' as UpdateProgressLayout,
      clickable: true,
      showSpinner: false,
      icon: 'activity' as const,
    };
  })(), isOpenClawUpdateBlockedByApp);
  const updateProgressTitle = updateProgressVisual.detail || updateFailureDetail || updateCheckDetail || undefined;
  const updateProgressWidthClass = updateProgressVisual.layout === 'expanded'
    ? 'w-full sm:w-[24rem]'
    : 'w-full sm:w-auto';
  const updateProgressButtonWidthClass = updateProgressVisual.layout === 'expanded'
    ? 'w-full sm:min-w-[24rem]'
    : 'w-full sm:w-auto';
  const updateCancelUnsafeDetail = joinDistinctLines([
    updateStatusInfo?.rawDetail,
    updateStatusInfo?.message,
  ]);
  const openClawUpdateCancelUnsafeDetail = joinDistinctLines([
    openClawUpdateStatusInfo?.rawDetail,
    openClawUpdateStatusInfo?.message,
  ]);
  const updateCancelModalTitle = updateStatusInfo?.canCancel
    ? t('settings.about.updateCancelConfirmTitle')
    : t('settings.about.updateCancelUnavailableTitle');
  const updateCancelModalMessage = updateStatusInfo?.canCancel
    ? t('settings.about.updateCancelConfirmMessage')
    : t('settings.about.updateCancelUnavailableMessage');
  const openClawUpdateCancelModalTitle = openClawUpdateStatusInfo?.canCancel
    ? t('settings.openclawUpdate.updateCancelConfirmTitle')
    : t('settings.openclawUpdate.updateCancelUnavailableTitle');
  const openClawUpdateCancelModalMessage = openClawUpdateStatusInfo?.canCancel
    ? t('settings.openclawUpdate.updateCancelConfirmMessage')
    : t('settings.openclawUpdate.updateCancelUnavailableMessage');
  const updateRestartModalTitle = updateRestartModalStage === 'confirm'
    ? t('settings.about.restartServiceConfirmTitle')
    : updateRestartModalStage === 'restarting'
      ? t('settings.about.restartServiceRestartingTitle')
      : updateRestartModalStage === 'success'
        ? t('settings.about.restartServiceRestartSuccessTitle')
        : updateRestartModalStage === 'failure'
          ? t('settings.about.restartServiceRestartFailedTitle')
          : '';
  const updateRestartModalMessage = updateRestartModalStage === 'confirm'
    ? t('settings.about.restartServiceConfirmMessage')
    : updateRestartModalStage === 'restarting'
      ? t('settings.about.restartServiceRestartingMessage')
      : updateRestartModalStage === 'success'
        ? t('settings.about.restartServiceRestartSuccessMessage')
        : updateRestartModalStage === 'failure'
          ? t('settings.about.restartServiceRestartFailedMessage')
          : '';
  const resolveProgressToneClasses = (tone: UpdateProgressTone) => (
    tone === 'success'
      ? {
        container: 'border-emerald-200 bg-emerald-50',
        hover: 'hover:bg-emerald-100',
        text: 'text-emerald-700',
        icon: 'text-emerald-600',
        fill: 'bg-emerald-200/90',
        detail: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      }
      : tone === 'error'
        ? {
          container: 'border-red-200 bg-red-50',
          hover: 'hover:bg-red-100',
          text: 'text-red-700',
          icon: 'text-red-600',
          fill: 'bg-red-200/90',
          detail: 'border-red-200 bg-red-50 text-red-700',
        }
        : {
          container: 'border-blue-200 bg-blue-50',
          hover: 'hover:bg-blue-100',
          text: 'text-[#2563eb]',
          icon: 'text-[#2563eb]',
          fill: 'bg-blue-200/90',
          detail: 'border-blue-200 bg-blue-50 text-[#2563eb]',
        }
  );
  const updateProgressToneClasses = resolveProgressToneClasses(updateProgressVisual.tone);
  const openClawUpdateProgressToneClasses = resolveProgressToneClasses(openClawUpdateProgressVisual.tone);
  const openClawUpdateProgressTitle = openClawUpdateProgressVisual.detail || openClawUpdateFailureDetail || openClawUpdateActiveDetail || openClawCheckDetail || undefined;
  const openClawUpdateProgressWidthClass = openClawUpdateProgressVisual.layout === 'expanded'
    ? 'w-full sm:w-[24rem]'
    : 'w-full sm:w-auto';
  const openClawUpdateProgressButtonWidthClass = openClawUpdateProgressVisual.layout === 'expanded'
    ? 'w-full sm:min-w-[24rem]'
    : 'w-full sm:w-auto';
  const secondaryActionButtonClass = 'inline-flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold leading-5 text-[#2563eb] text-center transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60';
  const renderProgressActionButton = (
    visual: {
      progress: number;
      label: string;
      detail: string;
      clickable: boolean;
      muted?: boolean;
      showSpinner: boolean;
      icon: 'activity' | 'success' | 'error';
    },
    toneClasses: {
      container: string;
      hover: string;
      text: string;
      icon: string;
      fill: string;
      detail: string;
    },
    onClick: () => void,
    widthClass: string,
    buttonWidthClass: string,
    title?: string,
  ) => (
    <div className={widthClass}>
      <button
        type="button"
        onClick={onClick}
        disabled={!visual.clickable}
        title={title}
        className={`relative overflow-hidden rounded-xl border text-left transition-colors ${buttonWidthClass} ${toneClasses.container} ${visual.clickable ? toneClasses.hover : 'cursor-default'} ${visual.muted ? 'opacity-60 saturate-50' : !visual.clickable ? 'opacity-90' : ''}`}
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-l-xl transition-[width] duration-500 ease-out ${toneClasses.fill}`}
          style={{ width: `${Math.min(Math.max(visual.progress, 0), 100)}%` }}
        />
        <div className="relative z-10 flex items-center justify-center gap-2 px-4 py-2.5 text-center">
          {visual.showSpinner
            ? <Loader2 className={`h-4 w-4 shrink-0 animate-spin ${toneClasses.icon}`} />
            : visual.icon === 'success'
              ? <Check className={`h-4 w-4 shrink-0 ${toneClasses.icon}`} />
              : visual.icon === 'error'
                ? <X className={`h-4 w-4 shrink-0 ${toneClasses.icon}`} />
                : <Activity className={`h-4 w-4 shrink-0 ${toneClasses.icon}`} />}
          <span className={`truncate whitespace-nowrap text-sm font-semibold leading-5 ${toneClasses.text}`}>
            {visual.label}
          </span>
        </div>
      </button>
      {visual.detail ? (
        <div className={`mt-2 whitespace-pre-wrap rounded-xl border px-4 py-3 text-sm ${toneClasses.detail}`}>
          {visual.detail}
        </div>
      ) : null}
    </div>
  );

  return {
    openClawCurrentVersion,
    isAppUpdateFlowActive,
    isOpenClawUpdateFlowActive,
    isAppUpdateBlockedByOpenClaw,
    isOpenClawUpdateBlockedByApp,
    openClawEffectiveLatestVersion,
    effectiveLatestVersion,
    updatePhaseVisual,
    openClawPhaseVisual,
    updateFailureDetail,
    updateRestartSteps,
    updateRestartStepItems,
    openClawUpdateFailureDetail,
    openClawUpdateLatestLog,
    openClawUpdateActiveDetail,
    updateCheckDetail,
    openClawCheckDetail,
    applyMutualExclusionToVisual,
    updateProgressVisual,
    openClawUpdateProgressVisual,
    updateProgressTitle,
    updateProgressWidthClass,
    updateProgressButtonWidthClass,
    updateCancelUnsafeDetail,
    openClawUpdateCancelUnsafeDetail,
    updateCancelModalTitle,
    updateCancelModalMessage,
    openClawUpdateCancelModalTitle,
    openClawUpdateCancelModalMessage,
    updateRestartModalTitle,
    updateRestartModalMessage,
    resolveProgressToneClasses,
    updateProgressToneClasses,
    openClawUpdateProgressToneClasses,
    openClawUpdateProgressTitle,
    openClawUpdateProgressWidthClass,
    openClawUpdateProgressButtonWidthClass,
    secondaryActionButtonClass,
    renderProgressActionButton,
  };
}
