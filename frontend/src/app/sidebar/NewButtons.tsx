import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useAccess } from '../access';
import type { AgentEditorState } from './useAgentEditor';
import type { GroupEditorState } from './useGroupEditor';

/**
 * 打开「新建智能体」弹窗（重置表单）。侧栏按钮与 Ctrl/Cmd+N 快捷键共用这一处；能不能新建由调用方按 `agents.manage` 判。
 */
export async function openNewAgentEditor(editor: AgentEditorState): Promise<void> {
  const { syncGlobalFallbackEnabled, setModalMode, setEditingSessionId, setSubmitError, setNewSessionData, setIsModalOpen } = editor;
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
}

/** 「+ 新建 智能体 / 工作群」按钮组：重置对应表单并打开弹窗。 */
export default function NewButtons({ editor, groupEditor, onNewExternal }: { editor: AgentEditorState; groupEditor: GroupEditorState; onNewExternal?: () => void }) {
  const { t } = useTranslation();
  // 新建 Agent 会装配 OpenClaw Agent，是管理员的事；member 只能用自己的 Agent 建群。
  const canCreateAgent = useAccess().can('agents.manage');
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
            onClick={() => { void openNewAgentEditor(editor); }}
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
      {onNewExternal && canCreateAgent && (
        // 建外部运行时单聊（POST /api/sessions）是管理员的；member 用被授权的运行时（`ext:<运行时>`）已有的单聊。
        // 外部运行时单聊单独一行：三个按钮挤在 256px 的侧栏里会把「智能体」竖着折成三行。
        <div className="flex items-center mt-2">
          <span className="flex items-center gap-1 text-sm flex-shrink-0 mr-2 invisible" aria-hidden="true">
            <Plus className="w-4 h-4" />
            {t('sidebar.newBtn')}
          </span>
          <button
            onClick={onNewExternal}
            data-testid="new-external-agent"
            className="flex-1 py-1.5 px-3 text-gray-600 border border-dashed border-gray-300 rounded-xl bg-white hover:bg-amber-50 hover:text-gray-900 hover:border-orange-300 transition-colors text-sm active:scale-95 text-center"
          >
            {t('sidebar.externalAgent')}
          </button>
        </div>
      )}
    </div>
  );
}
