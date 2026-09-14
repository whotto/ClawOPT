import fs from 'fs';
import path from 'path';

import {
  BROWSER_HEADED_MODE_RESTART_POLL_INTERVAL_MS,
  BROWSER_HEADED_MODE_RESTART_TIMEOUT_MS,
  UPDATE_RESTART_RESUME_POLL_INTERVAL_MS,
} from '../control';
import type { ConfigManager } from '../core/config';
import { gatewayRestartStatePath } from '../core/paths';
import { execFilePromise, readCliErrorDetail } from '../core/process';
import { normalizeCliText, sleep } from '../core/util';
import { ensureResolvedOpenClawExecutablePath } from './cli';
import {
  isLocalGatewayHostname,
  parseGatewayUrlForStatusProbe,
  probeGatewayConnectionStatus,
  readLocalGatewayRuntimeConfig,
} from './gateway-probe';
import type { OpenClawClient } from './openclaw-client';

type GatewayRestartTrigger =
  | 'gateway'
  | 'browser-headed-mode';

type GatewayRestartTaskStatus =
  | 'idle'
  | 'restarting'
  | 'failed';

type GatewayRestartSnapshot = {
  status: GatewayRestartTaskStatus;
  trigger: GatewayRestartTrigger | null;
  rawDetail: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  targetHeadedModeEnabled: boolean | null;
};
export const OPENCLAW_GATEWAY_HEALTH_PROBE_TIMEOUTS_MS = [700, 1000] as const;
export const OPENCLAW_GATEWAY_READY_PROBE_TIMEOUT_MS = 20000;
export const OPENCLAW_GATEWAY_READY_PROBE_STEP_TIMEOUT_MS = 5000;
export const OPENCLAW_GATEWAY_READY_RESULT_CACHE_TTL_MS = 3000;
export const OPENCLAW_GATEWAY_RESTART_STABLE_WINDOW_MS = 20 * 1000;
const OPENCLAW_GATEWAY_MANUAL_RESTART_STABLE_WINDOW_MS = 5 * 1000;
export const OPENCLAW_GATEWAY_SERVICE_NAME = 'openclaw-gateway.service';

function createDefaultGatewayRestartSnapshot(): GatewayRestartSnapshot {
  return {
    status: 'idle',
    trigger: null,
    rawDetail: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    targetHeadedModeEnabled: null,
  };
}

function readPersistedGatewayRestartSnapshot(): GatewayRestartSnapshot | null {
  try {
    if (!fs.existsSync(gatewayRestartStatePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(gatewayRestartStatePath, 'utf8')) as Partial<GatewayRestartSnapshot>;
    if (parsed.status !== 'restarting' && parsed.status !== 'failed') {
      return null;
    }

    const trigger = normalizeCliText(parsed.trigger);
    return {
      ...createDefaultGatewayRestartSnapshot(),
      ...parsed,
      status: parsed.status,
      trigger: trigger === 'gateway' || trigger === 'browser-headed-mode' ? trigger : null,
      rawDetail: normalizeCliText(parsed.rawDetail) || null,
      startedAt: normalizeCliText(parsed.startedAt) || null,
      updatedAt: normalizeCliText(parsed.updatedAt) || new Date().toISOString(),
      targetHeadedModeEnabled: typeof parsed.targetHeadedModeEnabled === 'boolean' ? parsed.targetHeadedModeEnabled : null,
    };
  } catch (error) {
    console.warn('[GatewayRestart] Failed to read persisted restart state:', error);
    return null;
  }
}

type OpenClawGatewayServiceRuntimeState = {
  execMainPid: number | null;
  activeState: string | null;
  subState: string | null;
  activeEnterTimestampMonotonic: number | null;
  execMainStartTimestampMonotonic: number | null;
  stateChangeTimestampMonotonic: number | null;
};

function parseSystemdMonotonicValue(value: string) {
  const parsed = Number.parseInt(normalizeCliText(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSystemdShowProperties(stdout: string) {
  const properties = new Map<string, string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizeCliText(line.slice(0, separatorIndex));
    if (!key) {
      continue;
    }

    properties.set(key, line.slice(separatorIndex + 1));
  }

  return properties;
}

export async function readOpenClawGatewayServiceRuntimeState() {
  try {
    const { stdout } = await execFilePromise(
      'systemctl',
      [
        '--user',
        'show',
        'openclaw-gateway.service',
        '-p', 'ExecMainPID',
        '-p', 'ActiveState',
        '-p', 'SubState',
        '-p', 'ActiveEnterTimestampMonotonic',
        '-p', 'ExecMainStartTimestampMonotonic',
        '-p', 'StateChangeTimestampMonotonic',
      ],
      {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      }
    );
    const properties = parseSystemdShowProperties(stdout);
    const pidRaw = properties.get('ExecMainPID') || '';
    const activeStateRaw = properties.get('ActiveState') || '';
    const subStateRaw = properties.get('SubState') || '';
    const activeEnterRaw = properties.get('ActiveEnterTimestampMonotonic') || '';
    const execMainStartRaw = properties.get('ExecMainStartTimestampMonotonic') || '';
    const stateChangeRaw = properties.get('StateChangeTimestampMonotonic') || '';
    const parsedPid = Number.parseInt(normalizeCliText(pidRaw), 10);

    return {
      execMainPid: Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null,
      activeState: normalizeCliText(activeStateRaw) || null,
      subState: normalizeCliText(subStateRaw) || null,
      activeEnterTimestampMonotonic: parseSystemdMonotonicValue(activeEnterRaw),
      execMainStartTimestampMonotonic: parseSystemdMonotonicValue(execMainStartRaw),
      stateChangeTimestampMonotonic: parseSystemdMonotonicValue(stateChangeRaw),
    } satisfies OpenClawGatewayServiceRuntimeState;
  } catch {
    return {
      execMainPid: null,
      activeState: null,
      subState: null,
      activeEnterTimestampMonotonic: null,
      execMainStartTimestampMonotonic: null,
      stateChangeTimestampMonotonic: null,
    } satisfies OpenClawGatewayServiceRuntimeState;
  }
}

function hasGatewayRestartBeenObserved(
  previousRuntimeState: OpenClawGatewayServiceRuntimeState,
  nextRuntimeState: OpenClawGatewayServiceRuntimeState
) {
  if (
    previousRuntimeState.execMainPid !== null
    && nextRuntimeState.execMainPid !== null
    && nextRuntimeState.execMainPid !== previousRuntimeState.execMainPid
  ) {
    return true;
  }

  if (
    previousRuntimeState.activeEnterTimestampMonotonic !== null
    && nextRuntimeState.activeEnterTimestampMonotonic !== null
    && nextRuntimeState.activeEnterTimestampMonotonic > previousRuntimeState.activeEnterTimestampMonotonic
  ) {
    return true;
  }

  if (
    previousRuntimeState.execMainStartTimestampMonotonic !== null
    && nextRuntimeState.execMainStartTimestampMonotonic !== null
    && nextRuntimeState.execMainStartTimestampMonotonic > previousRuntimeState.execMainStartTimestampMonotonic
  ) {
    return true;
  }

  if (
    previousRuntimeState.stateChangeTimestampMonotonic !== null
    && nextRuntimeState.stateChangeTimestampMonotonic !== null
    && nextRuntimeState.stateChangeTimestampMonotonic > previousRuntimeState.stateChangeTimestampMonotonic
    && (nextRuntimeState.activeState !== previousRuntimeState.activeState || nextRuntimeState.subState !== previousRuntimeState.subState)
  ) {
    return true;
  }

  return false;
}

function isGatewayRuntimeStateKnown(runtimeState: OpenClawGatewayServiceRuntimeState) {
  return runtimeState.execMainPid !== null
    || runtimeState.activeState !== null
    || runtimeState.subState !== null
    || runtimeState.activeEnterTimestampMonotonic !== null
    || runtimeState.execMainStartTimestampMonotonic !== null
    || runtimeState.stateChangeTimestampMonotonic !== null;
}

function getGatewayRestartStableWindowMs(trigger: GatewayRestartTrigger | null) {
  return trigger === 'gateway'
    ? OPENCLAW_GATEWAY_MANUAL_RESTART_STABLE_WINDOW_MS
    : OPENCLAW_GATEWAY_RESTART_STABLE_WINDOW_MS;
}

export type GatewayServiceDeps = {
  configManager: ConfigManager;
  connections: Map<string, OpenClawClient>;
};

export function createGatewayService(ctx: GatewayServiceDeps) {
  const { configManager, connections } = ctx;

  function syncPersistedGatewayRestartSnapshot() {
    try {
      if (gatewayRestartSnapshot.status === 'restarting' || gatewayRestartSnapshot.status === 'failed') {
        fs.mkdirSync(path.dirname(gatewayRestartStatePath), { recursive: true });
        fs.writeFileSync(gatewayRestartStatePath, `${JSON.stringify(gatewayRestartSnapshot, null, 2)}\n`);
        return;
      }

      fs.rmSync(gatewayRestartStatePath, { force: true });
    } catch (error) {
      console.warn('[GatewayRestart] Failed to sync persisted restart state:', error);
    }
  }
  let gatewayRestartSnapshot = readPersistedGatewayRestartSnapshot() || createDefaultGatewayRestartSnapshot();
  let activeGatewayRestartTask: Promise<void> | null = null;
  let gatewayRestartReconcileStableSinceMs: number | null = null;

  function getGatewayRestartSnapshot() {
    return { ...gatewayRestartSnapshot };
  }

  function patchGatewayRestartSnapshot(patch: Partial<GatewayRestartSnapshot>) {
    if (patch.status !== undefined) {
      gatewayRestartReconcileStableSinceMs = null;
    }
    gatewayRestartSnapshot = {
      ...gatewayRestartSnapshot,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    syncPersistedGatewayRestartSnapshot();
  }

  function resetGatewayRestartSnapshot() {
    gatewayRestartReconcileStableSinceMs = null;
    gatewayRestartSnapshot = createDefaultGatewayRestartSnapshot();
    syncPersistedGatewayRestartSnapshot();
  }
  let gatewayRestartTask: Promise<void> | null = null;
  let gatewayRestartQueued = false;

  async function restartGatewayService() {
    for (const [sessionId, client] of connections.entries()) {
      try {
        client.disconnect();
      } catch (err) {
        console.error(`Error disconnecting client ${sessionId}:`, err);
      }
    }
    connections.clear();
    const executablePath = await ensureResolvedOpenClawExecutablePath();
    await execFilePromise(executablePath, ['gateway', 'restart']);
  }

  function buildGatewayStatusProbeParams() {
    const appConfig = configManager.getConfig();
    const localGatewayConfig = readLocalGatewayRuntimeConfig();
    const localPort = localGatewayConfig?.port ?? 18789;
    const localGatewayUrl = `ws://127.0.0.1:${localPort}`;
    const configuredGatewayUrl = normalizeCliText(appConfig.gatewayUrl);
    const gatewayTarget = parseGatewayUrlForStatusProbe(configuredGatewayUrl || localGatewayUrl);
    const shouldUseLocalRuntimeConfig = !!localGatewayConfig
      && (!configuredGatewayUrl || (gatewayTarget ? isLocalGatewayHostname(gatewayTarget.hostname) : false));

    return {
      gatewayUrl: shouldUseLocalRuntimeConfig ? localGatewayUrl : configuredGatewayUrl,
      token: shouldUseLocalRuntimeConfig
        ? (localGatewayConfig.token || undefined)
        : (normalizeCliText(appConfig.token) || localGatewayConfig?.token || undefined),
      password: shouldUseLocalRuntimeConfig
        ? (localGatewayConfig.password || undefined)
        : (normalizeCliText(appConfig.password) || localGatewayConfig?.password || undefined),
    };
  }

  async function probeGatewayRestartReadinessStatus() {
    return probeGatewayConnectionStatus(buildGatewayStatusProbeParams(), {
      preferLocalHealth: true,
      allowRpcProbe: false,
    });
  }

  async function waitForGatewayRestartAfterBrowserModeChange(
    previousRuntimeState: OpenClawGatewayServiceRuntimeState,
    options?: {
      stableWindowMs?: number;
    },
  ) {
    const deadline = Date.now() + BROWSER_HEADED_MODE_RESTART_TIMEOUT_MS;
    const stableWindowMs = Math.max(0, options?.stableWindowMs ?? OPENCLAW_GATEWAY_RESTART_STABLE_WINDOW_MS);
    let restartObserved = false;
    let lastFailure = 'OpenClaw restart in progress';

    while (Date.now() < deadline) {
      const runtimeState = await readOpenClawGatewayServiceRuntimeState();
      const runtimeStateKnown = isGatewayRuntimeStateKnown(runtimeState);
      const runtimeStateRunning = runtimeState.activeState === 'active' && runtimeState.subState === 'running';
      if (hasGatewayRestartBeenObserved(previousRuntimeState, runtimeState)) {
        restartObserved = true;
      }

      if (
        runtimeStateKnown
        && !runtimeStateRunning
      ) {
        restartObserved = true;
      }

      if (runtimeStateKnown && runtimeState.activeState === 'failed') {
        throw new Error('OpenClaw gateway service failed to restart.');
      }

      const probe = await probeGatewayRestartReadinessStatus();
      const runtimeReady = !runtimeStateKnown || runtimeStateRunning;

      if (!probe.connected || !runtimeReady) {
        restartObserved = true;
        lastFailure = probe.message || (runtimeReady
          ? 'OpenClaw gateway is still warming up.'
          : 'OpenClaw gateway service is still starting.');
      } else if (restartObserved) {
        await waitForGatewayConnectionStable(Math.max(0, deadline - Date.now()), {
          minimumStableWindowMs: stableWindowMs,
          probeIntervalMs: BROWSER_HEADED_MODE_RESTART_POLL_INTERVAL_MS,
        });
        return;
      } else {
        lastFailure = 'Waiting to observe OpenClaw gateway restart.';
      }

      await sleep(BROWSER_HEADED_MODE_RESTART_POLL_INTERVAL_MS);
    }

    throw new Error(
      restartObserved
        ? (lastFailure || 'Timed out waiting for OpenClaw to restart.')
        : 'Timed out waiting to observe OpenClaw gateway restart.'
    );
  }

  async function waitForGatewayConnectionStable(
    timeoutMs: number,
    options?: {
      minimumStableWindowMs?: number;
      probeIntervalMs?: number;
    },
  ) {
    const deadline = Date.now() + timeoutMs;
    const minimumStableWindowMs = Math.max(0, options?.minimumStableWindowMs ?? 0);
    const probeIntervalMs = Math.max(250, options?.probeIntervalMs ?? UPDATE_RESTART_RESUME_POLL_INTERVAL_MS);
    let lastFailure = 'OpenClaw connection is still recovering';
    let stableSinceMs: number | null = null;

    while (Date.now() < deadline) {
      const probe = await probeGatewayRestartReadinessStatus();
      if (probe.connected) {
        const now = Date.now();
        if (stableSinceMs === null) {
          stableSinceMs = now;
        }

        if ((now - stableSinceMs) >= minimumStableWindowMs) {
          return;
        }

        lastFailure = 'OpenClaw gateway recovered, waiting to confirm connection stability.';
      } else {
        stableSinceMs = null;
        lastFailure = probe.message || lastFailure;
      }

      await sleep(probeIntervalMs);
    }

    throw new Error(lastFailure || 'Timed out waiting for OpenClaw to become available.');
  }

  async function reconcileGatewayRestartSnapshot() {
    if (gatewayRestartSnapshot.status !== 'restarting' || activeGatewayRestartTask) {
      gatewayRestartReconcileStableSinceMs = null;
      return getGatewayRestartSnapshot();
    }

    try {
      const probe = await probeGatewayRestartReadinessStatus();
      if (probe.connected) {
        const now = Date.now();
        if (gatewayRestartReconcileStableSinceMs === null) {
          gatewayRestartReconcileStableSinceMs = now;
        } else if ((now - gatewayRestartReconcileStableSinceMs) >= getGatewayRestartStableWindowMs(gatewayRestartSnapshot.trigger)) {
          resetGatewayRestartSnapshot();
        }
      } else {
        gatewayRestartReconcileStableSinceMs = null;
      }
    } catch {
      gatewayRestartReconcileStableSinceMs = null;
    }

    return getGatewayRestartSnapshot();
  }

  function runTrackedGatewayRestart(options: {
    trigger: GatewayRestartTrigger;
    previousRuntimeState: OpenClawGatewayServiceRuntimeState;
    targetHeadedModeEnabled?: boolean | null;
  }) {
    if (activeGatewayRestartTask) {
      return getGatewayRestartSnapshot();
    }

    patchGatewayRestartSnapshot({
      status: 'restarting',
      trigger: options.trigger,
      rawDetail: null,
      startedAt: new Date().toISOString(),
      targetHeadedModeEnabled: typeof options.targetHeadedModeEnabled === 'boolean'
        ? options.targetHeadedModeEnabled
        : null,
    });

    activeGatewayRestartTask = (async () => {
      try {
        await restartGatewayService();
        await waitForGatewayRestartAfterBrowserModeChange(options.previousRuntimeState, {
          stableWindowMs: getGatewayRestartStableWindowMs(options.trigger),
        });
        resetGatewayRestartSnapshot();
      } catch (error) {
        patchGatewayRestartSnapshot({
          status: 'failed',
          trigger: options.trigger,
          rawDetail: readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error)),
          targetHeadedModeEnabled: typeof options.targetHeadedModeEnabled === 'boolean'
            ? options.targetHeadedModeEnabled
            : null,
        });
        console.error('Tracked gateway restart task failed:', error);
      }
    })().finally(() => {
      activeGatewayRestartTask = null;
    });

    return getGatewayRestartSnapshot();
  }

  function scheduleGatewayRestart() {
    gatewayRestartQueued = true;
    if (gatewayRestartTask) {
      return gatewayRestartTask;
    }

    gatewayRestartTask = (async () => {
      while (gatewayRestartQueued) {
        gatewayRestartQueued = false;
        await restartGatewayService();
      }
    })().finally(() => {
      gatewayRestartTask = null;
    });

    return gatewayRestartTask;
  }

  return {
    getGatewayRestartSnapshot,
    resetGatewayRestartSnapshot,
    restartGatewayService,
    buildGatewayStatusProbeParams,
    waitForGatewayRestartAfterBrowserModeChange,
    waitForGatewayConnectionStable,
    reconcileGatewayRestartSnapshot,
    runTrackedGatewayRestart,
    scheduleGatewayRestart,
  };
}
export type GatewayService = ReturnType<typeof createGatewayService>;
