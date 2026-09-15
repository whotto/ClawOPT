// 群聊模式下未选中群时的群列表页。
import { Menu, Plus, Trash2, Users } from 'lucide-react';
import { CreateGroupDialog, type CreateGroupDialogProps } from './CreateGroupDialog';
import type { ChatController } from '../hooks/useChatController';

type GroupListPageProps = Pick<
  ChatController,
  'props' | 't' | 'onMenuClick' | 'groups' | 'setShowCreateDialog' | 'setNewGroupId' |
  'setNewGroupName' | 'setNewGroupDesc' | 'setSelectedMembers' | 'setGroupCreateError' |
  'resolveGroupMemberDisplayName' | 'handleDeleteGroup'
> & CreateGroupDialogProps;

export function GroupListPage(c: GroupListPageProps) {
  const {
    props, t, onMenuClick, groups, setShowCreateDialog, setNewGroupId, setNewGroupName,
    setNewGroupDesc, setSelectedMembers, setGroupCreateError, resolveGroupMemberDisplayName,
    handleDeleteGroup,
  } = c;
  return (
    <div className="flex flex-col h-full bg-gradient-to-b from-gray-50 to-blue-50/30">
      <header className="h-14 px-4 sm:px-6 border-b border-gray-300 flex items-center justify-between flex-shrink-0 bg-white z-10 w-full">
        <div className="flex items-center gap-3">
          <button onClick={onMenuClick} className="md:hidden p-2 hover:bg-gray-100 rounded-xl"><Menu className="w-5 h-5" /></button>
          <Users className="w-5 h-5 text-blue-500" />
          <h1 className="text-lg font-bold text-gray-900">{t('unifiedChat.groupTitle')}</h1>
        </div>
        <button
          onClick={() => {
            setNewGroupId('');
            setNewGroupName('');
            setNewGroupDesc('');
            setSelectedMembers([]);
            setGroupCreateError(null);
            setShowCreateDialog(true);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-4 h-4" /> {t('unifiedChat.newGroup')}
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <Users className="w-16 h-16 mb-4 opacity-30" />
            <p className="text-lg font-bold mb-2">{t('unifiedChat.noGroupsTitle')}</p>
            <p className="text-sm">{t('unifiedChat.noGroupsDescription')}</p>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-4">
            {groups.map(group => (
              <div key={group.id} className="bg-white rounded-2xl border border-gray-200 p-5 hover:border-blue-300 transition-all cursor-pointer group" onClick={() => props.onSelectGroup?.(group.id)}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-base font-bold text-gray-900">{group.name}</h3>
                    {group.description && <p className="text-sm text-gray-500 mt-0.5">{group.description}</p>}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteGroup(group.id); }} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg opacity-0 group-hover:opacity-100 transition-all">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Users className="w-4 h-4 text-gray-400" />
                  {group.members.map(m => (<span key={m.id} className="text-xs font-bold text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full">{resolveGroupMemberDisplayName(m)}</span>))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <CreateGroupDialog {...c} />
    </div>
  );
}
