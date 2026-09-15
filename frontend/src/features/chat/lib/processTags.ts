// 过程块标签（执行过程的起止标记）的解析与「群聊消息是否停在半截」判定。
import { DEFAULT_PROCESS_END_TAG, DEFAULT_PROCESS_START_TAG } from './constants';

export function resolveProcessTagPair(
  primaryStartTag?: string | null,
  primaryEndTag?: string | null,
  secondaryStartTag?: string | null,
  secondaryEndTag?: string | null,
): { startTag: string; endTag: string } {
  const normalize = (value?: string | null) => (typeof value === 'string' ? value.trim() : '');

  const primaryStart = normalize(primaryStartTag);
  const primaryEnd = normalize(primaryEndTag);
  if (primaryStart && primaryEnd) {
    return { startTag: primaryStart, endTag: primaryEnd };
  }

  const secondaryStart = normalize(secondaryStartTag);
  const secondaryEnd = normalize(secondaryEndTag);
  if (secondaryStart && secondaryEnd) {
    return { startTag: secondaryStart, endTag: secondaryEnd };
  }

  return {
    startTag: DEFAULT_PROCESS_START_TAG,
    endTag: DEFAULT_PROCESS_END_TAG,
  };
}

function escapeRegExpForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripProcessBlocksForStatus(content: string, processStartTag: string, processEndTag: string): string {
  const startPattern = escapeRegExpForPattern(processStartTag.trim());
  const endPattern = escapeRegExpForPattern(processEndTag.trim());
  return content
    .replace(new RegExp(`${startPattern}[\\s\\S]*?(?:${endPattern}|$)`, 'g'), '\n\n')
    .replace(new RegExp(`(?:${startPattern}|${endPattern})`, 'g'), '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isLikelyInactiveGroupMessageStale(content: string, processStartTag?: string, processEndTag?: string): boolean {
  const normalized = content.trim();
  if (!normalized) return true;

  const { startTag, endTag } = resolveProcessTagPair(processStartTag, processEndTag);
  if (!startTag || !endTag || !normalized.includes(startTag)) return false;

  if (normalized.lastIndexOf(endTag) < normalized.lastIndexOf(startTag)) {
    return true;
  }

  return stripProcessBlocksForStatus(normalized, startTag, endTag).length === 0;
}
