// 跨页签共用：翻译、共用 loading 位、错误详情弹窗、删除确认弹窗的状态。
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import type { DeleteTarget } from '../shared/settingsTypes';

export function useSettingsShared() {
  const { t, i18n } = useTranslation();

  const openSettingsErrorModal = (message: string, detail = '') => {
    setGatewayErrorMessage(message);
    setGatewayErrorDetail(detail);
    setGatewayErrorModalOpen(true);
  };
  const [isLoading, setIsLoading] = useState(false);
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
    isLoading,
    setIsLoading,
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
