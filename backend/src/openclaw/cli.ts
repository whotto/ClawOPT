import fs from 'fs';
import path from 'path';
import os from 'os';

import { execFilePromise } from '../core/process';
import { normalizeCliText, shellQuote } from '../core/util';

function isExecutableFile(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

let cachedOpenClawExecutablePath: string | null = null;
let openClawCliRepairInFlight: Promise<string> | null = null;

function resolveOpenClawPackageRootFromPath(inputPath: string | null | undefined): string | null {
  const normalizedInput = normalizeCliText(inputPath);
  if (!normalizedInput) return null;

  let resolvedPath = normalizedInput;
  try {
    resolvedPath = fs.realpathSync(normalizedInput);
  } catch {}

  const marker = `${path.sep}node_modules${path.sep}openclaw${path.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex !== -1) {
    const rootPath = resolvedPath.slice(0, markerIndex + marker.length - 1);
    return normalizeCliText(rootPath) || null;
  }

  let current = resolvedPath;
  try {
    if (!fs.statSync(current).isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (current && current !== path.dirname(current)) {
    if (path.basename(current) === 'openclaw' && path.basename(path.dirname(current)) === 'node_modules') {
      return current;
    }

    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { name?: unknown };
        if (normalizeCliText(packageJson?.name) === 'openclaw') {
          return current;
        }
      } catch {}
    }

    current = path.dirname(current);
  }

  return null;
}

export function collectOpenClawPackageRoots() {
  const npmPrefix = normalizeCliText(process.env.npm_config_prefix);
  const moduleBaseDirs = [
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(os.homedir(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    npmPrefix ? path.join(npmPrefix, 'lib', 'node_modules') : '',
  ];
  const roots: string[] = [];
  const seen = new Set<string>();

  const pushRoot = (candidate: string) => {
    const normalized = normalizeCliText(candidate);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    roots.push(normalized);
  };

  for (const moduleBaseDir of moduleBaseDirs) {
    pushRoot(path.join(moduleBaseDir, 'openclaw'));
    try {
      const stagedRoots = fs.readdirSync(moduleBaseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\.openclaw-/i.test(entry.name))
        .map((entry) => {
          const fullPath = path.join(moduleBaseDir, entry.name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(fullPath).mtimeMs;
          } catch {}
          return { fullPath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const stagedRoot of stagedRoots) {
        pushRoot(stagedRoot.fullPath);
      }
    } catch {}
  }

  const globalBinPath = path.join(os.homedir(), '.npm-global', 'bin', process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
  try {
    const resolvedFromBin = fs.realpathSync(globalBinPath);
    pushRoot(path.dirname(resolvedFromBin));
    const resolvedRoot = resolveOpenClawPackageRootFromPath(resolvedFromBin);
    if (resolvedRoot) {
      pushRoot(resolvedRoot);
    }
  } catch {}

  const executableName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  const executableCandidates = [
    normalizeCliText(process.env.OPENCLAW_BIN),
    path.join(os.homedir(), '.npm-global', 'bin', executableName),
    path.join(os.homedir(), '.local', 'bin', executableName),
    '/usr/local/bin/openclaw',
    '/usr/bin/openclaw',
    ...normalizeCliText(process.env.PATH)
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.join(entry, executableName)),
  ];
  const seenExecutableCandidates = new Set<string>();
  for (const candidate of executableCandidates) {
    const normalizedCandidate = normalizeCliText(candidate);
    if (!normalizedCandidate || seenExecutableCandidates.has(normalizedCandidate)) continue;
    seenExecutableCandidates.add(normalizedCandidate);

    const resolvedRoot = resolveOpenClawPackageRootFromPath(normalizedCandidate);
    if (resolvedRoot) {
      pushRoot(resolvedRoot);
    }
  }

  return roots;
}

function collectOpenClawPackageEntryCandidates() {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: string | null | undefined) => {
    const normalized = normalizeCliText(candidate);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  for (const packageRoot of collectOpenClawPackageRoots()) {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    try {
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
          bin?: string | Record<string, string>;
        };
        if (typeof packageJson.bin === 'string') {
          pushCandidate(path.join(packageRoot, packageJson.bin));
        } else if (packageJson.bin && typeof packageJson.bin === 'object' && typeof packageJson.bin.openclaw === 'string') {
          pushCandidate(path.join(packageRoot, packageJson.bin.openclaw));
        }
      }
    } catch {}

    pushCandidate(path.join(packageRoot, 'openclaw.mjs'));
  }

  return candidates;
}

function findShellResolvedOpenClawCommandPath() {
  const executableName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  const seen = new Set<string>();
  const pathEntries = normalizeCliText(process.env.PATH)
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, executableName);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getPreferredOpenClawShellEntrypointPath() {
  const executableName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  const preferredDirs = [
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
  ];
  const pathEntries = normalizeCliText(process.env.PATH)
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);

  for (const preferredDir of preferredDirs) {
    if (pathEntries.includes(preferredDir)) {
      return path.join(preferredDir, executableName);
    }
  }

  return path.join(preferredDirs[0], executableName);
}

function buildOpenClawShellWrapperScript(resolvedExecutablePath: string) {
  const preferredCandidates = [
    normalizeCliText(resolvedExecutablePath),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'openclaw', 'openclaw.mjs'),
    path.join(os.homedir(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules', 'openclaw', 'openclaw.mjs'),
  ].filter(Boolean);
  const preferredCandidateLines = preferredCandidates
    .map((candidate) => `  ${shellQuote(candidate)}`)
    .join('\n');
  const stagedBaseDirLines = [
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(os.homedir(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules'),
  ].map((candidate) => `  ${shellQuote(candidate)}`).join('\n');

  return `#!/usr/bin/env bash
set -euo pipefail

preferred_candidates=(
${preferredCandidateLines}
)

staged_base_dirs=(
${stagedBaseDirLines}
)

for candidate in "\${preferred_candidates[@]}"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

for base_dir in "\${staged_base_dirs[@]}"; do
  if [ ! -d "$base_dir" ]; then
    continue
  fi

  while IFS= read -r candidate; do
    if [ -x "$candidate" ]; then
      exec "$candidate" "$@"
    fi
  done < <(ls -dt "$base_dir"/.openclaw-*/openclaw.mjs 2>/dev/null || true)
done

echo "OpenClaw CLI not found." >&2
exit 127
`;
}

async function canExecuteOpenClawCommand(filePath: string) {
  try {
    await execFilePromise(filePath, ['--version'], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

export async function ensureOpenClawShellEntrypoint(resolvedExecutablePath: string) {
  if (process.platform === 'win32') {
    return null;
  }

  const shellResolvedPath = findShellResolvedOpenClawCommandPath();
  if (shellResolvedPath && await canExecuteOpenClawCommand(shellResolvedPath)) {
    return shellResolvedPath;
  }

  const shellEntrypointPath = getPreferredOpenClawShellEntrypointPath();
  fs.mkdirSync(path.dirname(shellEntrypointPath), { recursive: true });
  fs.rmSync(shellEntrypointPath, { force: true });
  fs.writeFileSync(shellEntrypointPath, buildOpenClawShellWrapperScript(resolvedExecutablePath), { mode: 0o755 });
  fs.chmodSync(shellEntrypointPath, 0o755);

  if (!await canExecuteOpenClawCommand(shellEntrypointPath)) {
    throw new Error(`Failed to repair the OpenClaw shell entrypoint at ${shellEntrypointPath}.`);
  }

  cachedOpenClawExecutablePath = shellEntrypointPath;
  return shellEntrypointPath;
}

async function readOpenClawGatewayServiceVersion() {
  try {
    const { stdout } = await execFilePromise('systemctl', ['--user', 'show', 'openclaw-gateway.service', '-p', 'Description', '--value'], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const description = normalizeCliText(stdout);
    const matched = description.match(/v?(\d{4}\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
    return matched?.[1] || null;
  } catch {
    return null;
  }
}

async function repairBrokenOpenClawCliInstall(preferredVersion?: string | null) {
  if (openClawCliRepairInFlight) {
    return openClawCliRepairInFlight;
  }

  openClawCliRepairInFlight = (async () => {
    const gatewayReportedVersion = await readOpenClawGatewayServiceVersion();
    const targetVersion = normalizeCliText(preferredVersion) || gatewayReportedVersion || 'latest';
    const packageSpec = targetVersion === 'latest' ? 'openclaw@latest' : `openclaw@${targetVersion}`;

    cachedOpenClawExecutablePath = null;
    await execFilePromise('npm', ['install', '-g', packageSpec], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 20,
      env: process.env,
    });

    cachedOpenClawExecutablePath = null;
    const resolvedExecutablePath = getOpenClawExecutablePath();
    await ensureOpenClawShellEntrypoint(resolvedExecutablePath);
    return cachedOpenClawExecutablePath || resolvedExecutablePath;
  })();

  try {
    return await openClawCliRepairInFlight;
  } finally {
    openClawCliRepairInFlight = null;
  }
}

export async function ensureResolvedOpenClawExecutablePath(preferredRepairVersion?: string | null) {
  try {
    return getOpenClawExecutablePath();
  } catch {
    return repairBrokenOpenClawCliInstall(preferredRepairVersion);
  }
}

function getOpenClawExecutablePath() {
  if (cachedOpenClawExecutablePath && isExecutableFile(cachedOpenClawExecutablePath)) {
    return cachedOpenClawExecutablePath;
  }

  const executableName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  const candidates = [
    normalizeCliText(process.env.OPENCLAW_BIN),
    ...normalizeCliText(process.env.PATH)
      .split(path.delimiter)
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => path.join(entry, executableName)),
    path.join(os.homedir(), '.npm-global', 'bin', executableName),
    path.join(os.homedir(), '.local', 'bin', executableName),
    '/usr/local/bin/openclaw',
    '/usr/bin/openclaw',
    ...collectOpenClawPackageEntryCandidates(),
  ].filter(Boolean);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableFile(candidate)) {
      cachedOpenClawExecutablePath = candidate;
      return candidate;
    }
  }

  throw new Error(
    `OpenClaw CLI not found. Checked: ${Array.from(seen).join(', ')}`
  );
}

export async function readOpenClawVersion() {
  try {
    const executablePath = await ensureResolvedOpenClawExecutablePath();
    const { stdout } = await execFilePromise(executablePath, ['--version']);
    const raw = normalizeCliText(stdout);
    const matched = raw.match(/OpenClaw\s+([^\s(]+)/i);
    return matched?.[1] || raw || null;
  } catch {
    return null;
  }
}
