import { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { createGroup, updateGroup } from '../../api/groups';
import { requestActiveContextRefresh } from '../../utils/contextRefresh';
import { getGroupIdValidationKey } from '../../utils/groupId';
import type { SettingsTab, ViewType } from '../routeState';
import { resolveSidebarSubmitError } from './sidebarFormat';
import type { GroupMemberDraft, GroupSummary } from './sidebarTypes';

type GroupEditorDeps = {
  t: TFunction;
  groups: GroupSummary[];
  reloadGroups: () => Promise<void>;
  onSelectGroup: (id: string) => void;
  navigateTo: (view: ViewType, tab?: SettingsTab, openMenu?: boolean) => void;
  settingsTab: SettingsTab;
  activeGroupId: string | null;
  currentView: ViewType;
};

/** 新建 / 编辑工作群弹窗的表单状态与提交。 */
export function useGroupEditor({ t, groups, reloadGroups, onSelectGroup, navigateTo, settingsTab, activeGroupId, currentView }: GroupEditorDeps) {
  const [draggedAgentId, setDraggedAgentId] = useState<string | null>(null);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [groupModalMode, setGroupModalMode] = useState<'create' | 'edit'>('create');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [newGroupId, setNewGroupId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [newGroupSystemPrompt, setNewGroupSystemPrompt] = useState('');
  const [newProcessStartTag, setNewProcessStartTag] = useState('');
  const [newProcessEndTag, setNewProcessEndTag] = useState('');
  const [newMaxChainDepth, setNewMaxChainDepth] = useState<number>(6);
  const [selectedGroupMembers, setSelectedGroupMembers] = useState<GroupMemberDraft[]>([]);
  const [groupSearchQuery, setGroupSearchQuery] = useState('');
  const [isMemberDropdownOpen, setIsMemberDropdownOpen] = useState(false);
  // 注意：这个 ref 实际挂在智能体弹窗的模型输入框容器上（改造前即如此），点外部关闭的判定依赖它。
  const memberDropdownRef = useRef<HTMLDivElement>(null);
  const [activeRoleTab, setActiveRoleTab] = useState('');
  const [groupSubmitError, setGroupSubmitError] = useState<string | null>(null);
  const groupIdErrorKey = getGroupIdValidationKey(
    newGroupId,
    groups.map((group) => group.id),
    {
      currentId: groupModalMode === 'edit' ? editingGroupId : null,
      requireValue: groupModalMode === 'create',
    }
  );
  const groupIdError = groupIdErrorKey
    ? String(t(groupIdErrorKey, { groupId: newGroupId.trim() }))
    : null;
  const visibleGroupIdError = groupIdErrorKey && groupIdErrorKey !== 'groups.idRequired'
    ? groupIdError
    : null;

  useEffect(() => {
    if (selectedGroupMembers.length === 0) {
      if (activeRoleTab) {
        setActiveRoleTab('');
      }
      return;
    }

    if (!selectedGroupMembers.some((member) => member.agentId === activeRoleTab)) {
      setActiveRoleTab(selectedGroupMembers[0].agentId);
    }
  }, [activeRoleTab, selectedGroupMembers]);

  useEffect(() => {
    if (!isMemberDropdownOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (memberDropdownRef.current && !memberDropdownRef.current.contains(event.target as Node)) {
        setIsMemberDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isMemberDropdownOpen]);

  const handleCreateGroup = async () => {
    if (!newGroupId.trim() || !newGroupName.trim() || selectedGroupMembers.length === 0) return;
    if (groupModalMode === 'create' && groupIdError) {
      setGroupSubmitError(groupIdError);
      return;
    }
    try {
      const groupBody = {
        id: newGroupId.trim(),
        name: newGroupName.trim(),
        description: newGroupDesc.trim(),
        system_prompt: newGroupSystemPrompt.trim(),
        process_start_tag: newProcessStartTag,
        process_end_tag: newProcessEndTag,
        max_chain_depth: newMaxChainDepth,
        members: selectedGroupMembers,
      };
      // 编辑走 PUT /groups/:id，新建走 POST /groups（进入编辑态时总会同时设置 editingGroupId）。
      const res = await (groupModalMode === 'edit' && editingGroupId
        ? updateGroup(editingGroupId, groupBody)
        : createGroup(groupBody));
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setShowGroupDialog(false);
        setNewGroupId('');
        setNewGroupName('');
        setNewGroupDesc('');
        setNewGroupSystemPrompt('');
        setNewProcessStartTag('');
        setNewProcessEndTag('');
        setNewMaxChainDepth(6);
        setSelectedGroupMembers([]);
        setGroupSubmitError(null);
        await reloadGroups();
        if (groupModalMode === 'create') {
          onSelectGroup(data.id);
          navigateTo('groups', settingsTab, false);
        } else if (groupModalMode === 'edit' && editingGroupId && activeGroupId === editingGroupId && currentView === 'groups') {
          requestActiveContextRefresh({ mode: 'group', id: editingGroupId });
        }
      } else {
        setGroupSubmitError(resolveSidebarSubmitError(data, t, 'sidebar.createFail'));
      }
    } catch {
      setGroupSubmitError(t('sidebar.netError'));
    }
  };

  const toggleGroupMember = (agentId: string, name: string) => {
    setSelectedGroupMembers(prev => {
      const exists = prev.find(m => m.agentId === agentId);
      if (exists) return prev.filter(m => m.agentId !== agentId);
      return [...prev, { agentId, displayName: name, roleDescription: '' }];
    });
  };

  const removeGroupMember = (agentId: string) => {
    setSelectedGroupMembers((prev) => prev.filter((member) => member.agentId !== agentId));
  };

  const updateGroupMemberRole = (agentId: string, role: string) => {
    setSelectedGroupMembers(prev => prev.map(m => m.agentId === agentId ? { ...m, roleDescription: role } : m));
  };

  return {
    draggedAgentId, setDraggedAgentId,
    showGroupDialog, setShowGroupDialog,
    groupModalMode, setGroupModalMode,
    editingGroupId, setEditingGroupId,
    newGroupId, setNewGroupId,
    newGroupName, setNewGroupName,
    newGroupDesc, setNewGroupDesc,
    newGroupSystemPrompt, setNewGroupSystemPrompt,
    newProcessStartTag, setNewProcessStartTag,
    newProcessEndTag, setNewProcessEndTag,
    newMaxChainDepth, setNewMaxChainDepth,
    selectedGroupMembers, setSelectedGroupMembers,
    groupSearchQuery, setGroupSearchQuery,
    isMemberDropdownOpen, setIsMemberDropdownOpen,
    memberDropdownRef,
    activeRoleTab, setActiveRoleTab,
    groupSubmitError, setGroupSubmitError,
    groupIdError,
    visibleGroupIdError,
    handleCreateGroup,
    toggleGroupMember,
    removeGroupMember,
    updateGroupMemberRole,
  };
}

export type GroupEditorState = ReturnType<typeof useGroupEditor>;
