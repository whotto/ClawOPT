import { useTranslation } from 'react-i18next';
import { useAccess } from '../access';
import { Edit2, RefreshCw, Share2, Trash2, X } from 'lucide-react';
import type { SidebarProps } from './Sidebar';
import { FavoriteButton } from './SidebarCards';
import type { SidebarFavoriteType } from './sidebarTypes';
import type { AgentEditorState } from './useAgentEditor';
import type { SessionActionsState } from './useSessionActions';
import type { useSidebarFavorites } from './useSidebarFavorites';

/** 智能体详情弹窗（只读），底部可导出、编辑、重置、删除。 */
export default function AgentInfoModal({
  sidebar,
  actions,
  editor,
  favorites,
}: {
  sidebar: SidebarProps;
  actions: SessionActionsState;
  editor: AgentEditorState;
  favorites: Pick<ReturnType<typeof useSidebarFavorites>, 'isFavorite' | 'toggleFavorite'>;
}) {
  const { t } = useTranslation();
  // 编辑 / 删除会改动或撤销 OpenClaw Agent、导出配置包在预设库里：都是管理员的入口。重置只清自己的会话，照常给。
  const { can } = useAccess();
  const canManageAgents = can('agents.manage');
  const canExportPack = can('settings.presets');
  const { availableModels, navigateTo } = sidebar;
  const { viewingSession, setIsInfoModalOpen, infoActiveTab, setInfoActiveTab, confirmResetSession, confirmDeleteSession } = actions;
  const { getRuntimeModeLabel, getEffectiveSystemPromptModeLabel, getEffectiveToolModeLabel, handleStartEdit } = editor;
  const renderFavoriteButton = (type: SidebarFavoriteType, id: string, className: string) => (
    <FavoriteButton type={type} id={id} className={className} favorites={favorites} />
  );
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsInfoModalOpen(false)}></div>
      <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-hidden relative z-10 animate-in fade-in zoom-in-95 duration-200 flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-xl font-bold text-gray-900 leading-tight truncate">
                  {viewingSession.name}
                </h3>
                {renderFavoriteButton(
                  'agents',
                  viewingSession.id,
                  'flex-shrink-0 p-1.5 rounded-lg text-blue-500 hover:bg-blue-50 hover:text-yellow-600 transition-all'
                )}
              </div>
            </div>
          </div>
          <button 
            onClick={() => setIsInfoModalOpen(false)}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div className="space-y-4">

            {/* ID + Name side by side */}
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.agentId')}</label>
                <p className="text-sm font-mono text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{viewingSession.agentId || viewingSession.id}</p>
              </div>
              <div className="flex-1">
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.agentName')}</label>
                <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{viewingSession.name}</p>
              </div>
            </div>

            {/* Model */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.independentModel')}</label>
              <div className="flex items-center gap-2 bg-gray-50 p-3 rounded-xl border border-gray-100 min-h-[46px]">
                <span className="text-sm font-mono text-gray-900">
                  {viewingSession.model ? (availableModels.find(m => m.id === viewingSession.model)?.alias || viewingSession.model) : t('sidebar.defaultModel')}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(() => {
                const runtimeMode = viewingSession.runtimeMode || viewingSession.runtime_mode;
                const systemPromptMode = viewingSession.systemPromptMode || viewingSession.system_prompt_mode;
                const toolMode = viewingSession.toolMode || viewingSession.tool_mode;

                return (
                  <>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.runtimeModeTitle')}</label>
                <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{getRuntimeModeLabel(runtimeMode)}</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.systemPromptModeTitle')}</label>
                <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{getEffectiveSystemPromptModeLabel(runtimeMode, systemPromptMode)}</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">{t('sidebar.toolModeTitle')}</label>
                <p className="text-sm text-gray-900 bg-gray-50 p-3 rounded-xl border border-gray-100">{getEffectiveToolModeLabel(runtimeMode, toolMode)}</p>
              </div>
                  </>
                );
              })()}
            </div>

            {/* 输出工作过程 - read-only */}
            <div className="flex items-center gap-4">
              <span className="text-sm font-semibold text-gray-700">{t('sidebar.outputProcess')}</span>
              {(() => {
                const isOn = !!(viewingSession.process_start_tag && viewingSession.process_end_tag);
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

            {/* MD Files tab+editor - read-only */}
            <div className="flex-1 flex flex-col min-h-0 border border-gray-100 rounded-2xl overflow-hidden bg-gray-50/30">
              <div className="flex p-1 bg-gray-100/50 gap-1 overflow-x-auto no-scrollbar">
                {[
                  { id: 'soul', name: t('sidebar.tabSoul'), content: viewingSession.soulContent },
                  { id: 'user', name: t('sidebar.tabUser'), content: viewingSession.userContent },
                  { id: 'agents', name: t('sidebar.tabAgents'), content: viewingSession.agentsContent },
                  { id: 'tools', name: t('sidebar.tabTools'), content: viewingSession.toolsContent },
                  { id: 'heartbeat', name: t('sidebar.tabHeartbeat'), content: viewingSession.heartbeatContent },
                  { id: 'identity', name: t('sidebar.tabIdentity'), content: viewingSession.identityContent },
                ].map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setInfoActiveTab(tab.id as any)}
                    className={`flex-none px-3 py-1.5 text-sm rounded-lg transition-all whitespace-nowrap border border-gray-200 ${infoActiveTab === tab.id ? 'bg-white text-blue-600 font-bold' : 'font-normal text-gray-500 hover:text-gray-700 hover:bg-white/50'}`}
                  >
                    {tab.name}
                  </button>
                ))}
              </div>
              <div className="p-4 h-36 overflow-y-auto bg-white">
                {(() => {
                  const tabs = {
                    soul: viewingSession.soulContent,
                    user: viewingSession.userContent,
                    agents: viewingSession.agentsContent,
                    tools: viewingSession.toolsContent,
                    heartbeat: viewingSession.heartbeatContent,
                    identity: viewingSession.identityContent,
                  };
                  const content = tabs[infoActiveTab as keyof typeof tabs] || '';
                  return (
                    <pre className="text-[13px] font-mono text-gray-800 leading-relaxed whitespace-pre-wrap">
                      {content || <span className="text-gray-400">{t('sidebar.noItems')}</span>}
                    </pre>
                  );
                })()}
              </div>
            </div>

          </div>

        </div>
        <div className="p-6 border-t border-gray-100 bg-gray-50/50 flex gap-3">
          <button
            type="button"
            onClick={() => setIsInfoModalOpen(false)}
            className="flex-1 flex items-center justify-center px-4 py-2.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-xl font-bold transition-all"
          >
            {t('common.close')}
          </button>
          {canExportPack && <button
            onClick={() => {
              try {
                localStorage.setItem('clawopt_pack_export', JSON.stringify({ kind: 'agent', id: viewingSession.id, name: viewingSession.name }));
              } catch { /* 隐私模式下 localStorage 不可用，退化成不预选 */ }
              setIsInfoModalOpen(false);
              navigateTo('settings', 'presets', false);
            }}
            className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 rounded-xl font-bold transition-all"
          >
            <Share2 className="hidden sm:block w-4 h-4" />
            {t('sidebar.exportPack')}
          </button>}
          {canManageAgents && <button
            onClick={() => handleStartEdit(null, viewingSession)}
            className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-white border border-blue-200 text-blue-600 hover:bg-blue-50 hover:border-blue-300 rounded-xl font-bold transition-all"
          >
            <Edit2 className="hidden sm:block w-4 h-4" />
            {t('common.edit')}
          </button>}
          <button
            onClick={(e) => { setIsInfoModalOpen(false); confirmResetSession(e, viewingSession.id); }}
            className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-orange-50 text-orange-600 border border-orange-100 hover:bg-orange-100 hover:border-orange-200 rounded-xl font-bold transition-all"
          >
            <RefreshCw className="hidden sm:block w-4 h-4" />
            {t('common.reset')}
          </button>
          {canManageAgents && <button
            onClick={(e) => { setIsInfoModalOpen(false); confirmDeleteSession(e, viewingSession.id); }}
            disabled={viewingSession.id === 'main' || viewingSession.agentId === 'main'}
            className="flex-1 flex items-center justify-center sm:gap-2 px-4 py-2.5 bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 hover:border-red-200 rounded-xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 className="hidden sm:block w-4 h-4" />
            {t('common.delete')}
          </button>}
        </div>
      </div>
    </div>
  );
}
