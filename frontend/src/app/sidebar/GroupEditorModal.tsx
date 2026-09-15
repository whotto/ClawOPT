import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react';
import MemberRuntimeSection from './MemberRuntimeSection';
import { resolveGroupMemberDisplayName as resolveMemberName } from './sidebarFormat';
import {
  MODAL_EDITOR_TEXTAREA_CLASS,
  MODAL_FIELD_LABEL_CLASS,
  MODAL_FORM_FONT_STYLE,
  MODAL_TEXTAREA_CLASS,
  MODAL_TEXT_INPUT_CLASS,
  type SidebarSession,
} from './sidebarTypes';
import type { GroupEditorState } from './useGroupEditor';
import { openclawSessionsOnly } from '../../utils/openclawSessions';

/** 新建 / 编辑工作群弹窗。 */
export default function GroupEditorModal({ groupEditor, sessions }: { groupEditor: GroupEditorState; sessions: SidebarSession[] }) {
  const { t } = useTranslation();
  const {
    setShowGroupDialog, groupModalMode, newGroupId, setNewGroupId, setGroupSubmitError, visibleGroupIdError,
    newGroupName, setNewGroupName, newGroupSystemPrompt, setNewGroupSystemPrompt,
    newProcessStartTag, setNewProcessStartTag, setNewProcessEndTag, newMaxChainDepth, setNewMaxChainDepth,
    selectedGroupMembers, setSelectedGroupMembers, isMemberDropdownOpen, setIsMemberDropdownOpen,
    groupSearchQuery, setGroupSearchQuery, toggleGroupMember, activeRoleTab, setActiveRoleTab,
    draggedAgentId, setDraggedAgentId, removeGroupMember, updateGroupMemberRole,
    groupSubmitError, handleCreateGroup, groupIdError,
    updateGroupMemberRuntime, addRemoteGroupMember, memberRuntimes, memberDropdownRef,
  } = groupEditor;
  const [remoteMemberName, setRemoteMemberName] = useState('');
  const remoteRuntimeAvailable = memberRuntimes.some((runtime) => runtime.kind === 'remote');
  const resolveGroupMemberDisplayName = (member: Parameters<typeof resolveMemberName>[0]) => resolveMemberName(member, sessions);
  // 成员下拉只列 OpenClaw Agent：外部运行时单聊不是可加进群的 OpenClaw 成员（外部成员用每个成员的运行时选择加）。
  const openclawSessions = openclawSessionsOnly(sessions);
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowGroupDialog(false)} />
      <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 max-h-[calc(100vh-2rem)] flex flex-col" style={MODAL_FORM_FONT_STYLE}>
        <div className="flex items-center justify-between p-6 border-b border-gray-100 bg-gray-50/50">
          <h3 className="text-xl font-bold text-gray-900">{groupModalMode === 'create' ? t('sidebar.newGroupTitle') : t('sidebar.editGroupTitle')}</h3>
          <button onClick={() => setShowGroupDialog(false)} className="p-2 hover:bg-gray-100 rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div className="flex gap-4">
            <div className="flex-1">
              <label className={MODAL_FIELD_LABEL_CLASS}>{t('chat.groupId')} <span className="text-red-500">*</span></label>
              <input
                value={newGroupId}
                onChange={e => {
                  setNewGroupId(e.target.value);
                  setGroupSubmitError(null);
                }}
                placeholder={t('chat.groupIdPlaceholder')}
                disabled={groupModalMode === 'edit'}
                autoFocus={groupModalMode === 'create'}
                className={`${MODAL_TEXT_INPUT_CLASS} ${
                  groupModalMode === 'edit'
                    ? 'text-gray-500 cursor-not-allowed'
                    : visibleGroupIdError
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
                  setGroupSubmitError(null);
                }}
                placeholder={t('chat.groupNamePlaceholder')}
                className={MODAL_TEXT_INPUT_CLASS}
              />
            </div>
          </div>

          <div>
            <label className={MODAL_FIELD_LABEL_CLASS}>{t('chat.groupSystemPromptOptional')}</label>
            <textarea
              value={newGroupSystemPrompt}
              onChange={(e) => setNewGroupSystemPrompt(e.target.value)}
              placeholder={t('chat.groupSystemPromptPlaceholder')}
              className={`${MODAL_TEXTAREA_CLASS} h-24`}
            />
          </div>

          <div className="flex items-center justify-between gap-8 mb-1.5">
            <div className="flex items-center gap-4 flex-1">
              <span className="text-sm font-bold text-gray-700">{t('sidebar.outputProcess')}</span>
              <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                <input 
                  type="checkbox" 
                  className="sr-only peer"
                  checked={!!newProcessStartTag}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setNewProcessStartTag('[执行工作_Start]');
                      setNewProcessEndTag('[执行工作_End]');
                    } else {
                      setNewProcessStartTag('');
                      setNewProcessEndTag('');
                    }
                  }}
                />
                <div className="w-11 h-6 bg-blue-100 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-200 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
              </label>
            </div>
            <div className="flex items-center gap-4 flex-1 justify-end">
              <span className="text-sm font-bold text-gray-700">{t('chat.maxChainDepth')}</span>
              <input
                type="number"
                min="0"
                max="100"
                value={newMaxChainDepth}
                onChange={e => {
                  const val = parseInt(e.target.value);
                  setNewMaxChainDepth(isNaN(val) ? 0 : val);
                }}
                className="w-16 h-10 px-0 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-center text-gray-900 outline-none transition-all focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
            </div>
          </div>
          
          <div className="space-y-1.5 mb-6 text-xs text-gray-400 font-normal">
            <div>{t('sidebar.outputProcessHint')}</div>
            <div>{t('sidebar.chainDepthHint')}</div>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">
              {t('chat.selectMembers')} ({selectedGroupMembers.length})
            </label>
            {/* 点外部收起的判定容器（useGroupEditor 的 mousedown 监听）：必须是成员下拉这一块，而不是别的弹窗里的元素 */}
            <div className="relative" ref={memberDropdownRef}>
              <div className={`flex items-center w-full px-4 py-2.5 border rounded-xl bg-white transition-colors ${isMemberDropdownOpen ? 'border-blue-400 ring-2 ring-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <Search className="w-4 h-4 text-gray-400 mr-2 flex-shrink-0" />
                <input
                  value={groupSearchQuery}
                  onChange={e => setGroupSearchQuery(e.target.value)}
                  onFocus={() => setIsMemberDropdownOpen(true)}
                  onBlur={() => setTimeout(() => setIsMemberDropdownOpen(false), 200)}
                  placeholder={t('sidebar.searchAddAgent')}
                  className="flex-1 text-[15px] text-gray-900 placeholder:text-gray-400 outline-none bg-transparent"
                />
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setIsMemberDropdownOpen((open) => !open)}
                  aria-label={t('chat.selectMembers')}
                  aria-expanded={isMemberDropdownOpen}
                  className="ml-2 -mr-1 p-1 text-gray-400 transition-colors hover:text-gray-600 cursor-pointer"
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${isMemberDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
              </div>

              {isMemberDropdownOpen && (
                <div className="absolute top-[calc(100%+4px)] left-0 right-0 max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-xl z-50 py-1 scrollbar-hide">
                  {openclawSessions.filter(s => s.name.toLowerCase().includes(groupSearchQuery.toLowerCase())).length === 0 ? (
                    <div className="px-4 py-3 text-sm text-gray-400 text-center font-medium">{t('sidebar.noItems')}</div>
                  ) : (
                    openclawSessions.filter(s => s.name.toLowerCase().includes(groupSearchQuery.toLowerCase())).map(s => {
                      const memberAgentId = s.agentId || s.id;
                      const isSelected = selectedGroupMembers.some(m => m.agentId === memberAgentId);
                      return (
                        <button
                          key={s.id}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            toggleGroupMember(memberAgentId, s.name);
                          }}
                          className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center justify-between group transition-colors"
                        >
                          <span className="text-sm font-semibold text-gray-800 group-hover:text-blue-600 transition-colors">{s.name}</span>
                          {isSelected ? (
                            <div className="w-5 h-5 rounded-md bg-blue-500 flex items-center justify-center">
                              <Check className="w-3.5 h-3.5 text-white" />
                            </div>
                          ) : (
                            <div className="w-5 h-5 rounded-md border-2 border-gray-200 group-hover:border-blue-400 transition-colors flex items-center justify-center" />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
          {remoteRuntimeAvailable && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 -mt-2">
              <input
                value={remoteMemberName}
                onChange={(e) => setRemoteMemberName(e.target.value)}
                placeholder={t('remoteOpenclaw.addMemberPlaceholder')}
                className={`${MODAL_TEXT_INPUT_CLASS} sm:max-w-xs`}
              />
              <button
                type="button"
                disabled={!remoteMemberName.trim()}
                onClick={() => { addRemoteGroupMember(remoteMemberName); setRemoteMemberName(''); }}
                className="h-10 px-4 inline-flex items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-blue-600 bg-white border border-blue-200 hover:bg-blue-50 disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />{t('remoteOpenclaw.addMember')}
              </button>
            </div>
          )}
          {selectedGroupMembers.length > 0 && (
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-1">
                {t('chat.defineRoles')}
              </label>
              <p className="text-xs text-gray-400 mb-3">{t('chat.defineRolesDesc')} {t('chat.dragToReorder')}</p>
              
              {/* Unified tab+editor — same style as the soul/agents file editor */}
              <div className="flex-1 flex flex-col min-h-0 border border-gray-100 rounded-2xl overflow-hidden mt-2 bg-gray-50/30">
                {/* Tab bar */}
                <div className="flex p-1 bg-gray-100/50 gap-1 overflow-x-auto no-scrollbar">
                  {selectedGroupMembers.map(m => {
                     const activeMember = selectedGroupMembers.find(member => member.agentId === activeRoleTab) || selectedGroupMembers[0];
                     const isActive = activeMember.agentId === m.agentId;
                     return (
                       <div
                         key={m.agentId}
                         draggable={true}
                         onDragStart={(e) => {
                           setDraggedAgentId(m.agentId);
                           e.dataTransfer.effectAllowed = 'move';
                         }}
                         onDragOver={(e) => {
                           e.preventDefault();
                           e.dataTransfer.dropEffect = 'move';
                         }}
                         onDrop={(e) => {
                           e.preventDefault();
                           if (!draggedAgentId || draggedAgentId === m.agentId) return;
                           const oldIndex = selectedGroupMembers.findIndex(x => x.agentId === draggedAgentId);
                           const newIndex = selectedGroupMembers.findIndex(x => x.agentId === m.agentId);
                           if (oldIndex === -1 || newIndex === -1) return;
                           const newMembers = [...selectedGroupMembers];
                           const [removed] = newMembers.splice(oldIndex, 1);
                           newMembers.splice(newIndex, 0, removed);
                           setSelectedGroupMembers(newMembers);
                           setDraggedAgentId(null);
                         }}
                         onDragEnd={() => setDraggedAgentId(null)}
                         className={`flex-none flex items-center rounded-lg border border-gray-200 transition-all ${isActive ? 'bg-white text-blue-600' : 'text-gray-500 hover:bg-white/50 hover:text-gray-700'} ${draggedAgentId === m.agentId ? 'opacity-50' : ''}`}
                       >
                         <button
                           type="button"
                           onClick={() => setActiveRoleTab(m.agentId)}
                           className={`px-3 py-1.5 text-sm whitespace-nowrap transition-colors cursor-grab active:cursor-grabbing ${isActive ? 'font-bold text-blue-600' : 'font-normal text-inherit'}`}
                         >
                           <span>{resolveGroupMemberDisplayName(m)}</span>
                         </button>
                         <button
                           type="button"
                           onClick={(e) => {
                             e.stopPropagation();
                             removeGroupMember(m.agentId);
                           }}
                           aria-label={t('chat.removeMember').replace('{{name}}', resolveGroupMemberDisplayName(m))}
                           className={`mr-1 flex h-6 w-6 items-center justify-center rounded-md transition-colors ${isActive ? 'text-blue-400 hover:bg-blue-50 hover:text-blue-600' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
                         >
                           <X className="h-3.5 w-3.5" />
                         </button>
                       </div>
                     );
                  })}
                </div>
                {/* Editor area */}
                <div className="flex-1 relative">
                  {(() => {
                    const activeMember = selectedGroupMembers.find(m => m.agentId === activeRoleTab) || selectedGroupMembers[0];
                    if (!activeMember) return null;
                    return (
                      <>
                        <textarea
                          key={activeMember.agentId}
                          value={activeMember.roleDescription}
                          onChange={e => updateGroupMemberRole(activeMember.agentId, e.target.value)}
                          placeholder={t('chat.rolePlaceholder').replace('{{name}}', resolveGroupMemberDisplayName(activeMember))}
                          className={MODAL_EDITOR_TEXTAREA_CLASS}
                        />
                        {/* P2：成员运行时（OpenClaw / 本机外部 CLI / 远程 OpenClaw 网关上的 Agent） */}
                        <MemberRuntimeSection
                          key={`runtime-${activeMember.agentId}`}
                          member={activeMember}
                          runtimes={memberRuntimes}
                          groupId={groupModalMode === 'edit' ? newGroupId : ''}
                          onChange={(patch) => updateGroupMemberRuntime(activeMember.agentId, patch)}
                        />
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}
          {groupSubmitError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              {groupSubmitError}
            </div>
          )}
        </div>
        <div className="p-6 border-t border-gray-100 bg-gray-50/50 flex gap-3">
          <button 
            type="button" 
            onClick={() => setShowGroupDialog(false)}
            className="flex-1 px-4 py-2.5 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl font-bold transition-all active:scale-[0.98]"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleCreateGroup}
            disabled={!newGroupId.trim() || !newGroupName.trim() || selectedGroupMembers.length === 0 || (groupModalMode === 'create' && !!groupIdError)}
            className="flex-1 px-4 py-2.5 text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-bold transition-all active:scale-[0.98]"
          >
            {groupModalMode === 'create' ? t('chat.newGroupChat') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
