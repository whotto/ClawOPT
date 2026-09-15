// 网关连接配置、允许的主机、网关探测与重启流程。
import { useEffect, useRef, useState } from 'react';
import { type BrowserHeadedModeModalStage, EMPTY_INLINE_ERROR, type GatewayRestartNoticeSource, type GatewayRestartTaskInfo, type GatewayRestartTrigger, type RestartFlowModalStage, type SettingsProps } from '../shared/settingsTypes';
import { CONNECTION_STATUS_REFRESH_EVENT, joinDistinctLines, normalizeGatewayRestartTaskInfo, parseTimestampMs, resolveStructuredErrorDisplay } from '../shared/settingsHelpers';
import { detectAllConfig, getGatewayRestartStatus, resetGatewayRestartStatus, restartGateway, saveConfig, testGatewayConfig } from '../../../api/config';
import type { useUpdateSettings } from './useUpdateSettings';
import type { useSettingsShared } from './useSettingsShared';

export function useGatewaySettings(deps: Pick<ReturnType<typeof useUpdateSettings> & ReturnType<typeof useSettingsShared> & SettingsProps, 'fetchCurrentVersionInfo' | 'fetchOpenClawLatestVersion' | 'fetchOpenClawUpdateStatus' | 'handleResetOpenClawUpdateState' | 'isStartingOpenClawUpdate' | 'openClawUpdateStatusInfo' | 'openSettingsErrorModal' | 'setDeleteModalMessage' | 'setDeleteTarget' | 'setDetectedOpenClawVersion' | 'setGatewayErrorDetail' | 'setGatewayErrorMessage' | 'setGatewayErrorModalOpen' | 'setIsDeleteModalOpen' | 'setAreaLoading' | 'setOpenClawLatestVersionError' | 'setOpenClawLatestVersionInfo' | 'settingsTab' | 't' | 'updateRestartModalStage'>) {
  const { fetchCurrentVersionInfo, fetchOpenClawLatestVersion, fetchOpenClawUpdateStatus, handleResetOpenClawUpdateState, isStartingOpenClawUpdate, openClawUpdateStatusInfo, openSettingsErrorModal, setDeleteModalMessage, setDeleteTarget, setDetectedOpenClawVersion, setGatewayErrorDetail, setGatewayErrorMessage, setGatewayErrorModalOpen, setIsDeleteModalOpen, setAreaLoading, setOpenClawLatestVersionError, setOpenClawLatestVersionInfo, settingsTab, t, updateRestartModalStage } = deps;
  const setIsLoading = (loading: boolean) => setAreaLoading('gateway', loading);

  // --- Gateway settings state ---
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  // 后端不再回读密钥值（明文回读等于把凭据发给任何能打开页面的人），
  // 这里只知道「配没配」，输入框留空表示不修改。
  const [hasToken, setHasToken] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [hasLoginPassword, setHasLoginPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testResult, setTestResult] = useState<{ success?: boolean; message?: string } | null>(null);
  const [gatewaySaved, setGatewaySaved] = useState(false);
  const [gatewayError, setGatewayError] = useState(false);
  const [isDetectingAll, setIsDetectingAll] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [allowedHosts, setAllowedHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState('');
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [editHostValue, setEditHostValue] = useState('');
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartSuccess, setRestartSuccess] = useState(false);
  const [gatewayRestartNoticeSource, setGatewayRestartNoticeSource] = useState<GatewayRestartNoticeSource>(null);
  const [browserHeadedModeModalStage, setBrowserHeadedModeModalStage] = useState<BrowserHeadedModeModalStage>(null);
  const [gatewayRestartModalStage, setGatewayRestartModalStage] = useState<RestartFlowModalStage>(null);
  const [gatewayRestartModalDetail, setGatewayRestartModalDetail] = useState('');
  const [gatewayRestartTaskInfo, setGatewayRestartTaskInfo] = useState<GatewayRestartTaskInfo | null>(null);
  const gatewayRestartTaskInfoRef = useRef<GatewayRestartTaskInfo | null>(null);
  const pendingGatewayRestartStartRef = useRef<{ trigger: GatewayRestartTrigger; startedAtMs: number } | null>(null);

  const updateGatewayRestartTaskInfo = (nextTaskInfo: GatewayRestartTaskInfo | null) => {
    gatewayRestartTaskInfoRef.current = nextTaskInfo;
    setGatewayRestartTaskInfo(nextTaskInfo);
  };
  useEffect(() => {
    setTestResult(null);
  }, [url, token, password]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    const activeStatus = openClawUpdateStatusInfo?.status;
    if (isStartingOpenClawUpdate) {
      return;
    }
    if (activeStatus === 'update_succeeded') {
      void (async () => {
        await fetchCurrentVersionInfo({ silent: true });
        await detectGatewayConfig({ silent: true });
        setOpenClawLatestVersionInfo(null);
        setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
        window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
        await handleResetOpenClawUpdateState();
      })();
      return;
    }
    if (!activeStatus || !['checking', 'updating', 'stopping'].includes(activeStatus)) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const nextUpdate = await fetchOpenClawUpdateStatus({ quiet: true });
      if (cancelled || !nextUpdate) return;

      if (activeStatus === 'stopping' && nextUpdate.status === 'idle') {
        await fetchCurrentVersionInfo({ silent: true });
        await detectGatewayConfig({ silent: true });
        const latest = await fetchOpenClawLatestVersion({ quiet: true });
        if (latest) {
          setOpenClawLatestVersionInfo(latest);
        }
        window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
        return;
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
  }, [settingsTab, openClawUpdateStatusInfo?.status, isStartingOpenClawUpdate]);

  useEffect(() => {
    if (settingsTab !== 'gateway' || gatewayRestartTaskInfo?.status !== 'restarting') {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const nextTask = await fetchGatewayRestartTaskStatus();
        if (cancelled || !nextTask || nextTask.status !== 'restarting') {
          return;
        }
      } catch {}
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settingsTab, gatewayRestartTaskInfo?.status]);

  const handleSave = async () => {
    setIsLoading(true);
    setGatewayError(false);
    if (!url.trim()) {
      setGatewayErrorMessage(t('settings.gateway.gatewayUrlRequired'));
      setGatewayErrorDetail('');
      setGatewayErrorModalOpen(true);
      setIsLoading(false);
      return;
    }

    try {
      const res = await saveConfig({ gatewayUrl: url, token, password });
      if (res.ok) {
        setGatewaySaved(true);
        setTimeout(() => setGatewaySaved(false), 2000);
      } else throw new Error(t('settings.gateway.saveFailed'));
    } catch (err) {
      setGatewayError(true);
      setTimeout(() => setGatewayError(false), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const detectGatewayConfig = async (options?: { silent?: boolean }) => {
    setIsDetectingAll(true);
    if (!options?.silent) {
      setDetectError('');
    }
    try {
      const res = await detectAllConfig();
      const data = await res.json();
      if (data.success && data.data) {
        if (data.data.gatewayUrl) setUrl(data.data.gatewayUrl);
        if (data.data.token) setToken(data.data.token);
        if (data.data.password) setPassword(data.data.password);
        setDetectedOpenClawVersion(typeof data.data.openclawVersion === 'string' ? data.data.openclawVersion : '');
      } else {
        if (options?.silent) {
          return false;
        }
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.detectFailed');
        setDetectError(display.message);
        if (display.detail) {
          openSettingsErrorModal(display.message, display.detail);
        }
      }
    } catch (err) {
      console.error(err);
      if (!options?.silent) {
        setDetectError(t('settings.gateway.detectNetworkError'));
      }
    } finally {
      setIsDetectingAll(false);
    }
    return true;
  };

  const openGatewayRestartConfirm = () => {
    if (
      isRestarting
      || gatewayRestartModalStage
      || browserHeadedModeModalStage === 'restarting'
      || updateRestartModalStage === 'restarting'
    ) {
      return false;
    }
    setRestartSuccess(false);
    setGatewayRestartModalDetail('');
    setGatewayRestartModalStage('confirm');
    return true;
  };

  const handleRestartGateway = () => {
    openGatewayRestartConfirm();
  };

  const applyGatewayRestartTaskState = (data: { restart?: unknown }) => {
    const nextTaskInfo = normalizeGatewayRestartTaskInfo(data.restart);
    const pendingStart = pendingGatewayRestartStartRef.current;
    const currentTaskInfo = gatewayRestartTaskInfoRef.current;

    if (
      pendingStart
      && currentTaskInfo?.status === 'restarting'
      && currentTaskInfo.trigger === pendingStart.trigger
      && nextTaskInfo?.status === 'idle'
    ) {
      const nextUpdatedAtMs = parseTimestampMs(nextTaskInfo.updatedAt);
      if (nextUpdatedAtMs === null || nextUpdatedAtMs < pendingStart.startedAtMs) {
        return currentTaskInfo;
      }
    }

    if (pendingStart) {
      const nextUpdatedAtMs = parseTimestampMs(nextTaskInfo?.updatedAt);
      const acknowledgedProgress = nextTaskInfo?.trigger === pendingStart.trigger
        && (nextTaskInfo.status === 'restarting' || nextTaskInfo.status === 'failed');
      const completedLocalRequest = nextTaskInfo?.status === 'idle'
        && (nextUpdatedAtMs === null || nextUpdatedAtMs >= pendingStart.startedAtMs);

      if (acknowledgedProgress || completedLocalRequest) {
        pendingGatewayRestartStartRef.current = null;
      }
    }

    updateGatewayRestartTaskInfo(nextTaskInfo);
    return nextTaskInfo;
  };

  const fetchGatewayRestartTaskStatus = async () => {
    const res = await getGatewayRestartStatus();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.errorDetail === 'string' && data.errorDetail.trim()
        ? data.errorDetail.trim()
        : 'Failed to load gateway restart status');
    }
    return applyGatewayRestartTaskState(data);
  };

  const resetGatewayRestartTaskStatus = async () => {
    const res = await resetGatewayRestartStatus();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.errorDetail === 'string' && data.errorDetail.trim()
        ? data.errorDetail.trim()
        : 'Failed to reset gateway restart status');
    }
    return applyGatewayRestartTaskState(data);
  };

  const closeGatewayRestartModal = () => {
    if (gatewayRestartModalStage === 'restarting') return;
    setGatewayRestartModalStage(null);
    setGatewayRestartModalDetail('');
    if (gatewayRestartTaskInfo?.status === 'failed' && gatewayRestartTaskInfo.trigger === 'gateway') {
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

  const handleConfirmRestartGateway = async () => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    setIsRestarting(true);
    setRestartSuccess(false);
    setGatewayRestartModalDetail('');
    setGatewayRestartModalStage('restarting');
    pendingGatewayRestartStartRef.current = {
      trigger: 'gateway',
      startedAtMs,
    };
    updateGatewayRestartTaskInfo({
      status: 'restarting',
      trigger: 'gateway',
      rawDetail: null,
      startedAt,
      updatedAt: startedAt,
      targetHeadedModeEnabled: null,
    });
    try {
      const res = await restartGateway();
      const data = await res.json().catch(() => ({}));
      applyGatewayRestartTaskState(data);
      if (res.ok) {
        await fetchGatewayRestartTaskStatus().catch(() => {});
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.restartFailed');
        setGatewayRestartModalDetail(joinDistinctLines([
          display.message !== t('settings.gateway.restartFailed') ? display.message : '',
          display.detail,
        ]));
        setGatewayRestartModalStage('failure');
      }
    } catch (err) {
      pendingGatewayRestartStartRef.current = null;
      console.error(err);
      const detail = err instanceof Error && err.message.trim() ? err.message.trim() : '';
      setGatewayRestartModalDetail(detail);
      setGatewayRestartModalStage('failure');
      updateGatewayRestartTaskInfo({
        status: 'failed',
        trigger: 'gateway',
        rawDetail: detail || null,
        startedAt: null,
        updatedAt: new Date().toISOString(),
        targetHeadedModeEnabled: null,
      });
    }
  };

  const handleAddHost = async () => {
    if (!newHost.trim()) return;
    const updated = [...allowedHosts, newHost.trim()];
    try {
      const res = await saveConfig({ allowedHosts: updated });
      if (res.ok) {
        setAllowedHosts(updated);
        setNewHost('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateHost = async () => {
    if (!editHostValue.trim() || !editingHost) return;
    const updated = allowedHosts.map(h => h === editingHost ? editHostValue.trim() : h);
    try {
      const res = await saveConfig({ allowedHosts: updated });
      if (res.ok) {
        setAllowedHosts(updated);
        setEditingHost(null);
        setEditHostValue('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const startEditHost = (host: string) => {
    setEditingHost(host);
    setEditHostValue(host);
  };

  const handleRemoveHost = (hostToRemove: string) => {
    setDeleteTarget({ type: 'host', value: hostToRemove });
    setDeleteModalMessage(t('settings.gateway.removeHostConfirm', { host: hostToRemove }));
    setIsDeleteModalOpen(true);
  };

  const handleTest = async () => {
    setIsLoading(true);
    setTestResult(null);
    try {
      const res = await testGatewayConfig({ gatewayUrl: url, token, password });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setGatewayErrorModalOpen(false);
        setGatewayErrorMessage('');
        setGatewayErrorDetail('');
        setTestResult({ success: true, message: data.message || '' });
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.testFailed');
        setTestResult({ success: false, message: display.message });
        openSettingsErrorModal(display.message, display.detail);
      }
    } catch (err) {
      const detail = err instanceof Error && err.message.trim() ? err.message.trim() : '';
      const message = t('settings.gateway.testFailed');
      setTestResult({ success: false, message });
      openSettingsErrorModal(message, detail);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    url,
    setUrl,
    token,
    setToken,
    password,
    setPassword,
    hasToken,
    setHasToken,
    hasPassword,
    setHasPassword,
    hasLoginPassword,
    setHasLoginPassword,
    showPassword,
    setShowPassword,
    testResult,
    setTestResult,
    gatewaySaved,
    setGatewaySaved,
    gatewayError,
    setGatewayError,
    isDetectingAll,
    setIsDetectingAll,
    detectError,
    setDetectError,
    allowedHosts,
    setAllowedHosts,
    newHost,
    setNewHost,
    editingHost,
    setEditingHost,
    editHostValue,
    setEditHostValue,
    isRestarting,
    setIsRestarting,
    restartSuccess,
    setRestartSuccess,
    gatewayRestartNoticeSource,
    setGatewayRestartNoticeSource,
    browserHeadedModeModalStage,
    setBrowserHeadedModeModalStage,
    gatewayRestartModalStage,
    setGatewayRestartModalStage,
    gatewayRestartModalDetail,
    setGatewayRestartModalDetail,
    gatewayRestartTaskInfo,
    setGatewayRestartTaskInfo,
    gatewayRestartTaskInfoRef,
    pendingGatewayRestartStartRef,
    updateGatewayRestartTaskInfo,
    handleSave,
    detectGatewayConfig,
    openGatewayRestartConfirm,
    handleRestartGateway,
    applyGatewayRestartTaskState,
    fetchGatewayRestartTaskStatus,
    resetGatewayRestartTaskStatus,
    closeGatewayRestartModal,
    handleConfirmRestartGateway,
    handleAddHost,
    handleUpdateHost,
    startEditHost,
    handleRemoveHost,
    handleTest,
  };
}
