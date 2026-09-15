import { extractAttachmentFromStandaloneLine } from './attachments';
import { escapeRegExpForPattern } from './links';
import { isFenceOpeningLine, isFenceClosingLine } from './markdownContent';

export function hasSearchMatchInProcessBlocks(content: string, query: string, processStartTag?: string, processEndTag?: string, explicitProcessContent?: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery && explicitProcessContent && explicitProcessContent.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  const startTag = processStartTag?.trim();
  const endTag = processEndTag?.trim();
  if (!content || !normalizedQuery || !startTag || !endTag) return false;

  const regex = new RegExp(
    `${escapeRegExpForPattern(startTag)}([\\s\\S]*?)(?:${escapeRegExpForPattern(endTag)}|$)`,
    'g'
  );

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if ((match[1] || '').toLowerCase().includes(normalizedQuery)) {
      return true;
    }
  }

  return false;
}

function findTrailingIncompleteProcessTagFragment(content: string, tag?: string): string {
  const normalizedTag = tag?.trim() || '';
  if (!content || !normalizedTag || content.endsWith(normalizedTag)) {
    return '';
  }

  const minFragmentLength = Math.min(3, Math.max(1, normalizedTag.length - 1));
  const maxFragmentLength = Math.min(content.length, normalizedTag.length - 1);

  for (let length = maxFragmentLength; length >= minFragmentLength; length -= 1) {
    const fragment = normalizedTag.slice(0, length);
    if (content.endsWith(fragment)) {
      return fragment;
    }
  }

  return '';
}

export function sanitizeConfiguredProcessText(
  content: string,
  processStartTag?: string,
  processEndTag?: string,
): { content: string; hasTrailingPlaceholder: boolean } {
  if (!content) {
    return { content, hasTrailingPlaceholder: false };
  }

  const tags = [processStartTag?.trim(), processEndTag?.trim()]
    .filter((tag): tag is string => Boolean(tag));

  if (tags.length === 0) {
    return { content, hasTrailingPlaceholder: false };
  }

  let hasTrailingPlaceholder = false;
  let cleanedContent = content.replace(/\r\n?/g, '\n');

  for (const tag of tags) {
    cleanedContent = cleanedContent.replace(new RegExp(escapeRegExpForPattern(tag), 'g'), '');
  }

  cleanedContent = cleanedContent
    .split('\n')
    .map((line) => {
      let nextLine = line;

      while (true) {
        const startFragment = findTrailingIncompleteProcessTagFragment(nextLine, processStartTag);
        const endFragment = findTrailingIncompleteProcessTagFragment(nextLine, processEndTag);
        const fragment = startFragment.length >= endFragment.length ? startFragment : endFragment;

        if (!fragment) {
          return nextLine;
        }

        hasTrailingPlaceholder = true;
        nextLine = nextLine
          .slice(0, nextLine.length - fragment.length)
          .replace(/[ \t]+$/g, '');
      }
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  return {
    content: cleanedContent,
    hasTrailingPlaceholder,
  };
}

export function normalizeProcessPreviewablePathLines(content: string): string {
  if (!content || !content.includes('/')) return content;

  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const normalizedLines: string[] = [];
  let activeFence: { marker: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    if (!activeFence) {
      const openingFence = isFenceOpeningLine(line);
      if (openingFence) {
        activeFence = openingFence;
        normalizedLines.push(line);
        continue;
      }

      const attachment = extractAttachmentFromStandaloneLine(line);
      if (attachment?.url) {
        if (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1].trim() !== '') {
          normalizedLines.push('');
        }
        normalizedLines.push(`[${attachment.name}](${attachment.url})`);
        normalizedLines.push('');
        continue;
      }

      normalizedLines.push(line);
      continue;
    }

    normalizedLines.push(line);
    if (isFenceClosingLine(line, activeFence.marker, activeFence.length)) {
      activeFence = null;
    }
  }

  return normalizedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

type ProcessToolStep = {
  label: string;
  detail: string;
  status: 'running' | 'done' | 'error';
};

const KNOWN_TOOL_PROGRESS_LABELS = new Set([
  '子任务已返回结果',
  '子任务已启动',
  '页面操作已完成',
  '正在打开页面',
  '命令已完成',
  '命令执行失败',
  '正在执行工具',
  '文件读取已完成',
  '文件修改已完成',
  '图片查看已完成',
  '正在打开文件',
  '计划已更新',
  '正在运行命令',
  '搜索已完成',
  '正在搜索',
  '正在启动子任务',
  '工具已完成',
  '工具执行失败',
  '正在修改文件',
  '正在更新计划',
  '正在查看图片',
  '正在等待子任务结果',
  '子任務已返回結果',
  '子任務已啟動',
  '頁面操作已完成',
  '正在開啟頁面',
  '命令已完成',
  '命令執行失敗',
  '正在執行工具',
  '檔案讀取已完成',
  '檔案修改已完成',
  '圖片查看已完成',
  '正在開啟檔案',
  '計畫已更新',
  '正在執行命令',
  '搜尋已完成',
  '正在搜尋',
  '正在啟動子任務',
  '工具已完成',
  '工具執行失敗',
  '正在修改檔案',
  '正在更新計畫',
  '正在查看圖片',
  '正在等待子任務結果',
  'Subtask returned',
  'Subtask started',
  'Browser action completed',
  'Opening page',
  'Command completed',
  'Command failed',
  'Running tool',
  'File read completed',
  'File update completed',
  'Image inspection completed',
  'Opening file',
  'Plan updated',
  'Running command',
  'Search completed',
  'Searching',
  'Starting subtask',
  'Tool completed',
  'Tool failed',
  'Updating file',
  'Updating plan',
  'Inspecting image',
  'Waiting for subtask result',
]);

function isKnownToolProgressLabel(label: string): boolean {
  const normalized = label.trim();
  if (KNOWN_TOOL_PROGRESS_LABELS.has(normalized)) return true;
  return /^(正在执行工具|正在執行工具|Running tool)\s+\S+/.test(normalized);
}

function resolveProcessToolStepStatus(label: string): ProcessToolStep['status'] {
  if (/(失败|失敗|failed)/i.test(label)) return 'error';
  if (/^正在/.test(label) || /^(Running|Opening|Searching|Updating|Starting|Waiting|Inspecting)\b/i.test(label)) {
    return 'running';
  }
  return 'done';
}

function parseProcessToolStepLine(line: string): ProcessToolStep | null {
  const bulletMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
  if (!bulletMatch) return null;

  const text = bulletMatch[1].trim();
  const splitMatch = text.match(/^(.+?)(?:：|:\s+)([\s\S]*)$/);
  const label = (splitMatch?.[1] || text).trim();
  const detail = (splitMatch?.[2] || '').trim();
  if (!isKnownToolProgressLabel(label)) return null;

  return {
    label,
    detail,
    status: resolveProcessToolStepStatus(label),
  };
}

export function splitProcessContent(content: string): { toolSteps: ProcessToolStep[]; modelContent: string } {
  const toolSteps: ProcessToolStep[] = [];
  const modelLines: string[] = [];

  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const toolStep = parseProcessToolStepLine(line);
    if (toolStep) {
      toolSteps.push(toolStep);
    } else {
      modelLines.push(line);
    }
  }

  return {
    toolSteps,
    modelContent: modelLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

export const normalizeProcessBlocks = (content: string, processStartTag?: string, processEndTag?: string) => {
  if (!content || !processStartTag || !processEndTag) return content;

  const startTag = processStartTag.trim();
  const endTag = processEndTag.trim();
  const startStr = escapeRegExpForPattern(startTag);
  const endStr = escapeRegExpForPattern(endTag);
  const cleanupTagArtifacts = (value: string) => (
    value
      .replace(new RegExp(`(?:${startStr}|${endStr})`, 'g'), '\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
  const regex = new RegExp(`${startStr}([\\s\\S]*?)(?:${endStr}|$)`, 'g');
  const processBlocks: { inner: string; isExtracting: boolean }[] = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    const isExtracting = !match[0].endsWith(endTag);
    processBlocks.push({ inner: match[1], isExtracting });
  }

  if (processBlocks.length === 0) return content;

  const mergedInner = cleanupTagArtifacts(processBlocks.map(block => block.inner).join('\n\n'));
  const isStillExtracting = processBlocks[processBlocks.length - 1].isExtracting;
  const lang = isStillExtracting ? 'process_step_thought_streaming' : 'process_step_thought';
  const cleanedContent = cleanupTagArtifacts(content.replace(regex, '\n'));

  if (!mergedInner) {
    return cleanedContent;
  }

  return `\`\`\`\`${lang}\n${mergedInner}\n\`\`\`\`\n\n${cleanedContent}`.trim();
};
