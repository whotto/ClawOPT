import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export const markdownRemarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
export const markdownRehypePlugins = [rehypeKatex];

function normalizeMathSegment(segment: string): string {
  return segment
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner) => `\n\n$$\n${String(inner).trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner) => `$${String(inner).trim()}$`);
}

export function normalizeMathMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const normalized: string[] = [];
  let fenceMarker: string | null = null;
  let pending = '';

  const flushPending = () => {
    if (!pending) return;
    normalized.push(normalizeMathSegment(pending));
    pending = '';
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fenceMarker) {
        flushPending();
        normalized.push(line);
        fenceMarker = marker;
        continue;
      }
      if (marker === fenceMarker) {
        normalized.push(line);
        fenceMarker = null;
        continue;
      }
    }

    if (fenceMarker) {
      normalized.push(line);
      continue;
    }

    pending += pending ? `\n${line}` : line;
  }

  flushPending();
  return normalized.join('\n');
}
