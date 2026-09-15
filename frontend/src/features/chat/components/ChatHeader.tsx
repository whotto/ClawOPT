// 会话标题、连接 / 协作状态（群聊悬浮成员列表）与会话内搜索框。
import { Menu, X, Search, ChevronUp, ChevronDown } from 'lucide-react';
import { getAgentColor } from '../lib/agentColors';
import type { ChatController } from '../hooks/useChatController';
import { ConversationTitleBar } from '../../sessions/ConversationTitleBar';
import { useShellContext } from '../../../app/shellContext';

type ChatHeaderProps = Pick<
  ChatController,
  'props' | 't' | 'onMenuClick' | 'isChat' | 'isGroup' | 'isLoading' | 'showMobileSearch' |
  'setShowMobileSearch' | 'messageSearchQuery' | 'setMessageSearchQuery' | 'searchMatches' |
  'currentMatchIndex' | 'aiName' | 'currentGroup' | 'resolveGroupMemberDisplayName' |
  'activeProcessingAgents' | 'isGroupBusy' | 'handleNextSearch' | 'handlePrevSearch' |
  'activeKey' | 'currentSession' | 'sessions' | 'setSubmitError'
>;

export function ChatHeader(c: ChatHeaderProps) {
  const {
    props, t, onMenuClick, isChat, isGroup, isLoading, showMobileSearch, setShowMobileSearch,
    messageSearchQuery, setMessageSearchQuery, searchMatches, currentMatchIndex, aiName,
    currentGroup, resolveGroupMemberDisplayName, activeProcessingAgents, isGroupBusy,
    handleNextSearch, handlePrevSearch, activeKey, currentSession, sessions, setSubmitError,
  } = c;
  const shell = useShellContext();
  const headerTitle = isChat ? aiName : currentGroup?.name;
  const headerStatus = (() => {
    if (isChat) {
      if (!props.isConnected) return { text: t('common.disconnected'), color: 'text-red-500', dotColor: 'bg-red-500', pulse: false };
      if (isLoading) return { text: t('common.processing'), color: 'text-green-600', dotColor: 'bg-green-500', pulse: true };
      return { text: t('common.connected'), color: 'text-green-600', dotColor: 'bg-green-500', pulse: false };
    }
    if (isGroupBusy) return { text: t('common.processing'), color: 'text-green-600', dotColor: 'bg-green-500', pulse: true };
    return { text: t('unifiedChat.collaboratingCount', { count: currentGroup?.members.length ?? 0 }), color: 'text-green-600', dotColor: 'bg-green-500', pulse: false };
  })();

  return (
    <header className="h-14 px-4 sm:px-6 border-b border-gray-300 flex items-center justify-between flex-shrink-0 bg-white z-10 w-full relative">
      {!showMobileSearch && (
        <div className="flex items-center space-x-2 sm:space-x-3 flex-shrink-0">
          <button className="md:hidden text-gray-500 hover:text-gray-900 focus:outline-none pr-1" onClick={onMenuClick}><Menu className="w-6 h-6" /></button>
          <div className="flex items-center space-x-2 sm:space-x-3">
            <h1 className="text-[17px] sm:text-lg font-bold text-gray-900 leading-tight truncate">{headerTitle}</h1>
            <div className={`flex items-center gap-1 sm:gap-1.5 text-xs sm:text-sm group/badge cursor-default relative ${headerStatus.color}`}>
              <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${headerStatus.dotColor} ${headerStatus.pulse ? 'animate-pulse' : ''}`}></span>
              <span className={`font-medium ${headerStatus.pulse ? 'animate-pulse' : ''}`}>{headerStatus.text}</span>

              {/* TOOLTIP FOR GROUP CHAT */}
              {isGroup && currentGroup && (
                <div className="absolute top-full left-0 mt-3 bg-white w-64 rounded-2xl border border-gray-200 z-50 opacity-0 invisible group-hover/badge:opacity-100 group-hover/badge:visible transition-all animate-in fade-in slide-in-from-top-2 p-2">

                  <div className="flex flex-col gap-0.5">
                    {currentGroup.members.map(m => {
                      const memberDisplayName = resolveGroupMemberDisplayName(m);
                      const isWorking = activeProcessingAgents.includes(m.agent_id);
                      return (
                        <div key={m.agent_id} className="flex flex-row items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-gray-50/80 transition-colors">
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 border border-gray-200 ${getAgentColor(m.agent_id, currentGroup.members)}`}>
                            {memberDisplayName[0]}
                          </div>
                          <div className="flex flex-col min-w-0 flex-1">
                            <span className="text-sm font-normal text-gray-800 line-clamp-1 truncate leading-tight">{memberDisplayName}</span>
                          </div>
                          <div className={`text-xs font-normal tracking-wide w-fit px-2 py-0.5 rounded-md flex gap-1.5 items-center flex-shrink-0 border ${isWorking ? 'text-green-600 bg-green-50 border-green-100' : 'text-gray-400 bg-gray-50 border-gray-100/50'}`}>
                            {isWorking && <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse"></span>}
                            {isWorking ? t('common.processing') : t('common.idle')}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            {isChat && activeKey && (
              <ConversationTitleBar
                sessionId={activeKey}
                externalRuntime={(currentSession as { externalRuntime?: string } | null)?.externalRuntime ?? null}
                sessionName={(id) => sessions.find((s) => s.id === id)?.name ?? null}
                isLoading={isLoading}
                onForked={() => shell.reloadSessions()}
                onError={(message) => setSubmitError(message)}
              />
            )}
          </div>
        </div>
      )}
      {!showMobileSearch && (
        <button className="md:hidden p-2 text-gray-500 hover:text-gray-900 ml-auto" onClick={() => setShowMobileSearch(true)}><Search className="w-5 h-5" /></button>
      )}
      {/* Search bar */}
      <div className={`flex-1 max-w-sm ml-auto items-center justify-end md:pl-6 ${showMobileSearch ? 'flex w-full' : 'hidden md:flex'}`}>
        <div className="relative w-full group flex items-center gap-1 sm:gap-2">
          {showMobileSearch && (
            <button onClick={() => { setShowMobileSearch(false); setMessageSearchQuery(''); }} className="md:hidden p-2 text-gray-500 hover:text-gray-700"><X className="w-5 h-5" /></button>
          )}
          <div className="relative w-full">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><Search className="h-4 w-4 text-gray-400 group-focus-within:text-blue-500 transition-colors" /></div>
            <input type="text" placeholder={isChat ? t('unifiedChat.searchCurrentConversation') : t('unifiedChat.searchGroupConversation')} value={messageSearchQuery} onChange={(e) => setMessageSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) handlePrevSearch(); else handleNextSearch(); } }}
              className="block w-full pl-9 pr-24 py-2 rounded-xl border border-gray-200 bg-gray-50 hover:border-gray-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm font-medium placeholder-gray-400" />
            {messageSearchQuery && (
              <div className="absolute inset-y-0 right-0 flex items-center pr-1.5 space-x-1">
                <span className="text-[11px] font-bold text-gray-400 px-1 border-r border-gray-200 mr-0.5">{searchMatches.length > 0 ? `${currentMatchIndex + 1}/${searchMatches.length}` : '0/0'}</span>
                <button onClick={handlePrevSearch} disabled={searchMatches.length === 0} className="p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 rounded-md disabled:opacity-30" title={t('unifiedChat.previousResult')}><ChevronUp className="w-4 h-4" /></button>
                <button onClick={handleNextSearch} disabled={searchMatches.length === 0} className="p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 rounded-md disabled:opacity-30" title={t('unifiedChat.nextResult')}><ChevronDown className="w-4 h-4" /></button>
                <button onClick={() => setMessageSearchQuery('')} className="p-1 mr-1 text-gray-400 hover:bg-red-50 hover:text-red-500 rounded-md ml-0.5"><X className="w-4 h-4" /></button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
