// 跨页签共用：翻译、按领域分开的 loading 计数、错误详情弹窗、删除确认弹窗的状态。
import { useTranslation } from 'react-i18next';
import { useCallback, useState } from 'react';
import type { DeleteTarget } from '../shared/settingsTypes';
import { applySettingsAreaLoading, EMPTY_SETTINGS_LOADING, isSettingsAreaLoading, type SettingsLoadingArea } from '../shared/settingsLoading';

export function useSettingsShared() {
  const { t, i18n } = useTranslation();

  const openSettingsErrorModal = (message: string, detail = '') => {
    setGatewayErrorMessage(message);
    setGatewayErrorDetail(detail);
    setGatewayErrorModalOpen(true);
  };
  // 每个领域一份（见 shared/settingsLoading.ts）：模型页保存时网关页按钮不该跟着锁住。
  const [loadingAreas, setLoadingAreas] = useState(EMPTY_SETTINGS_LOADING);
  const setAreaLoading = useCallback((area: SettingsLoadingArea, loading: boolean) => {
    setLoadingAreas((prev) => applySettingsAreaLoading(prev, area, loading));
  }, []);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleteModalMessage, setDeleteModalMessage] = useState('');
  const [gatewayErrorModalOpen, setGatewayErrorModalOpen] = useState(false);
  const [gatewayErrorMessage, setGatewayErrorMessage] = useState('');
  const [gatewayErrorDetail, setGatewayErrorDetail] = useState('');

  return {
    t,
    i18n,
    openSettingsErrorModal,
    setAreaLoading,
    isGeneralLoading: isSettingsAreaLoading(loadingAreas, 'general'),
    isCommandsLoading: isSettingsAreaLoading(loadingAreas, 'commands'),
    isModelsLoading: isSettingsAreaLoading(loadingAreas, 'models'),
    isGatewayLoading: isSettingsAreaLoading(loadingAreas, 'gateway'),
    deleteTarget,
    setDeleteTarget,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    deleteModalMessage,
    setDeleteModalMessage,
    gatewayErrorModalOpen,
    setGatewayErrorModalOpen,
    gatewayErrorMessage,
    setGatewayErrorMessage,
    gatewayErrorDetail,
    setGatewayErrorDetail,
  };
}
