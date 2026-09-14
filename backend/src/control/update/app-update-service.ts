import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  StructuredRequestError,
  UPDATE_ALREADY_RUNNING_ERROR_CODE,
  UPDATE_CANCEL_FAILED_ERROR_CODE,
  UPDATE_CANNOT_CANCEL_PHASE_ERROR_CODE,
  UPDATE_NO_NEW_VERSION_ERROR_CODE,
  UPDATE_NOT_RUNNING_ERROR_CODE,
  UPDATE_RESTART_NOT_READY_ERROR_CODE,
  UPDATE_SERVICE_NOT_FOUND_ERROR_CODE,
} from '../../core/http';
import { appRepoRoot, updateRestartStatePath } from '../../core/paths';
import { execFilePromise, readCliErrorDetail } from '../../core/process';
import { normalizeCliText } from '../../core/util';
import { type GatewayService, readOpenClawGatewayServiceRuntimeState } from '../../openclaw';
import {
  type BrowserService,
  markBrowserWarmupRequested,
  readBrowserUnavailableReason,
} from '../gateway/browser-service';
import {
  type LatestVersionInfo as AppLatestVersionInfo,
  getCurrentAppVersionInfo,
  getLatestVersionInfo,
} from './app-version';

const UPDATE_SCRIPT_URL = 'https://raw.githubusercontent.com/whotto/ClawOPT/main/update.sh';
const UPDATE_PHASE_MARKER_PREFIX = '::clawopt-update-phase::';
export const UPDATE_LOG_LIMIT = 200;
export const UPDATE_CANCEL_KILL_TIMEOUT_MS = 5000;
const UPDATE_RESTART_DELAY_MS = 250;
const UPDATE_CANCELLABLE_PHASES = new Set(['downloading-script', 'detect-service', 'git-pull']);
const CLAWOPT_SERVICE_FILE_REGEX = /^clawopt(?:-\d+)?\.service$/;
export const UPDATE_RESTART_RESUME_POLL_INTERVAL_MS = 1500;
const UPDATE_RESTART_RESUME_TIMEOUT_MS = 3 * 60 * 1000;

type UpdateRestartStepId =
  | 'restart_openclaw'
  | 'restart_project'
  | 'warmup_browser';

type UpdateRestartStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed';

type UpdateRestartStep = {
  id: UpdateRestartStepId;
  status: UpdateRestartStepStatus;
  detail: string | null;
  updatedAt: string | null;
};

type UpdateStatus =
  | 'idle'
  | 'has_update'
  | 'checking'
  | 'updating'
  | 'stopping'
  | 'update_succeeded'
  | 'update_failed'
  | 'restarting'
  | 'restart_failed';

type UpdateSnapshot = {
  status: UpdateStatus;
  phase: string | null;
  canCancel: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  message: string | null;
  rawDetail: string | null;
  logs: string[];
  startedAt: string | null;
  updatedAt: string | null;
  serviceName: string | null;
  restartSteps: UpdateRestartStep[] | null;
};

type ActiveUpdateProcess = {
  child: ReturnType<typeof spawn>;
  startCommit: string | null;
  cancelRequested: boolean;
  cancelTimer: NodeJS.Timeout | null;
};
const UPDATE_RESTART_STEP_IDS: UpdateRestartStepId[] = [
  'restart_openclaw',
  'restart_project',
  'warmup_browser',
];

function createDefaultUpdateSnapshot(): UpdateSnapshot {
  return {
    status: 'idle',
    phase: null,
    canCancel: false,
    currentVersion: getCurrentAppVersionInfo().version,
    latestVersion: null,
    message: null,
    rawDetail: null,
    logs: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
    serviceName: null,
    restartSteps: null,
  };
}

function createDefaultUpdateRestartSteps(): UpdateRestartStep[] {
  const updatedAt = new Date().toISOString();
  return UPDATE_RESTART_STEP_IDS.map((id) => ({
    id,
    status: 'pending',
    detail: null,
    updatedAt,
  }));
}

function normalizeUpdateRestartSteps(raw: unknown): UpdateRestartStep[] | null {
  if (!Array.isArray(raw)) return null;

  const normalized: UpdateRestartStep[] = [];
  for (const id of UPDATE_RESTART_STEP_IDS) {
    const matched = raw.find((entry) => (
      entry
      && typeof entry === 'object'
      && normalizeCliText((entry as { id?: unknown }).id) === id
    )) as { status?: unknown; detail?: unknown; updatedAt?: unknown } | undefined;

    const status = normalizeCliText(matched?.status);
    normalized.push({
      id,
      status: status === 'running' || status === 'completed' || status === 'failed' ? status : 'pending',
      detail: normalizeCliText(matched?.detail) || null,
      updatedAt: normalizeCliText(matched?.updatedAt) || null,
    });
  }

  return normalized;
}

function updateRestartStepStatus(
  steps: UpdateRestartStep[] | null | undefined,
  id: UpdateRestartStepId,
  status: UpdateRestartStepStatus,
  detail?: string | null
) {
  const nextSteps = normalizeUpdateRestartSteps(steps) || createDefaultUpdateRestartSteps();
  const updatedAt = new Date().toISOString();

  return nextSteps.map((step) => (
    step.id === id
      ? {
        ...step,
        status,
        detail: normalizeCliText(detail) || null,
        updatedAt,
      }
      : step
  ));
}

function readPersistedUpdateRestartSnapshot(): UpdateSnapshot | null {
  try {
    if (!fs.existsSync(updateRestartStatePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(updateRestartStatePath, 'utf8')) as Partial<UpdateSnapshot>;
    if (parsed.status !== 'restarting' && parsed.status !== 'restart_failed') {
      return null;
    }

    return {
      ...createDefaultUpdateSnapshot(),
      ...parsed,
      status: parsed.status,
      phase: normalizeCliText(parsed.phase) || null,
      currentVersion: normalizeCliText(parsed.currentVersion) || null,
      latestVersion: normalizeCliText(parsed.latestVersion) || null,
      message: normalizeCliText(parsed.message) || null,
      rawDetail: normalizeCliText(parsed.rawDetail) || null,
      serviceName: normalizeCliText(parsed.serviceName) || null,
      startedAt: normalizeCliText(parsed.startedAt) || null,
      updatedAt: normalizeCliText(parsed.updatedAt) || new Date().toISOString(),
      logs: Array.isArray(parsed.logs)
        ? parsed.logs.map((entry) => normalizeCliText(entry)).filter((entry): entry is string => Boolean(entry))
        : [],
      restartSteps: normalizeUpdateRestartSteps(parsed.restartSteps) || createDefaultUpdateRestartSteps(),
    };
  } catch (error) {
    console.warn('[UpdateRestart] Failed to read persisted restart state:', error);
    return null;
  }
}

function getUpdatePhaseMessage(phase: string) {
  switch (phase) {
    case 'downloading-script':
      return 'Downloading update script.';
    case 'detect-service':
      return 'Detecting current service.';
    case 'git-pull':
      return 'Pulling the latest code.';
    case 'deploy-release':
      return 'Running deploy-release.sh.';
    case 'install-dependencies':
      return 'Installing dependencies.';
    case 'build':
      return 'Building the project.';
    case 'patch-config':
      return 'Patching OpenClaw configuration.';
    case 'restart-openclaw-runtime':
      return 'Restarting the OpenClaw gateway.';
    case 'reconcile-openclaw-runtime':
      return 'Reconciling OpenClaw runtime.';
    case 'repair-openclaw-device':
      return 'Repairing local OpenClaw device scopes.';
    case 'recover-browser-runtime':
      return 'Recovering and validating browser runtime.';
    case 'setup-service':
      return 'Updating service configuration.';
    case 'service-restart':
      return 'Restarting service.';
    case 'restart-openclaw':
      return 'Restarting OpenClaw.';
    case 'restart-project':
      return 'Restarting this project.';
    case 'warmup-browser':
      return 'Warming up the browser runtime.';
    case 'complete':
      return 'Update completed.';
    default:
      return null;
  }
}

async function readGitHeadCommit() {
  try {
    const { stdout } = await execFilePromise('git', ['rev-parse', 'HEAD'], {
      cwd: appRepoRoot,
      maxBuffer: 1024 * 1024,
    });
    return normalizeCliText(stdout) || null;
  } catch {
    return null;
  }
}

async function cleanupUpdateResidualFiles() {
  const lockFiles = [
    path.join(appRepoRoot, '.git', 'index.lock'),
    path.join(appRepoRoot, '.git', 'HEAD.lock'),
    path.join(appRepoRoot, '.git', 'FETCH_HEAD.lock'),
    path.join(appRepoRoot, '.git', 'shallow.lock'),
    path.join(appRepoRoot, '.git', 'config.lock'),
    path.join(appRepoRoot, '.git', 'ORIG_HEAD.lock'),
  ];

  for (const filePath of lockFiles) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }
}

async function revertUpdateWorkspace(startCommit: string | null) {
  if (!startCommit) return;
  await execFilePromise('git', ['reset', '--hard', startCommit], {
    cwd: appRepoRoot,
    maxBuffer: 1024 * 1024,
  });
  await cleanupUpdateResidualFiles();
}

function getCurrentClawUiPort() {
  return normalizeCliText(process.env.PORT) || '3115';
}

function resolveClawUiServiceName() {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const currentPort = getCurrentClawUiPort();
  const preferred = `clawopt-${currentPort}.service`;
  const preferredPath = path.join(serviceDir, preferred);
  if (fs.existsSync(preferredPath)) {
    return preferred;
  }

  const legacyPath = path.join(serviceDir, 'clawopt.service');
  if (currentPort === '3115' && fs.existsSync(legacyPath)) {
    return 'clawopt.service';
  }

  try {
    const candidates = fs.readdirSync(serviceDir).filter((entry) => CLAWOPT_SERVICE_FILE_REGEX.test(entry));
    if (candidates.includes(preferred)) return preferred;
    if (candidates.includes('clawopt.service')) return 'clawopt.service';
    if (candidates.length === 1) return candidates[0];
  } catch {}

  throw new StructuredRequestError(404, UPDATE_SERVICE_NOT_FOUND_ERROR_CODE, `Could not determine the current ClawOPT service for port ${currentPort}.`);
}

function buildUpdateCommand(targetPort: string) {
  return `set -o pipefail; curl -fsSL ${JSON.stringify(UPDATE_SCRIPT_URL)} | bash -s -- ${JSON.stringify(targetPort)}`;
}

export type AppUpdateServiceDeps = {
  browser: BrowserService;
  gatewayService: GatewayService;
};

export function createAppUpdateService(ctx: AppUpdateServiceDeps) {
  const { scheduleDeferredBrowserWarmup } = ctx.browser;
  const { scheduleGatewayRestart, waitForGatewayConnectionStable, waitForGatewayRestartAfterBrowserModeChange } = ctx.gatewayService;

  function syncPersistedUpdateRestartSnapshot() {
    try {
      if (updateSnapshot.status === 'restarting' || updateSnapshot.status === 'restart_failed') {
        fs.mkdirSync(path.dirname(updateRestartStatePath), { recursive: true });
        fs.writeFileSync(updateRestartStatePath, `${JSON.stringify(updateSnapshot, null, 2)}\n`);
        return;
      }

      fs.rmSync(updateRestartStatePath, { force: true });
    } catch (error) {
      console.warn('[UpdateRestart] Failed to sync persisted restart state:', error);
    }
  }

  let updateSnapshot = readPersistedUpdateRestartSnapshot() || createDefaultUpdateSnapshot();
  let activeUpdateProcess: ActiveUpdateProcess | null = null;
  let cachedLatestVersionInfo: AppLatestVersionInfo | null = null;
  let updateRestartResumeTask: Promise<void> | null = null;

  function appendUpdateLog(message: string) {
    const line = normalizeCliText(message);
    if (!line) return;
    updateSnapshot.logs = [...updateSnapshot.logs.slice(-(UPDATE_LOG_LIMIT - 1)), line];
    updateSnapshot.updatedAt = new Date().toISOString();
    syncPersistedUpdateRestartSnapshot();
  }

  function patchUpdateSnapshot(patch: Partial<UpdateSnapshot>) {
    updateSnapshot = {
      ...updateSnapshot,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    syncPersistedUpdateRestartSnapshot();
  }

  function resetUpdateSnapshot() {
    updateSnapshot = createDefaultUpdateSnapshot();
    syncPersistedUpdateRestartSnapshot();
  }

  function rememberLatestVersionInfo(info: AppLatestVersionInfo | null) {
    cachedLatestVersionInfo = info;
    if (!info) {
      if (updateSnapshot.status === 'has_update') {
        patchUpdateSnapshot({
          status: 'idle',
          latestVersion: null,
        });
      }
      return;
    }

    if (activeUpdateProcess || ['checking', 'updating', 'stopping', 'update_succeeded', 'update_failed', 'restarting', 'restart_failed'].includes(updateSnapshot.status)) {
      return;
    }

    patchUpdateSnapshot({
      status: info.hasUpdate ? 'has_update' : 'idle',
      latestVersion: info.latestVersion || null,
      currentVersion: info.currentVersion || getCurrentAppVersionInfo().version,
      message: null,
      rawDetail: null,
    });
  }

  function updatePhaseState(phase: string) {
    patchUpdateSnapshot({
      phase,
      canCancel: UPDATE_CANCELLABLE_PHASES.has(phase),
      message: getUpdatePhaseMessage(phase),
    });
  }

  function consumeUpdateOutputLine(line: string, source: 'stdout' | 'stderr') {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.trim()) return;
    appendUpdateLog(trimmed);
    if (trimmed.startsWith(UPDATE_PHASE_MARKER_PREFIX)) {
      const phase = normalizeCliText(trimmed.slice(UPDATE_PHASE_MARKER_PREFIX.length));
      if (phase) updatePhaseState(phase);
      return;
    }
    if (source === 'stderr') {
      patchUpdateSnapshot({
        rawDetail: trimmed,
      });
    }
  }

  function attachUpdateOutput(stream: NodeJS.ReadableStream | null, source: 'stdout' | 'stderr') {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        consumeUpdateOutputLine(line, source);
        newlineIndex = buffer.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (buffer) {
        consumeUpdateOutputLine(buffer, source);
        buffer = '';
      }
    });
  }

  function buildUpdateStatusResponse(): UpdateSnapshot {
    if (updateSnapshot.status === 'idle' && cachedLatestVersionInfo?.hasUpdate) {
      return {
        ...updateSnapshot,
        status: 'has_update',
        latestVersion: cachedLatestVersionInfo.latestVersion || updateSnapshot.latestVersion,
        currentVersion: cachedLatestVersionInfo.currentVersion || updateSnapshot.currentVersion,
      };
    }

    return {
      ...updateSnapshot,
    };
  }

  async function resumePersistedUpdateRestartFlow() {
    if (updateSnapshot.status !== 'restarting') {
      return;
    }
    if (updateRestartResumeTask) {
      return updateRestartResumeTask;
    }

    updateRestartResumeTask = (async () => {
      try {
        let restartSteps = normalizeUpdateRestartSteps(updateSnapshot.restartSteps) || createDefaultUpdateRestartSteps();

        if (restartSteps.some((step) => step.id === 'restart_openclaw' && step.status !== 'completed')) {
          patchUpdateSnapshot({
            phase: 'restart-openclaw',
            message: getUpdatePhaseMessage('restart-openclaw'),
            rawDetail: null,
            restartSteps,
          });
          await waitForGatewayConnectionStable(UPDATE_RESTART_RESUME_TIMEOUT_MS);
          restartSteps = updateRestartStepStatus(restartSteps, 'restart_openclaw', 'completed');
        }

        restartSteps = updateRestartStepStatus(restartSteps, 'restart_project', 'completed');
        restartSteps = updateRestartStepStatus(restartSteps, 'warmup_browser', 'running');
        patchUpdateSnapshot({
          phase: 'warmup-browser',
          message: getUpdatePhaseMessage('warmup-browser'),
          rawDetail: null,
          restartSteps,
        });

        const unavailableReason = readBrowserUnavailableReason();
        if (unavailableReason) {
          // 没启用的可选能力，跳过而不是判失败——升级到此算完成。
          restartSteps = updateRestartStepStatus(restartSteps, 'warmup_browser', 'skipped', unavailableReason);
          patchUpdateSnapshot({ restartSteps });
          appendUpdateLog(`Browser warmup skipped: ${unavailableReason}`);
        } else {
          const warmupResult = await scheduleDeferredBrowserWarmup();
          if (!warmupResult.ready) {
            throw new Error(warmupResult.detail || 'Browser warmup did not complete successfully.');
          }
        }

        rememberLatestVersionInfo(null);
        resetUpdateSnapshot();
      } catch (error) {
        const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
        let restartSteps = normalizeUpdateRestartSteps(updateSnapshot.restartSteps) || createDefaultUpdateRestartSteps();
        const failingStepId: UpdateRestartStepId = updateSnapshot.phase === 'warmup-browser'
          ? 'warmup_browser'
          : updateSnapshot.phase === 'restart-project'
            ? 'restart_project'
            : 'restart_openclaw';
        restartSteps = updateRestartStepStatus(restartSteps, failingStepId, 'failed', detail);
        patchUpdateSnapshot({
          status: 'restart_failed',
          canCancel: false,
          message: 'Failed to restart OpenClaw and finish browser warmup.',
          rawDetail: detail,
          restartSteps,
        });
        appendUpdateLog(`Restart flow failed: ${detail}`);
      } finally {
        updateRestartResumeTask = null;
      }
    })();

    return updateRestartResumeTask;
  }

  async function startUpdateTask() {
    if (activeUpdateProcess || ['checking', 'updating', 'stopping', 'restarting'].includes(updateSnapshot.status)) {
      throw new StructuredRequestError(409, UPDATE_ALREADY_RUNNING_ERROR_CODE, 'An update task is already running.');
    }

    patchUpdateSnapshot({
      status: 'checking',
      phase: null,
      canCancel: false,
      message: 'Checking for updates.',
      rawDetail: null,
      logs: [],
      startedAt: new Date().toISOString(),
      currentVersion: getCurrentAppVersionInfo().version,
      latestVersion: null,
    });

    const latestInfo = await getLatestVersionInfo();
    rememberLatestVersionInfo(latestInfo);
    if (!latestInfo.hasUpdate || !latestInfo.latestVersion) {
      resetUpdateSnapshot();
      throw new StructuredRequestError(409, UPDATE_NO_NEW_VERSION_ERROR_CODE, 'No newer version is available.');
    }

    const startCommit = await readGitHeadCommit();
    const targetPort = getCurrentClawUiPort();
    const child = spawn('/bin/bash', ['-lc', buildUpdateCommand(targetPort)], {
      cwd: appRepoRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAWOPT_SKIP_SERVICE_RESTART: '1',
      },
    });

    activeUpdateProcess = {
      child,
      startCommit,
      cancelRequested: false,
      cancelTimer: null,
    };

    patchUpdateSnapshot({
      status: 'updating',
      phase: 'downloading-script',
      canCancel: true,
      currentVersion: latestInfo.currentVersion || getCurrentAppVersionInfo().version,
      latestVersion: latestInfo.latestVersion,
      message: getUpdatePhaseMessage('downloading-script'),
      rawDetail: null,
    });
    appendUpdateLog(`Starting update to ${latestInfo.latestVersion}.`);

    attachUpdateOutput(child.stdout, 'stdout');
    attachUpdateOutput(child.stderr, 'stderr');

    child.once('error', (error) => {
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      patchUpdateSnapshot({
        status: 'update_failed',
        canCancel: false,
        message: 'Update failed.',
        rawDetail: detail,
      });
      appendUpdateLog(`Update process failed to start: ${detail}`);
      activeUpdateProcess = null;
    });

    child.once('close', async (code, signal) => {
      const activeProcess = activeUpdateProcess;
      activeUpdateProcess = null;
      if (activeProcess?.cancelTimer) {
        clearTimeout(activeProcess.cancelTimer);
      }

      if (activeProcess?.cancelRequested) {
        try {
          await revertUpdateWorkspace(activeProcess.startCommit);
          resetUpdateSnapshot();
          appendUpdateLog('Update cancelled and workspace restored to the previous version.');
        } catch (error) {
          const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
          patchUpdateSnapshot({
            status: 'update_failed',
            canCancel: false,
            message: 'Update cancel cleanup failed.',
            rawDetail: detail,
          });
          appendUpdateLog(`Failed to restore workspace after cancel: ${detail}`);
        }
        rememberLatestVersionInfo(null);
        return;
      }

      if (code === 0) {
        patchUpdateSnapshot({
          status: 'update_succeeded',
          phase: 'complete',
          canCancel: false,
          currentVersion: getCurrentAppVersionInfo().version,
          latestVersion: latestInfo.latestVersion,
          message: 'Update completed. Restart the service to apply the new build.',
          rawDetail: null,
        });
        appendUpdateLog('Update completed successfully. Waiting for service restart.');
        return;
      }

      const detail = updateSnapshot.rawDetail
        || `Update exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`;
      patchUpdateSnapshot({
        status: 'update_failed',
        canCancel: false,
        message: 'Update failed.',
        rawDetail: detail,
      });
      appendUpdateLog(`Update failed: ${detail}`);
    });

    return buildUpdateStatusResponse();
  }

  async function cancelUpdateTask() {
    if (!activeUpdateProcess || !['updating', 'checking', 'stopping'].includes(updateSnapshot.status)) {
      throw new StructuredRequestError(409, UPDATE_NOT_RUNNING_ERROR_CODE, 'There is no running update task to stop.');
    }

    if (updateSnapshot.status === 'stopping') {
      return buildUpdateStatusResponse();
    }

    if (!updateSnapshot.canCancel || !updateSnapshot.phase || !UPDATE_CANCELLABLE_PHASES.has(updateSnapshot.phase)) {
      throw new StructuredRequestError(409, UPDATE_CANNOT_CANCEL_PHASE_ERROR_CODE, `The current phase (${updateSnapshot.phase || 'unknown'}) cannot be stopped safely.`);
    }

    patchUpdateSnapshot({
      status: 'stopping',
      canCancel: false,
      message: 'Stopping update task.',
    });
    appendUpdateLog('Stopping update task on user request.');

    activeUpdateProcess.cancelRequested = true;
    try {
      process.kill(-activeUpdateProcess.child.pid!, 'SIGTERM');
    } catch (error) {
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      patchUpdateSnapshot({
        status: 'update_failed',
        canCancel: false,
        message: 'Failed to stop update task.',
        rawDetail: detail,
      });
      throw new StructuredRequestError(500, UPDATE_CANCEL_FAILED_ERROR_CODE, detail);
    }

    activeUpdateProcess.cancelTimer = setTimeout(() => {
      try {
        if (activeUpdateProcess?.cancelRequested) {
          process.kill(-activeUpdateProcess.child.pid!, 'SIGKILL');
        }
      } catch {}
    }, UPDATE_CANCEL_KILL_TIMEOUT_MS);

    return buildUpdateStatusResponse();
  }

  async function resetUpdateTaskState() {
    if (activeUpdateProcess) {
      throw new StructuredRequestError(409, UPDATE_ALREADY_RUNNING_ERROR_CODE, 'Cannot reset while an update task is running.');
    }
    rememberLatestVersionInfo(null);
    resetUpdateSnapshot();
    return buildUpdateStatusResponse();
  }

  async function restartClawUiService() {
    if (updateSnapshot.status !== 'update_succeeded') {
      throw new StructuredRequestError(409, UPDATE_RESTART_NOT_READY_ERROR_CODE, 'Service restart is only available after a successful update.');
    }

    const serviceName = resolveClawUiServiceName();
    await execFilePromise('systemctl', ['--user', 'show', serviceName, '--property', 'LoadState'], {
      maxBuffer: 1024 * 1024,
    });
    const previousGatewayRuntimeState = await readOpenClawGatewayServiceRuntimeState();
    let restartSteps = createDefaultUpdateRestartSteps();
    restartSteps = updateRestartStepStatus(restartSteps, 'restart_openclaw', 'running');

    patchUpdateSnapshot({
      status: 'restarting',
      phase: 'restart-openclaw',
      canCancel: false,
      serviceName,
      message: getUpdatePhaseMessage('restart-openclaw'),
      rawDetail: null,
      restartSteps,
    });
    appendUpdateLog(`Restart flow started for OpenClaw and ${serviceName}.`);

    setTimeout(() => {
      (async () => {
        await scheduleGatewayRestart();
        await waitForGatewayRestartAfterBrowserModeChange(previousGatewayRuntimeState);
        restartSteps = updateRestartStepStatus(restartSteps, 'restart_openclaw', 'completed');
        restartSteps = updateRestartStepStatus(restartSteps, 'restart_project', 'running');
        patchUpdateSnapshot({
          phase: 'restart-project',
          message: getUpdatePhaseMessage('restart-project'),
          restartSteps,
        });
        appendUpdateLog(`OpenClaw restart finished. Restarting ${serviceName}.`);
        markBrowserWarmupRequested();
        await execFilePromise('systemctl', ['--user', 'restart', serviceName, '--no-block'], {
          maxBuffer: 1024 * 1024,
        });
      })().catch((error) => {
        const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
        let failedSteps = normalizeUpdateRestartSteps(updateSnapshot.restartSteps) || restartSteps;
        const failingStepId: UpdateRestartStepId = updateSnapshot.phase === 'restart-project'
          ? 'restart_project'
          : 'restart_openclaw';
        failedSteps = updateRestartStepStatus(failedSteps, failingStepId, 'failed', detail);
        patchUpdateSnapshot({
          status: 'restart_failed',
          canCancel: false,
          serviceName,
          message: `Failed during the restart flow for ${serviceName}.`,
          rawDetail: detail,
          restartSteps: failedSteps,
        });
        appendUpdateLog(`Restart failed: ${detail}`);
      });
    }, UPDATE_RESTART_DELAY_MS);

    return buildUpdateStatusResponse();
  }

  return {
    rememberLatestVersionInfo,
    buildUpdateStatusResponse,
    resumePersistedUpdateRestartFlow,
    startUpdateTask,
    cancelUpdateTask,
    resetUpdateTaskState,
    restartClawUiService,
  };
}
export type AppUpdateService = ReturnType<typeof createAppUpdateService>;
