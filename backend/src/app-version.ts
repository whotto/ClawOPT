import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

type RootPackageJson = {
  name?: string;
  version?: string;
  description?: string;
  appName?: string;
  homepage?: string;
  repository?: string | { type?: string; url?: string };
};

type BuildMeta = {
  appName?: string | null;
  buildTime?: string | null;
  commit?: string | null;
};

type GitHubRepositoryInfo = {
  owner: string;
  repo: string;
  slug: string;
  htmlUrl: string;
  releasesUrl: string;
  apiUrl: string;
};

export type CurrentAppVersionInfo = {
  appName: string;
  version: string;
  releaseTag: string;
  commit: string | null;
  buildTime: string | null;
  repositoryUrl: string | null;
  openclawVersion: string | null;
};

export type LatestVersionInfo = {
  appName: string;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  status: 'update_available' | 'up_to_date' | 'no_release';
  releaseTag: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadUrl: string | null;
  repositoryUrl: string | null;
  canUpgrade: false;
  upgradeSupported: false;
  upgradeReasonCode: 'version.directUpgradeUnsupported';
  upgradeReason: string;
};

const repoRoot = path.resolve(__dirname, '..', '..');
const rootPackageJsonPath = path.join(repoRoot, 'package.json');
const buildMetaPath = path.join(repoRoot, '.clawopt-build.json');
const githubApiAcceptHeader = 'application/vnd.github+json';
const githubLookupUserAgent = 'ClawOPT-VersionLookup';
const githubLookupTimeoutMs = 10000;
const directUpgradeReason = 'Automatic in-place upgrade is not enabled. Updating this app requires a server-side deploy script, dependency install, and service restart on the host machine.';

function readRootPackageJson(): RootPackageJson {
  return JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8')) as RootPackageJson;
}

function readBuildMeta(): BuildMeta | null {
  if (!fs.existsSync(buildMetaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(buildMetaPath, 'utf-8')) as BuildMeta;
  } catch {
    return null;
  }
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeVersion(version: string | null | undefined): string {
  return String(version || '').trim().replace(/^v/i, '');
}

function toReleaseTag(version: string): string {
  return `v${normalizeVersion(version)}`;
}

function normalizeRepositoryUrl(repository: RootPackageJson['repository']): string | null {
  if (typeof repository === 'string' && repository.trim()) return repository.trim();
  if (repository && typeof repository === 'object' && typeof repository.url === 'string' && repository.url.trim()) {
    return repository.url.trim();
  }
  return null;
}

function safeReadGit(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function parseGitHubRepository(repositoryUrl: string | null): GitHubRepositoryInfo | null {
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

function resolveGitHubRepository(rootPackageJson: RootPackageJson): GitHubRepositoryInfo | null {
  const explicitRepository = normalizeText(process.env.CLAWOPT_GITHUB_REPOSITORY);
  if (explicitRepository) {
    const normalizedOverride = explicitRepository.includes('github.com')
      ? explicitRepository
      : `https://github.com/${explicitRepository}`;
    return parseGitHubRepository(normalizedOverride);
  }

  const packageRepository = normalizeRepositoryUrl(rootPackageJson.repository);
  const gitRemote = safeReadGit(['remote', 'get-url', 'origin']);
  return parseGitHubRepository(packageRepository || gitRemote);
}

function parseSemver(version: string): { core: number[]; prerelease: string[] | null } | null {
  const normalized = normalizeVersion(version);
  if (!normalized) return null;
  const [corePart, prereleasePart] = normalized.split('-', 2);
  const core = corePart.split('.').map((segment) => Number.parseInt(segment, 10));
  if (core.length === 0 || core.some((segment) => Number.isNaN(segment))) return null;
  return {
    core,
    prerelease: prereleasePart ? prereleasePart.split('.').filter(Boolean) : null,
  };
}

function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) {
    return normalizeVersion(a).localeCompare(normalizeVersion(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  const maxLength = Math.max(parsedA.core.length, parsedB.core.length);
  for (let index = 0; index < maxLength; index += 1) {
    const segmentA = parsedA.core[index] ?? 0;
    const segmentB = parsedB.core[index] ?? 0;
    if (segmentA !== segmentB) return segmentA > segmentB ? 1 : -1;
  }

  if (!parsedA.prerelease && !parsedB.prerelease) return 0;
  if (!parsedA.prerelease) return 1;
  if (!parsedB.prerelease) return -1;

  const maxPreLength = Math.max(parsedA.prerelease.length, parsedB.prerelease.length);
  for (let index = 0; index < maxPreLength; index += 1) {
    const segmentA = parsedA.prerelease[index];
    const segmentB = parsedB.prerelease[index];
    if (segmentA === undefined) return -1;
    if (segmentB === undefined) return 1;
    const numericA = Number.parseInt(segmentA, 10);
    const numericB = Number.parseInt(segmentB, 10);
    const bothNumeric = !Number.isNaN(numericA) && !Number.isNaN(numericB);
    if (bothNumeric && numericA !== numericB) return numericA > numericB ? 1 : -1;
    if (!bothNumeric && segmentA !== segmentB) return segmentA.localeCompare(segmentB, undefined, { numeric: true, sensitivity: 'base' });
  }

  return 0;
}

function readCurrentAppVersionInfoFromDisk(): CurrentAppVersionInfo {
  const rootPackageJson = readRootPackageJson();
  const buildMeta = readBuildMeta();
  const repository = resolveGitHubRepository(rootPackageJson);
  const version = normalizeVersion(rootPackageJson.version || '0.0.0') || '0.0.0';
  const appName = normalizeText(rootPackageJson.appName)
    || normalizeText(buildMeta?.appName)
    || normalizeText(rootPackageJson.description)
    || normalizeText(rootPackageJson.name)
    || 'ClawOPT';

  return {
    appName,
    version,
    releaseTag: toReleaseTag(version),
    commit: normalizeText(process.env.CLAWOPT_BUILD_COMMIT) || normalizeText(buildMeta?.commit) || safeReadGit(['rev-parse', '--short', 'HEAD']),
    buildTime: normalizeText(process.env.CLAWOPT_BUILD_TIME) || normalizeText(buildMeta?.buildTime),
    repositoryUrl: repository?.htmlUrl || normalizeText(rootPackageJson.homepage),
    openclawVersion: null,
  };
}

const runningAppVersionInfo = readCurrentAppVersionInfoFromDisk();

export function getCurrentAppVersionInfo(): CurrentAppVersionInfo {
  return {
    ...runningAppVersionInfo,
  };
}

export async function getLatestVersionInfo(): Promise<LatestVersionInfo> {
  const current = getCurrentAppVersionInfo();
  const rootPackageJson = readRootPackageJson();
  const repository = resolveGitHubRepository(rootPackageJson);

  if (!repository) {
    throw new Error('GitHub repository is not configured in root package.json repository or git remote origin.');
  }

  const headers: Record<string, string> = {
    Accept: githubApiAcceptHeader,
    'User-Agent': githubLookupUserAgent,
  };
  const token = normalizeText(process.env.GITHUB_TOKEN) || normalizeText(process.env.GH_TOKEN);
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), githubLookupTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${repository.apiUrl}/releases/latest`, {
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`GitHub Releases request timed out after ${githubLookupTimeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    const repositoryProbeResponse = await fetch(repository.apiUrl, { headers });
    if (repositoryProbeResponse.status === 404) {
      throw new Error(`GitHub repository ${repository.slug} was not found.`);
    }
    if (!repositoryProbeResponse.ok) {
      const detail = normalizeText(await repositoryProbeResponse.text()) || `GitHub repository probe failed with HTTP ${repositoryProbeResponse.status}.`;
      throw new Error(detail);
    }
    return {
      appName: current.appName,
      currentVersion: current.version,
      latestVersion: null,
      hasUpdate: false,
      status: 'no_release',
      releaseTag: null,
      releaseName: null,
      publishedAt: null,
      releaseNotes: null,
      releaseUrl: repository.releasesUrl,
      downloadUrl: null,
      repositoryUrl: repository.htmlUrl,
      canUpgrade: false,
      upgradeSupported: false,
      upgradeReasonCode: 'version.directUpgradeUnsupported',
      upgradeReason: directUpgradeReason,
    };
  }

  if (!response.ok) {
    const detail = normalizeText(await response.text()) || `GitHub Releases request failed with HTTP ${response.status}.`;
    throw new Error(detail);
  }

  const data = await response.json() as {
    tag_name?: string;
    name?: string;
    body?: string;
    html_url?: string;
    published_at?: string;
    assets?: Array<{ browser_download_url?: string }>;
  };

  const latestVersion = normalizeVersion(normalizeText(data.tag_name) || normalizeText(data.name) || '');
  const hasUpdate = latestVersion ? compareSemver(latestVersion, current.version) > 0 : false;
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const firstDownloadAsset = assets.find((asset) => normalizeText(asset.browser_download_url)) || null;

  return {
    appName: current.appName,
    currentVersion: current.version,
    latestVersion: latestVersion || null,
    hasUpdate,
    status: hasUpdate ? 'update_available' : 'up_to_date',
    releaseTag: normalizeText(data.tag_name),
    releaseName: normalizeText(data.name) || normalizeText(data.tag_name),
    publishedAt: normalizeText(data.published_at),
    releaseNotes: typeof data.body === 'string' ? data.body : null,
    releaseUrl: normalizeText(data.html_url) || repository.releasesUrl,
    downloadUrl: firstDownloadAsset?.browser_download_url || null,
    repositoryUrl: repository.htmlUrl,
    canUpgrade: false,
    upgradeSupported: false,
    upgradeReasonCode: 'version.directUpgradeUnsupported',
    upgradeReason: directUpgradeReason,
  };
}
