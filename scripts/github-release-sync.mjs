import fs from 'fs';
import path from 'path';
import {
  buildReleaseName,
  normalizeVersion,
  readRootPackageJson,
  repoRoot,
  resolveGitHubRepository,
  runGit,
  toReleaseTag,
} from './versioning-utils.mjs';

const args = new Set(process.argv.slice(2));
const createTag = args.has('--create-tag');
const pushTag = args.has('--push');
const syncGitHubRelease = args.has('--github-release');
const verifyTagRef = args.has('--verify-tag-ref');

const packageJson = readRootPackageJson();
const version = normalizeVersion(packageJson.version);
if (!version) {
  throw new Error('Root package.json is missing a valid version value.');
}

const releaseTag = toReleaseTag(version);
const releaseName = buildReleaseName(version);
const repository = resolveGitHubRepository();
const hasExplicitAction = createTag || pushTag || syncGitHubRelease;

if (!repository) {
  throw new Error('Unable to resolve GitHub repository from root package.json repository or git remote origin.');
}

const refName = process.env.GITHUB_REF_NAME?.trim();
if (verifyTagRef && refName && refName !== releaseTag) {
  throw new Error(`Git ref ${refName} does not match root package version ${version} (${releaseTag}).`);
}

function localTagExists(tag) {
  return Boolean(runGit(['rev-parse', '--verify', `refs/tags/${tag}`], { allowFailure: true }));
}

function createAnnotatedTag(tag, message) {
  runGit(['tag', '-a', tag, '-m', message]);
}

function pushTagToOrigin(tag) {
  runGit(['push', 'origin', tag]);
}

function readReleaseNotes() {
  const notesFile = process.env.GITHUB_RELEASE_NOTES_FILE?.trim();
  if (notesFile) {
    const resolvedPath = path.isAbsolute(notesFile) ? notesFile : path.join(repoRoot, notesFile);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Release notes file not found: ${resolvedPath}`);
    }
    return fs.readFileSync(resolvedPath, 'utf-8').trim();
  }
  return `Release ${releaseTag}`;
}

async function requestGitHub(method, pathname, body) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required to sync GitHub releases.');
  }

  const response = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ClawOPT-ReleaseSync',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${method} ${pathname} failed: ${response.status} ${detail}`);
  }

  return response.json();
}

async function upsertGitHubRelease() {
  const notes = readReleaseNotes();
  const existingRelease = await requestGitHub('GET', `/repos/${repository.slug}/releases/tags/${releaseTag}`);
  const payload = {
    tag_name: releaseTag,
    name: releaseName,
    body: notes,
    draft: false,
    prerelease: false,
    generate_release_notes: false,
  };

  if (existingRelease?.id) {
    const updated = await requestGitHub('PATCH', `/repos/${repository.slug}/releases/${existingRelease.id}`, payload);
    console.log(`Updated GitHub Release ${updated.html_url}`);
    return;
  }

  const created = await requestGitHub('POST', `/repos/${repository.slug}/releases`, payload);
  console.log(`Created GitHub Release ${created.html_url}`);
}

const tagExists = localTagExists(releaseTag);

if (!hasExplicitAction) {
  console.log(JSON.stringify({
    version,
    releaseTag,
    repository: repository.slug,
    localTagExists: tagExists,
  }, null, 2));
  process.exit(0);
}

if (!tagExists) {
  if (!createTag) {
    throw new Error(`Git tag ${releaseTag} does not exist. Run npm run release:tag first.`);
  }
  createAnnotatedTag(releaseTag, `Release ${releaseTag}`);
  console.log(`Created local tag ${releaseTag}`);
} else {
  console.log(`Local tag ${releaseTag} already exists`);
}

if (pushTag) {
  pushTagToOrigin(releaseTag);
  console.log(`Pushed tag ${releaseTag} to origin`);
}

if (syncGitHubRelease) {
  await upsertGitHubRelease();
}

console.log(`Version sync complete for ${releaseTag} using ${repository.slug}`);
