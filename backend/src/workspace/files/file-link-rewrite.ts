import fs from 'fs';
import path from 'path';

type RewriteVisibleFileLinkOptions = {
  workspacePath?: string | null;
};

const ABSOLUTE_PATH_REGEX = /(\/(?:[^\s\)\]\u0022\u0027\u0060\*|<>\uff08\uff09\u3010\u3011\u300a\u300b\u300c\u300d]+))/g;
const RELATIVE_PATH_REGEX = /(^|[\s([{\u3008\uff08\u3010\u300a"'`])((?:\.{1,2}\/)?(?:[A-Za-z0-9_\-.~\u4e00-\u9fa5]+\/)*[A-Za-z0-9_\-.~\u4e00-\u9fa5]+\.[A-Za-z0-9]{1,20})(?=$|[\s)\]}>\u3009\uff09\u3011\u300b"'`*,:;!?])/gu;

function buildMarkdownDownloadLink(absolutePath: string): string {
  const encodedPath = Buffer.from(absolutePath).toString('base64');
  const filename = path.basename(absolutePath);
  return `\n\n[${filename}](/api/files/download?path=${encodeURIComponent(encodedPath)})\n\n`;
}

function cleanupRewrittenFileLinks(text: string): string {
  return text
    .replace(/\*{1,2}\s*\n\n(\[[^\]]+\]\([^\)]+\))\n\n\s*\*{1,2}/g, '\n\n$1\n\n')
    .replace(/`{1,3}\s*\n\n(\[[^\]]+\]\([^\)]+\))\n\n\s*`{1,3}/g, '\n\n$1\n\n');
}

function isSafeExistingAbsoluteFilePath(candidatePath: string): boolean {
  return path.isAbsolute(candidatePath)
    && !!path.extname(candidatePath)
    && fs.existsSync(candidatePath);
}

function resolveWorkspaceRelativeFilePath(candidatePath: string, workspacePath?: string | null): string | null {
  if (!workspacePath) return null;

  const normalized = candidatePath.trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('://') || normalized.startsWith('~/')) {
    return null;
  }

  const absoluteWorkspacePath = path.resolve(workspacePath);
  const absoluteCandidatePath = path.resolve(absoluteWorkspacePath, normalized);
  const relativeToWorkspace = path.relative(absoluteWorkspacePath, absoluteCandidatePath);

  if (
    !relativeToWorkspace
    || relativeToWorkspace.startsWith('..')
    || path.isAbsolute(relativeToWorkspace)
    || !path.extname(absoluteCandidatePath)
    || !fs.existsSync(absoluteCandidatePath)
  ) {
    return null;
  }

  return absoluteCandidatePath;
}

export function rewriteVisibleFileLinks(text: string, options: RewriteVisibleFileLinkOptions = {}): string {
  if (!text) return text;

  let rewritten = text.replace(ABSOLUTE_PATH_REGEX, (match, _pathMatch, offset, source) => {
    if (match.split('/').length < 3) return match;
    if (match.includes('://')) return match;
    if (offset > 0 && source[offset - 1] === ':') return match;
    if (offset > 0 && source[offset - 1] === '(') return match;
    if (!isSafeExistingAbsoluteFilePath(match)) return match;
    return buildMarkdownDownloadLink(match);
  });

  if (options.workspacePath) {
    rewritten = rewritten.replace(RELATIVE_PATH_REGEX, (fullMatch, prefix, candidatePath, offset, source) => {
      const candidateOffset = offset + prefix.length;
      if (candidateOffset > 0 && source[candidateOffset - 1] === '(') {
        return fullMatch;
      }
      if (prefix === '[' || source.slice(candidateOffset + candidatePath.length, candidateOffset + candidatePath.length + 2) === '](') {
        return fullMatch;
      }

      const absoluteCandidatePath = resolveWorkspaceRelativeFilePath(candidatePath, options.workspacePath);
      if (!absoluteCandidatePath) {
        return fullMatch;
      }

      return `${prefix}${buildMarkdownDownloadLink(absoluteCandidatePath)}`;
    });
  }

  return cleanupRewrittenFileLinks(rewritten);
}
