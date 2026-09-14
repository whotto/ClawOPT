// 超过 800 行的原因：MessageBubbleInner 本身约 830 行，isLatest / 展开收起 / 流式状态与渲染在同一闭包里交织，按 P0「逐字搬迁、不改逻辑」不再往下拆。
import React from 'react';
import { Check, Copy, Trash2, RefreshCw, Quote, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
// PrismAsyncLight 按需加载语言包；Prism 全量版把所有语言打进主包。
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { normalizeLanguage } from '../../../i18n';
import { getFileIconInfo } from '../../../utils/fileUtils';
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeMathMarkdown } from '../../../utils/markdownMath';
import { FILE_ATTACHMENT_CARD_CLASS_NAME, LocalPathAttachmentGuard, FileAttachmentActions, QuoteBlock, EmbedPreviewCard } from './AttachmentCards';
import { AnimatedExecutingPlaceholder, ProcessStepBlock } from './ProcessStepBlock';
import { isHtmlAttachmentFile, parseStandaloneEmbedPreviews, extractSingleLocalPath, buildFileAttachmentFromPath, extractStandaloneFileLinks, extractPreviewableLinksAndText, parseAttachmentsFromContent } from './attachments';
import type { Attachment } from './attachments';
import { EXTERNAL_LINK_CLASS_NAME, normalizeNavigableHref } from './links';
import { isInlineMarkdownCodeNode, getMarkdownNodePlainText, buildCodeCopyId, getCodeLanguage, shouldRenderEmbeddedFilesAsMarkdown, normalizeMalformedFencedBlocks } from './markdownContent';
import { hasSearchMatchInProcessBlocks, sanitizeConfiguredProcessText, normalizeProcessBlocks } from './processContent';
import { highlightSearchNodes } from './searchHighlight';

export interface PendingFile {
  file: File;
  preview: string;
}

export interface MessageProps {
  id: string | number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  processContent?: string;
  processStreaming?: boolean;
  rawDetail?: string;
  timestamp: Date;
  isHighlighted?: boolean;
  searchQuery?: string;
  showDateDivider?: boolean;
  
  // Customization
  agentName?: string;
  modelDisplayName?: string;
  avatarUrl?: string;
  avatarChar?: string;
  avatarColorClass?: string;

  // Edit State
  isEditing?: boolean;
  editContent?: string;
  editIsDragging?: boolean;
  editExistingAttachments?: Attachment[];
  editPendingFiles?: PendingFile[];
  onSetEditIsDragging?: (isDragging: boolean) => void;
  onSetEditContent?: (content: string) => void;
  onSetEditExistingAttachments?: (setter: (prev: Attachment[]) => Attachment[] | Attachment[]) => void;
  onSetEditPendingFiles?: (setter: (prev: PendingFile[]) => PendingFile[] | PendingFile[]) => void;
  onDropNewFiles?: (files: File[]) => void;

  // Events
  onEditClick?: (attachments: Attachment[], text: string) => void;
  onCancelEdit?: () => void;
  onSaveEdit?: () => void;
  onRegenerate?: () => void;
  onQuote?: () => void;
  onCopy?: (content: string, id: string | number) => void;
  onDelete?: () => void;
  
  
  isCopied?: boolean;
  activeCopiedId?: string | null;
  isLoading?: boolean;
  onPreview?: (url: string, filename: string) => void;
  // Process Stream Rules
  processStartTag?: string;
  processEndTag?: string;

  isLatest?: boolean;
  preserveProcessExpansionWhenNotLatest?: boolean;
}

const MessageBubbleInner: React.FC<MessageProps> = ({
  id, role, content, processContent, processStreaming, rawDetail, timestamp, isHighlighted, searchQuery, showDateDivider,
  agentName, modelDisplayName, avatarUrl, avatarChar, avatarColorClass,
  isEditing, editContent, editIsDragging, editExistingAttachments, editPendingFiles,
  onSetEditIsDragging, onSetEditContent, onSetEditExistingAttachments, onDropNewFiles,
  onEditClick, onCancelEdit, onSaveEdit, onRegenerate, onQuote, onCopy, onDelete,
  isCopied, activeCopiedId, isLoading, onPreview, processStartTag, processEndTag, isLatest,
  preserveProcessExpansionWhenNotLatest
}) => {
  const { t, i18n } = useTranslation();
  const currentLocale = normalizeLanguage(i18n.resolvedLanguage || i18n.language);
  const normalizedSearchQuery = searchQuery?.trim() || '';
  const canAcceptEditFileDrop = Boolean(isEditing && onDropNewFiles && onSetEditIsDragging);
  const [isProcessManualToggle] = React.useState<boolean | null>(null);
  const [hasBeenLatestForProcess, setHasBeenLatestForProcess] = React.useState(
    Boolean(isLatest && preserveProcessExpansionWhenNotLatest)
  );

  React.useEffect(() => {
    if (preserveProcessExpansionWhenNotLatest && isLatest) {
      setHasBeenLatestForProcess(true);
    }
  }, [isLatest, preserveProcessExpansionWhenNotLatest]);

  const shouldKeepProcessExpanded = preserveProcessExpansionWhenNotLatest
    ? hasBeenLatestForProcess
    : !!isLatest;
  const explicitProcessContent = typeof processContent === 'string' ? processContent.trim() : '';
  const sanitizedExplicitProcessContent = sanitizeConfiguredProcessText(
    explicitProcessContent,
    processStartTag,
    processEndTag,
  );
  const shouldRenderExplicitProcessBlock = !!sanitizedExplicitProcessContent.content || !!processStreaming;
  const isProcessExpanded = isProcessManualToggle !== null ? isProcessManualToggle : shouldKeepProcessExpanded;
  const shouldAutoExpandProcessBlocks = Boolean(
    isHighlighted && hasSearchMatchInProcessBlocks(
      content,
      normalizedSearchQuery,
      processStartTag,
      processEndTag,
      sanitizedExplicitProcessContent.content,
    )
  );
  const renderMessageSearchHighlighted = (children: React.ReactNode, scope: string) => (
    highlightSearchNodes(children, normalizedSearchQuery, `${scope}-${id}`)
  );
  let displayContent = content;

  // Parse structural quotes first so process blocks inside quotes stay inside
  if (displayContent) {
    const quoteRegex = /\[引用开始(?:[ \t]+author="(.*?)")?(?:[ \t]+time="(.*?)")?\]([\s\S]*?)(?:\[引用结束\]|$)/g;
    displayContent = displayContent.replace(quoteRegex, (_match, author, time, inner, offset, fullString) => {
      const lastNewlineIdx = fullString.lastIndexOf('\n', offset);
      const lineStartIdx = lastNewlineIdx === -1 ? 0 : lastNewlineIdx + 1;
      const lineTextBeforeTag = fullString.substring(lineStartIdx, offset);
      const prefixMatch = lineTextBeforeTag.match(/^[ \t>]*/);
      const prefix = prefixMatch ? prefixMatch[0] : '';
      const hasTextBefore = lineTextBeforeTag.length > prefix.length;

      const meta = `${author || t('common.unknown')}|${time || ''}`;
      const leadingInsert = hasTextBefore ? `\n${prefix}` : ``;
      const trailingInsert = `\n${prefix}`;
      return `${leadingInsert}\`\`\`\`\`\`chat_quote\n${meta}\n${inner.trim()}\n${prefix}\`\`\`\`\`\`${trailingInsert}`;
    });
  }

  // Then handle process blocks that are OUTSIDE quotes (not inside chat_quote blocks)
  if (!shouldRenderExplicitProcessBlock && processStartTag && processEndTag && displayContent) {
    // Split content by chat_quote blocks to avoid extracting process blocks from inside quotes
    const quoteBlockRegex = /``````chat_quote[\s\S]*?``````/g;
    const quoteBlocks: string[] = [];
    let contentWithPlaceholders = displayContent.replace(quoteBlockRegex, (match) => {
      const placeholder = `__QUOTE_BLOCK_${quoteBlocks.length}__`;
      quoteBlocks.push(match);
      return placeholder;
    });

    const normalizedContent = normalizeProcessBlocks(contentWithPlaceholders, processStartTag, processEndTag);

    if (normalizedContent !== contentWithPlaceholders) {
      contentWithPlaceholders = normalizedContent;
    }

    // Restore quote blocks
    quoteBlocks.forEach((block, i) => {
      contentWithPlaceholders = contentWithPlaceholders.replace(`__QUOTE_BLOCK_${i}__`, block);
    });

    displayContent = contentWithPlaceholders;
  }

  displayContent = normalizeMalformedFencedBlocks(displayContent);
  const trailingProcessPlaceholder = sanitizeConfiguredProcessText(
    displayContent,
    processStartTag,
    processEndTag,
  );
  displayContent = trailingProcessPlaceholder.content;
  const shouldRenderExecutingPlaceholder = role === 'assistant'
    && trailingProcessPlaceholder.hasTrailingPlaceholder
    && (!!isLatest || !!processStreaming);

  const renderFileAttachmentCards = (attachments: Attachment[], keyPrefix: string) => (
    <div className="flex flex-wrap gap-2 mb-3">
      {attachments.map((att, index) => (
        <LocalPathAttachmentGuard
          key={`${keyPrefix}-${index}`}
          attachment={att}
          fallback={att.localPath ? (
            <div className="max-w-full">
              <div
                dir="ltr"
                title={att.localPath}
                className="max-w-full whitespace-pre-wrap break-all font-mono text-[14px] leading-6 text-gray-700"
              >
                {renderMessageSearchHighlighted(att.localPath, `attachment-path-${index}`)}
              </div>
            </div>
          ) : null}
        >
          {att.isImage ? (
            <a
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              className="relative cursor-pointer rounded-xl border border-gray-300 bg-white p-1 hover:bg-[#fffdf0] hover:border-orange-300 transition-all flex items-center justify-center"
              onClick={(event) => {
                if (onPreview) {
                  event.preventDefault();
                  onPreview(att.url, att.name);
                }
              }}
              title={t('common.previewImage')}
            >
              <img src={att.url} alt={att.name} className="w-20 h-20 object-cover rounded-lg" />
            </a>
          ) : (
            (() => {
              const fileName = att.name || t('common.file');
              const isHtmlFile = isHtmlAttachmentFile(fileName, att.url);
              const { Icon, typeText, bgColor } = getFileIconInfo(fileName);
              return (
                <div className={FILE_ATTACHMENT_CARD_CLASS_NAME}>
                  <div
                    className="flex items-center gap-3 p-2.5 rounded-xl border border-gray-300 bg-white hover:bg-[#fffdf0] hover:border-orange-300 cursor-pointer transition-all w-full"
                    onClick={(event) => {
                      if (onPreview) {
                        event.preventDefault();
                        onPreview(att.url, fileName);
                      } else {
                        window.open(att.url, '_blank');
                      }
                    }}
                  >
                    <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0 border border-gray-100`}>
                      <Icon className="w-5 h-5 text-white" />
                    </div>
                    <div className={`flex flex-col min-w-0 ${isHtmlFile ? 'pr-20' : 'pr-12'} w-full relative`}>
                      <div className="text-[13px] font-bold text-gray-800 truncate transition-colors w-full leading-snug">
                        {fileName}
                      </div>
                      <span className="text-[11px] text-gray-400 font-medium mt-0.5">{typeText}</span>
                    </div>
                    <FileAttachmentActions url={att.url} filename={fileName} />
                  </div>
                </div>
              );
            })()
          )}
        </LocalPathAttachmentGuard>
      ))}
    </div>
  );

  return (
    <div key={id}>
      {showDateDivider && (
        <div className="flex items-center justify-center my-8 gap-4">
          <div className="h-px bg-gray-100 flex-1"></div>
          <span className="px-4 py-1.5 bg-[#eff1f4] text-gray-500 text-[11px] rounded-full">
            {timestamp.toLocaleDateString(currentLocale, { year: 'numeric', month: 'long', day: 'numeric' })}
          </span>
          <div className="h-px bg-gray-100 flex-1"></div>
        </div>
      )}
	      
	      {role === 'system' && (
	        <div data-msg-id={id} className={`flex justify-center transition-all duration-500 ${isHighlighted ? 'ring-4 ring-blue-500/20 bg-[#eff6ff] px-4 py-2 rounded-2xl' : ''}`}>
	          <div className={`text-xs text-gray-500 bg-gray-100 px-3 py-1.5 border border-gray-200 ${rawDetail ? 'rounded-2xl max-w-xl w-full' : 'rounded-full'}`}>
              <div>{highlightSearchNodes(content, normalizedSearchQuery, `system-${id}`)}</div>
              {rawDetail && (
                <div className="mt-2 pt-2 border-t border-gray-200 text-[11px] text-gray-400 whitespace-pre-wrap break-all font-mono">
                  {rawDetail}
                </div>
              )}
            </div>
	        </div>
	      )}

      {role !== 'system' && (
      <div data-msg-id={id} {...(role === 'user' ? {'data-user-msg-id': id} : {})} className={`flex w-full mb-6 transition-all duration-500 group/msg ${isHighlighted ? 'ring-4 ring-blue-500/20 bg-[#eff6ff] -mx-4 px-4 py-2 rounded-2xl' : ''} ${role === 'user' ? 'justify-end' : 'flex-col justify-start items-start'}`}>
        <div className={`flex flex-col min-w-0 ${isEditing ? 'w-full' : (role === 'user' ? 'items-end max-w-[85%]' : 'items-start flex-1 w-full')}`}>
          
          {role === 'assistant' && (
            <div className="flex items-center gap-3 mb-4 flex-wrap w-full">
              {avatarUrl ? (
                <img src={avatarUrl} alt={t('common.ai')} className="w-8 h-8 rounded-full border border-gray-200 object-cover bg-gray-50 flex-shrink-0" />
              ) : avatarChar ? (
                <div className={`w-8 h-8 rounded-full ${avatarColorClass || 'bg-blue-500'} border border-gray-200 flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
                  {avatarChar}
                </div>
              ) : (
                <div className="w-8 h-8 rounded-full border border-gray-200 object-cover bg-gray-50 flex-shrink-0" />
              )}
              <div className="flex items-end gap-2 flex-wrap min-w-0">
                <span className="text-[17px] font-bold text-gray-900 leading-none">{agentName || t('common.ai')}</span>
                {modelDisplayName && (
                  <span className="self-end text-gray-500 text-[12px] leading-none tracking-tight ml-1">
                    {modelDisplayName}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className={`group relative text-[16px] leading-[1.6] transition-all duration-300 w-full ${
            role === 'user' 
              ? `text-[#1f2937] border ${isEditing ? 'p-1' : 'px-5 py-3'} rounded-[20px] rounded-tr-[4px] ${isHighlighted ? 'bg-[#f7fbff] border-blue-300' : 'bg-gray-50 border-gray-200'}`
              : `text-[#1f2937] border-none p-0 bg-transparent`
          }`}>
            {isEditing ? (
              <div 
                className={`flex flex-col gap-0 w-full bg-white rounded-2xl border-2 transition-colors overflow-hidden ${canAcceptEditFileDrop && editIsDragging ? 'border-blue-400 bg-blue-50/30' : 'border-blue-200'}`}
                onDragOver={canAcceptEditFileDrop ? (e => { e.preventDefault(); onSetEditIsDragging?.(true); }) : undefined}
                onDragLeave={canAcceptEditFileDrop ? (e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onSetEditIsDragging?.(false); }) : undefined}
                onDrop={canAcceptEditFileDrop ? (e => {
                  e.preventDefault();
                  onSetEditIsDragging?.(false);
                  const files = Array.from(e.dataTransfer.files);
                  if (!files.length) return;
                  onDropNewFiles?.(files);
                }) : undefined}
              >
                {/* File previews row (existing + new) */}
                {((editExistingAttachments?.length || 0) > 0 || (editPendingFiles?.length || 0) > 0) && (
                  <div className="flex flex-wrap gap-2 p-3 pb-0 animate-in fade-in">
                    {/* Existing attachments */}
                    {editExistingAttachments?.map((att, idx) => (
                      <div key={`existing-${idx}`} className={`relative group ${ att.isImage ? 'w-20 h-20' : 'w-max min-w-[100px] max-w-[180px] h-12 pl-2 pr-3 flex items-center gap-2' } rounded-xl overflow-hidden bg-white border border-gray-300 flex-shrink-0 hover:border-red-200 transition-all`}>
                        {att.isImage ? (
                          <img src={att.url} className="w-full h-full object-cover" alt={att.name} />
                        ) : (() => {
                          const { Icon, typeText, bgColor } = getFileIconInfo(att.name);
                          return (
                            <>
                              <div className={`w-8 h-8 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0`}>
                                <Icon className="w-4 h-4 text-white" />
                              </div>
                              <div className="flex flex-col min-w-0 pr-3">
                                <span className="text-[11px] font-semibold text-gray-700 truncate w-full">{att.name}</span>
                                <span className="text-[10px] text-gray-400">{typeText}</span>
                              </div>
                            </>
                          );
                        })()}
                        <button
                          type="button"
                          onClick={() => {
                            if (onSetEditExistingAttachments) {
                                onSetEditExistingAttachments(prev => prev.filter((_, i) => i !== idx));
                            }
                          }}
                          className="absolute top-1 right-1 bg-black/60 hover:bg-red-500 text-white rounded-full p-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {/* Newly added files */}
                    {editPendingFiles?.map((pf, idx) => (
                      <div key={`new-${idx}`} className={`relative group ${ pf.preview ? 'w-20 h-20' : 'w-max min-w-[100px] max-w-[180px] h-12 pl-2 pr-3 flex items-center gap-2' } rounded-xl overflow-hidden bg-white border border-gray-300 flex-shrink-0 hover:border-red-200 transition-all`}>
                        {pf.preview ? (
                          <img src={pf.preview} className="w-full h-full object-cover" alt="preview" />
                        ) : (() => {
                          const { Icon, typeText, bgColor } = getFileIconInfo(pf.file.name);
                          return (
                            <>
                              <div className={`w-8 h-8 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0`}>
                                <Icon className="w-4 h-4 text-white" />
                              </div>
                              <div className="flex flex-col min-w-0 pr-3">
                                <span className="text-[11px] font-semibold text-gray-700 truncate w-full">{pf.file.name.split('.')[0]}</span>
                                <span className="text-[10px] text-gray-400">{typeText}</span>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  className={`w-full min-h-[60px] resize-none outline-none border-none text-[16px] font-medium bg-transparent leading-relaxed ${((editExistingAttachments?.length || 0) > 0 || (editPendingFiles?.length || 0) > 0) ? 'p-3 pt-2' : 'p-3'}`}
                  value={editContent || ''}
                  onChange={e => onSetEditContent?.(e.target.value)}
                  autoFocus
                  onFocus={(e) => {
                    const val = e.target.value;
                    e.target.value = '';
                    e.target.value = val;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      onSaveEdit?.();
                    } else if (e.key === 'Escape') {
                      onCancelEdit?.();
                    }
                  }}
                  placeholder={t('messageBubble.editMessagePlaceholder')}
                />
                <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-gray-100 bg-gray-50/50">
                  <button
                    onClick={onCancelEdit}
                    className="inline-flex min-w-[72px] flex-shrink-0 items-center justify-center whitespace-nowrap px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 text-sm font-medium transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={onSaveEdit}
                    className="inline-flex min-w-[72px] flex-shrink-0 items-center justify-center whitespace-nowrap px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium transition-colors"
                  >
                    {t('common.send')}
                  </button>
                </div>
              </div>
            ) : (
              <div className={`prose prose-sm max-w-none prose-slate text-[16px] pb-1 ${role === 'user' ? 'prose-pre:bg-gray-50' : (isHighlighted ? 'prose-pre:bg-[#f7fbff]' : 'prose-pre:bg-gray-50')}`}>
                {shouldRenderExplicitProcessBlock ? (
                  <ProcessStepBlock
                    content={explicitProcessContent}
                    initiallyExpanded={isProcessExpanded}
                    forceExpanded={shouldAutoExpandProcessBlocks}
                    searchQuery={normalizedSearchQuery}
                    isExtractingProcess={!!processStreaming}
                    onPreview={onPreview}
                    processStartTag={processStartTag}
                    processEndTag={processEndTag}
                  />
                ) : null}
                {/* Always show images/files at the top if there are any trailing attachments */}
                {(() => {
                  const { attachments } = parseAttachmentsFromContent(displayContent);
                  if (attachments.length > 0) {
                    return (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {attachments.map((att, i) =>
                          att.isImage ? (
                            <a href={att.url} target="_blank" rel="noopener noreferrer" key={i} 
                               className="relative cursor-pointer rounded-xl border border-gray-200 bg-white p-1 hover:bg-[#fffdf0] hover:border-orange-300 transition-all flex items-center justify-center"
                               onClick={(e) => {
                                  if (onPreview) { e.preventDefault(); onPreview(att.url, att.name); }
                               }}
                               title={t('common.previewImage')}
                            >
                              <img src={att.url} alt={att.name} className="w-20 h-20 object-cover rounded-lg" />
                            </a>
                          ) : (
                            (() => {
                              const fileName = att.name || t('common.file');
                              const isHtmlFile = isHtmlAttachmentFile(fileName, att.url);
                              const { Icon, typeText, bgColor } = getFileIconInfo(fileName);
                              return (
                                <div key={i} className={FILE_ATTACHMENT_CARD_CLASS_NAME}>
                                  <div className="flex items-center gap-3 p-2.5 rounded-xl border border-gray-200 bg-white hover:bg-[#fffdf0] hover:border-orange-300 cursor-pointer transition-all w-full"
                                       onClick={(e) => {
                                          if (onPreview) {
                                             e.preventDefault();
                                             onPreview(att.url, fileName);
                                          } else {
                                             window.open(att.url, '_blank');
                                          }
                                       }}>
                                    <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0 border border-gray-100`}>
                                      <Icon className="w-5 h-5 text-white" />
                                    </div>
                                    <div className={`flex flex-col min-w-0 ${isHtmlFile ? 'pr-20' : 'pr-12'} w-full relative`}>
                                      <div className="text-[13px] font-bold text-gray-800 truncate transition-colors w-full leading-snug">
                                        {fileName}
                                      </div>
                                      <span className="text-[11px] text-gray-400 font-medium mt-0.5">{typeText}</span>
                                    </div>
                                    <FileAttachmentActions url={att.url} filename={fileName} />
                                  </div>
                                </div>
                              );
                            })()
                          )
                        )}
                      </div>
                    );
                  }
                  return null;
                })()}

                {(() => {
                    const { text } = parseAttachmentsFromContent(displayContent);
                    const renderSearchHighlighted = (children: React.ReactNode, scope: string) => (
                      highlightSearchNodes(children, normalizedSearchQuery, `${scope}-${id}`)
                    );
                    const markdownComponents: any = {
                      pre({ node, children, ...props }: any) {
                        let isProcessStep = false;
                        let hasStandaloneFileLinks = false;
                        let hasMixedMarkdownFileLinks = false;
                        React.Children.forEach(children, (child: any) => {
                          if (child?.props?.className?.includes('language-process_step_thought')) {
                            isProcessStep = true;
                          }
                          const childText = child?.props?.children ? String(child.props.children).replace(/\n$/, '') : '';
                          if (extractStandaloneFileLinks(childText.trim()).length > 0) {
                            hasStandaloneFileLinks = true;
                          }
                          const childLanguage = getCodeLanguage(child?.props?.className);
                          const embeddedFiles = extractPreviewableLinksAndText(childText.trim());
                          if (
                            embeddedFiles.attachments.length > 0
                            && shouldRenderEmbeddedFilesAsMarkdown(childLanguage, embeddedFiles.text)
                          ) {
                            hasMixedMarkdownFileLinks = true;
                          }
                        });
                        if (isProcessStep) return <>{children}</>;
                        if (hasStandaloneFileLinks || hasMixedMarkdownFileLinks) return <>{children}</>;
                        return <pre {...props}>{children}</pre>;
                      },
                      code({ node, inline, className, children, ...props }: any) {
                        const codeLanguage = getCodeLanguage(className);
                        const codeText = children ? String(children).replace(/\n$/, '') : '';
                        const isInlineCode = typeof inline === 'boolean'
                          ? inline
                          : isInlineMarkdownCodeNode(node, className);
                        const inlineLinkHref = isInlineCode ? normalizeNavigableHref(codeText) : null;
                        const codeCopyId = !inline ? buildCodeCopyId(id, node, codeText) : '';
                        const isCodeCopied = !inline && activeCopiedId === codeCopyId;
                        const standaloneFileLinks = !inline ? extractStandaloneFileLinks(codeText.trim()) : [];
                        const embeddedFileLinks = !inline ? extractPreviewableLinksAndText(codeText.trim()) : { attachments: [], text: codeText };
                        const singleLocalPath = !inline ? extractSingleLocalPath(codeText) : null;
                        const singleFileAttachment = !inline && singleLocalPath ? buildFileAttachmentFromPath(codeText, singleLocalPath) : null;
                        if (!inline && singleFileAttachment) {
                          return renderFileAttachmentCards([singleFileAttachment], `code-path-file-${id}`);
                        }
                        if (!inline && singleLocalPath) {
                          return (
                            <div className="not-prose mb-4 max-w-full">
                              <div
                                dir="ltr"
                                title={singleLocalPath}
                                className="max-w-full whitespace-pre-wrap break-all font-mono text-[14px] leading-6 text-gray-700"
                              >
                                {renderSearchHighlighted(singleLocalPath, 'path-block')}
                              </div>
                            </div>
                          );
                        }
                        if (!inline && standaloneFileLinks.length > 0) {
                          return renderFileAttachmentCards(standaloneFileLinks, `code-file-${id}`);
                        }
                        if (
                          !inline
                          && embeddedFileLinks.attachments.length > 0
                          && shouldRenderEmbeddedFilesAsMarkdown(codeLanguage, embeddedFileLinks.text)
                        ) {
                          return (
                            <div className="mb-4">
                              {renderFileAttachmentCards(embeddedFileLinks.attachments, `code-file-mixed-${id}`)}
                              {embeddedFileLinks.text.trim() ? (
                                <div className="prose prose-sm max-w-none prose-slate text-[16px] pb-1">
                                  <ReactMarkdown
                                    remarkPlugins={markdownRemarkPlugins}
                                    rehypePlugins={markdownRehypePlugins}
                                    components={markdownComponents}
                                  >
                                    {normalizeMathMarkdown(embeddedFileLinks.text)}
                                  </ReactMarkdown>
                                </div>
                              ) : null}
                            </div>
                          );
                        }
                        if (!inline && (codeLanguage === 'process_step_thought' || codeLanguage === 'process_step_thought_streaming')) {
                           return (
                             <ProcessStepBlock
                               content={codeText.trim()}
                               initiallyExpanded={isProcessExpanded}
                               forceExpanded={shouldAutoExpandProcessBlocks}
                               searchQuery={normalizedSearchQuery}
                               isExtractingProcess={codeLanguage === 'process_step_thought_streaming'}
                               onPreview={onPreview}
                               processStartTag={processStartTag}
                               processEndTag={processEndTag}
                             />
                           );
                        }
                        if (!inline && codeLanguage === 'chat_quote') {
                           const lines = codeText.split('\n');
                           const meta = lines[0] || '';
                           const sepIdx = meta.indexOf('|');
                           const author = sepIdx !== -1 ? meta.slice(0, sepIdx) : t('common.unknown');
                           const time = sepIdx !== -1 ? meta.slice(sepIdx + 1) : '';
                           const quoteContent = normalizeMalformedFencedBlocks(
                             normalizeProcessBlocks(lines.slice(1).join('\n'), processStartTag, processEndTag)
                           );

                           const quoteMarkdownComponents = {
                             ...markdownComponents,
                             p(props: any) {
                               const nodes = props.node?.children || [];
                               const isAttachmentBlock = nodes.length > 0 && nodes.every(
                                 (child: any) =>
                                     (child.type === 'element' && child.tagName === 'img') ||
                                     (child.type === 'element' && child.tagName === 'a') ||
                                     (child.type === 'text' && child.value.trim() === '') ||
                                     (child.type === 'element' && child.tagName === 'br')
                               );

                               const attachmentCount = nodes.filter(
                                 (c: any) => c.type === 'element' && (c.tagName === 'img' || c.tagName === 'a')
                               ).length;

                               if (isAttachmentBlock && attachmentCount > 0) {
                                 return (
                                   <div className="flex flex-wrap gap-2 w-full items-start" style={{ marginTop: 0, marginBottom: '0.25rem' }}>
                                     {renderSearchHighlighted(props.children, 'quote-p-attachments')}
                                   </div>
                                 );
                               }
                               return (
                                 <p style={{ marginTop: 0, marginBottom: '0.25rem', wordBreak: 'break-word' }} {...props}>
                                   {renderSearchHighlighted(props.children, 'quote-p')}
                                 </p>
                               );
                             },
                             ol(props: any) {
                               return <ol style={{ marginTop: '0.125rem', marginBottom: '0.25rem', paddingLeft: 0, listStyle: 'none' }} {...props} />;
                             },
                             ul(props: any) {
                               return <ul style={{ marginTop: '0.125rem', marginBottom: '0.25rem', paddingLeft: 0, listStyle: 'none' }} {...props} />;
                             },
                             li(props: any) {
                               return (
                                 <li style={{ marginTop: 0, marginBottom: '0.25rem' }} {...props}>
                                   {renderSearchHighlighted(props.children, 'quote-li')}
                                 </li>
                               );
                             },
                             code(props: any) {
                               const innerMatch = /language-(\w+)/.exec(props.className || '');
                               const codeText = props.children ? String(props.children).replace(/\n$/, '') : '';
                               // Handle dense process step block inside quotes
                               if (!props.inline && innerMatch && (innerMatch[1] === 'process_step_thought' || innerMatch[1] === 'process_step_thought_streaming')) {
                                  return (
                                    <ProcessStepBlock
                                      content={codeText.trim()}
                                      initiallyExpanded={isProcessExpanded}
                                      forceExpanded={shouldAutoExpandProcessBlocks}
                                      searchQuery={normalizedSearchQuery}
                                      isExtractingProcess={innerMatch[1] === 'process_step_thought_streaming'}
                                      isDense
                                      onPreview={onPreview}
                                      processStartTag={processStartTag}
                                      processEndTag={processEndTag}
                                    />
                                  );
                               }
                               // Delegate normal code blocks logic back to main component
                               return markdownComponents.code(props);
                             }
                           };

                           return <QuoteBlock author={author} time={time} content={quoteContent} components={quoteMarkdownComponents} />;
                        }
                        if (isInlineCode && inlineLinkHref) {
                          return (
                            <a
                              href={inlineLinkHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`${EXTERNAL_LINK_CLASS_NAME} font-mono`}
                            >
                              {renderSearchHighlighted(codeText, 'inline-link')}
                            </a>
                          );
                        }
                        return !isInlineCode && codeLanguage ? (
                          <div className="relative group/code mt-4 mb-4 inline-block w-fit max-w-full align-top overflow-hidden rounded-xl border border-gray-300 bg-white transition-colors hover:bg-[#f3f5f8]">
                            <div className="absolute right-3 top-3 z-20">
                              <button
                                onClick={() => onCopy?.(codeText, codeCopyId)}
                                className={`p-1.5 rounded-md border cursor-pointer transition-colors flex items-center justify-center ${
                                  isCodeCopied === true
                                    ? 'opacity-100 '
                                    : 'opacity-0 group-hover/code:opacity-100 '
                                }${
                                  isCodeCopied === true
                                    ? 'bg-green-50 border-green-200 text-green-600 hover:bg-green-50 hover:border-green-200'
                                    : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600'
                                }`}
                                title={isCodeCopied === true ? t('common.copied') : t('common.copyCode')}
                              >
                                {isCodeCopied === true ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                              </button>
                            </div>
                            <SyntaxHighlighter
                              {...props}
                              style={oneLight as any}
                              language={codeLanguage}
                              PreTag="div"
                              codeTagProps={{
                                className: '!bg-transparent',
                                style: { backgroundColor: 'transparent' },
                              }}
                              className="!rounded-xl !text-[14px] !bg-[#f8f9fa] group-hover/code:!bg-[#f1f4f7] !p-5 !pr-14 !m-0 !max-w-full !overflow-x-auto transition-colors"
                            >
                              {codeText}
                            </SyntaxHighlighter>
                          </div>
                        ) : isInlineCode ? (
                          <code className="bg-[#f1f3f4] text-[#d93025] px-1.5 py-0.5 rounded font-mono text-[14px]" {...props}>
                            {children}
                          </code>
                        ) : (
                          <code className="bg-[#f1f3f4] text-[#d93025] px-1.5 py-0.5 rounded font-mono text-[14px]" {...props}>
                            {children}
                          </code>
                        );
                      },
                      img(props: any) {
                        return (
                          <a href={props.src} target="_blank" rel="noopener noreferrer" 
                             onClick={(e) => {
                               if (onPreview && props.src) {
                                  e.preventDefault();
                                  onPreview(props.src, props.alt || t('common.file'));
                               }
                             }}
                             className="block my-4 p-1.5 rounded-xl border border-gray-200 bg-white w-max max-w-full hover:bg-[#fffdf0] hover:border-orange-300 transition-all cursor-pointer">
                            <img src={props.src} alt={props.alt || t('common.file')} className="max-w-[300px] w-[300px] max-h-[300px] object-cover block my-0 rounded-lg" />
                          </a>
                        );
                      },
                      a(props: any) {
                        if (props.href?.startsWith('/uploads/') || props.href?.startsWith('/api/files/')) {
                          const nodes = Array.isArray(props.children) ? props.children : [props.children];
                          const fileName = nodes.map((n: any) => String(n)).join('') || t('common.file');
                          const isHtmlFile = isHtmlAttachmentFile(fileName, props.href);
                          const { Icon, typeText, bgColor } = getFileIconInfo(fileName);
                          return (
                            <div className={`${FILE_ATTACHMENT_CARD_CLASS_NAME} mr-3 mb-3`}>
                              <div className="flex items-center gap-3 p-2.5 rounded-xl border border-gray-200 bg-white hover:bg-[#fffdf0] hover:border-orange-300 cursor-pointer transition-all w-full"
                                   onClick={(e) => {
                                      if (onPreview) {
                                         e.preventDefault();
                                         onPreview(props.href, fileName);
                                      } else {
                                         window.open(props.href, '_blank');
                                      }
                                   }}>
                                <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center flex-shrink-0 border border-gray-100`}>
                                  <Icon className="w-5 h-5 text-white" />
                                </div>
                                <div className={`flex flex-col min-w-0 ${isHtmlFile ? 'pr-20' : 'pr-12'} w-full relative`}>
                                  <div className="text-[13px] font-bold text-gray-800 truncate transition-colors w-full leading-snug">
                                    {fileName}
                                  </div>
                                  <span className="text-[11px] text-gray-400 font-medium mt-0.5">{typeText}</span>
                                </div>
                                <FileAttachmentActions url={props.href} filename={fileName} />
                              </div>
                            </div>
                          );
                        }
                        const normalizedHref = normalizeNavigableHref(props.href);
                        return (
                          <a
                            {...props}
                            href={normalizedHref || props.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={EXTERNAL_LINK_CLASS_NAME}
                          >
                            {renderSearchHighlighted(props.children, 'link')}
                          </a>
                        );
                      },
                      h1(props: any) {
                        return <h1 {...props}>{renderSearchHighlighted(props.children, 'h1')}</h1>;
                      },
                      h2(props: any) {
                        return <h2 {...props}>{renderSearchHighlighted(props.children, 'h2')}</h2>;
                      },
                      h3(props: any) {
                        return <h3 {...props}>{renderSearchHighlighted(props.children, 'h3')}</h3>;
                      },
                      h4(props: any) {
                        return <h4 {...props}>{renderSearchHighlighted(props.children, 'h4')}</h4>;
                      },
                      h5(props: any) {
                        return <h5 {...props}>{renderSearchHighlighted(props.children, 'h5')}</h5>;
                      },
                      h6(props: any) {
                        return <h6 {...props}>{renderSearchHighlighted(props.children, 'h6')}</h6>;
                      },
                      p(props: any) {
                        const embedPreviews = parseStandaloneEmbedPreviews(getMarkdownNodePlainText(props.node));
                        if (embedPreviews.length > 0) {
                          return (
                            <div className="w-full">
                              {embedPreviews.map((embed, index) => (
                                <EmbedPreviewCard key={`${embed.url}-${index}`} embed={embed} />
                              ))}
                            </div>
                          );
                        }

                        const nodes = props.node?.children || [];
                        const isAttachmentBlock = nodes.length > 0 && nodes.every(
                          (child: any) => 
                              (child.type === 'element' && child.tagName === 'img') || 
                              (child.type === 'element' && child.tagName === 'a') || 
                              (child.type === 'text' && child.value.trim() === '') ||
                              (child.type === 'element' && child.tagName === 'br')
                        );
                        
                        const attachmentCount = nodes.filter(
                          (c: any) => c.type === 'element' && (c.tagName === 'img' || c.tagName === 'a')
                        ).length;
                        
                        if (isAttachmentBlock && attachmentCount > 0) {
                          return (
                            <div className="flex flex-wrap gap-3 mb-4 w-full items-start">
                              {renderSearchHighlighted(props.children, 'p-attachments')}
                            </div>
                          );
                        }
                        return (
                          <p className="mb-4 last:mb-0 break-words" {...props}>
                            {renderSearchHighlighted(props.children, 'p')}
                          </p>
                        );
                      },
                      li(props: any) {
                        return <li {...props}>{renderSearchHighlighted(props.children, 'li')}</li>;
                      },
                      td(props: any) {
                        return <td {...props}>{renderSearchHighlighted(props.children, 'td')}</td>;
                      },
                      th(props: any) {
                        return <th {...props}>{renderSearchHighlighted(props.children, 'th')}</th>;
                      }
                    };

                    return (
                  <ReactMarkdown
                    remarkPlugins={markdownRemarkPlugins}
                    rehypePlugins={markdownRehypePlugins}
                    components={markdownComponents}
                  >
                    {normalizeMathMarkdown(text)}
                  </ReactMarkdown>
                  );
                })()}
                {shouldRenderExecutingPlaceholder ? (
                  <div className="not-prose text-[16px] leading-[1.6] text-gray-500">
                    <AnimatedExecutingPlaceholder label={t('messageBubble.executingPlaceholder')} />
                  </div>
                ) : null}


              </div>
            )}
          </div>
          
          <div className={`mt-2 flex items-center gap-1.5 text-[14px] text-gray-500 font-sans font-normal w-full ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <span className={`text-[12px] opacity-70 font-sans ${role === 'user' ? 'mr-0' : 'mr-2'}`}>{timestamp.toLocaleTimeString(currentLocale, { hour: '2-digit', minute: '2-digit' })}</span>

            {role === 'user' && isLatest && (
              <button 
                onClick={() => {
                  const { attachments, text } = parseAttachmentsFromContent(content);
                  onEditClick?.(attachments, text);
                }} 
                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-all group/btn outline-none relative" 
                title={t('common.edit')}
              >
                 <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
              </button>
            )}
            
            {role === 'assistant' && onRegenerate && isLatest && (
              <button disabled={isLoading} onClick={onRegenerate} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-all group/btn outline-none relative disabled:opacity-50" title={t('common.regenerate')}>
                <RefreshCw className="w-[15px] h-[15px]" />
              </button>
            )}

            {onQuote && (
              <button onClick={onQuote} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-all group/btn outline-none relative" title={t('common.quote')}>
                  <Quote className="w-4 h-4" />
              </button>
            )}

            <button onClick={() => onCopy?.(content, id)} className={`p-1.5 hover:bg-blue-50 rounded-md transition-all group/btn outline-none relative ${isCopied ? 'text-blue-600 bg-blue-50' : 'text-gray-400 hover:text-blue-600'}`} title={t('common.copy')}>
                {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>

            {onDelete && (
              <button onClick={onDelete} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-all group/btn outline-none relative" title={t('common.delete')}>
                  <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
    </div>
      )}
    </div>
  );
};

// Custom comparator: skip function props (they're always recreated inline in .map() loops)
// Only re-render when data props actually change
const messageBubbleAreEqual = (prevProps: MessageProps, nextProps: MessageProps): boolean => {
  const dataKeys: (keyof MessageProps)[] = [
    'id', 'role', 'content', 'processContent', 'processStreaming', 'rawDetail', 'isHighlighted', 'searchQuery', 'showDateDivider',
    'agentName', 'modelDisplayName', 'avatarUrl', 'avatarChar', 'avatarColorClass',
    'isEditing', 'editContent', 'editIsDragging',
    'isCopied', 'activeCopiedId', 'isLoading', 'isLatest',
    'processStartTag', 'processEndTag',
    'preserveProcessExpansionWhenNotLatest'
  ];
  for (const key of dataKeys) {
    if (prevProps[key] !== nextProps[key]) return false;
  }
  // Check timestamp by value (Date objects are always new)
  if (prevProps.timestamp?.getTime() !== nextProps.timestamp?.getTime()) return false;
  return true;
};

export const MessageBubble = React.memo(MessageBubbleInner, messageBubbleAreEqual);
