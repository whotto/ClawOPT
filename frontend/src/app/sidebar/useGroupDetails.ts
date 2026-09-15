import { useState } from 'react';

/** 工作群详情弹窗与其删除 / 重置确认弹窗的开关。 */
export function useGroupDetails() {
  const [isGroupInfoOpen, setIsGroupInfoOpen] = useState(false);
  const [viewingGroup, setViewingGroup] = useState<any>(null);
  const [infoActiveRoleTab, setInfoActiveRoleTab] = useState<string>('');
  const [isDeleteGroupModalOpen, setIsDeleteGroupModalOpen] = useState(false);
  const [isResetGroupModalOpen, setIsResetGroupModalOpen] = useState(false);

  return {
    isGroupInfoOpen, setIsGroupInfoOpen,
    viewingGroup, setViewingGroup,
    infoActiveRoleTab, setInfoActiveRoleTab,
    isDeleteGroupModalOpen, setIsDeleteGroupModalOpen,
    isResetGroupModalOpen, setIsResetGroupModalOpen,
  };
}

export type GroupDetailsState = ReturnType<typeof useGroupDetails>;
