import fs from 'fs';

import { sharedFileStore, writeJsonAtomicSync } from '../../core/files';
import {
  applyOpenClawExecPreflightBypass,
  getExecApprovalsPath,
  getOpenClawConfigPath,
  readJsonConfigSafe,
  readOpenClawConfig,
  readOpenClawConfigSafe,
  restoreFilePathSnapshots,
  restoreTextFile,
  snapshotOpenClawExecPreflightPatchFiles,
  snapshotTextFile,
  synchronizeOpenClawBrowserFillCompatBestEffort,
} from '../../openclaw';
import { warmManagedHostToolingInBackground } from '../../workspace';
import { applyBrowserRepairSettingsToOpenClawConfig } from './browser-service';
import {
  ensureHostTakeoverWrappers,
  installHostTakeoverHelper,
  reloadOpenClawGatewayUserSystemd,
  restoreHostTakeoverOverride,
  safeReadHostTakeoverStatus,
  setHostTakeoverSystemdOverrideEnabled,
  snapshotHostTakeoverOverride,
} from './host-takeover';

function isMaxPermissionsConfigEnabled(config: any): boolean {
  return !config?.tools?.profile && config?.tools?.exec?.security === 'full';
}

export function readMaxPermissionsEnabled(): boolean | null {
  try {
    const config = readOpenClawConfig();
    if (!config) {
      return null;
    }
    return isMaxPermissionsConfigEnabled(config);
  } catch (error) {
    return null;
  }
}

export function patchExecApprovals(enabled: boolean) {
  const execApprovalsPath = getExecApprovalsPath();
  if (!fs.existsSync(execApprovalsPath)) {
    return;
  }

  const approvalsRead = readJsonConfigSafe(execApprovalsPath);
  const approvals: any = approvalsRead.exists ? approvalsRead.value : {};
  if (!approvals.defaults) approvals.defaults = {};

  if (enabled) {
    approvals.defaults.ask = 'off';
    approvals.defaults.security = 'full';
    approvals.agents = { '*': { allowlist: [{ pattern: '*' }] } };
  } else {
    delete approvals.defaults.ask;
    delete approvals.defaults.security;
    delete approvals.agents;
  }

  writeJsonAtomicSync(execApprovalsPath, approvals);
}

function applyMaxPermissionsConfig(config: any, enabled: boolean) {
  if (enabled) {
    config.tools = MAX_PERMISSIONS_TOOLS;

    if (!config.commands) config.commands = {};
    config.commands.bash = true;
    config.commands.restart = true;
    config.commands.native = 'auto';
    config.commands.nativeSkills = 'auto';

    if (!config.browser) config.browser = {};
    config.browser.enabled = true;
    applyBrowserRepairSettingsToOpenClawConfig(config);
  } else {
    config.tools = { profile: 'coding' };
  }

  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (enabled) {
    if (!config.agents.defaults.sandbox) config.agents.defaults.sandbox = {};
    config.agents.defaults.sandbox.mode = 'off';
    config.agents.defaults.elevatedDefault = 'full';
  } else {
    if (config.agents.defaults.sandbox && typeof config.agents.defaults.sandbox === 'object') {
      delete config.agents.defaults.sandbox.mode;
      if (Object.keys(config.agents.defaults.sandbox).length === 0) {
        delete config.agents.defaults.sandbox;
      }
    }
    delete config.agents.defaults.elevatedDefault;
  }
}

function setMaxPermissionsEnabled(enabled: boolean) {
  const configPath = getOpenClawConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error('openclaw.json not found');
  }

  const config = readOpenClawConfigSafe() ?? {};
  applyMaxPermissionsConfig(config, enabled);

  sharedFileStore.writeJsonSync(configPath, config);
  patchExecApprovals(enabled);

  return { enabled };
}

export async function configureMaxPermissionsState(enabled: boolean, options?: { systemPassword?: string | null }) {
  const configPath = getOpenClawConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error('openclaw.json not found');
  }

  const execApprovalsPath = getExecApprovalsPath();
  const configSnapshot = snapshotTextFile(configPath);
  const approvalsSnapshot = snapshotTextFile(execApprovalsPath);
  const overrideSnapshot = snapshotHostTakeoverOverride();
  const execPreflightSnapshot = snapshotOpenClawExecPreflightPatchFiles();
  let overrideTouched = false;

  try {
    if (enabled) {
      ensureHostTakeoverWrappers();
      await installHostTakeoverHelper(options?.systemPassword);
      overrideTouched = true;
      await setHostTakeoverSystemdOverrideEnabled(true);
    } else {
      overrideTouched = overrideSnapshot.existed;
      await setHostTakeoverSystemdOverrideEnabled(false);
    }

    setMaxPermissionsEnabled(enabled);
    applyOpenClawExecPreflightBypass(enabled);
    synchronizeOpenClawBrowserFillCompatBestEffort();

    if (enabled) {
      warmManagedHostToolingInBackground();
    }

    return {
      enabled,
      hostTakeover: await safeReadHostTakeoverStatus(enabled),
    };
  } catch (error) {
    try {
      restoreTextFile(configPath, configSnapshot);
    } catch (restoreConfigError) {
      console.error('Failed to restore openclaw.json after max permissions error:', restoreConfigError);
    }

    try {
      restoreTextFile(execApprovalsPath, approvalsSnapshot);
    } catch (restoreApprovalsError) {
      console.error('Failed to restore exec approvals after max permissions error:', restoreApprovalsError);
    }

    try {
      restoreFilePathSnapshots(execPreflightSnapshot);
    } catch (restoreExecPreflightError) {
      console.error('Failed to restore the OpenClaw exec preflight patch state after max permissions error:', restoreExecPreflightError);
    }

    try {
      restoreHostTakeoverOverride(overrideSnapshot);
      if (overrideTouched) {
        await reloadOpenClawGatewayUserSystemd();
      }
    } catch (restoreOverrideError) {
      console.error('Failed to restore host takeover override after max permissions error:', restoreOverrideError);
    }

    throw error;
  }
}

// --- Max Permissions Toggle ---
const MAX_PERMISSIONS_TOOLS = {
  web: {
    fetch: { enabled: true }
  },
  exec: {
    security: 'full',
    ask: 'off'
  },
  elevated: {
    enabled: true,
    allowFrom: { webchat: ['*'], '*': ['*'] }
  }
};
