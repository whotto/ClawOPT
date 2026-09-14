import { rewriteVisibleFileLinks } from '../../workspace';
import type { SplitChatProcessOutputResult } from './chat-run-managers';

function cleanupChatProcessText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findTrailingIncompleteChatProcessTagFragment(content: string, tag?: string): string {
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

function stripChatProcessTagArtifacts(
  content: string,
  processStartTag?: string,
  processEndTag?: string,
): string {
  if (!content) return content;

  const tags = [processStartTag?.trim(), processEndTag?.trim()]
    .filter((tag): tag is string => Boolean(tag));
  let cleanedContent = content.replace(/\r\n?/g, '\n');

  for (const tag of tags) {
    cleanedContent = cleanedContent.replace(new RegExp(escapeRegExpForPattern(tag), 'g'), '');
  }

  cleanedContent = cleanedContent
    .split('\n')
    .map((line) => {
      let nextLine = line;

      while (true) {
        const startFragment = findTrailingIncompleteChatProcessTagFragment(nextLine, processStartTag);
        const endFragment = findTrailingIncompleteChatProcessTagFragment(nextLine, processEndTag);
        const fragment = startFragment.length >= endFragment.length ? startFragment : endFragment;

        if (!fragment) {
          return nextLine;
        }

        nextLine = nextLine
          .slice(0, nextLine.length - fragment.length)
          .replace(/[ \t]+$/g, '');
      }
    })
    .join('\n');

  return cleanupChatProcessText(cleanedContent);
}

export function splitChatProcessOutput(
  content: string,
  processStartTag?: string,
  processEndTag?: string,
): SplitChatProcessOutputResult {
  const normalizedContent = content.replace(/\r\n?/g, '\n');
  const startTag = processStartTag?.trim();
  const endTag = processEndTag?.trim();

  if (!normalizedContent || !startTag || !endTag) {
    return {
      finalContent: stripChatProcessTagArtifacts(cleanupChatProcessText(normalizedContent), processStartTag, processEndTag),
      processContent: '',
      processStreaming: false,
    };
  }

  const startPattern = escapeRegExpForPattern(startTag);
  const endPattern = escapeRegExpForPattern(endTag);
  const processRegex = new RegExp(`${startPattern}([\\s\\S]*?)(?:${endPattern}|$)`, 'g');
  const processBlocks: string[] = [];
  let processStreaming = false;
  let match: RegExpExecArray | null;

  while ((match = processRegex.exec(normalizedContent)) !== null) {
    processBlocks.push(match[1] || '');
    if (!match[0].endsWith(endTag)) {
      processStreaming = true;
    }
  }

  if (processBlocks.length === 0) {
    return {
      finalContent: stripChatProcessTagArtifacts(cleanupChatProcessText(normalizedContent), processStartTag, processEndTag),
      processContent: '',
      processStreaming: false,
    };
  }

  const processContent = stripChatProcessTagArtifacts(
    cleanupChatProcessText(processBlocks.join('\n\n')),
    processStartTag,
    processEndTag,
  );
  const finalContent = stripChatProcessTagArtifacts(
    cleanupChatProcessText(
      normalizedContent
        .replace(processRegex, '\n\n')
        .replace(new RegExp(`(?:${startPattern}|${endPattern})`, 'g'), '\n\n'),
    ),
    processStartTag,
    processEndTag,
  );

  return {
    finalContent,
    processContent,
    processStreaming,
  };
}

export function combineChatProcessContent(toolContent: string, modelContent: string): string {
  return [toolContent, modelContent]
    .map((value) => cleanupChatProcessText(value || ''))
    .filter(Boolean)
    .join('\n\n');
}

export function rewriteOpenClawMediaPaths(text: string, workspacePath?: string): string {
  return rewriteVisibleFileLinks(text, { workspacePath });
}

export const DEFAULT_PROCESS_START_TAG = '[执行工作_Start]';
export const DEFAULT_PROCESS_END_TAG = '[执行工作_End]';

export function escapeRegExpForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripProcessBlocks(content: string, pairs: Array<{ startTag: string; endTag: string }>): string {
  let cleaned = content;

  for (const pair of pairs) {
    const startPattern = escapeRegExpForPattern(pair.startTag);
    const endPattern = escapeRegExpForPattern(pair.endTag);
    const blockRegex = new RegExp(`${startPattern}[\\s\\S]*?(?:${endPattern}|$)`, 'g');
    cleaned = cleaned.replace(blockRegex, '\n\n');
    cleaned = cleaned.replace(new RegExp(`(?:${startPattern}|${endPattern})`, 'g'), '\n\n');
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

export function hasUnclosedProcessBlock(content: string, pairs: Array<{ startTag: string; endTag: string }>): boolean {
  return pairs.some((pair) => {
    const lastStartIndex = content.lastIndexOf(pair.startTag);
    if (lastStartIndex === -1) return false;
    const lastEndIndex = content.lastIndexOf(pair.endTag);
    return lastEndIndex < lastStartIndex;
  });
}
