import { spawn } from 'child_process';

import {
  OPENCLAW_UPDATE_ALREADY_RUNNING_ERROR_CODE,
  OPENCLAW_UPDATE_CANCEL_FAILED_ERROR_CODE,
  OPENCLAW_UPDATE_NO_NEW_VERSION_ERROR_CODE,
  OPENCLAW_UPDATE_NOT_RUNNING_ERROR_CODE,
  StructuredRequestError,
} from '../../core/http';
import { execFilePromise, readCliErrorDetail } from '../../core/process';
import { normalizeCliText } from '../../core/util';
import {
  ensureOpenClawShellEntrypoint,
  ensureResolvedOpenClawExecutablePath,
  type GatewayService,
  OPENCLAW_GATEWAY_RESTART_STABLE_WINDOW_MS,
  readOpenClawVersion,
} from '../../openclaw';
import { BROWSER_HEADED_MODE_RESTART_TIMEOUT_MS } from '../gateway/browser-service';
import type { ImageGenerationService } from '../models/image-generation-service';
import { UPDATE_CANCEL_KILL_TIMEOUT_MS, UPDATE_LOG_LIMIT } from './app-update-service';

type OpenClawLatestVersionInfo = {
  currentVersion: string | null;
  latestVersion: string | null;
  hasUpdate: boolean;
  status: 'update_available' | 'up_to_date';
  channel: string | null;
  channelLabel: string | null;
  installKind: string | null;
  packageManager: string | null;
};

type OpenClawUpdateStatus =
  | 'idle'
  | 'checking'
  | 'updating'
  | 'stopping'
  | 'update_succeeded'
  | 'update_failed';

type OpenClawUpdateSnapshot = {
  status: OpenClawUpdateStatus;
  phase: string | null;
  canCancel: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  message: string | null;
  rawDetail: string | null;
  logs: string[];
  startedAt: string | null;
  updatedAt: string | null;
};

type ActiveOpenClawUpdateProcess = {
  child: ReturnType<typeof spawn>;
  cancelRequested: boolean;
  cancelTimer: NodeJS.Timeout | null;
  phaseTimer: NodeJS.Timeout | null;
};
const OPENCLAW_LATEST_VERSION_CACHE_TTL_MS = 60 * 1000;
const OPENCLAW_UPDATE_RUNTIME_RECONCILE_INTERVAL_MS = 1200;
const OPENCLAW_UPDATE_GATEWAY_RECOVERY_POLL_INTERVAL_MS = 5 * 1000;
const OPENCLAW_UPDATE_SUCCESS_AUTO_RESET_MS = 5000;
const OPENCLAW_UPDATE_CANCELLABLE_PHASES = new Set([
  'download-package',
  'install-package',
  'running-update',
]);

function createDefaultOpenClawUpdateSnapshot(): OpenClawUpdateSnapshot {
  return {
    status: 'idle',
    phase: null,
    canCancel: false,
    currentVersion: null,
    latestVersion: null,
    message: null,
    rawDetail: null,
    logs: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function getOpenClawUpdatePhaseMessage(phase: string) {
  switch (phase) {
    case 'checking-status':
      return 'Checking the latest OpenClaw version.';
    case 'download-package':
      return 'Downloading the OpenClaw update package.';
    case 'install-package':
      return 'Installing the OpenClaw update package.';
    case 'switch-command-entrypoint':
      return 'Switching the OpenClaw command entrypoint.';
    case 'finalize-update':
      return 'Finalizing the OpenClaw package update.';
    case 'running-update':
      return 'Updating OpenClaw.';
    case 'stopping-update':
      return 'Stopping the OpenClaw update.';
    case 'repair-command-entrypoint':
      return 'Repairing the OpenClaw command entrypoint.';
    case 'verifying-version':
      return 'Verifying the upgraded OpenClaw version.';
    case 'complete':
      return 'OpenClaw update completed.';
    default:
      return null;
  }
}

function collectOpenClawUpdateTextFragments(value: unknown, fragments: string[] = [], seen = new Set<string>()) {
  if (typeof value === 'string') {
    const normalized = normalizeCliText(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      fragments.push(normalized);
    }
    return fragments;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectOpenClawUpdateTextFragments(entry, fragments, seen);
    }
    return fragments;
  }

  if (!value || typeof value !== 'object') {
    return fragments;
  }

  const objectValue = value as Record<string, unknown>;
  for (const key of ['message', 'detail', 'summary', 'phase', 'stage', 'step', 'action', 'status', 'event']) {
    if (key in objectValue) {
      collectOpenClawUpdateTextFragments(objectValue[key], fragments, seen);
    }
  }

  for (const key of ['data', 'payload', 'result', 'update']) {
    if (key in objectValue) {
      collectOpenClawUpdateTextFragments(objectValue[key], fragments, seen);
    }
  }

  return fragments;
}

function inferOpenClawUpdatePhaseFromText(text: string) {
  const normalized = normalizeCliText(text).toLowerCase();
  if (!normalized) return null;

  if (/(download|downloading|fetching|retriev|tarball|archive|artifact)/i.test(normalized)) {
    return 'download-package';
  }
  if (/(extract|extracting|unpack|unpacking|install(?:ing|ed)?|apply(?:ing)?|copy(?:ing)? files?|prepar(?:e|ing).*package|node_modules)/i.test(normalized)) {
    return 'install-package';
  }
  if (/(switch|switching|replace|replacing|activate|activating|link|symlink|launcher|entrypoint|bin\/openclaw|shell command)/i.test(normalized)) {
    return 'switch-command-entrypoint';
  }
  if (/(cleanup|cleaning|clean up|finaliz|finishing|completed|postinstall)/i.test(normalized)) {
    return 'finalize-update';
  }
  if (/(verif|confirming version|checking version|validate version)/i.test(normalized)) {
    return 'verifying-version';
  }
  if (/(check|checking).*(update|version)|latest version/i.test(normalized)) {
    return 'checking-status';
  }

  return null;
}

function inferOpenClawUpdatePhaseFromPayload(payload: unknown): string | null {
  const fragments = collectOpenClawUpdateTextFragments(payload);
  for (const fragment of fragments) {
    const phase = inferOpenClawUpdatePhaseFromText(fragment);
    if (phase) {
      return phase;
    }
  }
  return null;
}

function parseOpenClawUpdateOutputLine(line: string) {
  const normalized = normalizeCliText(line);
  if (!normalized) {
    return {
      logLine: '',
      phase: null as string | null,
    };
  }

  let logLine = normalized;
  let phase = inferOpenClawUpdatePhaseFromText(normalized);

  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const fragments = collectOpenClawUpdateTextFragments(parsed);
    if (fragments.length > 0) {
      logLine = fragments.join(' | ');
    }
    phase = inferOpenClawUpdatePhaseFromPayload(parsed) || phase;
  } catch {}

  return {
    logLine,
    phase,
  };
}

export type OpenClawUpdateServiceDeps = {
  imageGeneration: ImageGenerationService;
  gatewayService: GatewayService;
};

export function createOpenClawUpdateService(ctx: OpenClawUpdateServiceDeps) {
  const { scheduleOpenClawImageProviderCacheRefresh } = ctx.imageGeneration;
  const { waitForGatewayConnectionStable } = ctx.gatewayService;

  let openClawUpdateSnapshot = createDefaultOpenClawUpdateSnapshot();
  let activeOpenClawUpdateProcess: ActiveOpenClawUpdateProcess | null = null;
  let cachedOpenClawLatestVersionInfo: OpenClawLatestVersionInfo | null = null;
  let cachedOpenClawLatestVersionCheckedAt = 0;
  let openClawUpdateRuntimeReconcileInFlight: Promise<void> | null = null;
  let openClawUpdateSuccessFinalizeTask: Promise<void> | null = null;
  let lastOpenClawUpdateRuntimeReconcileAt = 0;
  let openClawUpdateSuccessResetTimer: NodeJS.Timeout | null = null;

  function appendOpenClawUpdateLog(message: string) {
    const line = normalizeCliText(message);
    if (!line) return;
    openClawUpdateSnapshot.logs = [...openClawUpdateSnapshot.logs.slice(-(UPDATE_LOG_LIMIT - 1)), line];
    openClawUpdateSnapshot.updatedAt = new Date().toISOString();
  }

  function patchOpenClawUpdateSnapshot(patch: Partial<OpenClawUpdateSnapshot>) {
    openClawUpdateSnapshot = {
      ...openClawUpdateSnapshot,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  function resetOpenClawUpdateSnapshot() {
    if (openClawUpdateSuccessResetTimer) {
      clearTimeout(openClawUpdateSuccessResetTimer);
      openClawUpdateSuccessResetTimer = null;
    }
    openClawUpdateSnapshot = createDefaultOpenClawUpdateSnapshot();
  }

  function scheduleOpenClawUpdateSuccessAutoReset() {
    if (openClawUpdateSuccessResetTimer) {
      clearTimeout(openClawUpdateSuccessResetTimer);
    }
    openClawUpdateSuccessResetTimer = setTimeout(() => {
      if (activeOpenClawUpdateProcess || openClawUpdateSnapshot.status !== 'update_succeeded') {
        return;
      }
      resetOpenClawUpdateSnapshot();
    }, OPENCLAW_UPDATE_SUCCESS_AUTO_RESET_MS);
  }

  function rememberOpenClawLatestVersionInfo(info: OpenClawLatestVersionInfo | null) {
    cachedOpenClawLatestVersionInfo = info;
    cachedOpenClawLatestVersionCheckedAt = info ? Date.now() : 0;
  }

  function getCachedOpenClawLatestVersionInfo(currentVersion?: string | null): OpenClawLatestVersionInfo | null {
    if (!cachedOpenClawLatestVersionInfo || !cachedOpenClawLatestVersionCheckedAt) {
      return null;
    }

    if ((Date.now() - cachedOpenClawLatestVersionCheckedAt) > OPENCLAW_LATEST_VERSION_CACHE_TTL_MS) {
      rememberOpenClawLatestVersionInfo(null);
      return null;
    }

    if (
      currentVersion
      && cachedOpenClawLatestVersionInfo.currentVersion
      && cachedOpenClawLatestVersionInfo.currentVersion !== currentVersion
    ) {
      return null;
    }

    return cachedOpenClawLatestVersionInfo;
  }

  function patchOpenClawUpdatePhaseState(phase: string, patch: Partial<OpenClawUpdateSnapshot> = {}) {
    patchOpenClawUpdateSnapshot({
      phase,
      canCancel: OPENCLAW_UPDATE_CANCELLABLE_PHASES.has(phase),
      message: getOpenClawUpdatePhaseMessage(phase) || openClawUpdateSnapshot.message,
      ...patch,
    });
  }

  function buildOpenClawUpdateStatusResponse(): OpenClawUpdateSnapshot {
    return {
      ...openClawUpdateSnapshot,
    };
  }

  function scheduleOpenClawUpdateSuccessFinalization(options: {
    currentVersion: string | null;
    latestVersion: string | null;
    successLogMessage: string;
  }) {
    if (openClawUpdateSuccessFinalizeTask) {
      return openClawUpdateSuccessFinalizeTask;
    }

    openClawUpdateSuccessFinalizeTask = (async () => {
      try {
        appendOpenClawUpdateLog('Waiting for OpenClaw gateway connection to stabilize after the update.');
        await waitForGatewayConnectionStable(BROWSER_HEADED_MODE_RESTART_TIMEOUT_MS, {
          minimumStableWindowMs: OPENCLAW_GATEWAY_RESTART_STABLE_WINDOW_MS,
          probeIntervalMs: OPENCLAW_UPDATE_GATEWAY_RECOVERY_POLL_INTERVAL_MS,
        });
        patchOpenClawUpdateSnapshot({
          status: 'update_succeeded',
          phase: 'complete',
          canCancel: false,
          currentVersion: options.currentVersion,
          latestVersion: options.latestVersion,
          message: getOpenClawUpdatePhaseMessage('complete'),
          rawDetail: null,
        });
        appendOpenClawUpdateLog(options.successLogMessage);
        scheduleOpenClawImageProviderCacheRefresh('OpenClaw update success');
        scheduleOpenClawUpdateSuccessAutoReset();
      } catch (error) {
        const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
        patchOpenClawUpdateSnapshot({
          status: 'update_failed',
          phase: 'verifying-version',
          canCancel: false,
          message: 'OpenClaw update verification failed.',
          rawDetail: detail,
        });
        appendOpenClawUpdateLog(`OpenClaw update completed, but connection recovery failed: ${detail}`);
      } finally {
        openClawUpdateSuccessFinalizeTask = null;
      }
    })();

    return openClawUpdateSuccessFinalizeTask;
  }

  async function reconcileOpenClawUpdateSnapshotFromRuntime() {
    if (openClawUpdateSnapshot.status !== 'updating') {
      return;
    }

    const latestVersion = normalizeCliText(openClawUpdateSnapshot.latestVersion);
    if (!latestVersion) {
      return;
    }

    const now = Date.now();
    if (openClawUpdateRuntimeReconcileInFlight) {
      await openClawUpdateRuntimeReconcileInFlight;
      return;
    }
    if ((now - lastOpenClawUpdateRuntimeReconcileAt) < OPENCLAW_UPDATE_RUNTIME_RECONCILE_INTERVAL_MS) {
      return;
    }

    lastOpenClawUpdateRuntimeReconcileAt = now;
    openClawUpdateRuntimeReconcileInFlight = (async () => {
      let observedVersion: string | null = null;
      try {
        observedVersion = await readOpenClawVersion();
      } catch {
        return;
      }

      if (!observedVersion) {
        return;
      }

      if (observedVersion !== openClawUpdateSnapshot.currentVersion) {
        patchOpenClawUpdateSnapshot({
          currentVersion: observedVersion,
        });
      }

      if (observedVersion !== latestVersion) {
        return;
      }

      if (activeOpenClawUpdateProcess) {
        if (openClawUpdateSnapshot.phase !== 'verifying-version' || openClawUpdateSnapshot.canCancel) {
          patchOpenClawUpdatePhaseState('verifying-version', {
            currentVersion: observedVersion,
            canCancel: false,
          });
          appendOpenClawUpdateLog(`Detected OpenClaw ${observedVersion}. Verifying the upgraded version.`);
        }
        return;
      }

      if (openClawUpdateSnapshot.status !== 'update_succeeded' || openClawUpdateSnapshot.phase !== 'complete') {
        patchOpenClawUpdatePhaseState('verifying-version', {
          currentVersion: observedVersion,
          canCancel: false,
        });
        void scheduleOpenClawUpdateSuccessFinalization({
          currentVersion: observedVersion,
          latestVersion,
          successLogMessage: `Detected OpenClaw ${observedVersion}. Update completed successfully.`,
        });
      }
    })().finally(() => {
      openClawUpdateRuntimeReconcileInFlight = null;
    });

    await openClawUpdateRuntimeReconcileInFlight;
  }

  async function buildOpenClawUpdateStatusResponseAsync(): Promise<OpenClawUpdateSnapshot> {
    await reconcileOpenClawUpdateSnapshotFromRuntime();
    return buildOpenClawUpdateStatusResponse();
  }

  async function continueOpenClawUpdateRecoveryIfTargetVersionInstalled(options: {
    latestVersion: string;
    detail: string;
  }): Promise<boolean> {
    const observedVersion = await readOpenClawVersion();
    if (observedVersion !== options.latestVersion) {
      return false;
    }

    patchOpenClawUpdatePhaseState('verifying-version', {
      currentVersion: observedVersion,
      latestVersion: options.latestVersion,
      canCancel: false,
      rawDetail: null,
    });
    appendOpenClawUpdateLog(
      `OpenClaw ${observedVersion} is installed; continuing gateway recovery checks every ${
      Math.round(OPENCLAW_UPDATE_GATEWAY_RECOVERY_POLL_INTERVAL_MS / 1000)
    } seconds instead of failing on the first restart probe.`
    );
    if (options.detail) {
      appendOpenClawUpdateLog(`Initial gateway recovery detail: ${options.detail}`);
    }
    void scheduleOpenClawUpdateSuccessFinalization({
      currentVersion: observedVersion,
      latestVersion: options.latestVersion,
      successLogMessage: `OpenClaw update completed successfully after gateway recovery. Current version: ${observedVersion}.`,
    });
    return true;
  }

  function patchOpenClawUpdateRunningPhase(phase: string | null) {
    if (!phase || openClawUpdateSnapshot.status !== 'updating') {
      return;
    }

    if (openClawUpdateSnapshot.phase === phase) {
      return;
    }

    patchOpenClawUpdatePhaseState(phase);
  }

  function attachOpenClawUpdateOutput(stream: NodeJS.ReadableStream | null, source: 'stdout' | 'stderr') {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) {
          const parsedLine = parseOpenClawUpdateOutputLine(line);
          appendOpenClawUpdateLog(parsedLine.logLine || line);
          patchOpenClawUpdateRunningPhase(parsedLine.phase);
          if (source === 'stderr') {
            patchOpenClawUpdateSnapshot({
              rawDetail: parsedLine.logLine || line,
            });
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
    stream.on('end', () => {
      const line = buffer.replace(/\r$/, '');
      if (!line.trim()) return;
      const parsedLine = parseOpenClawUpdateOutputLine(line);
      appendOpenClawUpdateLog(parsedLine.logLine || line);
      patchOpenClawUpdateRunningPhase(parsedLine.phase);
      if (source === 'stderr') {
        patchOpenClawUpdateSnapshot({
          rawDetail: parsedLine.logLine || line,
        });
      }
    });
  }

  async function getOpenClawLatestVersionInfo(): Promise<OpenClawLatestVersionInfo> {
    const executablePath = await ensureResolvedOpenClawExecutablePath();
    const { stdout } = await execFilePromise(executablePath, ['update', 'status', '--json'], {
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(normalizeCliText(stdout) || '{}') as {
      update?: { installKind?: string; packageManager?: string };
      channel?: { value?: string; label?: string };
      availability?: { available?: boolean; latestVersion?: string | null };
    };
    const currentVersion = await readOpenClawVersion();
    const latestVersion = normalizeCliText(parsed?.availability?.latestVersion) || null;
    const hasUpdate = Boolean(parsed?.availability?.available && latestVersion && currentVersion && latestVersion !== currentVersion);

    const info: OpenClawLatestVersionInfo = {
      currentVersion,
      latestVersion,
      hasUpdate,
      status: hasUpdate ? 'update_available' : 'up_to_date',
      channel: normalizeCliText(parsed?.channel?.value) || null,
      channelLabel: normalizeCliText(parsed?.channel?.label) || null,
      installKind: normalizeCliText(parsed?.update?.installKind) || null,
      packageManager: normalizeCliText(parsed?.update?.packageManager) || null,
    };
    rememberOpenClawLatestVersionInfo(info);
    return info;
  }

  async function startOpenClawUpdateTask() {
    if (activeOpenClawUpdateProcess || ['checking', 'updating'].includes(openClawUpdateSnapshot.status)) {
      throw new StructuredRequestError(409, OPENCLAW_UPDATE_ALREADY_RUNNING_ERROR_CODE, 'An OpenClaw update task is already running.');
    }

    const currentVersion = await readOpenClawVersion();
    const cachedLatestInfo = getCachedOpenClawLatestVersionInfo(currentVersion);

    if (!cachedLatestInfo) {
      patchOpenClawUpdateSnapshot({
        status: 'checking',
        phase: 'checking-status',
        canCancel: false,
        currentVersion,
        latestVersion: null,
        message: getOpenClawUpdatePhaseMessage('checking-status'),
        rawDetail: null,
        logs: [],
        startedAt: new Date().toISOString(),
      });
    }

    const latestInfo = cachedLatestInfo || await getOpenClawLatestVersionInfo();
    if (!latestInfo.hasUpdate || !latestInfo.latestVersion) {
      resetOpenClawUpdateSnapshot();
      throw new StructuredRequestError(409, OPENCLAW_UPDATE_NO_NEW_VERSION_ERROR_CODE, 'No newer OpenClaw version is available.');
    }
    const targetVersion = latestInfo.latestVersion;

    const executablePath = await ensureResolvedOpenClawExecutablePath(targetVersion);
    const child = spawn(executablePath, ['update', '--json', '--yes'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
      },
    });

    activeOpenClawUpdateProcess = {
      child,
      cancelRequested: false,
      cancelTimer: null,
      phaseTimer: null,
    };

    patchOpenClawUpdatePhaseState('download-package', {
      status: 'updating',
      currentVersion: latestInfo.currentVersion,
      latestVersion: targetVersion,
      rawDetail: null,
    });
    appendOpenClawUpdateLog(`Starting OpenClaw update to ${targetVersion}.`);

    activeOpenClawUpdateProcess.phaseTimer = setTimeout(() => {
      if (
        activeOpenClawUpdateProcess?.child.pid === child.pid
        && openClawUpdateSnapshot.status === 'updating'
        && openClawUpdateSnapshot.phase === 'download-package'
      ) {
        patchOpenClawUpdatePhaseState('install-package');
      }
    }, 1500);

    attachOpenClawUpdateOutput(child.stdout, 'stdout');
    attachOpenClawUpdateOutput(child.stderr, 'stderr');

    child.once('error', (error) => {
      if (activeOpenClawUpdateProcess?.phaseTimer) {
        clearTimeout(activeOpenClawUpdateProcess.phaseTimer);
      }
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      patchOpenClawUpdateSnapshot({
        status: 'update_failed',
        phase: 'running-update',
        canCancel: false,
        message: 'OpenClaw update failed.',
        rawDetail: detail,
      });
      appendOpenClawUpdateLog(`OpenClaw update failed to start: ${detail}`);
      activeOpenClawUpdateProcess = null;
    });

    child.once('close', async (code, signal) => {
      const activeProcess = activeOpenClawUpdateProcess;
      activeOpenClawUpdateProcess = null;
      if (activeProcess?.cancelTimer) {
        clearTimeout(activeProcess.cancelTimer);
      }
      if (activeProcess?.phaseTimer) {
        clearTimeout(activeProcess.phaseTimer);
      }

      if (activeProcess?.cancelRequested) {
        resetOpenClawUpdateSnapshot();
        appendOpenClawUpdateLog('OpenClaw update cancelled.');
        return;
      }

      if (code === 0) {
        try {
          patchOpenClawUpdatePhaseState('repair-command-entrypoint');
          const resolvedExecutablePath = await ensureResolvedOpenClawExecutablePath(targetVersion);
          await ensureOpenClawShellEntrypoint(resolvedExecutablePath);
          appendOpenClawUpdateLog('Verified and repaired the OpenClaw shell entrypoint.');
          patchOpenClawUpdatePhaseState('verifying-version');
          const verifiedInfo = await getOpenClawLatestVersionInfo();
          void scheduleOpenClawUpdateSuccessFinalization({
            currentVersion: verifiedInfo.currentVersion,
            latestVersion: verifiedInfo.latestVersion,
            successLogMessage: `OpenClaw update completed successfully. Current version: ${verifiedInfo.currentVersion || 'unknown'}.`,
          });
        } catch (error) {
          const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
          patchOpenClawUpdateSnapshot({
            status: 'update_failed',
            phase: 'verifying-version',
            canCancel: false,
            message: 'OpenClaw update verification failed.',
            rawDetail: detail,
          });
          appendOpenClawUpdateLog(`OpenClaw update completed, but verification failed: ${detail}`);
        }
        return;
      }

      const detail = openClawUpdateSnapshot.rawDetail
        || `OpenClaw update exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`;
      const continuingRecovery = await continueOpenClawUpdateRecoveryIfTargetVersionInstalled({
        latestVersion: targetVersion,
        detail,
      });
      if (continuingRecovery) {
        return;
      }

      patchOpenClawUpdateSnapshot({
        status: 'update_failed',
        phase: 'running-update',
        canCancel: false,
        message: 'OpenClaw update failed.',
        rawDetail: detail,
      });
      appendOpenClawUpdateLog(`OpenClaw update failed: ${detail}`);
    });

    return buildOpenClawUpdateStatusResponse();
  }

  async function resetOpenClawUpdateTaskState() {
    if (activeOpenClawUpdateProcess || openClawUpdateSuccessFinalizeTask) {
      throw new StructuredRequestError(409, OPENCLAW_UPDATE_ALREADY_RUNNING_ERROR_CODE, 'Cannot reset while an OpenClaw update task is running.');
    }
    resetOpenClawUpdateSnapshot();
    return buildOpenClawUpdateStatusResponse();
  }

  async function cancelOpenClawUpdateTask() {
    if (!activeOpenClawUpdateProcess || !['checking', 'updating', 'stopping'].includes(openClawUpdateSnapshot.status)) {
      throw new StructuredRequestError(409, OPENCLAW_UPDATE_NOT_RUNNING_ERROR_CODE, 'There is no running OpenClaw update task to stop.');
    }

    if (openClawUpdateSnapshot.status === 'stopping') {
      return buildOpenClawUpdateStatusResponse();
    }

    patchOpenClawUpdateSnapshot({
      status: 'stopping',
      phase: 'stopping-update',
      canCancel: false,
      message: getOpenClawUpdatePhaseMessage('stopping-update'),
    });
    appendOpenClawUpdateLog('Stopping OpenClaw update on user request.');

    activeOpenClawUpdateProcess.cancelRequested = true;
    try {
      process.kill(-activeOpenClawUpdateProcess.child.pid!, 'SIGTERM');
    } catch (error) {
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      patchOpenClawUpdateSnapshot({
        status: 'update_failed',
        phase: 'stopping-update',
        canCancel: false,
        message: 'Failed to stop the OpenClaw update.',
        rawDetail: detail,
      });
      throw new StructuredRequestError(500, OPENCLAW_UPDATE_CANCEL_FAILED_ERROR_CODE, detail);
    }

    activeOpenClawUpdateProcess.cancelTimer = setTimeout(() => {
      try {
        if (activeOpenClawUpdateProcess?.cancelRequested) {
          process.kill(-activeOpenClawUpdateProcess.child.pid!, 'SIGKILL');
        }
      } catch {}
    }, UPDATE_CANCEL_KILL_TIMEOUT_MS);

    return buildOpenClawUpdateStatusResponse();
  }

  return {
    buildOpenClawUpdateStatusResponseAsync,
    getOpenClawLatestVersionInfo,
    startOpenClawUpdateTask,
    resetOpenClawUpdateTaskState,
    cancelOpenClawUpdateTask,
  };
}
export type OpenClawUpdateService = ReturnType<typeof createOpenClawUpdateService>;
