import fs from 'fs';
import path from 'path';

const ABSOLUTE_PATH_REGEX = /(\/(?:[^\s\)\]\u0022\u0027\u0060\*|<>\uff08\uff09\u3010\u3011\u300a\u300b\u300c\u300d]+))/g;
const ARTIFACT_CLOCK_SKEW_MS = 4000;
const MAX_RECENT_ARTIFACTS = 12;
const ARTIFACT_EXTENSIONS = new Set([
  '.7z',
  '.aac',
  '.avi',
  '.bmp',
  '.bz2',
  '.csv',
  '.doc',
  '.docx',
  '.epub',
  '.flac',
  '.fodp',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.odp',
  '.ods',
  '.odt',
  '.ogg',
  '.opus',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.rar',
  '.svg',
  '.tar',
  '.tgz',
  '.tsv',
  '.wav',
  '.weba',
  '.webm',
  '.webp',
  '.xls',
  '.xlsx',
  '.zip',
]);
const IGNORED_DIR_NAMES = new Set([
  '.cache',
  '.git',
  '.mypy_cache',
  '.openclaw',
  '.pytest_cache',
  '.venv',
  '__pycache__',
  'memory',
  'node_modules',
  'state',
  'tmp',
  'tmp_ppt',
  'tmp_ppt_pkg',
  'uploads',
  'venv',
]);

type WorkspaceArtifact = {
  absolutePath: string;
  filenameLower: string;
  stemLower: string;
  extensionLower: string;
  parentDirLower: string;
  activityMs: number;
};

function normalizeWorkspacePath(workspacePath?: string | null): string | null {
  if (!workspacePath) return null;
  const trimmed = workspacePath.trim();
  if (!trimmed) return null;

  try {
    const resolved = path.resolve(trimmed);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function isIgnoredDirectoryName(name: string) {
  return IGNORED_DIR_NAMES.has(name) || name.startsWith('.');
}

function isArtifactCandidateFile(fileName: string) {
  return ARTIFACT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function collectRecentWorkspaceArtifacts(workspacePath: string, startedAtMs: number): WorkspaceArtifact[] {
  const rootPath = path.resolve(workspacePath);
  const pendingDirs = [rootPath];
  const artifacts: WorkspaceArtifact[] = [];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (isIgnoredDirectoryName(entry.name)) continue;
        pendingDirs.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !isArtifactCandidateFile(entry.name)) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (!stat.isFile() || stat.size <= 0) {
        continue;
      }

      const activityMs = Math.max(stat.mtimeMs, stat.ctimeMs);
      if ((activityMs + ARTIFACT_CLOCK_SKEW_MS) < startedAtMs) {
        continue;
      }

      const parsed = path.parse(fullPath);
      artifacts.push({
        absolutePath: fullPath,
        filenameLower: parsed.base.toLowerCase(),
        stemLower: parsed.name.toLowerCase(),
        extensionLower: parsed.ext.toLowerCase(),
        parentDirLower: path.basename(path.dirname(fullPath)).toLowerCase(),
        activityMs,
      });
    }
  }

  artifacts.sort((left, right) => {
    if (right.activityMs !== left.activityMs) {
      return right.activityMs - left.activityMs;
    }
    return left.absolutePath.localeCompare(right.absolutePath);
  });

  return artifacts.slice(0, MAX_RECENT_ARTIFACTS);
}

function collectAbsolutePaths(text: string): string[] {
  return text.match(ABSOLUTE_PATH_REGEX) || [];
}

function isPathWithinWorkspace(candidatePath: string, workspacePath: string) {
  const resolvedCandidate = path.resolve(candidatePath);
  const relativePath = path.relative(workspacePath, resolvedCandidate);
  return relativePath === ''
    || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveArtifactReplacement(
  candidatePath: string,
  workspacePath: string,
  artifacts: WorkspaceArtifact[],
): string | null {
  if (!isPathWithinWorkspace(candidatePath, workspacePath)) {
    return null;
  }

  const resolvedCandidate = path.resolve(candidatePath);
  if (fs.existsSync(resolvedCandidate)) {
    return resolvedCandidate;
  }

  const parsedCandidate = path.parse(resolvedCandidate);
  const filenameLower = parsedCandidate.base.toLowerCase();
  const stemLower = parsedCandidate.name.toLowerCase();
  const extensionLower = parsedCandidate.ext.toLowerCase();
  const parentDirLower = path.basename(path.dirname(resolvedCandidate)).toLowerCase();

  let bestMatch: WorkspaceArtifact | null = null;
  let bestScore = 0;
  let duplicateBestScore = false;

  for (const artifact of artifacts) {
    let score = 0;

    if (artifact.filenameLower === filenameLower && filenameLower) {
      score += 120;
    }
    if (artifact.stemLower === stemLower && stemLower) {
      score += 80;
    }
    if (artifact.extensionLower === extensionLower && extensionLower) {
      score += 20;
    }
    if (artifact.parentDirLower === parentDirLower && parentDirLower) {
      score += 10;
    }

    if (score <= 0) {
      continue;
    }

    if (score > bestScore) {
      bestMatch = artifact;
      bestScore = score;
      duplicateBestScore = false;
      continue;
    }

    if (score === bestScore) {
      duplicateBestScore = true;
    }
  }

  if (!bestMatch || duplicateBestScore || bestScore < 80) {
    return null;
  }

  return bestMatch.absolutePath;
}

export function canonicalizeAssistantWorkspaceArtifacts(
  text: string,
  options: {
    workspacePath?: string | null;
    startedAtMs?: number | null;
  } = {},
): string {
  if (!text.trim()) {
    return text;
  }

  const workspacePath = normalizeWorkspacePath(options.workspacePath);
  const startedAtMs = Number(options.startedAtMs);
  if (!workspacePath || !Number.isFinite(startedAtMs) || startedAtMs <= 0) {
    return text;
  }

  const artifacts = collectRecentWorkspaceArtifacts(workspacePath, startedAtMs);
  if (artifacts.length === 0) {
    return text;
  }

  const replacedText = text.replace(ABSOLUTE_PATH_REGEX, (match) => {
    const replacement = resolveArtifactReplacement(match, workspacePath, artifacts);
    return replacement || match;
  });

  const surfacedPaths = new Set(
    collectAbsolutePaths(replacedText).map((candidatePath) => {
      try {
        return path.resolve(candidatePath);
      } catch {
        return candidatePath;
      }
    }),
  );

  const missingArtifactPaths = artifacts
    .map((artifact) => artifact.absolutePath)
    .filter((artifactPath) => !surfacedPaths.has(artifactPath));

  if (missingArtifactPaths.length === 0) {
    return replacedText;
  }

  return `${replacedText.trim()}\n\n${missingArtifactPaths.join('\n')}`.trim();
}
