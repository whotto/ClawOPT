import fs from 'fs';
import path from 'path';

import { BROWSER_TASK_BUSY_ERROR_CODE, StructuredRequestError } from '../../core/http';
import { browserWarmupMarkerPath } from '../../core/paths';
import { execFilePromise, readCliErrorDetail } from '../../core/process';
import { normalizeCliText, sleep } from '../../core/util';
import {
  ensureResolvedOpenClawExecutablePath,
  type GatewayService,
  getOpenClawConfigPath,
  probeGatewayConnectionStatus,
  readOpenClawConfig,
  readOpenClawConfigSafe,
  writeOpenClawConfig,
} from '../../openclaw';
import { readMaxPermissionsEnabled } from './max-permissions';

const BROWSER_HEALTH_CLI_TIMEOUT_MS = 15000;
const BROWSER_HEALTH_EXEC_TIMEOUT_MS = 20000;
const BROWSER_HEALTH_PROFILE = 'openclaw';
const BROWSER_HEALTH_VALIDATION_URL = 'https://example.com';
const BROWSER_HEALTH_FALLBACK_VALIDATION_URL = 'http://example.com';
const BROWSER_HEALTH_START_TIMEOUT_MS = 30000;
const BROWSER_HEALTH_OPEN_TIMEOUT_MS = 40000;
const BROWSER_HEALTH_SNAPSHOT_TIMEOUT_MS = 45000;
const BROWSER_HEALTH_GATEWAY_READY_TIMEOUT_MS = 60 * 1000;
const BROWSER_HEALTH_GATEWAY_READY_POLL_INTERVAL_MS = 1500;
export const BROWSER_SELF_HEAL_GATEWAY_READY_TIMEOUT_MS = 2 * 60 * 1000;
const BROWSER_SELF_HEAL_PLUGIN_REGISTRY_REFRESH_TIMEOUT_MS = 45 * 1000;
const BROWSER_SELF_HEAL_STOP_TIMEOUT_MS = 8000;
const BROWSER_SELF_HEAL_RESET_PROFILE_TIMEOUT_MS = 45000;
const BROWSER_POST_RESTART_WARMUP_DELAY_MS = 8000;
const BROWSER_POST_RESTART_WARMUP_MARKER_MAX_AGE_MS = 30 * 60 * 1000;
export const BROWSER_HEADED_MODE_RESTART_TIMEOUT_MS = 3 * 60 * 1000;
export const BROWSER_HEADED_MODE_RESTART_POLL_INTERVAL_MS = 1500;

type BrowserHealthIssue = 'permissions' | 'disabled' | 'stopped' | 'detect-error' | 'timeout' | 'unknown';

type BrowserHealthSnapshot = {
  healthy: boolean;
  issue: BrowserHealthIssue | null;
  checkedAt: number;
  maxPermissionsEnabled: boolean | null;
  profile: string | null;
  enabled: boolean | null;
  running: boolean | null;
  transport: string | null;
  chosenBrowser: string | null;
  detectedBrowser: string | null;
  headless: boolean | null;
  detectError: string | null;
  rawDetail: string | null;
  validationSucceeded: boolean | null;
  validationDetail: string | null;
  config: BrowserConfigState;
  runtime: BrowserRuntimeState | null;
};

type BrowserConfigState = {
  enabled: boolean | null;
  headless: boolean | null;
  profile: string | null;
  executablePath: string | null;
  noSandbox: boolean | null;
  attachOnly: boolean | null;
  cdpPort: number | null;
};

type BrowserRuntimeState = {
  profile: string | null;
  running: boolean | null;
  transport: string | null;
  chosenBrowser: string | null;
  detectedBrowser: string | null;
  headless: boolean | null;
  detectError: string | null;
};

type BrowserHeadedModeConfig = {
  headless: boolean;
  headedModeEnabled: boolean;
};

type PendingGatewayRuntimeConfig = {
  maxPermissionsEnabled?: boolean;
  browserHeadedModeEnabled?: boolean;
};

type BrowserHealthDiagnostics = Omit<BrowserHealthSnapshot, 'healthy' | 'issue' | 'validationSucceeded' | 'validationDetail'>;

type BrowserTaskStatus = 'idle' | 'checking' | 'repairing';

type BrowserTaskSnapshot = {
  status: BrowserTaskStatus;
  phase: string | null;
  rawDetail: string | null;
  updatedAt: string | null;
};

export function markBrowserWarmupRequested() {
  try {
    fs.mkdirSync(path.dirname(browserWarmupMarkerPath), { recursive: true });
    fs.writeFileSync(browserWarmupMarkerPath, `${Date.now()}\n`);
  } catch (error) {
    console.warn('[BrowserWarmup] Failed to persist warmup marker:', error);
  }
}

export function consumeBrowserWarmupRequest() {
  try {
    if (!fs.existsSync(browserWarmupMarkerPath)) {
      return false;
    }

    const stat = fs.statSync(browserWarmupMarkerPath);
    fs.unlinkSync(browserWarmupMarkerPath);
    return (Date.now() - stat.mtimeMs) <= BROWSER_POST_RESTART_WARMUP_MARKER_MAX_AGE_MS;
  } catch (error) {
    console.warn('[BrowserWarmup] Failed to consume warmup marker:', error);
    return false;
  }
}

function normalizeConfiguredBrowserProfile(config: any): string {
  return normalizeCliText(config?.browser?.defaultProfile)
    || normalizeCliText(config?.browser?.profile)
    || BROWSER_HEALTH_PROFILE;
}

export function applyBrowserRepairSettingsToOpenClawConfig(config: any): boolean {
  if (!config || typeof config !== 'object') {
    return false;
  }

  if (!config.browser || typeof config.browser !== 'object') {
    config.browser = {};
  }

  const currentPolicy = config.browser.ssrfPolicy && typeof config.browser.ssrfPolicy === 'object'
    ? { ...config.browser.ssrfPolicy }
    : {};
  const desiredAllowPrivateNetwork = true;
  let changed = false;

  if ('allowPrivateNetwork' in currentPolicy) {
    delete currentPolicy.allowPrivateNetwork;
    changed = true;
  }

  if (currentPolicy.dangerouslyAllowPrivateNetwork !== desiredAllowPrivateNetwork) {
    currentPolicy.dangerouslyAllowPrivateNetwork = desiredAllowPrivateNetwork;
    changed = true;
  }

  if (changed) {
    config.browser.ssrfPolicy = currentPolicy;
  }

  return changed;
}

export function synchronizeConfiguredBrowserRepairSettings() {
  const config = readOpenClawConfig();
  if (!config) {
    return {
      changed: false,
    };
  }

  const changed = applyBrowserRepairSettingsToOpenClawConfig(config);
  if (changed) {
    writeOpenClawConfig(config);
  }

  return {
    changed,
  };
}

export function synchronizeConfiguredBrowserRepairSettingsBestEffort() {
  try {
    synchronizeConfiguredBrowserRepairSettings();
  } catch (error) {
    console.error('Failed to synchronize browser repair settings into openclaw.json:', error);
  }
}

/**
 * 浏览器能力是否被配置排除了；返回原因，可用时返回 null。
 *
 * 两种排除方式，任一命中都说明**用户就没打算用浏览器**：
 *   - `plugins.allow` 是白名单且不含 "browser"：`openclaw browser` 子命令根本不存在
 *   - `browser.enabled` 不为 true：这正是 reconcile-openclaw-runtime.mjs 用的判据
 *
 * 为什么要有这个函数：升级流程末尾会做一次浏览器预热验收，而一个用户主动没启用的
 * 可选插件不该让整条升级流程报红。之前后端缺这道判断，`browser` 键干脆不存在时
 * `enabled` 既不是 true 也不是 false，于是既没短路也没跳过，直接去执行一个不存在的
 * 命令，然后把配置性的「命令不可用」当成升级失败。
 */
export function readBrowserUnavailableReason(): string | null {
  const config = readOpenClawConfig();
  const allow = config?.plugins?.allow;
  if (Array.isArray(allow) && !allow.some((entry: unknown) => normalizeCliText(String(entry)) === 'browser')) {
    return 'browser-not-allowed';
  }
  if (config?.browser?.enabled !== true) {
    return 'browser-not-enabled';
  }
  return null;
}

function readBrowserConfigState(): BrowserConfigState {
  const config = readOpenClawConfig();
  const profile = normalizeConfiguredBrowserProfile(config);
  const profileConfig = config?.browser?.profiles?.[profile];
  const configuredCdpPort = profileConfig?.cdpPort ?? config?.browser?.cdpPort;

  return {
    enabled: typeof config?.browser?.enabled === 'boolean' ? config.browser.enabled : null,
    headless: typeof profileConfig?.headless === 'boolean'
      ? profileConfig.headless
      : typeof config?.browser?.headless === 'boolean'
        ? config.browser.headless
        : null,
    profile,
    executablePath: normalizeCliText(config?.browser?.executablePath) || null,
    noSandbox: typeof config?.browser?.noSandbox === 'boolean' ? config.browser.noSandbox : null,
    attachOnly: typeof config?.browser?.attachOnly === 'boolean' ? config.browser.attachOnly : null,
    cdpPort: Number.isFinite(configuredCdpPort) ? Number(configuredCdpPort) : null,
  };
}

export function readBrowserHeadedModeConfig(): BrowserHeadedModeConfig {
  const configPath = getOpenClawConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error('openclaw.json not found');
  }

  const config = readOpenClawConfigSafe() ?? {};
  const headless = config?.browser?.headless === true;

  return {
    headless,
    headedModeEnabled: !headless,
  };
}

export function setBrowserHeadedModeEnabled(headedModeEnabled: boolean): BrowserHeadedModeConfig {
  const configPath = getOpenClawConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error('openclaw.json not found');
  }

  const config = readOpenClawConfigSafe() ?? {};
  if (!config.browser || typeof config.browser !== 'object') {
    config.browser = {};
  }
  config.browser.headless = !headedModeEnabled;
  writeOpenClawConfig(config);

  return {
    headless: config.browser.headless === true,
    headedModeEnabled: config.browser.headless !== true,
  };
}

function buildFallbackBrowserHealthDiagnostics(
  checkedAt = Date.now(),
  rawDetail?: string | null
): BrowserHealthDiagnostics {
  const browserConfig = readBrowserConfigState();

  return {
    checkedAt,
    maxPermissionsEnabled: readMaxPermissionsEnabled(),
    profile: browserConfig.profile,
    enabled: browserConfig.enabled,
    running: null,
    transport: null,
    chosenBrowser: null,
    detectedBrowser: null,
    headless: null,
    detectError: null,
    rawDetail: normalizeCliText(rawDetail) || null,
    config: browserConfig,
    runtime: null,
  };
}

function resolveBrowserValidationFailureIssue(detail: string, diagnostics: BrowserHealthDiagnostics): BrowserHealthIssue {
  if (diagnostics.enabled === false || /browser control is disabled/i.test(detail)) {
    return 'disabled';
  }
  if (diagnostics.detectError) {
    return 'detect-error';
  }
  if (/executablepath not found|attachonly|no chrome tabs found/i.test(detail)) {
    return 'detect-error';
  }
  if (diagnostics.running === false) {
    return 'stopped';
  }
  if (/timed out|timeout/i.test(detail)) {
    return 'timeout';
  }
  return 'unknown';
}

function finalizeBrowserHealthSnapshot(
  snapshot: BrowserHealthDiagnostics & {
    issue?: BrowserHealthIssue | null;
    validationSucceeded?: boolean | null;
    validationDetail?: string | null;
  }
): BrowserHealthSnapshot {
  let issue = snapshot.issue ?? null;
  const validationSucceeded = typeof snapshot.validationSucceeded === 'boolean'
    ? snapshot.validationSucceeded
    : null;
  const validationDetail = normalizeCliText(snapshot.validationDetail) || null;

  if (!issue) {
    if (snapshot.maxPermissionsEnabled === false) {
      issue = 'permissions';
    } else if (snapshot.enabled === false) {
      issue = 'disabled';
    } else if (validationSucceeded === false) {
      issue = resolveBrowserValidationFailureIssue(validationDetail || snapshot.rawDetail || '', snapshot);
    } else if (validationSucceeded !== true) {
      if (snapshot.running === false) issue = 'stopped';
      else if (snapshot.detectError) issue = 'detect-error';
      else issue = 'unknown';
    }
  }

  const fallbackDetail = normalizeCliText(snapshot.rawDetail) || null;
  const rawDetail = validationSucceeded === false
    ? validationDetail
    : issue === null
      ? null
      : fallbackDetail;

  return {
    ...snapshot,
    healthy: issue === null && validationSucceeded === true,
    issue,
    rawDetail,
    validationSucceeded,
    validationDetail,
  };
}

function buildBrowserHealthDiagnosticsFromCli(
  raw: any,
  checkedAt = Date.now(),
  browserConfig = readBrowserConfigState(),
  rawDetail?: string | null
): BrowserHealthDiagnostics {
  const maxPermissionsEnabled = readMaxPermissionsEnabled();
  const enabled = browserConfig.enabled;
  const running = typeof raw?.running === 'boolean' ? raw.running : null;
  const headless = typeof raw?.headless === 'boolean' ? raw.headless : null;
  const detectError = normalizeCliText(raw?.detectError) || null;
  const runtime: BrowserRuntimeState = {
    profile: normalizeCliText(raw?.profile) || browserConfig.profile,
    running,
    transport: normalizeCliText(raw?.transport) || null,
    chosenBrowser: normalizeCliText(raw?.chosenBrowser) || null,
    detectedBrowser: normalizeCliText(raw?.detectedBrowser) || null,
    headless,
    detectError,
  };

  return {
    checkedAt,
    maxPermissionsEnabled,
    profile: runtime.profile || browserConfig.profile,
    enabled,
    running,
    transport: runtime.transport,
    chosenBrowser: runtime.chosenBrowser,
    detectedBrowser: runtime.detectedBrowser,
    headless,
    detectError,
    rawDetail: normalizeCliText(rawDetail) || null,
    config: browserConfig,
    runtime,
  };
}

function parseBrowserStatusCliBoolean(value: string): boolean | null {
  const normalized = normalizeCliText(value).toLowerCase();
  if (normalized.startsWith('true')) return true;
  if (normalized.startsWith('false')) return false;
  return null;
}

function parseBrowserStatusCliText(output: string): Record<string, unknown> | null {
  const normalizedOutput = normalizeCliText(output);
  if (!normalizedOutput) return null;

  const parsed: Record<string, unknown> = {};
  for (const line of normalizedOutput.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9._-]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;

    const key = match[1];
    const value = match[2];
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'enabled' || normalizedKey === 'running' || normalizedKey === 'headless') {
      const parsedBoolean = parseBrowserStatusCliBoolean(value);
      if (parsedBoolean !== null) {
        parsed[normalizedKey] = parsedBoolean;
      }
      continue;
    }

    if (normalizedKey === 'profile') {
      parsed.profile = normalizeCliText(value);
    } else if (normalizedKey === 'transport') {
      parsed.transport = normalizeCliText(value);
    } else if (normalizedKey === 'browser' || normalizedKey === 'chosenbrowser') {
      parsed.chosenBrowser = normalizeCliText(value);
    } else if (normalizedKey === 'detectedbrowser') {
      parsed.detectedBrowser = normalizeCliText(value);
    } else if (normalizedKey === 'detecterror') {
      const detail = normalizeCliText(value);
      parsed.detectError = /^(none|null|n\/a)$/i.test(detail) ? '' : detail;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

function parseBrowserStatusCliOutput(output: string): Record<string, unknown> | null {
  const normalizedOutput = normalizeCliText(output);
  if (!normalizedOutput) return null;

  try {
    return JSON.parse(normalizedOutput);
  } catch {}

  const jsonStart = normalizedOutput.indexOf('{');
  const jsonEnd = normalizedOutput.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      return JSON.parse(normalizedOutput.slice(jsonStart, jsonEnd + 1));
    } catch {}
  }

  return parseBrowserStatusCliText(normalizedOutput);
}

async function runOpenClawBrowserCommand(args: string[], timeoutMs: number) {
  const executablePath = await ensureResolvedOpenClawExecutablePath();
  return execFilePromise(executablePath, ['browser', ...args], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

export async function refreshOpenClawPluginRegistryForBrowserSelfHeal() {
  const executablePath = await ensureResolvedOpenClawExecutablePath();
  await execFilePromise(executablePath, ['plugins', 'registry', '--refresh'], {
    timeout: BROWSER_SELF_HEAL_PLUGIN_REGISTRY_REFRESH_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

function isBrowserGatewayNotReadyError(error: unknown): boolean {
  return !!(error as { browserGatewayNotReady?: boolean } | null)?.browserGatewayNotReady;
}

function buildBrowserProfileArgs(browserConfig: BrowserConfigState, args: string[]) {
  return ['--browser-profile', browserConfig.profile || BROWSER_HEALTH_PROFILE, ...args];
}

function isExampleDomainSnapshot(snapshotText: string) {
  return normalizeCliText(snapshotText).includes('Example Domain');
}

function isCertificateInterstitialSnapshot(snapshotText: string) {
  const normalized = normalizeCliText(snapshotText);
  return /ERR_CERT_/i.test(normalized)
    || normalized.includes('您的连接不是私密连接')
    || normalized.includes('Your connection is not private');
}

function readConfiguredBrowserValidationError(browserConfig: BrowserConfigState): string | null {
  if (browserConfig.enabled === false) {
    return 'browser.enabled is false';
  }

  if (browserConfig.executablePath) {
    try {
      const stat = fs.statSync(browserConfig.executablePath);
      if (!stat.isFile()) {
        return `browser.executablePath not found: ${browserConfig.executablePath}`;
      }
      fs.accessSync(browserConfig.executablePath, fs.constants.X_OK);
    } catch {
      return `browser.executablePath not found: ${browserConfig.executablePath}`;
    }
  }

  return null;
}

export async function stopOpenClawBrowserBestEffort() {
  try {
    const browserConfig = readBrowserConfigState();
    await runOpenClawBrowserCommand(
      buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_SELF_HEAL_STOP_TIMEOUT_MS), 'stop']),
      BROWSER_SELF_HEAL_STOP_TIMEOUT_MS + 3000
    );
  } catch (error) {
    // Browser may already be stopped or the CLI may time out; self-heal should continue.
  }
}

export async function resetOpenClawBrowserProfile() {
  const browserConfig = readBrowserConfigState();
  await runOpenClawBrowserCommand(
    buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_SELF_HEAL_RESET_PROFILE_TIMEOUT_MS), 'reset-profile']),
    BROWSER_SELF_HEAL_RESET_PROFILE_TIMEOUT_MS + 3000
  );
}

export function shouldRetryBrowserRepairWithProfileReset(lastKnownIssue: BrowserHealthIssue | null) {
  const browserConfig = readBrowserConfigState();
  if (browserConfig.attachOnly === true) {
    return false;
  }

  return lastKnownIssue === 'detect-error'
    || lastKnownIssue === 'timeout'
    || lastKnownIssue === 'unknown';
}

type BrowserTaskProgressReporter = (phase: string, rawDetail?: string | null) => void;

type BrowserRuntimeReadiness = {
  ready: boolean;
  terminalFailure: boolean;
  diagnostics: BrowserHealthDiagnostics;
  detail: string | null;
};

async function readBrowserHealthDiagnostics(
  browserConfig = readBrowserConfigState(),
  checkedAt = Date.now(),
  rawDetail?: string | null
): Promise<BrowserHealthDiagnostics> {
  try {
    const { stdout, stderr } = await runOpenClawBrowserCommand(
      buildBrowserProfileArgs(browserConfig, ['--json', '--timeout', String(BROWSER_HEALTH_CLI_TIMEOUT_MS), 'status']),
      BROWSER_HEALTH_EXEC_TIMEOUT_MS
    );
    const parsed = parseBrowserStatusCliOutput(stdout) || parseBrowserStatusCliOutput(stderr);
    if (parsed) {
      return buildBrowserHealthDiagnosticsFromCli(parsed, checkedAt, browserConfig, rawDetail);
    }
    return buildFallbackBrowserHealthDiagnostics(checkedAt, rawDetail || 'Unable to parse OpenClaw browser status output');
  } catch (error: any) {
    const output = normalizeCliText(error?.stdout) || normalizeCliText(error?.stderr);
    if (output) {
      const parsed = parseBrowserStatusCliOutput(output);
      if (parsed) {
        return buildBrowserHealthDiagnosticsFromCli(parsed, checkedAt, browserConfig, rawDetail || readCliErrorDetail(error));
      }
    }

    return buildFallbackBrowserHealthDiagnostics(checkedAt, rawDetail || readCliErrorDetail(error));
  }
}

async function waitForBrowserRunning(browserConfig: BrowserConfigState, checkedAt: number) {
  let diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (diagnostics.running === true) {
      return diagnostics;
    }
    await sleep(2000);
    diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);
  }
  return diagnostics;
}

async function readBrowserSnapshot(browserConfig: BrowserConfigState) {
  const { stdout } = await runOpenClawBrowserCommand(
    buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_HEALTH_OPEN_TIMEOUT_MS), 'snapshot']),
    BROWSER_HEALTH_SNAPSHOT_TIMEOUT_MS
  );
  return normalizeCliText(stdout);
}

async function captureExampleDomainSnapshot(browserConfig: BrowserConfigState) {
  let lastSnapshot = '';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastSnapshot = await readBrowserSnapshot(browserConfig);
    if (isExampleDomainSnapshot(lastSnapshot)) {
      return lastSnapshot;
    }
    await sleep(2000);
  }

  const error = new Error(`Browser snapshot did not capture the Example Domain page. Last snapshot: ${lastSnapshot || 'empty'}`);
  (error as Error & { snapshotText?: string }).snapshotText = lastSnapshot;
  throw error;
}

async function openBrowserValidationUrl(browserConfig: BrowserConfigState, url: string) {
  const { stdout } = await runOpenClawBrowserCommand(
    buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_HEALTH_OPEN_TIMEOUT_MS), 'open', url]),
    BROWSER_HEALTH_OPEN_TIMEOUT_MS
  );

  if (!/opened:/i.test(normalizeCliText(stdout))) {
    throw new Error(`Browser open command did not confirm navigation to ${url}.`);
  }
}

export type BrowserServiceDeps = {
  gatewayService: GatewayService;
};

export function createBrowserService(ctx: BrowserServiceDeps) {
  const { buildGatewayStatusProbeParams } = ctx.gatewayService;

  let browserTaskSnapshot: BrowserTaskSnapshot = {
    status: 'idle',
    phase: null,
    rawDetail: null,
    updatedAt: null,
  };
  let browserWarmupTask: Promise<{ ready: boolean; detail: string | null }> | null = null;

  function getBrowserTaskSnapshot(): BrowserTaskSnapshot {
    return { ...browserTaskSnapshot };
  }

  function updateBrowserTaskSnapshot(patch: Partial<Omit<BrowserTaskSnapshot, 'updatedAt'>>) {
    browserTaskSnapshot = {
      ...browserTaskSnapshot,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  function resetBrowserTaskSnapshot() {
    browserTaskSnapshot = {
      status: 'idle',
      phase: null,
      rawDetail: null,
      updatedAt: new Date().toISOString(),
    };
  }

  function ensureBrowserTaskIdle() {
    if (browserTaskSnapshot.status !== 'idle') {
      throw new StructuredRequestError(409, BROWSER_TASK_BUSY_ERROR_CODE, 'Another browser task is already running.');
    }
  }

  async function waitForBrowserGatewayReady(
    timeoutMs: number,
    reportProgress?: BrowserTaskProgressReporter,
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastFailure = 'OpenClaw gateway is not ready for browser control yet.';

    while (Date.now() < deadline) {
      reportProgress?.('wait-gateway', lastFailure);
      const probe = await probeGatewayConnectionStatus(buildGatewayStatusProbeParams(), {
        preferLocalHealth: true,
        allowRpcProbe: false,
      });

      if (probe.connected) {
        reportProgress?.('wait-gateway');
        return;
      }

      lastFailure = probe.message || lastFailure;
      await sleep(BROWSER_HEALTH_GATEWAY_READY_POLL_INTERVAL_MS);
    }

    const error = new Error(lastFailure || 'Timed out waiting for OpenClaw gateway before browser control.');
    (error as Error & { browserGatewayNotReady?: boolean }).browserGatewayNotReady = true;
    throw error;
  }

  async function runBrowserRuntimeReadinessCheck(reportProgress?: BrowserTaskProgressReporter): Promise<BrowserRuntimeReadiness> {
    reportProgress?.('read-config');
    const checkedAt = Date.now();
    const browserConfig = readBrowserConfigState();
    const configError = readConfiguredBrowserValidationError(browserConfig);
    let diagnostics = buildFallbackBrowserHealthDiagnostics(checkedAt);

    if (configError && browserConfig.enabled === false) {
      return {
        ready: false,
        terminalFailure: true,
        diagnostics: buildFallbackBrowserHealthDiagnostics(checkedAt, configError),
        detail: null,
      };
    }

    if (configError) {
      return {
        ready: false,
        terminalFailure: true,
        diagnostics: buildFallbackBrowserHealthDiagnostics(checkedAt, configError),
        detail: configError,
      };
    }

    try {
      await waitForBrowserGatewayReady(BROWSER_HEALTH_GATEWAY_READY_TIMEOUT_MS, reportProgress);

      reportProgress?.('read-status');
      diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);
      if (diagnostics.running === true && !diagnostics.detectError) {
        return {
          ready: true,
          terminalFailure: false,
          diagnostics,
          detail: null,
        };
      }

      reportProgress?.('start-browser');
      await runOpenClawBrowserCommand(
        buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_HEALTH_START_TIMEOUT_MS), 'start']),
        BROWSER_HEALTH_START_TIMEOUT_MS
      );

      reportProgress?.('wait-running');
      diagnostics = await waitForBrowserRunning(browserConfig, checkedAt);
      if (diagnostics.running !== true) {
        return {
          ready: false,
          terminalFailure: false,
          diagnostics,
          detail: 'Browser runtime did not become healthy after start.',
        };
      }

      return {
        ready: true,
        terminalFailure: false,
        diagnostics,
        detail: null,
      };
    } catch (error: any) {
      const detail = readCliErrorDetail(error) || error?.message || 'Browser health check failed';
      diagnostics = isBrowserGatewayNotReadyError(error)
        ? buildFallbackBrowserHealthDiagnostics(checkedAt, detail)
        : await readBrowserHealthDiagnostics(browserConfig, checkedAt, detail);
      return {
        ready: false,
        terminalFailure: false,
        diagnostics,
        detail,
      };
    }
  }

  async function runDeferredBrowserWarmupOnce(): Promise<{ ready: boolean; detail: string | null }> {
    const reportProgress = (phase: string, rawDetail?: string | null) => {
      updateBrowserTaskSnapshot({
        status: 'checking',
        phase,
        rawDetail: normalizeCliText(rawDetail) || null,
      });
    };

    reportProgress('read-config');
    const readiness = await runBrowserRuntimeReadinessCheck(reportProgress);
    if (readiness.ready) {
      reportProgress('finalize');
      console.log('[BrowserWarmup] Browser runtime is ready after restart.');
      return {
        ready: true,
        detail: null,
      };
    }

    const detail = readiness.detail
      || readiness.diagnostics.rawDetail
      || readiness.diagnostics.detectError
      || 'Browser warmup did not complete.';
    reportProgress('finalize', detail);
    console.warn(`[BrowserWarmup] Browser warmup finished without readiness: ${detail}`);
    return {
      ready: false,
      detail,
    };
  }

  function scheduleDeferredBrowserWarmup(): Promise<{ ready: boolean; detail: string | null }> {
    if (browserWarmupTask) {
      return browserWarmupTask;
    }

    browserWarmupTask = (async () => {
      await sleep(BROWSER_POST_RESTART_WARMUP_DELAY_MS);

      if (browserTaskSnapshot.status !== 'idle') {
        console.log('[BrowserWarmup] Skipping deferred warmup because another browser task is running.');
        return {
          ready: false,
          detail: 'Another browser task is already running.',
        };
      }

      try {
        return await runDeferredBrowserWarmupOnce();
      } catch (error: any) {
        const detail = readCliErrorDetail(error) || error?.message || 'Deferred browser warmup failed';
        console.warn(`[BrowserWarmup] ${detail}`);
        return {
          ready: false,
          detail,
        };
      } finally {
        resetBrowserTaskSnapshot();
      }
    })().finally(() => {
      browserWarmupTask = null;
    });

    return browserWarmupTask;
  }

  async function runBrowserHealthCheck(reportProgress?: BrowserTaskProgressReporter): Promise<BrowserHealthSnapshot> {
    reportProgress?.('read-config');
    const checkedAt = Date.now();
    const browserConfig = readBrowserConfigState();
    const configError = readConfiguredBrowserValidationError(browserConfig);

    if (configError && browserConfig.enabled === false) {
      return finalizeBrowserHealthSnapshot({
        ...buildFallbackBrowserHealthDiagnostics(checkedAt, configError),
        validationSucceeded: null,
        validationDetail: null,
      });
    }

    if (configError) {
      return finalizeBrowserHealthSnapshot({
        ...buildFallbackBrowserHealthDiagnostics(checkedAt, configError),
        validationSucceeded: false,
        validationDetail: configError,
      });
    }

    let diagnostics = buildFallbackBrowserHealthDiagnostics(checkedAt);

    try {
      await waitForBrowserGatewayReady(BROWSER_HEALTH_GATEWAY_READY_TIMEOUT_MS, reportProgress);

      reportProgress?.('read-status');
      diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);

      reportProgress?.('start-browser');
      await runOpenClawBrowserCommand(
        buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_HEALTH_START_TIMEOUT_MS), 'start']),
        BROWSER_HEALTH_START_TIMEOUT_MS
      );

      reportProgress?.('wait-running');
      diagnostics = await waitForBrowserRunning(browserConfig, checkedAt);
      if (diagnostics.running !== true) {
        throw new Error('Browser runtime did not become healthy after start.');
      }

      reportProgress?.('open-validation');
      await openBrowserValidationUrl(browserConfig, BROWSER_HEALTH_VALIDATION_URL);

      try {
        reportProgress?.('capture-snapshot');
        await captureExampleDomainSnapshot(browserConfig);
      } catch (error: any) {
        const snapshotText = normalizeCliText(error?.snapshotText);
        if (!isCertificateInterstitialSnapshot(snapshotText)) {
          throw error;
        }

        reportProgress?.('open-validation');
        await openBrowserValidationUrl(browserConfig, BROWSER_HEALTH_FALLBACK_VALIDATION_URL);
        reportProgress?.('capture-snapshot');
        await captureExampleDomainSnapshot(browserConfig);
      }

      reportProgress?.('finalize');
      diagnostics = await readBrowserHealthDiagnostics(browserConfig, checkedAt);

      return finalizeBrowserHealthSnapshot({
        ...diagnostics,
        validationSucceeded: true,
        validationDetail: null,
      });
    } catch (error: any) {
      const detail = readCliErrorDetail(error) || error?.message || 'Browser health check failed';
      reportProgress?.('finalize', detail);
      diagnostics = isBrowserGatewayNotReadyError(error)
        ? buildFallbackBrowserHealthDiagnostics(checkedAt, detail)
        : await readBrowserHealthDiagnostics(browserConfig, checkedAt, detail);

      return finalizeBrowserHealthSnapshot({
        ...diagnostics,
        validationSucceeded: false,
        validationDetail: detail,
      });
    }
  }

  return {
    getBrowserTaskSnapshot,
    updateBrowserTaskSnapshot,
    resetBrowserTaskSnapshot,
    ensureBrowserTaskIdle,
    waitForBrowserGatewayReady,
    scheduleDeferredBrowserWarmup,
    runBrowserHealthCheck,
  };
}
export type BrowserService = ReturnType<typeof createBrowserService>;
