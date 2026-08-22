import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '..');
export const packageJsonPath = path.join(repoRoot, 'package.json');
export const buildMetaPath = path.join(repoRoot, '.clawopt-build.json');

export function readRootPackageJson() {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
}

export function readBuildMeta() {
  if (!fs.existsSync(buildMetaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(buildMetaPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeBuildMeta(meta) {
  fs.writeFileSync(buildMetaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

export function runGit(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

export function getGitCommit({ short = true } = {}) {
  return runGit(['rev-parse', short ? '--short' : 'HEAD', 'HEAD'], { allowFailure: true });
}

export function getGitRemoteUrl() {
  return runGit(['remote', 'get-url', 'origin'], { allowFailure: true });
}

function normalizeRepositoryUrl(repository) {
  if (typeof repository === 'string' && repository.trim()) return repository.trim();
  if (repository && typeof repository === 'object' && typeof repository.url === 'string' && repository.url.trim()) {
    return repository.url.trim();
  }
  return null;
}

export function parseGitHubRepository(repositoryUrl) {
  if (!repositoryUrl) return null;
  const cleaned = repositoryUrl
    .replace(/^git\+/, '')
    .replace(/^ssh:\/\//, '')
    .replace(/\.git$/i, '');
  const match = cleaned.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/#?]+)$/i);
  if (!match?.groups?.owner || !match.groups.repo) return null;
  return {
    owner: match.groups.owner,
    repo: match.groups.repo,
    slug: `${match.groups.owner}/${match.groups.repo}`,
    htmlUrl: `https://github.com/${match.groups.owner}/${match.groups.repo}`,
    releasesUrl: `https://github.com/${match.groups.owner}/${match.groups.repo}/releases`,
    apiUrl: `https://api.github.com/repos/${match.groups.owner}/${match.groups.repo}`,
  };
}

export function resolveGitHubRepository() {
  const packageJson = readRootPackageJson();
  const repositoryUrl = normalizeRepositoryUrl(packageJson.repository) || getGitRemoteUrl();
  return parseGitHubRepository(repositoryUrl);
}

export function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

export function toReleaseTag(version) {
  return `v${normalizeVersion(version)}`;
}

export function buildReleaseName(version) {
  return toReleaseTag(version);
}

