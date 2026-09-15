import React from 'react';
import { Check, RefreshCw, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { getFileIconInfo } from '../../../utils/fileUtils';
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeMathMarkdown } from '../../../utils/markdownMath';
import { FILE_ATTACHMENT_CARD_CLASS_NAME, LocalPathAttachmentGuard, FileAttachmentActions, EmbedPreviewCard } from './AttachmentCards';
import { isPreviewableFileLink, isHtmlAttachmentFile, parseStandaloneEmbedPreviews, extractSingleLocalPath, buildFileAttachmentFromPath, extractStandaloneFileLinks, extractPreviewableLinksAndText } from './attachments';
import type { Attachment } from './attachments';
import { EXTERNAL_LINK_CLASS_NAME, normalizeNavigableHref } from './links';
import { isInlineMarkdownCodeNode, getMarkdownNodePlainText, createStableContentKey, getCodeLanguage, shouldRenderEmbeddedFilesAsMarkdown } from './markdownContent';
import { sanitizeConfiguredProcessText, normalizeProcessPreviewablePathLines, splitProcessContent } from './processContent';
import { highlightSearchNodes } from './searchHighlight';

const EXECUTING_PLACEHOLDER_DOT_COUNTS = [1, 2, 3, 4, 5, 6];

export const AnimatedExecutingPlaceholder: React.FC<{ label: string }> = ({ label }) => {
  const [dotIndex, setDotIndex] = React.useState(0);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setDotIndex((current) => (current + 1) % EXECUTING_PLACEHOLDER_DOT_COUNTS.length);
    }, 420);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <span>
      {label}
      {'.'.repeat(EXECUTING_PLACEHOLDER_DOT_COUNTS[dotIndex])}
    </span>
  );
};

export const ProcessStepBlock = ({
  content,
  initiallyExpanded,
  forceExpanded,
  searchQuery,
  isExtractingProcess,
  isDense,
  onPreview,
  processStartTag,
  processEndTag,
}: {
  content: string,
  initiallyExpanded: boolean,
  forceExpanded?: boolean,
  searchQuery?: string,
  isExtractingProcess?: boolean,
  isDense?: boolean,
  onPreview?: (url: string, filename: string) => void,
  processStartTag?: string,
  processEndTag?: string,
}) => {
  const { t } = useTranslation();
  const normalizedSearchQuery = searchQuery?.trim() || '';
  const [isExpanded, setIsExpanded] = React.useState(initiallyExpanded || !!forceExpanded);
  const sanitizedProcessContent = sanitizeConfiguredProcessText(content, processStartTag, processEndTag);
  const normalizedContent = normalizeProcessPreviewablePathLines(sanitizedProcessContent.content);
  const { toolSteps, modelContent } = React.useMemo(
    () => splitProcessContent(normalizedContent),
    [normalizedContent]
  );
  const hasModelContent = modelContent.trim().length > 0;
  const hasToolSteps = toolSteps.length > 0;
  const shouldRenderInlineExecutingPlaceholder = Boolean(
    isExtractingProcess && (!normalizedContent.trim() || sanitizedProcessContent.hasTrailingPlaceholder)
  );
  const isProcessActive = Boolean(isExtractingProcess || shouldRenderInlineExecutingPlaceholder);
  const hasRenderableProcessContent = hasToolSteps || hasModelContent || shouldRenderInlineExecutingPlaceholder;

  React.useEffect(() => {
    if (forceExpanded) {
      setIsExpanded(true);
    }
  }, [forceExpanded]);

  if (!hasRenderableProcessContent) {
    return null;
  }

  const renderSearchHighlighted = (children: React.ReactNode, scope: string) => (
    highlightSearchNodes(children, normalizedSearchQuery, `process-${isDense ? 'dense' : 'default'}-${scope}`)
  );

  const renderProcessAttachmentCards = (attachments: Attachment[], keyPrefix: string) => (
    <div className="flex flex-wrap gap-4 w-full items-start py-1">
      {attachments.map((att, index) => (
        <LocalPathAttachmentGuard
          key={`${keyPrefix}-${index}`}
          attachment={att}
          fallback={att.localPath ? (
            <div className="max-w-full">
              <div
                dir="ltr"
                title={att.localPath}
                className="max-w-full whitespace-pre-wrap break-all font-mono text-[13.5px] leading-6 text-gray-700"
              >
                {renderSearchHighlighted(att.localPath, `attachment-path-${index}`)}
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
                  onPreview(att.url, att.name || t('common.file'));
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
                        {renderSearchHighlighted(fileName, `attachment-name-${index}`)}
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

  const processMarkdownComponents: any = {
    pre({ children, ...props }: any) {
      let hasStandaloneFileLinks = false;
      let hasMixedMarkdownFileLinks = false;
      let hasSingleLocalPath = false;

      React.Children.forEach(children, (child: any) => {
        const childText = child?.props?.children ? String(child.props.children).replace(/\n$/, '') : '';
        if (extractStandaloneFileLinks(childText.trim()).length > 0) {
          hasStandaloneFileLinks = true;
        }
        if (extractSingleLocalPath(childText)) {
          hasSingleLocalPath = true;
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

      if (hasStandaloneFileLinks || hasMixedMarkdownFileLinks || hasSingleLocalPath) return <>{children}</>;
      return <pre {...props}>{children}</pre>;
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
        (child: any) => child.type === 'element' && (child.tagName === 'img' || child.tagName === 'a')
      ).length;

      if (isAttachmentBlock && attachmentCount > 0) {
        return (
          <div className="w-full space-y-4" style={{ marginTop: 0, marginBottom: '1rem' }}>
            {props.children}
          </div>
        );
      }

      return <p {...props}>{renderSearchHighlighted(props.children, 'p')}</p>;
    },
    li(props: any) {
      return <li {...props}>{renderSearchHighlighted(props.children, 'li')}</li>;
    },
    code({ inline, className, children, ...props }: any) {
      const codeLanguage = getCodeLanguage(className);
      const codeText = children ? String(children).replace(/\n$/, '') : '';
      const isInlineCode = typeof inline === 'boolean'
        ? inline
        : isInlineMarkdownCodeNode(props.node, className);
      const inlineLinkHref = isInlineCode ? normalizeNavigableHref(codeText) : null;
      const standaloneFileLinks = !inline ? extractStandaloneFileLinks(codeText.trim()) : [];
      const embeddedFileLinks = !inline ? extractPreviewableLinksAndText(codeText.trim()) : { attachments: [], text: codeText };
      const singleLocalPath = !inline ? extractSingleLocalPath(codeText) : null;
      const singleFileAttachment = !inline && singleLocalPath ? buildFileAttachmentFromPath(codeText, singleLocalPath) : null;

      if (!inline && singleFileAttachment) {
        return renderProcessAttachmentCards([singleFileAttachment], `process-code-path-${createStableContentKey(singleLocalPath || codeText)}`);
      }

      if (!inline && standaloneFileLinks.length > 0) {
        return renderProcessAttachmentCards(standaloneFileLinks, `process-code-files-${createStableContentKey(codeText)}`);
      }

      if (
        !inline
        && embeddedFileLinks.attachments.length > 0
        && shouldRenderEmbeddedFilesAsMarkdown(codeLanguage, embeddedFileLinks.text)
      ) {
        return (
          <div className="space-y-4">
            {renderProcessAttachmentCards(embeddedFileLinks.attachments, `process-code-mixed-${createStableContentKey(codeText)}`)}
            {embeddedFileLinks.text.trim() ? (
              <div className="prose prose-sm max-w-none prose-slate text-[13.5px] text-[#444]">
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  components={processMarkdownComponents}
                >
                  {normalizeMathMarkdown(embeddedFileLinks.text)}
                </ReactMarkdown>
              </div>
            ) : null}
          </div>
        );
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

      return isInlineCode ? (
        <code {...props}>{children}</code>
      ) : (
        <code className={className} {...props}>{children}</code>
      );
    },
    img(props: any) {
      if (props.src && isPreviewableFileLink(props.src)) {
        return renderProcessAttachmentCards([
          { name: props.alt || t('common.file'), url: props.src, isImage: true },
        ], `process-image-${createStableContentKey(String(props.src))}`);
      }

      return <img {...props} alt={props.alt} />;
    },
    strong(props: any) {
      return <strong {...props}>{renderSearchHighlighted(props.children, 'strong')}</strong>;
    },
    em(props: any) {
      return <em {...props}>{renderSearchHighlighted(props.children, 'em')}</em>;
    },
    a(props: any) {
      if (props.href && isPreviewableFileLink(props.href)) {
        const nodes = Array.isArray(props.children) ? props.children : [props.children];
        const fileName = nodes.map((node: any) => String(node)).join('') || t('common.file');
        return renderProcessAttachmentCards([
          { name: fileName, url: props.href, isImage: false },
        ], `process-link-${createStableContentKey(`${props.href}-${fileName}`)}`);
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
          {renderSearchHighlighted(props.children, 'a')}
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
    blockquote(props: any) {
      return <blockquote {...props}>{renderSearchHighlighted(props.children, 'blockquote')}</blockquote>;
    },
    td(props: any) {
      return <td {...props}>{renderSearchHighlighted(props.children, 'td')}</td>;
    },
    th(props: any) {
      return <th {...props}>{renderSearchHighlighted(props.children, 'th')}</th>;
    }
  };

  return (
    <div className={`process-step-container flex flex-col ${isDense ? 'my-1.5' : 'mt-1 mb-4'} w-fit max-w-full min-w-[240px] border border-gray-300 rounded-xl overflow-hidden bg-white transition-colors leading-normal`}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center justify-between gap-4 px-3 py-2 w-full bg-[#f2fbf4] hover:bg-[#e6f7ea] transition-colors cursor-pointer outline-none ${isExpanded ? 'border-b border-gray-300' : ''}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex-shrink-0 flex items-center justify-center pl-0.5 pr-1">
             {isProcessActive ? (
                <RefreshCw className="w-[16px] h-[16px] text-[#5ca36f] animate-spin" strokeWidth={2.5} />
             ) : (
                <Check className="w-[16px] h-[16px] text-[#5ca36f]" strokeWidth={2.5} />
             )}
          </div>
          <div className="flex min-w-0 flex-col items-start">
            <span className="text-[13.5px] font-medium text-gray-700 leading-tight">{t('messageBubble.processTitle')}</span>
          </div>
        </div>
        <div className="text-gray-400 flex-shrink-0">
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>
      {isExpanded && (
        <div className="px-3 py-2.5 bg-white space-y-3">
          {hasToolSteps ? (
            <div className="not-prose">
              <div className="mb-1.5 text-[11.5px] font-semibold text-gray-500">{t('messageBubble.toolStepsLabel')}</div>
              <ol className="space-y-1.5">
                {toolSteps.map((step, index) => (
                  <li key={`${step.label}-${step.detail}-${index}`} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-[13px] leading-[1.45] text-gray-700">
                    <span className="mt-[2px] flex h-[18px] w-[18px] items-center justify-center rounded-full border border-gray-300 bg-white">
                      {step.status === 'running' && isProcessActive ? (
                        <RefreshCw className="h-3 w-3 animate-spin text-[#5ca36f]" strokeWidth={2.4} />
                      ) : step.status === 'error' ? (
                        <X className="h-3 w-3 text-[#d93025]" strokeWidth={2.4} />
                      ) : (
                        <Check className="h-3 w-3 text-[#5ca36f]" strokeWidth={2.4} />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-gray-700">{renderSearchHighlighted(step.label, `tool-label-${index}`)}</span>
                      {step.detail ? (
                        <span className="text-gray-500">：{renderSearchHighlighted(step.detail, `tool-detail-${index}`)}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {hasModelContent ? (
            <div>
              {hasToolSteps ? (
                <div className="not-prose mb-1.5 border-t border-gray-200 pt-2 text-[11.5px] font-semibold text-gray-500">
                  {t('messageBubble.modelProcessLabel')}
                </div>
              ) : null}
              <div className="text-[13.5px] font-sans text-[#444] break-all prose prose-sm max-w-none" style={{ lineHeight: '1.6' }}>
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  components={processMarkdownComponents}
                >
                  {normalizeMathMarkdown(modelContent)}
                </ReactMarkdown>
              </div>
            </div>
          ) : null}
          {shouldRenderInlineExecutingPlaceholder ? (
            <div className="not-prose text-[13.5px] leading-[1.6] text-[#666]">
              <AnimatedExecutingPlaceholder label={t('messageBubble.executingPlaceholder')} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};
