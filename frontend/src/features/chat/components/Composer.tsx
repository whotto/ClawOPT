// 输入区：错误提示、待发附件、@ 成员与快捷指令候选、引用预览、输入框与渲染预览、底部工具栏。
import { Plus, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { getFileIconInfo } from '../../../utils/fileUtils';
import { normalizeProcessBlocks, ProcessStepBlock } from '../message';
import {
  markdownRehypePlugins, markdownRemarkPlugins, normalizeMathMarkdown,
} from '../../../utils/markdownMath';
import { getAgentColor } from '../lib/agentColors';
import type { ChatController } from '../hooks/useChatController';
import { ContextUsageBadge } from './ContextUsageBadge';

type ComposerProps = Pick<
  ChatController,
  'handleFileChange' | 'removePendingFile' | 'handlePaste' | 'handleSubmit' | 'handleStop' |
  'handleGroupInputChange' | 'getFilteredMembers' | 'insertMention' | 'handleKeyDown' | 't' |
  'isChat' | 'isGroup' | 'input' | 'setInput' | 'isLoading' | 'submitError' | 'setSubmitError' |
  'submitNotice' | 'setSubmitNotice' |
  'inputPreview' | 'setInputPreview' | 'pendingFiles' | 'quotedMessage' | 'setQuotedMessage' |
  'showCommands' | 'setShowCommands' | 'slashCommands' | 'filteredCommands' | 'setFilteredCommands' |
  'commandIndex' | 'setCommandIndex' | 'showMentionPopup' | 'setShowMentionPopup' |
  'setMentionFilter' | 'mentionIndex' | 'setMentionIndex' | 'fileInputRef' | 'textareaRef' |
  'commandListRef' | 'currentGroup' | 'currentSession' | 'resolveGroupMemberDisplayName' |
  'hasDraftToSend' | 'isGroupBusy' | 'activeKey' | 'usageTick'
>;

export function Composer(c: ComposerProps) {
  const {
    handleFileChange, removePendingFile, handlePaste, handleSubmit, handleStop,
    handleGroupInputChange, getFilteredMembers, insertMention, handleKeyDown, t, isChat, isGroup,
    input, setInput, isLoading, submitError, setSubmitError, submitNotice, setSubmitNotice, inputPreview, setInputPreview,
    pendingFiles, quotedMessage, setQuotedMessage, showCommands, setShowCommands, slashCommands,
    filteredCommands, setFilteredCommands, commandIndex, setCommandIndex, showMentionPopup,
    setShowMentionPopup, setMentionFilter, mentionIndex, setMentionIndex, fileInputRef,
    textareaRef, commandListRef, currentGroup, currentSession, resolveGroupMemberDisplayName,
    hasDraftToSend, isGroupBusy, activeKey, usageTick,
  } = c;
  return (
    <div className="px-4 sm:px-6 pb-6 sm:pb-4 pt-2 flex-shrink-0 bg-white">
      <div className="max-w-5xl mx-auto flex flex-col gap-3">
        {/* 失败提示：发送、上传、历史加载共用这一处，可手动关闭 */}
        {submitError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <span className="flex-1 min-w-0 break-words">{submitError}</span>
            <button
              type="button"
              onClick={() => setSubmitError('')}
              className="shrink-0 text-red-400 hover:text-red-600"
              aria-label={t('common.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* 发送成功但要说明的情况（如 @ 了没有分配给自己的 Agent）：琥珀色，与失败提示区分，可手动关闭 */}
        {submitNotice && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            <span className="flex-1 min-w-0 break-words">{submitNotice}</span>
            <button
              type="button"
              onClick={() => setSubmitNotice('')}
              className="shrink-0 text-amber-400 hover:text-amber-600"
              aria-label={t('common.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Pending file previews */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-3 pb-2 animate-in slide-in-from-bottom-2 duration-300">
            {pendingFiles.map((pf, idx) => (
              <div key={idx} className={`relative group ${pf.preview ? 'w-24 h-24' : 'w-max min-w-[120px] max-w-[200px] h-14 pl-2 pr-3 flex items-center gap-2'} rounded-xl overflow-hidden bg-white border border-gray-300 flex-shrink-0 transition-all hover:scale-[1.02] active:scale-95 hover:bg-blue-50/50 hover:border-blue-200`}>
                {pf.preview ? (
                  <img src={pf.preview} className="w-full h-full object-cover" alt="preview" />
                ) : (
                  (() => { const { Icon, typeText, bgColor } = getFileIconInfo(pf.file.name); return (
                    <>
                      <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0 text-white`}><Icon className="w-5 h-5 text-white" /></div>
                      <div className="flex flex-col min-w-0 pr-4">
                        <span className="text-[12px] font-semibold text-gray-700 truncate w-full">{pf.file.name}</span>
                        <span className="text-[10px] text-gray-400 capitalize">{typeText}</span>
                      </div>
                    </>
                  ); })()
                )}
                <button onClick={() => removePendingFile(idx)} className="absolute top-1.5 right-1.5 bg-black/60 hover:bg-red-500 text-white rounded-full p-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all border border-transparent hover:border-white/20">
                  <Plus className="w-3.5 h-3.5 rotate-45" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="relative">
          {/* Group mention popup */}
          {isGroup && showMentionPopup && (
            <div className="absolute bottom-full left-0 mb-2 w-64 bg-white rounded-xl border border-gray-200 py-1 z-50 overflow-hidden">
              <div className="px-3 py-1.5 text-xs font-bold text-gray-400 border-b border-gray-100">{t('unifiedChat.mentionMembersTitle')}</div>
              {getFilteredMembers().map((m, idx) => (
                <button key={m.agent_id} onClick={() => insertMention(resolveGroupMemberDisplayName(m))} onMouseEnter={() => setMentionIndex(idx)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${idx === mentionIndex ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'}`}>
                  <div className={`w-6 h-6 rounded-full ${getAgentColor(m.agent_id, currentGroup?.members || [])} flex items-center justify-center text-white text-xs font-bold`}>{resolveGroupMemberDisplayName(m)[0]}</div>
                  <span className="font-bold">{resolveGroupMemberDisplayName(m)}</span>
                </button>
              ))}
              {getFilteredMembers().length === 0 && <div className="px-3 py-2 text-sm text-gray-400">{t('unifiedChat.noMatchingMembers')}</div>}
            </div>
          )}

          <form onSubmit={handleSubmit} className="relative flex flex-col border border-gray-200 rounded-2xl bg-white overflow-visible hover:border-gray-300 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 transition-all">
            {/* Quote preview */}
            {quotedMessage && (
              <div className="mx-4 mt-3 mb-1 px-3 py-2 bg-gray-100 rounded-lg relative group flex items-start justify-between animate-in fade-in slide-in-from-bottom-2">
                <div className="flex-1 min-w-0 pr-4">
                  <span className="text-[11px] font-bold text-gray-500 mb-0.5 block tracking-wider">{t('unifiedChat.quotedContent')}</span>
                  <div className="max-h-28 overflow-hidden prose prose-sm max-w-none prose-slate text-[13px] text-gray-700 break-words">
                    {(() => {
                      const processStart = (isGroup ? currentGroup?.process_start_tag : currentSession?.process_start_tag) || '[执行工作_Start]';
                      const processEnd = (isGroup ? currentGroup?.process_end_tag : currentSession?.process_end_tag) || '[执行工作_End]';
                      const processed = normalizeProcessBlocks(quotedMessage.content, processStart, processEnd);
                      const previewComponents: any = {
                        pre({ children }: any) { return <>{children}</>; },
                        code({ node, inline, className, children, ...props }: any) {
                          const match = /language-([^\s]+)/.exec(className || '');
                          const codeText = children ? String(children).replace(/\n$/, '') : '';
                          if (!inline && match && (match[1] === 'process_step_thought' || match[1] === 'process_step_thought_streaming')) {
                            return (
                              <ProcessStepBlock
                                content={codeText.trim()}
                                initiallyExpanded={false}
                                isExtractingProcess={match[1] === 'process_step_thought_streaming'}
                                isDense
                              />
                            );
                          }
                          return <code className={className} {...props}>{children}</code>;
                        }
                      };
                      return (
                        <ReactMarkdown
                          remarkPlugins={markdownRemarkPlugins}
                          rehypePlugins={markdownRehypePlugins}
                          components={previewComponents}
                        >
                          {normalizeMathMarkdown(processed)}
                        </ReactMarkdown>
                      );
                    })()}
                  </div>
                </div>
                <button type="button" onClick={() => setQuotedMessage(null)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded-full hover:bg-gray-200 transition-all flex-shrink-0"><X className="w-4 h-4" /></button>
              </div>
            )}

            {/* Chat command suggestions */}
            {isChat && showCommands && filteredCommands.length > 0 && (
              <div ref={commandListRef} className="absolute bottom-full left-0 mb-4 w-72 bg-white rounded-2xl border border-gray-300 z-[100] py-2 overflow-hidden animate-in fade-in slide-in-from-bottom-2">
                <div className="px-4 py-2.5 text-sm font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100 mb-1 flex justify-between items-center">
                  <span>{t('slashCommands.title')}</span><span>{t('unifiedChat.resultsCount', { count: filteredCommands.length })}</span>
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {filteredCommands.map((cmd, idx) => (
                    <button key={cmd.id} type="button"
                      onClick={() => { setInput(cmd.command + ' '); setShowCommands(false); textareaRef.current?.focus(); }}
                      onMouseEnter={() => setCommandIndex(idx)}
                      className={`w-full text-left px-4 py-3 flex flex-col gap-0.5 transition-colors ${idx === commandIndex ? 'bg-blue-100' : 'hover:bg-gray-50'}`}>
                      <span className={`text-sm font-extrabold ${idx === commandIndex ? 'text-blue-600' : 'text-gray-900'}`}>{cmd.command}</span>
                      <div className="text-[13px] text-gray-500 truncate">{cmd.description}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="relative">
              <textarea ref={textareaRef} rows={1} value={input} onKeyDown={handleKeyDown} onPaste={handlePaste}
                onChange={isGroup ? handleGroupInputChange : (e) => setInput(e.target.value)}
                placeholder={isChat && isLoading ? t('chatQueue.placeholderWhileRunning') : t('unifiedChat.inputPlaceholder')} disabled={isLoading && !isChat}
                className={`w-full min-h-[44px] max-h-[200px] py-3 pl-5 pr-8 bg-transparent focus:outline-none text-[16px] font-medium placeholder:text-gray-400 resize-none overflow-y-auto leading-relaxed border-none scrollbar-hide ${inputPreview ? 'invisible' : ''}`} />
              {inputPreview && (
                <div
                  className="absolute inset-0 py-3 pl-5 pr-8 overflow-y-auto leading-relaxed text-[16px] font-medium prose prose-sm max-w-none prose-slate cursor-text"
                  onClick={() => { setInputPreview(false); setTimeout(() => textareaRef.current?.focus(), 0); }}
                >
                  {input.trim() ? (() => {
                    const processStart = (isGroup ? currentGroup?.process_start_tag : currentSession?.process_start_tag) || '[执行工作_Start]';
                    const processEnd = (isGroup ? currentGroup?.process_end_tag : currentSession?.process_end_tag) || '[执行工作_End]';
                    const processed = normalizeProcessBlocks(input, processStart, processEnd);
                    const previewComponents: any = {
                      pre({ children }: any) { return <>{children}</>; },
                      code({ node, inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        const codeText = children ? String(children).replace(/\n$/, '') : '';
                        if (!inline && match && (match[1] === 'process_step_thought' || match[1] === 'process_step_thought_streaming')) {
                          return <ProcessStepBlock content={codeText.trim()} initiallyExpanded={true} isExtractingProcess={match[1] === 'process_step_thought_streaming'} />;
                        }
                        return <code className={className} {...props}>{children}</code>;
                      }
                    };
                    return (
                      <ReactMarkdown
                        remarkPlugins={markdownRemarkPlugins}
                        rehypePlugins={markdownRehypePlugins}
                        components={previewComponents}
                      >
                        {normalizeMathMarkdown(processed)}
                      </ReactMarkdown>
                    );
                  })() : (
                    <span className="text-gray-400">{t('unifiedChat.inputPlaceholder')}</span>
                  )}
                </div>
              )}
            </div>

            {/* Bottom toolbar */}
            <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100">
              <div className="flex items-center gap-1">
                <input type="file" ref={fileInputRef} multiple className="hidden" onChange={(e) => handleFileChange(Array.from(e.target.files || []))} />
                <button type="button" onClick={() => fileInputRef.current?.click()} className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all">
                  <Plus className="w-5 h-5" />
                </button>
                {isChat && (
                  <button type="button" onClick={() => { if (showCommands) setShowCommands(false); else { setFilteredCommands(slashCommands); setCommandIndex(0); setShowCommands(true); } }}
                    className="h-9 px-2 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all font-bold text-base">/</button>
                )}
                {isGroup && (
                  <button type="button" onClick={() => {
                    const ta = textareaRef.current; if (ta) {
                      const pos = ta.selectionStart; setInput(input.substring(0, pos) + '@' + input.substring(pos));
                      setShowMentionPopup(true); setMentionFilter('');
                      setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = pos + 1; }, 0);
                    }
                  }} className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all font-bold text-lg">@</button>
                )}
                <button
                  type="button"
                  onClick={() => { setInputPreview(p => !p); if (inputPreview) setTimeout(() => textareaRef.current?.focus(), 0); }}
                  className={`h-9 px-2.5 flex items-center justify-center rounded-lg text-xs font-medium transition-all ${inputPreview ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                  title={inputPreview ? t('unifiedChat.switchToEdit') : t('unifiedChat.previewRender')}
                >
                  {inputPreview ? t('common.edit') : t('unifiedChat.preview')}
                </button>
              </div>
              {(isChat && isLoading) || (isGroup && isGroupBusy) ? (
                <div className="flex items-center gap-2">
                  {isChat && hasDraftToSend && (
                    <button type="submit" className="px-4 h-9 flex items-center justify-center rounded-lg transition-all font-bold text-sm bg-blue-600 text-white hover:bg-blue-700 active:scale-95" title={t('chatQueue.queueHint')}>
                      {t('chatQueue.queue')}
                    </button>
                  )}
                  <button type="button" onClick={handleStop} className="px-4 h-9 flex items-center gap-1.5 justify-center rounded-lg transition-all font-bold text-sm bg-red-100 text-red-600 hover:bg-red-200 active:scale-95">
                    <span className="w-3 h-3 rounded-sm bg-red-600 inline-block flex-shrink-0" />{t('common.stop')}
                  </button>
                </div>
              ) : (
                <button type="submit" disabled={!hasDraftToSend || isLoading || isGroupBusy}
                  className={`px-4 h-9 flex items-center justify-center rounded-lg transition-all font-bold text-sm ${hasDraftToSend && !isLoading && !isGroupBusy ? 'bg-blue-600 text-white hover:bg-blue-700 active:scale-95' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>
                  {isLoading ? t('common.sending') : t('common.send')}
                </button>
              )}
            </div>
          </form>
          {isChat && activeKey && (
            <div className="mt-1.5 flex justify-end px-1">
              <ContextUsageBadge sessionId={activeKey} refreshKey={usageTick} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
