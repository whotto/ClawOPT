// 新建群聊弹窗。
import { X, Check } from 'lucide-react';
import {
  MODAL_FORM_FONT_STYLE, MODAL_FIELD_LABEL_CLASS, MODAL_TEXT_INPUT_CLASS, MODAL_TEXTAREA_CLASS,
} from '../lib/constants';
import type { ChatController } from '../hooks/useChatController';

export type CreateGroupDialogProps = Pick<
  ChatController,
  't' | 'sessions' | 'showCreateDialog' | 'setShowCreateDialog' | 'newGroupId' | 'setNewGroupId' |
  'newGroupName' | 'setNewGroupName' | 'newGroupDesc' | 'setNewGroupDesc' | 'selectedMembers' |
  'groupCreateError' | 'setGroupCreateError' | 'groupIdError' | 'visibleGroupIdError' |
  'handleCreateGroup' | 'toggleMember' | 'updateMemberRole'
>;

export function CreateGroupDialog(c: CreateGroupDialogProps) {
  const {
    t, sessions, showCreateDialog, setShowCreateDialog, newGroupId, setNewGroupId, newGroupName,
    setNewGroupName, newGroupDesc, setNewGroupDesc, selectedMembers, groupCreateError,
    setGroupCreateError, groupIdError, visibleGroupIdError, handleCreateGroup, toggleMember,
    updateMemberRole,
  } = c;
  return (
    <>
      {showCreateDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowCreateDialog(false)} />
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 max-h-[calc(100vh-2rem)] flex flex-col" style={MODAL_FORM_FONT_STYLE}>
            <div className="flex items-center justify-between p-6 border-b border-gray-100 bg-gray-50/50">
              <h3 className="text-xl font-bold text-gray-900">{t('unifiedChat.createGroupTitle')}</h3>
              <button onClick={() => setShowCreateDialog(false)} className="p-2 hover:bg-gray-100 rounded-lg"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className={MODAL_FIELD_LABEL_CLASS}>{t('chat.groupId')} <span className="text-red-500">*</span></label>
                  <input
                    value={newGroupId}
                    onChange={e => {
                      setNewGroupId(e.target.value);
                      setGroupCreateError(null);
                    }}
                    placeholder={t('chat.groupIdPlaceholder')}
                    autoFocus
                    className={`${MODAL_TEXT_INPUT_CLASS} ${
                      visibleGroupIdError
                        ? 'bg-red-50/50 border-red-300 focus:bg-white focus:ring-2 focus:ring-red-500/15 focus:border-red-400'
                        : ''
                    }`}
                  />
                  {visibleGroupIdError ? (
                    <p className="mt-1.5 text-xs text-red-500">{visibleGroupIdError}</p>
                  ) : null}
                </div>
                <div className="flex-1">
                  <label className={MODAL_FIELD_LABEL_CLASS}>{t('chat.groupName')} <span className="text-red-500">*</span></label>
                  <input
                    value={newGroupName}
                    onChange={e => {
                      setNewGroupName(e.target.value);
                      setGroupCreateError(null);
                    }}
                    placeholder={t('chat.groupNamePlaceholder')}
                    className={MODAL_TEXT_INPUT_CLASS}
                  />
                </div>
              </div>
              <div>
                <label className={MODAL_FIELD_LABEL_CLASS}>{t('unifiedChat.groupDescriptionLabel')}</label>
                <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)} placeholder={t('unifiedChat.groupDescriptionPlaceholder')} className={MODAL_TEXT_INPUT_CLASS} />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-2">👥 {t('unifiedChat.selectMembersLabel', { count: selectedMembers.length })}</label>
                <div className="grid grid-cols-2 gap-2">
                  {sessions.map(s => {
                    const memberAgentId = s.agentId || s.id;
                    const isSelected = selectedMembers.some(m => m.agentId === memberAgentId);
                    return (
                      <button key={s.id} onClick={() => toggleMember(memberAgentId, s.name)} className={`text-left p-3 rounded-xl border-2 transition-all ${isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300 bg-white'}`}>
                        <div className="flex items-center gap-2">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center ${isSelected ? 'bg-blue-500' : 'bg-gray-200'}`}>
                            {isSelected && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <span className="font-bold text-sm text-gray-900">{s.name}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
              {selectedMembers.length > 0 && (
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">📝 {t('unifiedChat.defineResponsibilitiesLabel')}</label>
                  <p className="text-xs text-gray-400 mb-3">{t('unifiedChat.defineResponsibilitiesDescription')}</p>
                  <div className="space-y-3">
                    {selectedMembers.map(m => (
                      <div key={m.agentId} className="bg-gray-50 rounded-xl p-3">
                        <div className="text-sm font-bold text-gray-800 mb-1.5">{m.displayName}</div>
                        <textarea value={m.roleDescription} onChange={e => updateMemberRole(m.agentId, e.target.value)}
                          placeholder={t('unifiedChat.memberRolePlaceholder', { name: m.displayName })}
                          rows={3} className={`${MODAL_TEXTAREA_CLASS} min-h-[72px] rounded-lg resize-y bg-white px-3 py-2`} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {groupCreateError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                  {groupCreateError}
                </div>
              )}
            </div>
            <div className="p-6 border-t border-gray-100 bg-gray-50/50">
              <button onClick={handleCreateGroup} disabled={!newGroupId.trim() || !newGroupName.trim() || selectedMembers.length === 0 || !!groupIdError}
                className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{t('unifiedChat.createGroupButton')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
