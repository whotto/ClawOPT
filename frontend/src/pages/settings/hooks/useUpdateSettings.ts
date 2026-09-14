// ClawOPT 与 OpenClaw 的版本检查、升级状态机、升级后重启弹窗（关于页的全部状态与轮询）。
import { useEffect, useState } from 'react';
import { type AppVersionInfo, EMPTY_INLINE_ERROR, type InlineErrorState, type LatestVersionInfo, type OpenClawLatestVersionInfo, type OpenClawUpdateStatusInfo, type RestartFlowModalStage, type SettingsProps, type UpdateRestartStep, type UpdateRestartStepStatus, type UpdateStatusInfo } from '../shared/settingsTypes';
import { cancelOpenClawUpdate, cancelUpdate, getLatestVersion, getOpenClawLatestVersion, getOpenClawUpdateStatus, getUpdateStatus, getVersion, resetOpenClawUpdate, resetUpdate, restartUpdatedService, startOpenClawUpdate, startUpdate } from '../../../api/update';
import { CONNECTION_STATUS_REFRESH_EVENT, joinDistinctLines, resolveStructuredErrorDisplay } from '../shared/settingsHelpers';
import { deriveUpdateRestartStartedAtMs, isPersistedUpdateRestartModalStateFresh, normalizeUpdateRestartSteps, readPersistedUpdateRestartModalState, UPDATE_RESTART_MODAL_TIMEOUT_MS, UPDATE_RESTART_STEP_IDS, writePersistedUpdateRestartModalState } from '../shared/updateRestart';
import type { useSettingsShared } from './useSettingsShared';

export function useUpdateSettings(deps: Pick<SettingsProps & ReturnType<typeof useSettingsShared>, 'isConnected' | 'openSettingsErrorModal' | 'settingsTab' | 't'>) {
  const { isConnected, openSettingsErrorModal, settingsTab, t } = deps;

  const [detectedOpenClawVersion, setDetectedOpenClawVersion] = useState('');
  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionInfo | null>(null);
  const [appVersionError, setAppVersionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isLoadingAppVersion, setIsLoadingAppVersion] = useState(false);
  const [openClawLatestVersionInfo, setOpenClawLatestVersionInfo] = useState<OpenClawLatestVersionInfo | null>(null);
  const [openClawLatestVersionError, setOpenClawLatestVersionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isCheckingOpenClawLatestVersion, setIsCheckingOpenClawLatestVersion] = useState(false);
  const [openClawUpdateStatusInfo, setOpenClawUpdateStatusInfo] = useState<OpenClawUpdateStatusInfo | null>(null);
  const [isStartingOpenClawUpdate, setIsStartingOpenClawUpdate] = useState(false);
  const [isOpenClawUpdateCancelModalOpen, setIsOpenClawUpdateCancelModalOpen] = useState(false);
  const [isCancellingOpenClawUpdate, setIsCancellingOpenClawUpdate] = useState(false);
  const [latestVersionInfo, setLatestVersionInfo] = useState<LatestVersionInfo | null>(null);
  const [latestVersionError, setLatestVersionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isCheckingLatestVersion, setIsCheckingLatestVersion] = useState(false);
  const [updateStatusInfo, setUpdateStatusInfo] = useState<UpdateStatusInfo | null>(null);
  const [hasLoadedUpdateStatusOnce, setHasLoadedUpdateStatusOnce] = useState(false);
  const [updateRestartModalStage, setUpdateRestartModalStage] = useState<RestartFlowModalStage>(null);
  const [updateRestartModalDetail, setUpdateRestartModalDetail] = useState('');
  const [updateRestartStepSnapshot, setUpdateRestartStepSnapshot] = useState<UpdateRestartStep[] | null>(null);
  const [updateRestartModalStartedAtMs, setUpdateRestartModalStartedAtMs] = useState<number | null>(null);
  const [isUpdateCancelModalOpen, setIsUpdateCancelModalOpen] = useState(false);
  const [isCancellingUpdate, setIsCancellingUpdate] = useState(false);

  const fetchCurrentVersionInfo = async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIsLoadingAppVersion(true);
      setAppVersionError(EMPTY_INLINE_ERROR);
    }
    try {
      const res = await getVersion();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!options?.silent) {
          setAppVersionError(resolveStructuredErrorDisplay(data, t, 'settings.about.currentVersionLoadFailed'));
        }
        setAppVersionInfo(null);
        return null;
      }
      const versionInfo = data as AppVersionInfo;
      setAppVersionInfo(versionInfo);
      setDetectedOpenClawVersion(versionInfo.openclawVersion || '');
      return versionInfo;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      if (!options?.silent) {
        setAppVersionError({
          message: t('settings.about.currentVersionLoadFailed'),
          detail,
        });
      }
      setAppVersionInfo(null);
      return null;
    } finally {
      if (!options?.silent) {
        setIsLoadingAppVersion(false);
      }
    }
  };

  const fetchUpdateStatus = async (options?: { quiet?: boolean }) => {
    try {
      const res = await getUpdateStatus();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setHasLoadedUpdateStatusOnce(true);
        if (!options?.quiet) {
          const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateStatusLoadFailed');
          setLatestVersionError(display);
        }
        return null;
      }
      const nextUpdate = data.update as UpdateStatusInfo;
      setUpdateStatusInfo(nextUpdate);
      setHasLoadedUpdateStatusOnce(true);
      return nextUpdate;
    } catch (error) {
      setHasLoadedUpdateStatusOnce(true);
      if (!options?.quiet) {
        const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
        setLatestVersionError({
          message: t('settings.about.updateStatusLoadFailed'),
          detail,
        });
      }
      return null;
    }
  };

  const fetchOpenClawUpdateStatus = async (options?: { quiet?: boolean }) => {
    try {
      const res = await getOpenClawUpdateStatus();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!options?.quiet) {
          const display = resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.statusLoadFailed');
          setOpenClawLatestVersionError(display);
        }
        return null;
      }
      const nextUpdate = data.update as OpenClawUpdateStatusInfo;
      setOpenClawUpdateStatusInfo(nextUpdate);
      return nextUpdate;
    } catch (error) {
      if (!options?.quiet) {
        const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
        setOpenClawLatestVersionError({
          message: t('settings.openclawUpdate.statusLoadFailed'),
          detail,
        });
      }
      return null;
    }
  };

  const fetchOpenClawLatestVersion = async (options?: { quiet?: boolean }) => {
    try {
      const res = await getOpenClawLatestVersion();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!options?.quiet) {
          setOpenClawLatestVersionError(resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.latestVersionLoadFailed'));
        }
        return null;
      }
      const latestData = data as OpenClawLatestVersionInfo;
      setOpenClawLatestVersionInfo(latestData);
      return latestData;
    } catch (error) {
      if (!options?.quiet) {
        const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
        setOpenClawLatestVersionError({
          message: t('settings.openclawUpdate.latestVersionLoadFailed'),
          detail,
        });
      }
      return null;
    }
  };

  const handleCheckOpenClawLatestVersion = async () => {
    setIsCheckingOpenClawLatestVersion(true);
    setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
    try {
      await fetchOpenClawLatestVersion();
    } finally {
      setIsCheckingOpenClawLatestVersion(false);
    }
  };

  const handleStartOpenClawUpdate = async () => {
    if (isStartingOpenClawUpdate || ['checking', 'updating', 'stopping'].includes(openClawUpdateStatusInfo?.status || '')) {
      return;
    }

    const previousUpdateStatusInfo = openClawUpdateStatusInfo;
    setIsStartingOpenClawUpdate(true);
    setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
    setOpenClawUpdateStatusInfo((current) => ({
      status: 'updating',
      phase: 'download-package',
      canCancel: true,
      currentVersion: current?.currentVersion || openClawLatestVersionInfo?.currentVersion || appVersionInfo?.openclawVersion || null,
      latestVersion: current?.latestVersion || openClawLatestVersionInfo?.latestVersion || null,
      message: t('settings.openclawUpdate.progressDownloading'),
      rawDetail: null,
      logs: current?.logs || [],
      startedAt: current?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    try {
      const res = await startOpenClawUpdate();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if ((data as { errorCode?: string })?.errorCode === 'openclawUpdate.alreadyRunning') {
          const runningStatus = await fetchOpenClawUpdateStatus({ quiet: true });
          if (runningStatus) {
            setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
            return;
          }
        }
        setOpenClawUpdateStatusInfo(previousUpdateStatusInfo);
        const display = resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.updateStartFailed');
        openSettingsErrorModal(display.message, display.detail);
        return;
      }
      setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
      setOpenClawUpdateStatusInfo(data.update as OpenClawUpdateStatusInfo);
    } catch (error) {
      setOpenClawUpdateStatusInfo(previousUpdateStatusInfo);
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.openclawUpdate.updateStartFailed'), detail);
    } finally {
      setIsStartingOpenClawUpdate(false);
    }
  };

  const handleCancelOpenClawUpdate = async () => {
    setIsCancellingOpenClawUpdate(true);
    try {
      const res = await cancelOpenClawUpdate();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.updateCancelFailed');
        openSettingsErrorModal(display.message, display.detail);
        return false;
      }
      setOpenClawUpdateStatusInfo(data.update as OpenClawUpdateStatusInfo);
      return true;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.openclawUpdate.updateCancelFailed'), detail);
      return false;
    } finally {
      setIsCancellingOpenClawUpdate(false);
    }
  };

  const handleResetOpenClawUpdateState = async () => {
    try {
      const res = await resetOpenClawUpdate();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.updateResetFailed');
        openSettingsErrorModal(display.message, display.detail);
        return false;
      }
      setOpenClawUpdateStatusInfo(data.update as OpenClawUpdateStatusInfo);
      return true;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.openclawUpdate.updateResetFailed'), detail);
      return false;
    }
  };

  const handleOpenClawLatestVersionAction = () => {
    if (isStartingOpenClawUpdate) {
      return;
    }

    if (openClawUpdateStatusInfo?.status === 'checking' || openClawUpdateStatusInfo?.status === 'stopping') {
      return;
    }

    if (openClawUpdateStatusInfo?.status === 'updating') {
      setIsOpenClawUpdateCancelModalOpen(true);
      return;
    }

    if (openClawLatestVersionInfo?.status === 'update_available') {
      void handleStartOpenClawUpdate();
      return;
    }

    if (openClawUpdateStatusInfo?.status === 'update_failed') {
      void (async () => {
        const reset = await handleResetOpenClawUpdateState();
        if (reset) {
          await handleCheckOpenClawLatestVersion();
        }
      })();
      return;
    }

    void handleCheckOpenClawLatestVersion();
  };

  const handleConfirmCancelOpenClawUpdate = async () => {
    if (!openClawUpdateStatusInfo?.canCancel || openClawUpdateStatusInfo.status !== 'updating') {
      return;
    }

    const cancelled = await handleCancelOpenClawUpdate();
    if (cancelled) {
      setIsOpenClawUpdateCancelModalOpen(false);
    }
  };

  const handleCheckLatestVersion = async () => {
    setIsCheckingLatestVersion(true);
    setLatestVersionError(EMPTY_INLINE_ERROR);
    setLatestVersionInfo(null);
    try {
      const res = await getLatestVersion();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLatestVersionError(resolveStructuredErrorDisplay(data, t, 'settings.about.latestVersionLoadFailed'));
        return;
      }
      const latestData = data as LatestVersionInfo;
      setLatestVersionInfo(latestData);
      setUpdateStatusInfo(prev => {
        if (!prev) return prev;
        if (['checking', 'updating', 'stopping', 'update_succeeded', 'update_failed', 'restarting', 'restart_failed'].includes(prev.status)) {
          return prev;
        }
        return {
          ...prev,
          status: latestData.hasUpdate ? 'has_update' : 'idle',
          currentVersion: latestData.currentVersion || prev.currentVersion,
          latestVersion: latestData.latestVersion || null,
          message: null,
          rawDetail: null,
        };
      });
      if (!appVersionInfo) {
        setAppVersionInfo(prev => prev || {
          appName: latestData.appName,
          version: latestData.currentVersion,
          releaseTag: `v${latestData.currentVersion}`,
          commit: null,
          buildTime: null,
          repositoryUrl: latestData.repositoryUrl,
          openclawVersion: null,
        });
      }
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      setLatestVersionError({
        message: t('settings.about.latestVersionLoadFailed'),
        detail,
      });
    } finally {
      setIsCheckingLatestVersion(false);
    }
  };

  const handleStartUpdate = async () => {
    try {
      const res = await startUpdate();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateStartFailed');
        openSettingsErrorModal(display.message, display.detail);
        return;
      }
      setLatestVersionError(EMPTY_INLINE_ERROR);
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.updateStartFailed'), detail);
    }
  };

  const handleCancelUpdate = async () => {
    setIsCancellingUpdate(true);
    try {
      const res = await cancelUpdate();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateCancelFailed');
        openSettingsErrorModal(display.message, display.detail);
        return false;
      }
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
      return true;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.updateCancelFailed'), detail);
      return false;
    } finally {
      setIsCancellingUpdate(false);
    }
  };

  const handleResetUpdateState = async () => {
    try {
      const res = await resetUpdate();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateResetFailed');
        openSettingsErrorModal(display.message, display.detail);
        return;
      }
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
      setLatestVersionInfo(null);
      setLatestVersionError(EMPTY_INLINE_ERROR);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.updateResetFailed'), detail);
    }
  };

  const handleRestartUpdatedService = () => {
    if (updateRestartModalStage || updateStatusInfo?.status !== 'update_succeeded') {
      return;
    }
    setUpdateRestartStepSnapshot(null);
    setUpdateRestartModalDetail('');
    setUpdateRestartModalStage('confirm');
  };

  const closeUpdateRestartModal = () => {
    if (updateRestartModalStage === 'restarting') return;
    setUpdateRestartModalStage(null);
    setUpdateRestartModalDetail('');
    setUpdateRestartStepSnapshot(null);
    setUpdateRestartModalStartedAtMs(null);
    writePersistedUpdateRestartModalState(null);
  };

  const handleConfirmRestartUpdatedService = async () => {
    const startedAtMs = Date.now();
    setUpdateRestartModalDetail('');
    setUpdateRestartModalStage('restarting');
    setUpdateRestartModalStartedAtMs(startedAtMs);
    writePersistedUpdateRestartModalState({
      stage: 'restarting',
      detail: '',
      stepSnapshot: null,
      startedAtMs,
    });
    try {
      const res = await restartUpdatedService();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.restartServiceFailed');
        setUpdateRestartModalDetail(joinDistinctLines([
          display.message !== t('settings.about.restartServiceFailed') ? display.message : '',
          display.detail,
        ]));
        setUpdateRestartModalStage('failure');
        setUpdateRestartModalStartedAtMs(null);
        writePersistedUpdateRestartModalState(null);
        return;
      }
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
      window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      setUpdateRestartModalDetail(detail);
      setUpdateRestartModalStage('failure');
      setUpdateRestartModalStartedAtMs(null);
      writePersistedUpdateRestartModalState(null);
    }
  };

  const handleLatestVersionAction = () => {
    if (updateStatusInfo?.status === 'checking' || updateStatusInfo?.status === 'stopping' || updateStatusInfo?.status === 'restarting') {
      return;
    }

    if (updateStatusInfo?.status === 'updating') {
      setIsUpdateCancelModalOpen(true);
      return;
    }

    if (updateStatusInfo?.status === 'update_succeeded') {
      handleRestartUpdatedService();
      return;
    }

    if (updateStatusInfo?.status === 'update_failed' || updateStatusInfo?.status === 'restart_failed') {
      void handleResetUpdateState();
      return;
    }

    if (updateStatusInfo?.status === 'has_update' || latestVersionInfo?.status === 'update_available') {
      void handleStartUpdate();
      return;
    }

    void handleCheckLatestVersion();
  };

  const handleConfirmCancelUpdate = async () => {
    if (!updateStatusInfo?.canCancel || updateStatusInfo.status !== 'updating') {
      return;
    }

    const cancelled = await handleCancelUpdate();
    if (cancelled) {
      setIsUpdateCancelModalOpen(false);
    }
  };

  useEffect(() => {
    if (settingsTab !== 'about' && settingsTab !== 'gateway') return;
    void fetchCurrentVersionInfo();
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    void fetchOpenClawUpdateStatus({ quiet: true });
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    void fetchUpdateStatus({ quiet: true });
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    const activeStatus = updateStatusInfo?.status;
    if (!activeStatus || !['checking', 'updating', 'stopping', 'restarting'].includes(activeStatus)) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const nextUpdate = await fetchUpdateStatus({ quiet: activeStatus === 'restarting' });
      if (cancelled || !nextUpdate) return;

      if (activeStatus === 'restarting' && nextUpdate.status === 'idle') {
        await fetchCurrentVersionInfo();
        await handleCheckLatestVersion();
      }

      if ((activeStatus === 'stopping' || activeStatus === 'updating') && nextUpdate.status === 'idle') {
        setLatestVersionInfo(null);
        setLatestVersionError(EMPTY_INLINE_ERROR);
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settingsTab, updateStatusInfo?.status]);

  useEffect(() => {
    if (updateStatusInfo?.status !== 'updating') {
      setIsUpdateCancelModalOpen(false);
      setIsCancellingUpdate(false);
    }
  }, [updateStatusInfo?.status]);

  useEffect(() => {
    const nextSteps = normalizeUpdateRestartSteps(updateStatusInfo?.restartSteps);
    if (nextSteps?.length) {
      setUpdateRestartStepSnapshot(nextSteps);
    }
  }, [updateStatusInfo?.restartSteps]);

  useEffect(() => {
    if (settingsTab !== 'about' || !hasLoadedUpdateStatusOnce) {
      return;
    }

    const persistedState = readPersistedUpdateRestartModalState();
    const freshPersistedState = isPersistedUpdateRestartModalStateFresh(persistedState)
      ? persistedState
      : null;

    if (persistedState && !freshPersistedState) {
      writePersistedUpdateRestartModalState(null);
    }

    if (updateStatusInfo?.status === 'restarting') {
      const startedAtMs = deriveUpdateRestartStartedAtMs(updateStatusInfo)
        ?? freshPersistedState?.startedAtMs
        ?? Date.now();

      setUpdateRestartModalDetail('');
      setUpdateRestartModalStage('restarting');
      setUpdateRestartModalStartedAtMs(startedAtMs);
      return;
    }

    if (updateStatusInfo?.status === 'restart_failed') {
      setUpdateRestartModalDetail(joinDistinctLines([
        updateStatusInfo.message,
        updateStatusInfo.rawDetail,
      ]));
      setUpdateRestartModalStage('failure');
      setUpdateRestartModalStartedAtMs(null);
      return;
    }

    if (freshPersistedState && (updateStatusInfo?.status === 'idle' || !updateStatusInfo) && !isConnected) {
      setUpdateRestartModalDetail(freshPersistedState.detail);
      setUpdateRestartModalStage('restarting');
      setUpdateRestartModalStartedAtMs(freshPersistedState.startedAtMs);
      if (freshPersistedState.stepSnapshot?.length) {
        setUpdateRestartStepSnapshot(freshPersistedState.stepSnapshot);
      }
      return;
    }

    if (freshPersistedState && isConnected) {
      writePersistedUpdateRestartModalState(null);
    }
  }, [
    hasLoadedUpdateStatusOnce,
    isConnected,
    settingsTab,
    updateStatusInfo,
  ]);

  useEffect(() => {
    if (!hasLoadedUpdateStatusOnce && updateRestartModalStage !== 'restarting') {
      return;
    }

    if (updateRestartModalStage !== 'restarting') {
      writePersistedUpdateRestartModalState(null);
      return;
    }

    writePersistedUpdateRestartModalState({
      stage: 'restarting',
      detail: updateRestartModalDetail,
      stepSnapshot: updateRestartStepSnapshot,
      startedAtMs: updateRestartModalStartedAtMs,
    });
  }, [
    hasLoadedUpdateStatusOnce,
    updateRestartModalDetail,
    updateRestartModalStage,
    updateRestartModalStartedAtMs,
    updateRestartStepSnapshot,
  ]);

  useEffect(() => {
    if (openClawUpdateStatusInfo?.status !== 'updating') {
      setIsOpenClawUpdateCancelModalOpen(false);
      setIsCancellingOpenClawUpdate(false);
    }
  }, [openClawUpdateStatusInfo?.status]);

  useEffect(() => {
    if (updateRestartModalStage !== 'restarting') {
      return;
    }

    if (updateStatusInfo?.status !== 'idle' || !isConnected) {
      return;
    }

    let cancelled = false;
    void (async () => {
      setUpdateRestartStepSnapshot((current) => UPDATE_RESTART_STEP_IDS.map((id) => {
        const matched = current?.find((step) => step.id === id) || null;
        return {
          id,
          status: 'completed' as UpdateRestartStepStatus,
          detail: matched?.detail || null,
          updatedAt: new Date().toISOString(),
        };
      }));
      await fetchCurrentVersionInfo({ silent: true });
      if (cancelled) return;
      setUpdateRestartModalDetail('');
      setUpdateRestartModalStage('success');
      setUpdateRestartModalStartedAtMs(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isConnected,
    updateRestartModalStage,
    updateStatusInfo?.status,
  ]);

  useEffect(() => {
    if (updateRestartModalStage !== 'restarting' || !updateRestartModalStartedAtMs) {
      return;
    }

    const timer = window.setInterval(() => {
      if (Date.now() - updateRestartModalStartedAtMs < UPDATE_RESTART_MODAL_TIMEOUT_MS) {
        return;
      }

      setUpdateRestartModalDetail(t('settings.about.restartServiceWaitTimeoutDetail'));
      setUpdateRestartModalStage('failure');
      setUpdateRestartModalStartedAtMs(null);
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [t, updateRestartModalStage, updateRestartModalStartedAtMs]);

  return {
    detectedOpenClawVersion,
    setDetectedOpenClawVersion,
    appVersionInfo,
    setAppVersionInfo,
    appVersionError,
    setAppVersionError,
    isLoadingAppVersion,
    setIsLoadingAppVersion,
    openClawLatestVersionInfo,
    setOpenClawLatestVersionInfo,
    openClawLatestVersionError,
    setOpenClawLatestVersionError,
    isCheckingOpenClawLatestVersion,
    setIsCheckingOpenClawLatestVersion,
    openClawUpdateStatusInfo,
    setOpenClawUpdateStatusInfo,
    isStartingOpenClawUpdate,
    setIsStartingOpenClawUpdate,
    isOpenClawUpdateCancelModalOpen,
    setIsOpenClawUpdateCancelModalOpen,
    isCancellingOpenClawUpdate,
    setIsCancellingOpenClawUpdate,
    latestVersionInfo,
    setLatestVersionInfo,
    latestVersionError,
    setLatestVersionError,
    isCheckingLatestVersion,
    setIsCheckingLatestVersion,
    updateStatusInfo,
    setUpdateStatusInfo,
    hasLoadedUpdateStatusOnce,
    setHasLoadedUpdateStatusOnce,
    updateRestartModalStage,
    setUpdateRestartModalStage,
    updateRestartModalDetail,
    setUpdateRestartModalDetail,
    updateRestartStepSnapshot,
    setUpdateRestartStepSnapshot,
    updateRestartModalStartedAtMs,
    setUpdateRestartModalStartedAtMs,
    isUpdateCancelModalOpen,
    setIsUpdateCancelModalOpen,
    isCancellingUpdate,
    setIsCancellingUpdate,
    fetchCurrentVersionInfo,
    fetchUpdateStatus,
    fetchOpenClawUpdateStatus,
    fetchOpenClawLatestVersion,
    handleCheckOpenClawLatestVersion,
    handleStartOpenClawUpdate,
    handleCancelOpenClawUpdate,
    handleResetOpenClawUpdateState,
    handleOpenClawLatestVersionAction,
    handleConfirmCancelOpenClawUpdate,
    handleCheckLatestVersion,
    handleStartUpdate,
    handleCancelUpdate,
    handleResetUpdateState,
    handleRestartUpdatedService,
    closeUpdateRestartModal,
    handleConfirmRestartUpdatedService,
    handleLatestVersionAction,
    handleConfirmCancelUpdate,
  };
}
