// 消息滚动区：骨架屏、日期徽标 / 空状态与消息气泡列表。isLatest 等传给气泡的属性与拆分前逐字一致。
import { Users } from 'lucide-react';
import { Fragment } from 'react';
import { MessageBubble } from '../message';
import { WorkspaceChangeCard } from '../workspace/WorkspaceChangeCard';
import { ToolRunSummaryCard } from './ToolRunSummaryCard';
import { TaskPlanCard } from './TaskPlanCard';
import { GROUP_MAX_CHAIN_DEPTH_MESSAGE_CODE } from '../lib/constants';
import { resolveStructuredMessageContent } from '../lib/messageMapping';
import { resolveProcessTagPair } from '../lib/processTags';
import { getAgentColor } from '../lib/agentColors';
import { MessageListSkeleton, HistoryLoadMoreSkeleton } from './HistorySkeletons';
import type { ChatController } from '../hooks/useChatController';

type MessageListProps = Pick<
  ChatController,
  'props' | 't' | 'sessions' | 'isChat' | 'isGroup' | 'activeKey' | 'messages' | 'isLoading' |
  'editingMessageId' | 'setEditingMessageId' | 'editContent' | 'setEditContent' |
  'editExistingAttachments' | 'setEditExistingAttachments' | 'editPendingFiles' |
  'setEditPendingFiles' | 'editIsDragging' | 'copiedId' | 'setPreviewFile' | 'activeHighlightId' |
  'debouncedMessageSearchQuery' | 'matchedMessageIdSet' | 'currentModel' | 'characters' |
  'messagesEndRef' | 'scrollContainerRef' | 'currentGroup' | 'currentSession' |
  'activeSessionName' | 'findSessionByAgentId' | 'visibleMessages' | 'isGroupBusy' |
  'formatMessageDate' | 'handleCopy' | 'resetEditComposer' | 'handleQuote' | 'handleDeleteMessage' |
  'handleSaveEdit' | 'handleRegenerate' | 'workspaceChangesByMessage' | 'openWorkspaceChange' | 'toolTracesByMessage' | 'taskPlansByMessage'
> & { showMessageListSkeleton: boolean; showOlderHistorySkeleton: boolean };

export function MessageList(c: MessageListProps) {
  const {
    props, t, sessions, isChat, isGroup, activeKey, messages, isLoading, editingMessageId,
    setEditingMessageId, editContent, setEditContent, editExistingAttachments,
    setEditExistingAttachments, editPendingFiles, setEditPendingFiles, editIsDragging, copiedId,
    setPreviewFile, activeHighlightId, debouncedMessageSearchQuery, matchedMessageIdSet,
    currentModel, characters, messagesEndRef, scrollContainerRef, currentGroup, currentSession,
    activeSessionName, findSessionByAgentId, visibleMessages, isGroupBusy, formatMessageDate,
    handleCopy, resetEditComposer, handleQuote, handleDeleteMessage, handleSaveEdit,
    handleRegenerate, showMessageListSkeleton, showOlderHistorySkeleton, workspaceChangesByMessage, openWorkspaceChange, toolTracesByMessage, taskPlansByMessage,
  } = c;
  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:px-8 sm:py-4 space-y-6 bg-white pb-0 relative">
      {showMessageListSkeleton ? (
        <MessageListSkeleton />
      ) : (
        <>
          {showOlderHistorySkeleton && <HistoryLoadMoreSkeleton />}

          {/* Date badge / empty state */}
          {isChat && (
            <div className="flex justify-center mb-8">
              <span className="px-4 py-1.5 bg-[#eff1f4] text-gray-500 text-[11px] rounded-full">
                {messages.length > 0 ? formatMessageDate(messages[0].timestamp) : t('unifiedChat.startConversation')}
              </span>
            </div>
          )}
          {isGroup && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-64 text-gray-400">
              <Users className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm font-medium">{t('unifiedChat.firstGroupMessageTitle')}</p>
              <p className="text-xs mt-1">{t('unifiedChat.firstGroupMessageDescription')}</p>
            </div>
          )}

          {/* Messages */}
          {visibleMessages.map((msg, index) => {
            const lastUserMsgId = [...visibleMessages].reverse().find(m => m.role === 'user')?.id ?? null;
            const isHighlighted = activeHighlightId === msg.id;
            const prevMsg = index > 0 ? visibleMessages[index - 1] : null;
            const showDateDivider = prevMsg ? msg.timestamp.toDateString() !== prevMsg.timestamp.toDateString() : false;

            // Model display
            let modelDisplayName: string | undefined;
            let agentName: string | undefined;
            let avatarUrl: string | undefined;
            let avatarChar: string | undefined;
            let avatarColorClass: string | undefined;

            if (isChat) {
              const session = sessions.find(s => s.id === activeKey);
              const character = characters.find(c => c.id === session?.characterId);
              const modelId = msg.model || session?.model || character?.model || currentModel;
              const modelInfo = props.availableModels?.find(m => m.id === modelId);
              // 外部运行时单聊：标签是「运行时 · 模式」，不是 OpenClaw 的模型名（流式中途消息还没有 model_used）。
              const externalRuntime = (session as { externalRuntime?: string } | undefined)?.externalRuntime;
              const externalMode = (session as { externalConfig?: { mode?: string } } | undefined)?.externalConfig?.mode === 'scoped' ? 'scoped' : 'global';
              modelDisplayName = externalRuntime
                ? t('externalAgent.badge', { runtime: t(`externalAgent.runtimeName.${externalRuntime}`, { defaultValue: externalRuntime }), mode: t(`groupRuntime.mode_${externalMode}`) })
                : modelInfo?.alias || modelId || 'OpenClaw';
              agentName = msg.agentName || activeSessionName;
              avatarUrl = '/ai-robot.jpg';
            } else {
              const isUser = msg.role === 'user';
              const isSystem = msg.role === 'system';
              const agentSession = (!isUser && !isSystem) ? findSessionByAgentId(msg.agentId) : null;

              const modelId = msg.model || agentSession?.model;

              if (modelId) {
                const modelInfo = props.availableModels?.find(m => m.id === modelId);
                modelDisplayName = modelInfo?.alias || modelId;
              } else {
                modelDisplayName = undefined;
              }

              agentName = msg.agentName;
              if (!isUser && !isSystem) {
                avatarChar = (msg.agentName || '?')[0];
                avatarColorClass = currentGroup ? getAgentColor(msg.agentId || '', currentGroup.members) : undefined;
              }
            }

            const resolvedContent = msg.role === 'system'
              ? resolveStructuredMessageContent(msg, t)
              : msg.content;

            if (msg.role === 'system' && msg.messageCode === GROUP_MAX_CHAIN_DEPTH_MESSAGE_CODE) {
              return (
                <div key={msg.id} className="flex justify-center my-6 relative w-full items-center">
                  <div className="absolute inset-0 flex items-center px-4 md:px-8" aria-hidden="true">
                    <div className="w-full border-t border-gray-200"></div>
                  </div>
                  <div className="flex justify-center relative">
                    <span className="px-4 py-1.5 bg-[#eff1f4] text-gray-500 text-[11px] rounded-full z-10">
                      {resolvedContent}
                    </span>
                  </div>
                </div>
              );
            }

            const resolvedProcessTags = isGroup
              ? resolveProcessTagPair(
                  currentGroup?.process_start_tag,
                  currentGroup?.process_end_tag,
                  findSessionByAgentId(msg.agentId)?.process_start_tag,
                  findSessionByAgentId(msg.agentId)?.process_end_tag,
                )
              : resolveProcessTagPair(
                  currentSession?.process_start_tag,
                  currentSession?.process_end_tag,
                );

            const workspaceChanges = isChat && msg.role === 'assistant' ? workspaceChangesByMessage.get(msg.id) : undefined;
            const toolTraces = isChat && msg.role !== 'user' ? toolTracesByMessage.get(msg.id) : undefined;
            const taskPlans = isChat && msg.role !== 'user' ? taskPlansByMessage.get(msg.id) : undefined;
            return (
              <Fragment key={msg.id}>
              <MessageBubble
                id={msg.id} role={msg.role} content={resolvedContent} timestamp={msg.timestamp}
                processContent={msg.processContent}
                processStreaming={msg.processStreaming}
                rawDetail={msg.rawDetail}
                interrupted={msg.interrupted}
                isHighlighted={isHighlighted} showDateDivider={showDateDivider}
                searchQuery={matchedMessageIdSet.has(msg.id) ? debouncedMessageSearchQuery : ''}
                agentName={agentName} modelDisplayName={modelDisplayName}
                avatarUrl={avatarUrl} avatarChar={avatarChar} avatarColorClass={avatarColorClass}
                onPreview={(url, filename) => setPreviewFile({url, filename})}
                isEditing={msg.id === editingMessageId} editContent={editContent}
                editIsDragging={editIsDragging} editExistingAttachments={editExistingAttachments as any} editPendingFiles={editPendingFiles as any}
                onSetEditIsDragging={undefined} onSetEditContent={setEditContent}
                onSetEditExistingAttachments={setEditExistingAttachments} onSetEditPendingFiles={setEditPendingFiles}
                onDropNewFiles={undefined}
                onEditClick={(attachments, text) => { setEditingMessageId(msg.id); setEditContent(text); setEditExistingAttachments(attachments); setEditPendingFiles([]); }}
                onCancelEdit={resetEditComposer}
                onSaveEdit={handleSaveEdit}
                onRegenerate={() => handleRegenerate(msg)}
                onQuote={() => handleQuote(msg)}
                onCopy={(content, id) => handleCopy(content, id as string)}
                onDelete={() => handleDeleteMessage(msg.id)}
                isCopied={copiedId === msg.id}
                activeCopiedId={copiedId}
                isLoading={isLoading || isGroupBusy}
                processStartTag={resolvedProcessTags.startTag}
                processEndTag={resolvedProcessTags.endTag}
                isLatest={msg.role === 'user' ? msg.id === lastUserMsgId : index === visibleMessages.length - 1}
                preserveProcessExpansionWhenNotLatest={isGroup && msg.role === 'assistant'}
              />
              {taskPlans && <TaskPlanCard plans={taskPlans} />}
              {toolTraces && <ToolRunSummaryCard sessionId={activeKey} runs={toolTraces} />}
              {workspaceChanges && <WorkspaceChangeCard changes={workspaceChanges} onOpen={openWorkspaceChange} />}
              </Fragment>
            );
          })}
        </>
      )}



      <div ref={messagesEndRef} />
    </div>
  );
}
