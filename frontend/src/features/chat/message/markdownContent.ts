
export function isInlineMarkdownCodeNode(node: any, className?: string): boolean {
  if (className) return false;
  const startLine = node?.position?.start?.line;
  const endLine = node?.position?.end?.line;
  return typeof startLine === 'number' && typeof endLine === 'number' && startLine === endLine;
}

export function getMarkdownNodePlainText(node: any): string {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') {
    return typeof node.value === 'string' ? node.value : '';
  }
  if (Array.isArray(node.children)) {
    return node.children.map(getMarkdownNodePlainText).join('');
  }
  return '';
}

export function createStableContentKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

export function buildCodeCopyId(messageId: string | number, node: any, codeText: string): string {
  const startOffset = node?.position?.start?.offset;
  const endOffset = node?.position?.end?.offset;

  if (Number.isFinite(startOffset) && Number.isFinite(endOffset)) {
    return `code-${messageId}-${startOffset}-${endOffset}`;
  }

  return `code-${messageId}-${createStableContentKey(codeText)}`;
}

function looksLikeMarkdownContent(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;

  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(normalized)
    || /(^|\n)\s{0,3}```/.test(normalized)
    || /\[[^\]]+\]\([^)]+\)/.test(normalized)
    || /\*\*[^*]+\*\*/.test(normalized)
    || /`[^`]+`/.test(normalized);
}

export function getCodeLanguage(className?: string): string {
  const match = /language-([^\s]+)/.exec(className || '');
  return (match?.[1] || '').toLowerCase();
}

export function shouldRenderEmbeddedFilesAsMarkdown(language: string, text: string): boolean {
  const normalizedLanguage = language.trim().toLowerCase();
  const normalizedText = text.trim();
  if (!normalizedText) return true;

  if (['markdown', 'md', 'mdx', 'text', 'txt', 'plain', 'plaintext'].includes(normalizedLanguage)) {
    return true;
  }

  return looksLikeMarkdownContent(normalizedText);
}

export function isFenceOpeningLine(line: string): { marker: '`' | '~'; length: number } | null {
  const match = line.match(/^ {0,3}((`{3,})|(~{3,}))(.*)$/);
  if (!match) return null;

  const fence = match[1];
  return {
    marker: fence[0] as '`' | '~',
    length: fence.length,
  };
}

export function isFenceClosingLine(line: string, marker: '`' | '~', length: number): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith(marker.repeat(length))) return false;
  return new RegExp(`^\\${marker}{${length},}[ \\t]*$`).test(trimmed);
}

function stripTrailingBrokenFenceFragments(lines: string[], marker: '`' | '~'): string[] {
  const nextLines = [...lines];

  while (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() === '') {
    nextLines.pop();
  }

  while (
    nextLines.length > 0
    && new RegExp(`^ {0,3}\\${marker}{1,2}[ \\t]*$`).test(nextLines[nextLines.length - 1].trim())
  ) {
    nextLines.pop();
    while (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() === '') {
      nextLines.pop();
    }
  }

  return nextLines;
}

export function maskFencedBlocks(content: string): string {
  if (!content || (!content.includes('```') && !content.includes('~~~'))) {
    return content;
  }

  const lines = content.split('\n');
  const maskedLines: string[] = [];
  let activeFence: { marker: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    if (!activeFence) {
      const openingFence = isFenceOpeningLine(line);
      if (openingFence) {
        activeFence = openingFence;
        maskedLines.push(' '.repeat(line.length));
        continue;
      }

      maskedLines.push(line);
      continue;
    }

    maskedLines.push(' '.repeat(line.length));
    if (isFenceClosingLine(line, activeFence.marker, activeFence.length)) {
      activeFence = null;
    }
  }

  return maskedLines.join('\n');
}

function isLikelyProseBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (/^(#{2,6}\s|>\s)/.test(trimmed)) {
    return true;
  }

  if (/^\*\*[^*]+\*\*[:：]?$/.test(trimmed)) {
    return true;
  }

  if (/[\u4e00-\u9fff]/.test(trimmed)) {
    if (/^(#|\/\/|--|\/\*|\*)/.test(trimmed)) return false;
    if (/[{}[\];]/.test(trimmed)) return false;
    if (/^(if|for|while|def|class|const|let|var|function|import|export|return|echo|curl|npm|pnpm|yarn|python|node|cd|ls|cat|cp|mv|rm|sudo|docker|kubectl|git|ffmpeg|openclaw)\b/i.test(trimmed)) {
      return false;
    }
    return true;
  }

  return /^[A-Za-z][A-Za-z0-9 _/-]{0,80}[:.!?]$/.test(trimmed);
}

export function normalizeMalformedFencedBlocks(content: string): string {
  if (!content || (!content.includes('```') && !content.includes('~~~'))) {
    return content;
  }

  const lines = content.split('\n');
  const normalizedLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const openingFence = isFenceOpeningLine(lines[index]);
    if (!openingFence) {
      normalizedLines.push(lines[index]);
      index += 1;
      continue;
    }

    normalizedLines.push(lines[index]);
    index += 1;

    const blockLines: string[] = [];
    let closed = false;

    while (index < lines.length) {
      const currentLine = lines[index];

      if (isFenceClosingLine(currentLine, openingFence.marker, openingFence.length)) {
        normalizedLines.push(...blockLines, currentLine);
        index += 1;
        closed = true;
        break;
      }

      if (
        openingFence.length === 3
        &&
        blockLines.length > 0
        && index > 0
        && lines[index - 1].trim() === ''
        && isLikelyProseBoundaryLine(currentLine)
      ) {
        normalizedLines.push(
          ...stripTrailingBrokenFenceFragments(blockLines, openingFence.marker),
          openingFence.marker.repeat(openingFence.length)
        );
        closed = true;
        break;
      }

      blockLines.push(currentLine);
      index += 1;
    }

    if (!closed) {
      normalizedLines.push(...stripTrailingBrokenFenceFragments(blockLines, openingFence.marker));
      normalizedLines.push(openingFence.marker.repeat(openingFence.length));
    }
  }

  return normalizedLines.join('\n');
}
