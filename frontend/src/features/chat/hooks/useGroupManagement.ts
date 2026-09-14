// 群的新建 / 删除与成员选择。
import { createGroup, deleteGroup } from '../../../api/groups';
import { resolveSubmitError } from '../lib/messageMapping';
import type { ChatViewState } from './useChatViewState';
import type { GroupEvents } from './useGroupEvents';

/** 本段读取的、由前面各段产出的值。 */
type GroupManagementContext = Pick<
  ChatViewState & GroupEvents,
  'props' | 't' | 'activeKey' | 'setShowCreateDialog' | 'newGroupId' | 'setNewGroupId' |
  'newGroupName' | 'setNewGroupName' | 'newGroupDesc' | 'setNewGroupDesc' | 'selectedMembers' |
  'setSelectedMembers' | 'setGroupCreateError' | 'groupIdError' | 'loadGroups'
>;

export function useGroupManagement(c: GroupManagementContext) {
  const {
    props, t, activeKey, setShowCreateDialog, newGroupId, setNewGroupId, newGroupName,
    setNewGroupName, newGroupDesc, setNewGroupDesc, selectedMembers, setSelectedMembers,
    setGroupCreateError, groupIdError, loadGroups,
  } = c;
  // ---- Group CRUD ----
  const handleCreateGroup = async () => {
    if (!newGroupId.trim() || !newGroupName.trim() || selectedMembers.length === 0) return;
    if (groupIdError) {
      setGroupCreateError(groupIdError);
      return;
    }
    try {
      const res = await createGroup({ id: newGroupId.trim(), name: newGroupName.trim(), description: newGroupDesc.trim(), members: selectedMembers });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setShowCreateDialog(false);
        setNewGroupId('');
        setNewGroupName('');
        setNewGroupDesc('');
        setSelectedMembers([]);
        setGroupCreateError(null);
        await loadGroups();
        props.onSelectGroup?.(data.id);
      } else {
        setGroupCreateError(resolveSubmitError(data, t, 'common.unknownError'));
      }
    } catch {
      setGroupCreateError(t('common.unknownError'));
    }
  };
  const handleDeleteGroup = async (id: string) => {
    try { await deleteGroup(id); await loadGroups(); if (activeKey === id) props.onSelectGroup?.(''); } catch {}
  };
  const toggleMember = (agentId: string, name: string) => {
    setSelectedMembers(prev => prev.find(m => m.agentId === agentId) ? prev.filter(m => m.agentId !== agentId) : [...prev, { agentId, displayName: name, roleDescription: '' }]);
  };
  const updateMemberRole = (agentId: string, role: string) => {
    setSelectedMembers(prev => prev.map(m => m.agentId === agentId ? { ...m, roleDescription: role } : m));
  };

  return { handleCreateGroup, handleDeleteGroup, toggleMember, updateMemberRole };
}
