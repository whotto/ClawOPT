import { useTranslation } from 'react-i18next';
import { Edit2, RefreshCw, Share2, Trash2, X } from 'lucide-react';
import type { SidebarProps } from './Sidebar';
import { FavoriteButton } from './SidebarCards';
import { resolveGroupMemberDisplayName as resolveMemberName } from './sidebarFormat';
import { memberRuntimeDraftFields, type SidebarFavoriteType } from './sidebarTypes';
import type { GroupDetailsState } from './useGroupDetails';
import type { GroupEditorState } from './useGroupEditor';
import type { useSidebarFavorites } from './useSidebarFavorites';

/** 工作群详情弹窗（只读），底部可编辑、导出、重置、删除。 */
export default function GroupInfoModal({
  sidebar,
  groupDetails,
  groupEditor,
  favorites,
}: {
  sidebar: SidebarProps;
  groupDetails: GroupDetailsState;
  groupEditor: GroupEditorState;
  favorites: Pick<ReturnType<typeof useSidebarFavorites>, 'isFavorite' | 'toggleFavorite'>;
}) {
  const { t } = useTranslation();
  const { navigateTo, sessions } = sidebar;
  const { viewingGroup, setIsGroupInfoOpen, infoActiveRoleTab, setInfoActiveRoleTab, setIsResetGroupModalOpen, setIsDeleteGroupModalOpen } = groupDetails;
  const {
    setGroupModalMode, setEditingGroupId, setNewGroupId, setNewGroupName, setNewGroupDesc, setNewGroupSystemPrompt,
    setNewProcessStartTag, setNewProcessEndTag, setNewMaxChainDepth, setSelectedGroupMembers, setGroupSubmitError, setShowGroupDialog,
  } = groupEditor;
  const resolveGroupMemberDisplayName = (member: Parameters<typeof resolveMemberName>[0]) => resolveMemberName(member, sessions);
  const renderFavoriteButton = (type: SidebarFavoriteType, id: string, className: string) => (
    <FavoriteButton type={type} id={id} className={className} favorites={favorites} />
  );
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIsGroupInfoOpen(false)} />
      <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-xl font-bold text-gray-900 leading-tight truncate">
                  {viewingGroup.name}
                </h3>
                {renderFavoriteButton(
                  'groups',
                  viewingGroup.id,
                  'flex-shrink-0 p-1.5 rounded-lg text-blue-500 hover:bg-blue-50 hover:text-yellow-600 transition-all'
                )}
              </div>
            </div>
          </div>
          <button 
            onClick={() => setIsGroupInfoOpen(false)} 
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="space-y-4">
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('chat.groupId')}</label>
                <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                  {viewingGroup.id}
                </p>
              </div>
              <div className="flex-1">
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('chat.groupName')}</label>
                <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                  {viewingGroup.name}
                </p>
              </div>
            </div>

            {viewingGroup.system_prompt && (
              <div className="group">
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('chat.groupSystemPrompt')}</label>
                <p className="text-sm text-gray-600 bg-gray-50 p-3 rounded-xl border border-gray-100 whitespace-pre-wrap leading-relaxed">
                  {viewingGroup.system_prompt}
                </p>
              </div>
            )}

            <div className="flex items-center justify-between gap-6">
              <div className="flex items-center gap-4">
                <span className="text-sm font-semibold text-gray-700">{t('sidebar.outputProcess')}</span>
                {/* Read-only toggle switch matching the edit modal style */}
                {(() => {
                  const isOn = !!(viewingGroup.process_start_tag && viewingGroup.process_end_tag);
                  return (
                    <label className="relative inline-flex items-center flex-shrink-0 pointer-events-none opacity-50 grayscale">
                      <input type="checkbox" checked={isOn} readOnly className="sr-only" />
                      <div className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${isOn ? 'bg-blue-600' : 'bg-gray-200'}`}>
                        <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${isOn ? 'translate-x-5' : 'translate-x-0'}`} />
                      </div>
                    </label>
                  );
                })()}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-gray-700">{t('chat.maxChainDepth')}</span>
                <span className="px-3 py-1 rounded-lg text-sm border border-gray-200 bg-gray-50 text-gray-700 font-mono">
                  {viewingGroup.max_chain_depth ?? 5}
                </span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">{t('chat.members')}</label>
              <div className="flex-1 flex flex-col min-h-0 border border-gray-100 rounded-2xl overflow-hidden bg-gray-50/30">
                <div className="flex p-1 bg-gray-100/50 gap-1 overflow-x-auto no-scrollbar">
                  {viewingGroup.members?.map((m: any) => {
                     const activeMember = viewingGroup.members.find((member: any) => member.agent_id === infoActiveRoleTab) || viewingGroup.members[0];
                     const isActive = activeMember.agent_id === m.agent_id;
                     return (
                       <button
                         key={m.agent_id}
                         type="button"
                         onClick={() => setInfoActiveRoleTab(m.agent_id)}
                         className={`flex-none px-3 py-1.5 text-sm rounded-lg transition-all whitespace-nowrap border border-gray-200 ${isActive ? 'bg-white text-blue-600 font-bold' : 'font-normal text-gray-500 hover:text-gray-700 hover:bg-white/50'}`}
                       >
                         {resolveGroupMemberDisplayName(m)}
                       </button>
                     );
                  })}
                </div>
                <div className="p-4 min-h-[120px] max-h-[220px] overflow-y-auto bg-white">
                  {(() => {
                    const activeMember = viewingGroup.members?.find((m: any) => m.agent_id === infoActiveRoleTab) || viewingGroup.members?.[0];
                    if (!activeMember) return <p className="text-gray-400 text-sm">{t('sidebar.noItems')}</p>;
                    return (
                      <div className="text-[13px] font-mono text-gray-800 leading-relaxed whitespace-pre-wrap">
                        {activeMember.role_description || <span className="text-gray-400">{t('sidebar.noItems')}</span>}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="p-6 border-t border-gray-100 bg-gray-50/50 flex gap-3">
          <button
            type="button"
            onClick={() => setIsGroupInfoOpen(false)}
            className="flex-1 flex items-center justify-center px-4 py-2.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-xl font-bold transition-all active:scale-[0.98]"
          >
            {t('common.close')}
          </button>
          <button
            onClick={() => {
              setGroupModalMode('edit');
              setEditingGroupId(viewingGroup.id);
              setNewGroupId(viewingGroup.id);
              setNewGroupName(viewingGroup.name);
              setNewGroupDesc(viewingGroup.description || '');
              setNewGroupSystemPrompt(viewingGroup.system_prompt || '');
              setNewProcessStartTag(viewingGroup.process_start_tag || '');
              setNewProcessEndTag(viewingGroup.process_end_tag || '');
              setNewMaxChainDepth(viewingGroup.max_chain_depth ?? 6);
              setSelectedGroupMembers(
                viewingGroup.members?.map((m: any) => ({
                  agentId: m.agent_id,
                  displayName: resolveGroupMemberDisplayName(m),
                  roleDescription: m.role_description || '',
                  ...memberRuntimeDraftFields(m),
                })) || []
              );
              setGroupSubmitError(null);
              setIsGroupInfoOpen(false);
              setShowGroupDialog(true);
            }}
            className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-white border border-blue-200 text-blue-600 hover:bg-blue-50 hover:border-blue-300 rounded-xl font-bold transition-all active:scale-[0.98]"
          >
            <Edit2 className="hidden sm:block w-4 h-4" />{t('common.edit')}
          </button>
          <button
            onClick={() => {
              try {
                localStorage.setItem('clawopt_pack_export', JSON.stringify({ kind: 'team', id: viewingGroup.id, name: viewingGroup.name }));
              } catch { /* 隐私模式下 localStorage 不可用，退化成不预选 */ }
              setIsGroupInfoOpen(false);
              navigateTo('settings', 'presets', false);
            }}
            className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 rounded-xl font-bold transition-all active:scale-[0.98]"
          >
            <Share2 className="hidden sm:block w-4 h-4" />{t('sidebar.exportPack')}
          </button>
          <button
            onClick={() => { setIsGroupInfoOpen(false); setIsResetGroupModalOpen(true); }}
            className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-orange-50 text-orange-600 border border-orange-100 hover:bg-orange-100 hover:border-orange-200 rounded-xl font-bold transition-all active:scale-[0.98]"
          >
            <RefreshCw className="hidden sm:block w-4 h-4" />{t('common.reset')}
          </button>
          <button
            onClick={() => { setIsGroupInfoOpen(false); setIsDeleteGroupModalOpen(true); }}
            className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 hover:border-red-200 rounded-xl font-bold transition-all active:scale-[0.98]"
          >
            <Trash2 className="hidden sm:block w-4 h-4" />{t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
