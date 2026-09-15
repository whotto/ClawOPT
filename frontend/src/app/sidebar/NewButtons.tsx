import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useAccess } from '../access';
import type { AgentEditorState } from './useAgentEditor';
import type { GroupEditorState } from './useGroupEditor';

/** 「+ 新建 智能体 / 工作群」按钮组：重置对应表单并打开弹窗。 */
export default function NewButtons({ editor, groupEditor }: { editor: AgentEditorState; groupEditor: GroupEditorState }) {
  const { t } = useTranslation();
  // 新建 Agent 会装配 OpenClaw Agent，是管理员的事；member 只能用自己的 Agent 建群。
  const canCreateAgent = useAccess().can('agents.manage');
  const { syncGlobalFallbackEnabled, setModalMode, setEditingSessionId, setSubmitError, setNewSessionData, setIsModalOpen } = editor;
  const {
    setGroupModalMode, setEditingGroupId, setNewGroupId, setNewGroupName, setNewGroupDesc, setNewGroupSystemPrompt,
    setNewProcessStartTag, setNewProcessEndTag, setNewMaxChainDepth, setSelectedGroupMembers, setGroupSubmitError, setShowGroupDialog,
  } = groupEditor;
  return (
    <div className="px-4 pb-3">
      <div className="flex items-center">
        <span className="flex items-center gap-1 text-sm text-gray-500 flex-shrink-0 mr-2">
          <Plus className="w-4 h-4" />
          {t('sidebar.newBtn')}
        </span>
        <div className="group flex flex-1 border border-gray-300 rounded-xl overflow-hidden bg-white transition-colors hover:border-orange-300">
          {canCreateAgent && <button
            onClick={async () => {
              await syncGlobalFallbackEnabled();
              setModalMode('create');
              setEditingSessionId(null);
              setSubmitError(null);
              setNewSessionData({ 
                id: '', 
                name: '', 
                model: '', 
                runtimeMode: 'configured',
                systemPromptMode: 'system',
                toolMode: 'full',
                runtimeMetrics: null,
                fallbackMode: 'disabled',
                fallbacks: [],
                process_start_tag: '',
                process_end_tag: '',
                soulContent: '', 
                userContent: '', 
                agentsContent: '', 
                toolsContent: '', 
                heartbeatContent: '', 
                identityContent: '' 
              });
              setIsModalOpen(true);
            }}
            className="flex-1 py-2 px-3 text-gray-600 hover:bg-amber-50 hover:text-gray-900 hover:font-semibold transition-colors font-normal text-sm active:scale-95 text-center border-r border-gray-300 hover:border-orange-300 group-hover:border-orange-300"
          >
            {t('sidebar.agentGroup')}
          </button>}
          <button
            onClick={() => {
              setGroupModalMode('create');
              setEditingGroupId(null);
              setNewGroupId('');
              setNewGroupName('');
              setNewGroupDesc('');
              setNewGroupSystemPrompt('');
              setNewProcessStartTag('');
              setNewProcessEndTag('');
              setNewMaxChainDepth(6);
              setSelectedGroupMembers([]);
              setGroupSubmitError(null);
              setShowGroupDialog(true);
            }}
            className="flex-1 py-2 px-3 text-gray-600 hover:bg-amber-50 hover:text-gray-900 hover:font-semibold transition-colors font-normal text-sm active:scale-95 text-center hover:border-orange-300"
          >
            {t('sidebar.workGroup')}
          </button>
        </div>
      </div>
    </div>
  );
}
