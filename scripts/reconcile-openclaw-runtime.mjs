import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PHASE_PREFIX = '::clawopt-update-phase::';
const OPENCLAW_EXECUTABLE = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
const BROWSER_PROFILE = 'openclaw';
const BROWSER_TEST_URL = 'https://example.com';
const BROWSER_FALLBACK_TEST_URL = 'http://example.com';
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const LOCAL_CLIENT_MODES = new Map([
  ['cli', new Set(['cli', 'probe'])],
  ['openclaw-control-ui', new Set(['webchat'])],
]);
const ALLOWED_OPERATOR_REPAIR_SCOPES = new Set([
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.approvals',
  'operator.pairing',
  'operator.talk.secrets',
]);
const SNAPSHOT_RETRY_COUNT = 5;
const BROWSER_RUNNING_RETRY_COUNT = 5;
const BROWSER_RETRY_DELAY_MS = 2000;
const GATEWAY_READY_RETRY_COUNT = 10;
const GATEWAY_READY_DELAY_MS = 3000;

function emitPhase(phase) {
  process.stdout.write(`${PHASE_PREFIX}${phase}\n`);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isExampleDomainSnapshot(snapshot) {
  return normalizeText(snapshot).includes('Example Domain');
}

function isCertificateInterstitialSnapshot(snapshot) {
  const normalized = normalizeText(snapshot);
  return /ERR_CERT_/i.test(normalized)
    || normalized.includes('您的连接不是私密连接')
    || normalized.includes('Your connection is not private');
}

function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function collectOpenClawPackageRoots() {
  const moduleBaseDirs = [
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(os.homedir(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules'),
  ];
  const roots = [];
  const seen = new Set();

  const pushRoot = (candidate) => {
    const normalized = normalizeText(candidate);
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

  const globalBinPath = path.join(os.homedir(), '.npm-global', 'bin', OPENCLAW_EXECUTABLE);
  try {
    const resolvedFromBin = fs.realpathSync(globalBinPath);
    pushRoot(path.dirname(resolvedFromBin));
  } catch {}

  return roots;
}

function collectOpenClawPackageEntryCandidates() {
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (candidate) => {
    const normalized = normalizeText(candidate);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  for (const packageRoot of collectOpenClawPackageRoots()) {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    try {
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
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

function findOpenClawExecutable() {
  const candidates = [
    normalizeText(process.env.OPENCLAW_BIN),
    ...normalizeText(process.env.PATH)
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.join(entry, OPENCLAW_EXECUTABLE)),
    path.join(os.homedir(), '.npm-global', 'bin', OPENCLAW_EXECUTABLE),
    path.join(os.homedir(), '.local', 'bin', OPENCLAW_EXECUTABLE),
    '/usr/local/bin/openclaw',
    '/usr/bin/openclaw',
    ...collectOpenClawPackageEntryCandidates(),
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(`OpenClaw CLI not found. Checked: ${Array.from(seen).join(', ')}`);
}

function findShellResolvedOpenClawCommand() {
  const seen = new Set();
  const pathEntries = normalizeText(process.env.PATH)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, OPENCLAW_EXECUTABLE);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getPreferredOpenClawShellEntrypointPath() {
  const homeDir = os.homedir();
  const preferredDirs = [
    path.join(homeDir, '.npm-global', 'bin'),
    path.join(homeDir, '.local', 'bin'),
  ];
  const pathEntries = normalizeText(process.env.PATH)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const preferredDir of preferredDirs) {
    if (pathEntries.includes(preferredDir)) {
      return path.join(preferredDir, OPENCLAW_EXECUTABLE);
    }
  }

  return path.join(preferredDirs[0], OPENCLAW_EXECUTABLE);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildOpenClawShellWrapperScript(resolvedExecutablePath) {
  const preferredCandidates = [
    normalizeText(resolvedExecutablePath),
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

async function canRunOpenClawExecutable(executablePath) {
  try {
    await runCommand(executablePath, ['--version'], {
      timeout: 15000,
      label: `${executablePath} --version`,
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureOpenClawShellEntrypoint(executablePath) {
  if (process.platform === 'win32') {
    return null;
  }

  const shellResolvedPath = findShellResolvedOpenClawCommand();
  if (shellResolvedPath && await canRunOpenClawExecutable(shellResolvedPath)) {
    log(`OpenClaw shell entrypoint is healthy: ${shellResolvedPath}`);
    return shellResolvedPath;
  }

  const shellEntrypointPath = getPreferredOpenClawShellEntrypointPath();
  fs.mkdirSync(path.dirname(shellEntrypointPath), { recursive: true });
  fs.rmSync(shellEntrypointPath, { force: true });
  fs.writeFileSync(shellEntrypointPath, buildOpenClawShellWrapperScript(executablePath), { mode: 0o755 });
  fs.chmodSync(shellEntrypointPath, 0o755);

  if (!await canRunOpenClawExecutable(shellEntrypointPath)) {
    throw new Error(`Failed to repair the OpenClaw shell entrypoint at ${shellEntrypointPath}.`);
  }

  log(`Repaired OpenClaw shell entrypoint: ${shellEntrypointPath}`);
  return shellEntrypointPath;
}

function parseJsonPayload(text) {
  const trimmed = normalizeText(text);
  if (!trimmed) {
    throw new Error('Command returned empty output.');
  }

  const firstBrace = trimmed.search(/[\[{]/);
  if (firstBrace === -1) {
    throw new Error(`Command did not return JSON: ${trimmed}`);
  }

  const payload = trimmed.slice(firstBrace);
  return JSON.parse(payload);
}

function parseBrowserStatusBoolean(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized.startsWith('true')) return true;
  if (normalized.startsWith('false')) return false;
  return null;
}

function parseBrowserStatusText(text) {
  const trimmed = normalizeText(text);
  if (!trimmed) return null;

  const parsed = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9._-]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === 'enabled' || key === 'running' || key === 'headless') {
      const parsedBoolean = parseBrowserStatusBoolean(value);
      if (parsedBoolean !== null) {
        parsed[key] = parsedBoolean;
      }
      continue;
    }

    if (key === 'profile') {
      parsed.profile = normalizeText(value);
    } else if (key === 'transport') {
      parsed.transport = normalizeText(value);
    } else if (key === 'browser' || key === 'chosenbrowser') {
      parsed.chosenBrowser = normalizeText(value);
    } else if (key === 'detectedbrowser') {
      parsed.detectedBrowser = normalizeText(value);
    } else if (key === 'detecterror') {
      const detail = normalizeText(value);
      parsed.detectError = /^(none|null|n\/a)$/i.test(detail) ? '' : detail;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

function parseBrowserStatusOutput(...outputs) {
  for (const output of outputs) {
    const trimmed = normalizeText(output);
    if (!trimmed) continue;

    try {
      return parseJsonPayload(trimmed);
    } catch {}

    const parsedText = parseBrowserStatusText(trimmed);
    if (parsedText) {
      return parsedText;
    }
  }

  throw new Error('OpenClaw browser status did not return parseable output.');
}

function scopeList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
}

function isAllowedLocalClient(clientId, clientMode) {
  const normalizedClientId = normalizeText(clientId);
  const normalizedClientMode = normalizeText(clientMode);
  const allowedModes = LOCAL_CLIENT_MODES.get(normalizedClientId);
  return Boolean(allowedModes && allowedModes.has(normalizedClientMode));
}

function readOpenClawConfig() {
  if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8'));
}

async function runCommand(file, args, options = {}) {
  const timeout = options.timeout ?? 30000;
  const label = options.label ?? `${file} ${args.join(' ')}`;

  try {
    const result = await execFileAsync(file, args, {
      timeout,
      maxBuffer: 1024 * 1024 * 8,
      env: process.env,
    });

    return {
      ok: true,
      stdout: normalizeText(result.stdout),
      stderr: normalizeText(result.stderr),
    };
  } catch (error) {
    const stdout = normalizeText(error?.stdout);
    const stderr = normalizeText(error?.stderr);
    const detail = stderr || stdout || error?.message || `Command failed: ${label}`;
    const wrapped = new Error(`${label} failed: ${detail}`);
    wrapped.stdout = stdout;
    wrapped.stderr = stderr;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function runOpenClaw(executablePath, args, options = {}) {
  return runCommand(executablePath, args, {
    ...options,
    label: `openclaw ${args.join(' ')}`,
  });
}

function isRetryableGatewayError(error) {
  const detail = normalizeText(error instanceof Error ? error.message : String(error)).toLowerCase();
  return detail.includes('gateway timeout')
    || detail.includes('connect econnrefused')
    || detail.includes('socket hang up')
    || detail.includes('failed to start cli');
}

async function listDevicesJson(executablePath) {
  const result = await runOpenClaw(executablePath, ['devices', 'list', '--json'], { timeout: 30000 });
  return parseJsonPayload(result.stdout);
}

async function waitForGatewayReady(executablePath, context) {
  let lastError = null;

  for (let attempt = 1; attempt <= GATEWAY_READY_RETRY_COUNT; attempt += 1) {
    try {
      await listDevicesJson(executablePath);
      if (attempt > 1) {
        log(`OpenClaw gateway became ready after ${attempt} attempts (${context}).`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableGatewayError(error) || attempt === GATEWAY_READY_RETRY_COUNT) {
        throw error;
      }
      log(`Waiting for OpenClaw gateway to become ready (${context}), attempt ${attempt}/${GATEWAY_READY_RETRY_COUNT}...`);
      await sleep(GATEWAY_READY_DELAY_MS);
    }
  }

  throw lastError ?? new Error(`OpenClaw gateway did not become ready (${context}).`);
}

async function ensureGatewayServiceAligned(executablePath) {
  emitPhase('reconcile-openclaw-runtime');

  const config = readOpenClawConfig();
  const installArgs = ['gateway', 'install', '--force', '--json'];
  const configuredPort = Number(config?.gateway?.port);
  if (Number.isFinite(configuredPort) && configuredPort > 0) {
    installArgs.push('--port', String(configuredPort));
  }

  log('Aligning OpenClaw gateway service with the current CLI install...');
  await runOpenClaw(executablePath, installArgs, { timeout: 120000 });

  log('Restarting OpenClaw gateway service after service reinstall...');
  await runOpenClaw(executablePath, ['gateway', 'restart', '--json'], { timeout: 120000 });
  await waitForGatewayReady(executablePath, 'post-gateway-restart');
}

function isEligibleRepairRequest(pending, pairedEntries) {
  if (!pending || pending.isRepair !== true) return false;
  if (normalizeText(pending.role) !== 'operator') return false;
  if (!isAllowedLocalClient(pending.clientId, pending.clientMode)) return false;

  const paired = pairedEntries.find((entry) => normalizeText(entry.deviceId) === normalizeText(pending.deviceId));
  if (!paired) return false;
  if (normalizeText(paired.role) !== 'operator') return false;
  if (!isAllowedLocalClient(paired.clientId, paired.clientMode)) return false;
  if (normalizeText(paired.clientId) !== normalizeText(pending.clientId)) return false;

  const pendingPublicKey = normalizeText(pending.publicKey);
  const pairedPublicKey = normalizeText(paired.publicKey);
  if (pendingPublicKey && pairedPublicKey && pendingPublicKey !== pairedPublicKey) {
    return false;
  }

  const requestedScopes = scopeList(pending.scopes);
  const approvedScopes = scopeList(paired.approvedScopes || paired.scopes);
  if (requestedScopes.length === 0 || approvedScopes.length === 0) return false;
  if (requestedScopes.some((scope) => !ALLOWED_OPERATOR_REPAIR_SCOPES.has(scope))) return false;
  if (approvedScopes.some((scope) => !requestedScopes.includes(scope))) return false;

  return requestedScopes.some((scope) => !approvedScopes.includes(scope));
}

async function reconcileLocalDeviceRepairs(executablePath) {
  emitPhase('repair-openclaw-device');
  log('Checking for local OpenClaw device repair requests...');

  const before = await listDevicesJson(executablePath);
  const pending = Array.isArray(before.pending) ? before.pending : [];
  const paired = Array.isArray(before.paired) ? before.paired : [];
  const eligible = pending.filter((entry) => isEligibleRepairRequest(entry, paired));

  if (eligible.length === 0) {
    log('No eligible local repair requests were found.');
    return;
  }

  for (const entry of eligible) {
    const requestedScopes = scopeList(entry.scopes).join(', ');
    log(`Approving local repair request ${entry.requestId} for ${entry.clientId}/${entry.clientMode} scopes: ${requestedScopes}`);
    await runOpenClaw(
      executablePath,
      ['devices', 'approve', normalizeText(entry.requestId), '--json'],
      { timeout: 30000 }
    );
  }

  const after = await listDevicesJson(executablePath);
  const afterPending = Array.isArray(after.pending) ? after.pending : [];
  const afterPaired = Array.isArray(after.paired) ? after.paired : [];

  for (const entry of eligible) {
    const stillPending = afterPending.some((pendingEntry) => normalizeText(pendingEntry.requestId) === normalizeText(entry.requestId));
    if (stillPending) {
      throw new Error(`Local repair request ${entry.requestId} is still pending after approval.`);
    }

    const pairedEntry = afterPaired.find((pairedItem) => normalizeText(pairedItem.deviceId) === normalizeText(entry.deviceId));
    const requestedScopes = scopeList(entry.scopes);
    const approvedScopes = scopeList(pairedEntry?.approvedScopes || pairedEntry?.scopes);
    if (!pairedEntry || requestedScopes.some((scope) => !approvedScopes.includes(scope))) {
      throw new Error(`Device ${entry.deviceId} did not receive the requested operator scopes after approval.`);
    }
  }
}

async function stopBrowserBestEffort(executablePath) {
  try {
    await runOpenClaw(
      executablePath,
      ['browser', '--browser-profile', BROWSER_PROFILE, '--timeout', '12000', 'stop'],
      { timeout: 18000 }
    );
  } catch (error) {
    log(`Browser stop skipped: ${error.message}`);
  }
}

async function readBrowserStatus(executablePath) {
  const result = await runOpenClaw(
    executablePath,
    ['browser', '--json', '--browser-profile', BROWSER_PROFILE, '--timeout', '15000', 'status'],
    { timeout: 20000 }
  );
  return parseBrowserStatusOutput(result.stdout, result.stderr);
}

async function waitForBrowserRunning(executablePath) {
  let lastStatus = null;

  for (let attempt = 1; attempt <= BROWSER_RUNNING_RETRY_COUNT; attempt += 1) {
    lastStatus = await readBrowserStatus(executablePath);
    if (lastStatus.enabled === true && lastStatus.running === true) {
      return lastStatus;
    }
    await sleep(BROWSER_RETRY_DELAY_MS);
  }

  return lastStatus;
}

async function captureExampleDomainSnapshot(executablePath) {
  let lastSnapshot = null;

  for (let attempt = 1; attempt <= SNAPSHOT_RETRY_COUNT; attempt += 1) {
    const snapshotResult = await runOpenClaw(
      executablePath,
      ['browser', '--browser-profile', BROWSER_PROFILE, '--timeout', '30000', 'snapshot'],
      { timeout: 45000 }
    );
    lastSnapshot = snapshotResult.stdout;
    if (isExampleDomainSnapshot(snapshotResult.stdout)) {
      return snapshotResult.stdout;
    }
    await sleep(BROWSER_RETRY_DELAY_MS);
  }

  const error = new Error(`Browser snapshot did not capture the Example Domain page. Last snapshot: ${normalizeText(lastSnapshot) || 'empty'}`);
  error.lastSnapshot = lastSnapshot;
  throw error;
}

async function validateBrowserRuntime(executablePath) {
  emitPhase('recover-browser-runtime');
  log(`Validating OpenClaw browser runtime for profile "${BROWSER_PROFILE}"...`);

  const statusBefore = await readBrowserStatus(executablePath);
  log(`Browser status before recovery: enabled=${String(statusBefore.enabled)} running=${String(statusBefore.running)} detected=${normalizeText(statusBefore.detectedBrowser) || 'unknown'}`);

  await stopBrowserBestEffort(executablePath);

  await runOpenClaw(
    executablePath,
    ['browser', '--browser-profile', BROWSER_PROFILE, '--timeout', '20000', 'start'],
    { timeout: 30000 }
  );

  const statusAfter = await waitForBrowserRunning(executablePath);
  if (statusAfter.enabled !== true || statusAfter.running !== true) {
    throw new Error(`Browser runtime did not become healthy after start (enabled=${String(statusAfter.enabled)}, running=${String(statusAfter.running)}).`);
  }

  const openResult = await runOpenClaw(
    executablePath,
    ['browser', '--browser-profile', BROWSER_PROFILE, '--timeout', '30000', 'open', BROWSER_TEST_URL],
    { timeout: 40000 }
  );
  if (!/opened:/i.test(openResult.stdout)) {
    throw new Error(`Browser open command did not confirm navigation to ${BROWSER_TEST_URL}.`);
  }

  try {
    await captureExampleDomainSnapshot(executablePath);
  } catch (error) {
    const lastSnapshot = normalizeText(error?.lastSnapshot);
    if (!isCertificateInterstitialSnapshot(lastSnapshot)) {
      throw error;
    }

    log(`Detected browser certificate interstitial for ${BROWSER_TEST_URL}; retrying runtime validation with ${BROWSER_FALLBACK_TEST_URL}.`);
    const fallbackOpenResult = await runOpenClaw(
      executablePath,
      ['browser', '--browser-profile', BROWSER_PROFILE, '--timeout', '30000', 'open', BROWSER_FALLBACK_TEST_URL],
      { timeout: 40000 }
    );
    if (!/opened:/i.test(fallbackOpenResult.stdout)) {
      throw new Error(`Browser fallback open command did not confirm navigation to ${BROWSER_FALLBACK_TEST_URL}.`);
    }
    await captureExampleDomainSnapshot(executablePath);
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    log('Usage: node scripts/reconcile-openclaw-runtime.mjs');
    log('Align OpenClaw gateway service, auto-approve safe local repair requests, and validate browser runtime.');
    return;
  }

  const executablePath = findOpenClawExecutable();
  log(`Using OpenClaw CLI: ${executablePath}`);
  await ensureOpenClawShellEntrypoint(executablePath);

  await ensureGatewayServiceAligned(executablePath);
  await reconcileLocalDeviceRepairs(executablePath);

  const config = readOpenClawConfig();
  if (config?.browser?.enabled === true) {
    await validateBrowserRuntime(executablePath);
  } else {
    log('Browser is disabled in openclaw.json; skipping browser runtime validation.');
  }

  log('OpenClaw runtime reconciliation completed successfully.');
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
