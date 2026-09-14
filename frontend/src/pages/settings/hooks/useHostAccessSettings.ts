// 最高权限（主机接管、设备配对）与浏览器健康 / 有头模式。两者共用浏览器健康状态与网关重启流程，拆开会形成双向依赖，所以放在一处。
import { useEffect, useState } from 'react';
import { type BrowserHeadedModeConfig, type BrowserHealthNotice, type BrowserHealthSnapshot, type BrowserTaskInfo, type DevicePairingStatus, EMPTY_INLINE_ERROR, type HostTakeoverStatus, type InlineErrorState, type SettingsProps } from '../shared/settingsTypes';
import { CONNECTION_STATUS_REFRESH_EVENT, resolveStructuredErrorDisplay, responseNeedsHostTakeoverPasswordPrompt } from '../shared/settingsHelpers';
import { approveLatestDevicePairing, checkBrowserHealth, getBrowserHeadedMode, getBrowserHealthTaskStatus, getMaxPermissions, saveBrowserHeadedMode, saveMaxPermissions, selfHealBrowser } from '../../../api/config';
import type { useGatewaySettings } from './useGatewaySettings';
import type { useSettingsShared } from './useSettingsShared';

export function useHostAccessSettings(deps: Pick<ReturnType<typeof useGatewaySettings> & SettingsProps & ReturnType<typeof useSettingsShared>, 'applyGatewayRestartTaskState' | 'browserHeadedModeModalStage' | 'fetchGatewayRestartTaskStatus' | 'gatewayRestartModalStage' | 'gatewayRestartTaskInfo' | 'handleConfirmRestartGateway' | 'openGatewayRestartConfirm' | 'pendingGatewayRestartStartRef' | 'resetGatewayRestartTaskStatus' | 'setBrowserHeadedModeModalStage' | 'setGatewayRestartModalDetail' | 'setGatewayRestartModalStage' | 'setGatewayRestartNoticeSource' | 'setIsRestarting' | 'setRestartSuccess' | 'settingsTab' | 't' | 'updateGatewayRestartTaskInfo'>) {
  const { applyGatewayRestartTaskState, browserHeadedModeModalStage, fetchGatewayRestartTaskStatus, gatewayRestartModalStage, gatewayRestartTaskInfo, handleConfirmRestartGateway, openGatewayRestartConfirm, pendingGatewayRestartStartRef, resetGatewayRestartTaskStatus, setBrowserHeadedModeModalStage, setGatewayRestartModalDetail, setGatewayRestartModalStage, setGatewayRestartNoticeSource, setIsRestarting, setRestartSuccess, settingsTab, t, updateGatewayRestartTaskInfo } = deps;

  const [maxPermissions, setMaxPermissions] = useState(false);
  const [isTogglingPermissions, setIsTogglingPermissions] = useState(false);
  const [hostTakeoverStatus, setHostTakeoverStatus] = useState<HostTakeoverStatus | null>(null);
  const [devicePairingStatus, setDevicePairingStatus] = useState<DevicePairingStatus | null>(null);
  const [hasLoadedMaxPermissionsState, setHasLoadedMaxPermissionsState] = useState(false);
  const [isApprovingDevicePairing, setIsApprovingDevicePairing] = useState(false);
  const [permissionsNotice, setPermissionsNotice] = useState<{ tone: 'success' | 'warning'; message: string } | null>(null);
  const [permissionsError, setPermissionsError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [permissionsPasswordModalOpen, setPermissionsPasswordModalOpen] = useState(false);
  const [permissionsPassword, setPermissionsPassword] = useState('');
  const [permissionsPasswordUser, setPermissionsPasswordUser] = useState('');
  const [permissionsPasswordError, setPermissionsPasswordError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isSubmittingPermissionsPassword, setIsSubmittingPermissionsPassword] = useState(false);
  const [maxPermissionsConfirmPendingEnabled, setMaxPermissionsConfirmPendingEnabled] = useState<boolean | null>(null);
  const [restartAfterPermissionsPasswordSubmit, setRestartAfterPermissionsPasswordSubmit] = useState(false);
  const [browserHealth, setBrowserHealth] = useState<BrowserHealthSnapshot | null>(null);
  const [browserHealthError, setBrowserHealthError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [browserHealthNotice, setBrowserHealthNotice] = useState<BrowserHealthNotice | null>(null);
  const [isCheckingBrowserHealth, setIsCheckingBrowserHealth] = useState(false);
  const [isSelfHealingBrowser, setIsSelfHealingBrowser] = useState(false);
  const [browserTaskInfo, setBrowserTaskInfo] = useState<BrowserTaskInfo | null>(null);
  const [browserHeadedModeEnabled, setBrowserHeadedModeEnabled] = useState<boolean | null>(null);
  const [isLoadingBrowserHeadedMode, setIsLoadingBrowserHeadedMode] = useState(false);
  const [isTogglingBrowserHeadedMode, setIsTogglingBrowserHeadedMode] = useState(false);
  const [browserHeadedModePendingEnabled, setBrowserHeadedModePendingEnabled] = useState<boolean | null>(null);
  const [browserHeadedModeModalDetail, setBrowserHeadedModeModalDetail] = useState('');

  useEffect(() => {
    if (settingsTab !== 'gateway') return;
    void fetchBrowserHeadedModeState();
    void fetchBrowserTaskStatus({ quiet: true });
    void fetchGatewayRestartTaskStatus().catch(() => {});
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'gateway') return;
    const activeStatus = browserTaskInfo?.status;
    if (!activeStatus || !['checking', 'repairing'].includes(activeStatus)) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const nextTask = await fetchBrowserTaskStatus({ quiet: true });
      if (cancelled || !nextTask) return;
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settingsTab, browserTaskInfo?.status]);

  useEffect(() => {
    if (!gatewayRestartTaskInfo) {
      return;
    }

    if (gatewayRestartTaskInfo.status === 'restarting') {
      if (gatewayRestartTaskInfo.trigger === 'browser-headed-mode') {
        if (typeof gatewayRestartTaskInfo.targetHeadedModeEnabled === 'boolean') {
          setBrowserHeadedModePendingEnabled(gatewayRestartTaskInfo.targetHeadedModeEnabled);
        }
        setIsTogglingBrowserHeadedMode(true);
        setBrowserHeadedModeModalDetail('');
        setBrowserHeadedModeModalStage('restarting');
      } else if (gatewayRestartTaskInfo.trigger === 'gateway') {
        setIsRestarting(true);
        setGatewayRestartModalDetail('');
        setGatewayRestartModalStage('restarting');
      }
      return;
    }

    if (gatewayRestartTaskInfo.status === 'failed') {
      const failureDetail = gatewayRestartTaskInfo.rawDetail || '';
      if (gatewayRestartTaskInfo.trigger === 'browser-headed-mode') {
        if (typeof gatewayRestartTaskInfo.targetHeadedModeEnabled === 'boolean') {
          setBrowserHeadedModePendingEnabled(gatewayRestartTaskInfo.targetHeadedModeEnabled);
        }
        setIsTogglingBrowserHeadedMode(false);
        setBrowserHeadedModeModalDetail(failureDetail);
        setBrowserHeadedModeModalStage('failure');
        void fetchBrowserHeadedModeState().catch(() => {});
      } else if (gatewayRestartTaskInfo.trigger === 'gateway') {
        setIsRestarting(false);
        setGatewayRestartModalDetail(failureDetail);
        setGatewayRestartModalStage('failure');
      }
      window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
      return;
    }

    if (browserHeadedModeModalStage === 'restarting') {
      setIsTogglingBrowserHeadedMode(false);
      setBrowserHeadedModeModalDetail('');
      setBrowserHeadedModeModalStage('success');
      void fetchBrowserHeadedModeState().catch(() => {});
      window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
    }

    if (gatewayRestartModalStage === 'restarting') {
      setIsRestarting(false);
      setRestartSuccess(true);
      setGatewayRestartNoticeSource(null);
      setGatewayRestartModalDetail('');
      setGatewayRestartModalStage('success');
      window.setTimeout(() => setRestartSuccess(false), 3000);
      window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
    }
  }, [
    browserHeadedModeModalStage,
    gatewayRestartModalStage,
    gatewayRestartTaskInfo,
  ]);

  const applyBrowserHealthSnapshot = (snapshot: BrowserHealthSnapshot) => {
    setBrowserHealth(snapshot);
    if (typeof snapshot.maxPermissionsEnabled === 'boolean') {
      setMaxPermissions(snapshot.maxPermissionsEnabled);
    }
    if (typeof snapshot.config?.headless === 'boolean') {
      setBrowserHeadedModeEnabled(snapshot.config.headless !== true);
    }
  };

  const applyBrowserHeadedModeConfig = (config: BrowserHeadedModeConfig) => {
    setBrowserHeadedModeEnabled(config.headedModeEnabled);
    setBrowserHealth(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        config: {
          enabled: prev.config?.enabled ?? prev.enabled,
          headless: config.headless,
          profile: prev.config?.profile ?? prev.profile,
          executablePath: prev.config?.executablePath ?? null,
          noSandbox: prev.config?.noSandbox ?? null,
          attachOnly: prev.config?.attachOnly ?? null,
          cdpPort: prev.config?.cdpPort ?? null,
        },
      };
    });
  };

  const browserHealthRequiresPairing = (snapshot: BrowserHealthSnapshot | null) => {
    if (!snapshot) {
      return false;
    }

    const detail = [
      snapshot.validationDetail,
      snapshot.rawDetail,
      snapshot.runtime?.detectError,
      snapshot.detectError,
    ].filter(Boolean).join('\n').toLowerCase();

    return detail.includes('pairing required');
  };

  const applyMaxPermissionsState = (data: { enabled?: unknown; hostTakeover?: unknown; devicePairing?: unknown }) => {
    setMaxPermissions(!!data.enabled);
    setHostTakeoverStatus((data.hostTakeover as HostTakeoverStatus | null) || null);
    if ('devicePairing' in data) {
      setDevicePairingStatus((data.devicePairing as DevicePairingStatus | null) || null);
    }
  };

  const fetchBrowserHeadedModeState = async () => {
    setIsLoadingBrowserHeadedMode(true);
    try {
      const res = await getBrowserHeadedMode();
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.config) {
        applyBrowserHeadedModeConfig(data.config as BrowserHeadedModeConfig);
      } else {
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserHeadedModeLoadFailed'));
      }
    } catch (err) {
      setBrowserHealthError({
        message: t('gateway.browserHeadedModeLoadFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsLoadingBrowserHeadedMode(false);
    }
  };

  const fetchMaxPermissionsState = async () => {
    try {
      const res = await getMaxPermissions();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.maxPermissionsLoadFailed');
        setPermissionsError(display);
        throw new Error(display.detail || display.message);
      }
      applyMaxPermissionsState(data);
      setPermissionsError(EMPTY_INLINE_ERROR);
      return !!data.enabled;
    } finally {
      setHasLoadedMaxPermissionsState(true);
    }
  };

  const handleApproveLatestDevicePairing = async () => {
    setIsApprovingDevicePairing(true);
    setPermissionsError(EMPTY_INLINE_ERROR);
    setPermissionsNotice(null);

    try {
      const res = await approveLatestDevicePairing();
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        if (data.devicePairing) {
          setDevicePairingStatus(data.devicePairing as DevicePairingStatus);
        } else {
          await fetchMaxPermissionsState().catch(() => {});
        }
        setPermissionsNotice({
          tone: 'success',
          message: t('settings.gateway.devicePairingApproveSuccess'),
        });
      } else {
        setPermissionsError(resolveStructuredErrorDisplay(data, t, 'gateway.devicePairingApproveFailed'));
      }
    } catch (err) {
      setPermissionsError({
        message: t('gateway.devicePairingApproveFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsApprovingDevicePairing(false);
    }
  };

  const closePermissionsPasswordModal = () => {
    if (isSubmittingPermissionsPassword) return;
    setPermissionsPasswordModalOpen(false);
    setPermissionsPasswordUser('');
    setPermissionsPassword('');
    setPermissionsPasswordError(EMPTY_INLINE_ERROR);
    setRestartAfterPermissionsPasswordSubmit(false);
  };

  const closeMaxPermissionsConfirmModal = () => {
    if (isTogglingPermissions) return;
    setMaxPermissionsConfirmPendingEnabled(null);
  };

  const requestMaxPermissionsChange = async (nextEnabled: boolean, systemPassword?: string) => {
    const res = await saveMaxPermissions({
        enabled: nextEnabled,
        ...(systemPassword ? { systemPassword } : {}),
      });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const applyMaxPermissionsChange = async (
    nextEnabled: boolean,
    options?: { restartAfterSuccess?: boolean },
  ) => {
    setMaxPermissions(nextEnabled);
    setIsTogglingPermissions(true);
    setPermissionsError(EMPTY_INLINE_ERROR);
    setPermissionsNotice(null);
    setBrowserHealthNotice(null);
    setGatewayRestartNoticeSource(null);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    try {
      const { res, data } = await requestMaxPermissionsChange(nextEnabled);
      if (res.ok && data.success) {
        applyMaxPermissionsState(data);
        setPermissionsError(EMPTY_INLINE_ERROR);
        setBrowserHealth(null);
        setGatewayRestartNoticeSource('permissions');
        if (data.restartRequired) {
          if (options?.restartAfterSuccess) {
            void handleConfirmRestartGateway();
          } else {
            openGatewayRestartConfirm();
          }
        }
      } else if (nextEnabled && responseNeedsHostTakeoverPasswordPrompt(data)) {
        setRestartAfterPermissionsPasswordSubmit(!!options?.restartAfterSuccess);
        if (typeof data.enabled === 'boolean' || data.hostTakeover) {
          applyMaxPermissionsState(data);
        } else {
          setMaxPermissions(false);
        }
        setPermissionsPasswordUser(
          typeof data?.errorParams?.userName === 'string' && data.errorParams.userName.trim()
            ? data.errorParams.userName.trim()
            : (data.hostTakeover?.currentUser || hostTakeoverStatus?.currentUser || '')
        );
        setPermissionsPassword('');
        setPermissionsPasswordError(EMPTY_INLINE_ERROR);
        setPermissionsPasswordModalOpen(true);
      } else {
        setPermissionsError(resolveStructuredErrorDisplay(data, t, 'gateway.maxPermissionsUpdateFailed'));
        if (typeof data.enabled === 'boolean' || data.hostTakeover) {
          applyMaxPermissionsState(data);
        } else {
          await fetchMaxPermissionsState().catch(() => {
            setMaxPermissions(!nextEnabled);
          });
        }
      }
    } catch (err) {
      console.error(err);
      setPermissionsError({
        message: t('gateway.maxPermissionsUpdateFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
      await fetchMaxPermissionsState().catch(() => {
        setMaxPermissions(!nextEnabled);
      });
    } finally {
      setIsTogglingPermissions(false);
    }
  };

  const handleToggleMaxPermissions = () => {
    const nextEnabled = !maxPermissions;
    setPermissionsError(EMPTY_INLINE_ERROR);
    setPermissionsNotice(null);
    setBrowserHealthNotice(null);
    setGatewayRestartNoticeSource(null);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setMaxPermissionsConfirmPendingEnabled(nextEnabled);
  };

  const handleConfirmMaxPermissionsToggle = async () => {
    if (maxPermissionsConfirmPendingEnabled === null) return;
    const nextEnabled = maxPermissionsConfirmPendingEnabled;
    setMaxPermissionsConfirmPendingEnabled(null);
    await applyMaxPermissionsChange(nextEnabled, { restartAfterSuccess: true });
  };

  const handleSubmitPermissionsPassword = async () => {
    if (!permissionsPassword.trim()) {
      setPermissionsPasswordError({
        message: t('settings.gateway.hostTakeoverPasswordRequired'),
        detail: '',
      });
      return;
    }

    setIsSubmittingPermissionsPassword(true);
    setPermissionsPasswordError(EMPTY_INLINE_ERROR);
    setPermissionsError(EMPTY_INLINE_ERROR);
    setPermissionsNotice(null);

    try {
      const { res, data } = await requestMaxPermissionsChange(true, permissionsPassword);
      if (res.ok && data.success) {
        applyMaxPermissionsState(data);
        setPermissionsPasswordUser('');
        setPermissionsPassword('');
        setPermissionsPasswordModalOpen(false);
        setPermissionsPasswordError(EMPTY_INLINE_ERROR);
        setBrowserHealth(null);
        setGatewayRestartNoticeSource('permissions');
        if (data.restartRequired) {
          if (restartAfterPermissionsPasswordSubmit) {
            setRestartAfterPermissionsPasswordSubmit(false);
            void handleConfirmRestartGateway();
          } else {
            openGatewayRestartConfirm();
          }
        }
        return;
      }

      if (typeof data.enabled === 'boolean' || data.hostTakeover) {
        applyMaxPermissionsState(data);
      }

      setPermissionsPasswordError(resolveStructuredErrorDisplay(data, t, 'gateway.hostTakeoverInstallFailed'));
    } catch (err) {
      setPermissionsPasswordError({
        message: t('gateway.hostTakeoverInstallFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsSubmittingPermissionsPassword(false);
    }
  };

  const fetchBrowserTaskStatus = async (options?: { quiet?: boolean }) => {
    try {
      const res = await getBrowserHealthTaskStatus();
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success || !data.task) {
        if (!options?.quiet) {
          setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserHealthFailed'));
        }
        return null;
      }
      const nextTask = data.task as BrowserTaskInfo;
      setBrowserTaskInfo(nextTask);
      return nextTask;
    } catch (err) {
      if (!options?.quiet) {
        setBrowserHealthError({
          message: t('gateway.browserHealthFailed'),
          detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
        });
      }
      return null;
    }
  };

  const handleCheckBrowserHealth = async () => {
    setIsCheckingBrowserHealth(true);
    setBrowserTaskInfo({
      status: 'checking',
      phase: 'read-config',
      rawDetail: null,
      updatedAt: null,
    });
    setBrowserHealth(null);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setBrowserHealthNotice(null);
    try {
      const res = await checkBrowserHealth();
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.health) {
        const snapshot = data.health as BrowserHealthSnapshot;
        applyBrowserHealthSnapshot(snapshot);
        if (browserHealthRequiresPairing(snapshot)) {
          await fetchMaxPermissionsState().catch(() => {});
        }
      } else {
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserHealthFailed'));
      }
    } catch (err) {
      setBrowserHealthError({
        message: t('gateway.browserHealthFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setBrowserTaskInfo({
        status: 'idle',
        phase: null,
        rawDetail: null,
        updatedAt: new Date().toISOString(),
      });
      setIsCheckingBrowserHealth(false);
    }
  };

  const handleToggleBrowserHeadedMode = async () => {
    if (browserHeadedModeEnabled === null) return;
    setBrowserHeadedModePendingEnabled(!browserHeadedModeEnabled);
    setBrowserHeadedModeModalDetail('');
    setBrowserHeadedModeModalStage('confirm');
  };

  const closeBrowserHeadedModeModal = () => {
    if (browserHeadedModeModalStage === 'restarting') return;
    setBrowserHeadedModeModalStage(null);
    setBrowserHeadedModePendingEnabled(null);
    setBrowserHeadedModeModalDetail('');
    if (gatewayRestartTaskInfo?.status === 'failed' && gatewayRestartTaskInfo.trigger === 'browser-headed-mode') {
      updateGatewayRestartTaskInfo({
        status: 'idle',
        trigger: null,
        rawDetail: null,
        startedAt: null,
        updatedAt: new Date().toISOString(),
        targetHeadedModeEnabled: null,
      });
      void resetGatewayRestartTaskStatus().catch(() => {});
    }
  };

  const handleConfirmBrowserHeadedModeToggle = async () => {
    if (browserHeadedModePendingEnabled === null) return;

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    setIsTogglingBrowserHeadedMode(true);
    setBrowserHeadedModeModalDetail('');
    setBrowserHeadedModeModalStage('restarting');
    pendingGatewayRestartStartRef.current = {
      trigger: 'browser-headed-mode',
      startedAtMs,
    };
    updateGatewayRestartTaskInfo({
      status: 'restarting',
      trigger: 'browser-headed-mode',
      rawDetail: null,
      startedAt,
      updatedAt: startedAt,
      targetHeadedModeEnabled: browserHeadedModePendingEnabled,
    });
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setBrowserHealthNotice(null);
    setGatewayRestartNoticeSource(null);
    setBrowserHealth(null);

    try {
      const res = await saveBrowserHeadedMode({ headedModeEnabled: browserHeadedModePendingEnabled });
      const data = await res.json().catch(() => ({}));
      applyGatewayRestartTaskState(data);
      if (res.ok && data.success && data.config) {
        applyBrowserHeadedModeConfig(data.config as BrowserHeadedModeConfig);
        await fetchGatewayRestartTaskStatus().catch(() => {});
      } else {
        await fetchBrowserHeadedModeState().catch(() => {});
        const display = resolveStructuredErrorDisplay(data, t, 'gateway.browserHeadedModeUpdateFailed');
        setBrowserHealthError(display);
        setBrowserHeadedModeModalDetail(display.detail);
        setBrowserHeadedModeModalStage('failure');
      }
    } catch (err) {
      pendingGatewayRestartStartRef.current = null;
      await fetchBrowserHeadedModeState().catch(() => {});
      const detail = err instanceof Error && err.message.trim() ? err.message.trim() : '';
      setBrowserHealthError({
        message: t('gateway.browserHeadedModeUpdateFailed'),
        detail,
      });
      setBrowserHeadedModeModalDetail(detail);
      setBrowserHeadedModeModalStage('failure');
      updateGatewayRestartTaskInfo({
        status: 'failed',
        trigger: 'browser-headed-mode',
        rawDetail: detail || null,
        startedAt: null,
        updatedAt: new Date().toISOString(),
        targetHeadedModeEnabled: browserHeadedModePendingEnabled,
      });
    }
  };

  const handleSelfHealBrowser = async () => {
    setIsSelfHealingBrowser(true);
    setBrowserTaskInfo({
      status: 'repairing',
      phase: 'inspect-current',
      rawDetail: null,
      updatedAt: null,
    });
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setBrowserHealthNotice(null);
    try {
      const res = await selfHealBrowser({
          lastKnownIssue: browserHealth?.issue || null,
        });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        const snapshot = data.health as BrowserHealthSnapshot | undefined;
        if (snapshot) {
          applyBrowserHealthSnapshot(snapshot);
          if (!snapshot.healthy) {
            setBrowserHealthError({
              message: t('gateway.browserHealthFailed'),
              detail: snapshot.validationDetail || snapshot.rawDetail || snapshot.detectError || '',
            });
            return;
          }
        } else {
          setBrowserHealth(null);
        }
        setBrowserHealthNotice({
          tone: 'success',
          message: t('settings.gateway.browserSelfHealSuccess'),
        });
      } else {
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserSelfHealFailed'));
      }
    } catch (err) {
      setBrowserHealthError({
        message: t('gateway.browserSelfHealFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setBrowserTaskInfo({
        status: 'idle',
        phase: null,
        rawDetail: null,
        updatedAt: new Date().toISOString(),
      });
      setIsSelfHealingBrowser(false);
    }
  };

  return {
    maxPermissions,
    setMaxPermissions,
    isTogglingPermissions,
    setIsTogglingPermissions,
    hostTakeoverStatus,
    setHostTakeoverStatus,
    devicePairingStatus,
    setDevicePairingStatus,
    hasLoadedMaxPermissionsState,
    setHasLoadedMaxPermissionsState,
    isApprovingDevicePairing,
    setIsApprovingDevicePairing,
    permissionsNotice,
    setPermissionsNotice,
    permissionsError,
    setPermissionsError,
    permissionsPasswordModalOpen,
    setPermissionsPasswordModalOpen,
    permissionsPassword,
    setPermissionsPassword,
    permissionsPasswordUser,
    setPermissionsPasswordUser,
    permissionsPasswordError,
    setPermissionsPasswordError,
    isSubmittingPermissionsPassword,
    setIsSubmittingPermissionsPassword,
    maxPermissionsConfirmPendingEnabled,
    setMaxPermissionsConfirmPendingEnabled,
    restartAfterPermissionsPasswordSubmit,
    setRestartAfterPermissionsPasswordSubmit,
    browserHealth,
    setBrowserHealth,
    browserHealthError,
    setBrowserHealthError,
    browserHealthNotice,
    setBrowserHealthNotice,
    isCheckingBrowserHealth,
    setIsCheckingBrowserHealth,
    isSelfHealingBrowser,
    setIsSelfHealingBrowser,
    browserTaskInfo,
    setBrowserTaskInfo,
    browserHeadedModeEnabled,
    setBrowserHeadedModeEnabled,
    isLoadingBrowserHeadedMode,
    setIsLoadingBrowserHeadedMode,
    isTogglingBrowserHeadedMode,
    setIsTogglingBrowserHeadedMode,
    browserHeadedModePendingEnabled,
    setBrowserHeadedModePendingEnabled,
    browserHeadedModeModalDetail,
    setBrowserHeadedModeModalDetail,
    applyBrowserHealthSnapshot,
    applyBrowserHeadedModeConfig,
    browserHealthRequiresPairing,
    applyMaxPermissionsState,
    fetchBrowserHeadedModeState,
    fetchMaxPermissionsState,
    handleApproveLatestDevicePairing,
    closePermissionsPasswordModal,
    closeMaxPermissionsConfirmModal,
    requestMaxPermissionsChange,
    applyMaxPermissionsChange,
    handleToggleMaxPermissions,
    handleConfirmMaxPermissionsToggle,
    handleSubmitPermissionsPassword,
    fetchBrowserTaskStatus,
    handleCheckBrowserHealth,
    handleToggleBrowserHeadedMode,
    closeBrowserHeadedModeModal,
    handleConfirmBrowserHeadedModeToggle,
    handleSelfHealBrowser,
  };
}
