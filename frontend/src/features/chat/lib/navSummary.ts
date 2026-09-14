// 导航点悬浮摘要的文本清洗（去掉过程块、引用标记、上传链接与 markdown 链接语法）。
import type { NavDotSummary } from './types';

const NAV_SUMMARY_FALLBACK_REGEXES = [
  /````(?:process_step_thought|process_step_thought_streaming)[\s\S]*?````/g,
  /\[引用开始[^\]]*\]/g,
  /\[引用结束\]/g,
  /\/uploads\/[^\s)]+/g,
  /\/api\/files\/[^\s)]+/g,
  /\[执行工作_Start\][\s\S]*?(?:\[执行工作_End\]|$)/g,
];
export const NAV_QUOTE_BLOCK_REGEX = /\[引用开始(?:[ \t]+author=".*?")?(?:[ \t]+time=".*?")?\][\s\S]*?(?:\[引用结束\]|$)/g;

function normalizeNavSummaryWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function normalizeNavSummaryLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripMarkdownSyntaxForNav(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

export function sanitizeNavSummaryText(text: string): string {
  const cleaned = NAV_SUMMARY_FALLBACK_REGEXES.reduce((value, regex) => value.replace(regex, '\n'), text);
  return normalizeNavSummaryWhitespace(stripMarkdownSyntaxForNav(cleaned));
}

export function buildNavDotSummary(primary: string, secondary?: string): NavDotSummary {
  const normalizedPrimary = normalizeNavSummaryWhitespace(primary);
  const normalizedSecondary = secondary ? normalizeNavSummaryWhitespace(secondary) : '';
  const primaryLines = normalizedPrimary ? normalizedPrimary.split('\n') : [];
  const fallbackPrimary = normalizeNavSummaryLine(primaryLines[0] || normalizedSecondary || '');
  const inferredSecondary = primaryLines.length > 1 ? primaryLines.slice(1).join(' ') : '';
  const finalSecondary = normalizeNavSummaryLine(normalizedSecondary || inferredSecondary);

  return {
    primary: fallbackPrimary,
    secondary: finalSecondary && finalSecondary !== fallbackPrimary ? finalSecondary : undefined,
    tooltipText: [fallbackPrimary, finalSecondary].filter(Boolean).join('\n'),
  };
}
