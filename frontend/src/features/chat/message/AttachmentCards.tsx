import React from 'react';
import { Quote, Download, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeMathMarkdown } from '../../../utils/markdownMath';
import { fetchResource } from '../../../api/files';
import { isHtmlAttachmentFile, downloadAttachmentFile, openAttachmentFileInNewTab } from './attachments';
import type { Attachment, EmbedPreview } from './attachments';

export const FILE_ATTACHMENT_CARD_CLASS_NAME = 'inline-flex w-full max-w-[420px] relative group/file';

const previewableLocalPathAvailabilityCache = new Map<string, boolean>();

function useLocalPathAvailability(localPath?: string, url?: string): boolean | null {
  const [retryTick, setRetryTick] = React.useState(0);
  const [isAvailable, setIsAvailable] = React.useState<boolean | null>(() => {
    if (!localPath) return true;
    return previewableLocalPathAvailabilityCache.get(localPath) ?? null;
  });

  React.useEffect(() => {
    setRetryTick(0);
  }, [localPath, url]);

  React.useEffect(() => {
    if (!localPath || !url) {
      setIsAvailable(true);
      return;
    }

    const cached = previewableLocalPathAvailabilityCache.get(localPath);
    if (cached !== undefined) {
      setIsAvailable(cached);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    setIsAvailable(null);

    fetchResource(url, { method: 'HEAD' })
      .then((response) => {
        if (cancelled) return;
        setIsAvailable(response.ok);
        if (response.ok) {
          previewableLocalPathAvailabilityCache.set(localPath, true);
        } else if (retryTick < 2) {
          retryTimer = window.setTimeout(() => {
            setRetryTick((current) => current + 1);
          }, 1200);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setIsAvailable(false);
        if (retryTick < 2) {
          retryTimer = window.setTimeout(() => {
            setRetryTick((current) => current + 1);
          }, 1200);
        }
      });

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [localPath, retryTick, url]);

  return isAvailable;
}

export function LocalPathAttachmentGuard({
  attachment,
  fallback,
  children,
}: {
  attachment: Attachment;
  fallback: React.ReactNode;
  children: React.ReactNode;
}) {
  const isAvailable = useLocalPathAvailability(attachment.localPath, attachment.url);

  if (attachment.localPath && isAvailable !== true) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}

export const FileAttachmentActions: React.FC<{ url: string; filename: string }> = ({ url, filename }) => {
  const { t } = useTranslation();
  const shouldShowOpenInNewTab = isHtmlAttachmentFile(filename, url);

  return (
    <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
      {shouldShowOpenInNewTab ? (
        <button
          type="button"
          className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-gray-400 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
          onClick={(event) => {
            event.stopPropagation();
            openAttachmentFileInNewTab(url);
          }}
          title={t('common.openInNewTab')}
        >
          <ExternalLink className="h-4 w-4" />
        </button>
      ) : null}
      <button
        type="button"
        className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-gray-400 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
        onClick={(event) => {
          event.stopPropagation();
          downloadAttachmentFile(url, filename);
        }}
        title={t('common.downloadFile')}
      >
        <Download className="h-4 w-4" />
      </button>
    </div>
  );
};

export const QuoteBlock: React.FC<{ author: string; time: string; content: string; components?: any }> = ({ author, time, content, components }) => {
  const [expanded, setExpanded] = React.useState(false);
  const lines = content.split('\n');
  const isLong = lines.length > 3 || content.length > 150;

  return (
    <div className="my-1.5 border border-[#E5E7EB] rounded-2xl overflow-hidden bg-[#FAFAFA] flex flex-col w-full max-w-full z-10 relative shadow-sm not-prose">
      <button
        onClick={() => isLong && setExpanded(!expanded)}
        className={`px-3 py-2 bg-[#F3F4F6]/80 border-b border-[#E5E7EB] flex items-center gap-1.5 text-[13px] text-gray-600 w-full text-left outline-none ${isLong ? 'cursor-pointer hover:bg-[#ECEEF1]/80' : 'cursor-default'} transition-colors`}
      >
        <Quote className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <span>{author}</span>
        {time && <span className="text-gray-400">{time}</span>}
        {isLong && (
          <span className="ml-auto text-gray-400">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </span>
        )}
      </button>
      <div className="px-3.5 py-2 relative" style={{ padding: '0.5rem 0.875rem' }}>
        <div className={`text-[13px] text-gray-700 font-sans break-words custom-markdown quote-content-inner ${!expanded && isLong ? 'max-h-[120px] overflow-hidden' : ''}`} style={{ lineHeight: '1.5', wordBreak: 'break-word' }}>
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={components}
          >
            {normalizeMathMarkdown(content)}
          </ReactMarkdown>
        </div>
        {!expanded && isLong && (
          <div className="absolute bottom-0 left-0 w-full h-10 bg-gradient-to-t from-[#FAFAFA] to-transparent pointer-events-none" />
        )}
      </div>
    </div>
  );
};

export const EmbedPreviewCard: React.FC<{ embed: EmbedPreview }> = ({ embed }) => {
  const { t } = useTranslation();

  return (
    <div className="not-prose my-4 w-full max-w-[900px] overflow-hidden rounded-lg border border-gray-300 bg-white">
      <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-gray-800">{embed.title}</div>
          <div className="truncate text-[11px] text-gray-500">{embed.url}</div>
        </div>
        <a
          href={embed.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
          title={t('common.preview')}
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
      <iframe
        src={embed.url}
        title={embed.title}
        className="block w-full border-0 bg-white"
        style={{ height: embed.height }}
        // 绝不能有 allow-same-origin：它与 allow-scripts 同时存在时，被嵌文档
        // 就运行在本站同源里，等于沙箱自我解除——可读同源存储、可访问 window.parent。
        // 而 embed 的 URL 来自模型输出，模型输出可被它读到的外部内容影响。
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
      />
    </div>
  );
};
