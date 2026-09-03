import express, { type Response as ExpressResponse } from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { writeJsonAtomicSync, writeFileAtomicSync } from './config-atomic-write';
import { readOpenClawConfigSafe, readJsonConfigSafe, readTextFileSafe, sanitizeErrorDetail } from './openclaw-config';
import { listRosterEntries, resolveRosterShape } from './agents-roster';
import os from 'os';
import { createServer } from 'http';
import multer from 'multer';
import { pathToFileURL } from 'url';
import { WebSocket } from 'ws';
import OpenClawClient, { extractOpenClawMessageText } from './openclaw-client';
import SessionManager from './session-manager';
import ConfigManager from './config-manager';
import DB from './db';
import AgentProvisioner, { ConfigReadError, type ImageGenerationEndpointModelSnapshot } from './agent-provisioner';
import {
  listPresets,
  loadPreset,
  resolveParamValues,
  buildRolePayload,
  planRole,
  writeWorkspaceExtras,
  presetsDirExists,
} from './preset-installer';
import { resolveServablePath } from './served-paths';
import {
  AUTH_COOKIE_NAME,
  AuthStore,
  hashPassword,
  isHashedPassword,
  readCookie,
  verifyPassword,
} from './auth-store';
import {
  MAX_PACK_BYTES,
  PackError,
  buildAgentEntry,
  buildPack,
  parsePack,
  readPackFile,
  sanitizeFileName,
  serializePack,
  writeAgentFiles,
  type ClawPack,
  type PackAgent,
  type PackTeam,
  type PackWarning,
} from './agent-pack';
import {
  GroupChatEngine,
  appendToolProgressLine,
  createAgentResponseFailedMessage,
  formatToolResultProgress,
  formatToolStartProgress,
  getStructuredGroupMessage,
  normalizeGroupToolProgressLocale,
  normalizeToolArgsRecord,
  type GroupToolProgressState,
} from './group-chat-engine';
import {
  deleteGroupWorkspace,
  ensureGroupWorkspace,
  getAgentMemoryDbPath,
  getAgentStatePath,
  getGroupRuntimeSessionKey,
  getGroupWorkspacePath,
  getGroupRuntimeAgentPrefix,
  getLegacyGroupRuntimeAgentId,
  getGroupRuntimeAgentId,
  removeGroupWorkspaceBootstrapFiles,
  getSharedGroupRuntimeAgentId,
  resetGroupWorkspace,
  validateGroupId,
} from './group-workspace';
import { exec, execFile, spawn } from 'child_process';
import dns from 'dns/promises';
import util from 'util';
import net from 'net';
import sharp from 'sharp';
import { buildImageUploadInspectionContext, rewriteMessageWithWorkspaceUploads } from './message-upload-rewrite';
import { rewriteVisibleFileLinks } from './file-link-rewrite';
import { canonicalizeAssistantWorkspaceArtifacts } from './workspace-artifact-rewrite';
import {
  buildAudioTranscriptContext,
  ensureManagedLocalAudioRuntimeReady,
  prepareAudioTranscriptsFromUploads,
} from './audio-transcription';
import {
  buildDocumentToolingContext,
  buildManagedDocumentToolingInstruction,
  ensureManagedDocumentToolingReady,
  hasDocumentUploads,
} from './document-tooling';
import type {
  AgentRuntimeMode,
  AgentSystemPromptMode,
  AgentToolMode,
  CapabilityCacheRow,
  ChatRow,
  MessagePageInfo,
  MessageSearchMatch,
  SessionRow,
  StoredFileRow,
} from './db';
import {
  type ChatHistorySnapshot,
  extractLatestAssistantOutcomeRecord,
  extractSettledAssistantOutcome,
  getHistoryTailActivity,
  getHistorySnapshot,
  getUnknownHistorySnapshot,
  isNonTerminalAssistantMessage,
  shouldPreferSettledAssistantText,
} from './chat-history-reconciliation';
import { selectPreferredTextSnapshot } from './text-snapshot-protection';
import { getCurrentAppVersionInfo, getLatestVersionInfo, type LatestVersionInfo as AppLatestVersionInfo } from './app-version';
import { shouldUseConfiguredImageGenerationModel } from './image-generation-routing';
import { readAgentBootstrapContextFromWorkspace } from './agent-bootstrap-context';

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

function execFileWithInput(
  file: string,
  args: string[],
  input: string,
  options?: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options?.env,
      cwd: options?.cwd,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const finalizeError = (error: any) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    const finalizeSuccess = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr });
    };

    if (options?.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeout);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finalizeError(error);
    });

    child.on('close', (code, signal) => {
      if (code === 0 && !timedOut) {
        finalizeSuccess();
        return;
      }

      const error: any = new Error(
        timedOut
          ? `${file} timed out`
          : `${file} exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`
      );
      error.code = code;
      error.signal = signal;
      error.timedOut = timedOut;
      error.stdout = stdout;
      error.stderr = stderr;
      finalizeError(error);
    });

    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

const app = express();
const server = createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

const dataDir = process.env.CLAWOPT_DATA_DIR || '.clawopt';
const uploadDir = path.join(process.env.HOME || '.', dataDir, 'uploads');
const browserWarmupMarkerPath = path.join(process.env.HOME || '.', dataDir, 'browser-warmup.pending');
const updateRestartStatePath = path.join(process.env.HOME || '.', dataDir, 'update-restart-state.json');
const gatewayRestartStatePath = path.join(process.env.HOME || '.', dataDir, 'gateway-restart-state.json');
fs.mkdirSync(uploadDir, { recursive: true });

// OpenClaw media directory (screenshots, inbound files, etc.)
const openclawMediaDir = path.join(process.env.HOME || '.', '.openclaw', 'media');

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const target = resolveUploadTargetFromBody((req.body || {}) as Record<string, unknown>);
      fs.mkdirSync(target.uploadsPath, { recursive: true });
      console.log(`[Upload] Context: ${target.contextType}, SessionKey: ${target.sessionKey}, Path: ${target.uploadsPath}`);
      cb(null, target.uploadsPath);
    } catch (err) {
      cb(err as Error, uploadDir);
    }
  },
  filename: (_req, file, cb) => {
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safe = decodedName.replace(/[^a-zA-Z0-9.\u4e00-\u9fa5_-]/g, '_');
    file.originalname = decodedName; // Save decoded name back for later use
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

// Initialize managers
const db = new DB();
const configManager = new ConfigManager();
const sessionManager = new SessionManager(db);
/** 会话令牌存储：随机、可过期、可吊销。 */
const authStore = new AuthStore(db);

// 迁移：把配置里的明文口令换成 scrypt 哈希。只做一次，之后配置里不再有明文。
(() => {
  try {
    const current = configManager.getConfig();
    const stored = typeof current.loginPassword === 'string' ? current.loginPassword : '';
    if (stored && !isHashedPassword(stored)) {
      configManager.setConfig({ loginPassword: hashPassword(stored) });
      console.log('[Auth] 已把明文登录口令迁移为 scrypt 哈希');
    }
  } catch (error) {
    console.warn('[Auth] 口令迁移失败，仍按原值校验：', error);
  }
})();
const agentProvisioner = new AgentProvisioner();
type StructuredMessageParams = Record<string, string | number | boolean | null>;
const CHAT_RUN_ERROR_CODE = 'chat.runError';
const CHAT_GATEWAY_DISCONNECTED_CODE = 'chat.gatewayDisconnected';
const CHAT_GATEWAY_DISCONNECTED_DETAIL = 'Connection to gateway lost. The process might have restarted.';
const CHAT_LATEST_ROUND_ONLY_CODE = 'chat.latestRoundOnly';
const CHAT_LATEST_ROUND_ONLY_DETAIL = 'Only the latest round can be edited or regenerated.';
const CHAT_RUN_ERROR_PREFIX = '❌ Error: ';
const GATEWAY_TEST_FAILED_ERROR_CODE = 'gateway.testFailed';
const GATEWAY_RESTART_FAILED_ERROR_CODE = 'gateway.restartFailed';
const GATEWAY_DETECT_FAILED_ERROR_CODE = 'gateway.detectFailed';
const BROWSER_HEALTH_FAILED_ERROR_CODE = 'gateway.browserHealthFailed';
const BROWSER_SELF_HEAL_FAILED_ERROR_CODE = 'gateway.browserSelfHealFailed';
const BROWSER_TASK_BUSY_ERROR_CODE = 'gateway.browserTaskBusy';
const BROWSER_HEADED_MODE_LOAD_FAILED_ERROR_CODE = 'gateway.browserHeadedModeLoadFailed';
const BROWSER_HEADED_MODE_UPDATE_FAILED_ERROR_CODE = 'gateway.browserHeadedModeUpdateFailed';
const GATEWAY_MAX_PERMISSIONS_UPDATE_FAILED_ERROR_CODE = 'gateway.maxPermissionsUpdateFailed';
const GATEWAY_HOST_TAKEOVER_CREDENTIALS_REQUIRED_ERROR_CODE = 'gateway.hostTakeoverCredentialsRequired';
const GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE = 'gateway.hostTakeoverInstallFailed';
const GATEWAY_HOST_TAKEOVER_SERVICE_NOT_FOUND_ERROR_CODE = 'gateway.hostTakeoverServiceNotFound';
const GATEWAY_DEVICE_PAIRING_APPROVE_FAILED_ERROR_CODE = 'gateway.devicePairingApproveFailed';
const GATEWAY_DEVICE_PAIRING_NO_PENDING_ERROR_CODE = 'gateway.devicePairingNoPending';
const FILE_PREVIEW_CONVERSION_TIMED_OUT_ERROR_CODE = 'filePreview.conversionTimedOut';
const AGENT_ID_REQUIRED_ERROR_CODE = 'agents.idRequired';
const PRESET_NOT_FOUND_ERROR_CODE = 'presets.notFound';
const PRESET_NO_ROLE_SELECTED_ERROR_CODE = 'presets.noRoleSelected';
const PRESET_INSTALL_FAILED_ERROR_CODE = 'presets.installFailed';
const PACK_SOURCE_REQUIRED_ERROR_CODE = 'packs.sourceRequired';
const PACK_AGENT_NOT_FOUND_ERROR_CODE = 'packs.agentNotFound';
const PACK_TEAM_NOT_FOUND_ERROR_CODE = 'packs.teamNotFound';
const PACK_FETCH_FAILED_ERROR_CODE = 'packs.fetchFailed';
const PACK_URL_BLOCKED_ERROR_CODE = 'packs.urlBlocked';
const PACK_GH_MISSING_ERROR_CODE = 'packs.ghMissing';
const PACK_GH_UNAUTHENTICATED_ERROR_CODE = 'packs.ghUnauthenticated';
const PACK_GIST_FAILED_ERROR_CODE = 'packs.gistFailed';
const AGENT_ID_CONTAINS_WHITESPACE_ERROR_CODE = 'agents.idContainsWhitespace';
const AGENT_ID_ALREADY_EXISTS_ERROR_CODE = 'agents.idAlreadyExists';
const AGENT_CONFIG_READ_FAILED_ERROR_CODE = 'agents.configReadFailed';
const GROUP_ID_REQUIRED_ERROR_CODE = 'groups.idRequired';
const GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE = 'groups.idContainsWhitespace';
const GROUP_ID_INVALID_ERROR_CODE = 'groups.idInvalid';
const GROUP_ID_ALREADY_EXISTS_ERROR_CODE = 'groups.idAlreadyExists';
const GROUP_NOT_FOUND_ERROR_CODE = 'groups.notFound';
const GROUP_RUN_IN_PROGRESS_ERROR_CODE = 'groups.runInProgress';
const MODEL_CREATE_FAILED_ERROR_CODE = 'models.createFailed';
const MODEL_UPDATE_FAILED_ERROR_CODE = 'models.updateFailed';
const MODEL_DELETE_FAILED_ERROR_CODE = 'models.deleteFailed';
const MODEL_TEST_FAILED_ERROR_CODE = 'models.testFailed';
const MODEL_DISCOVER_FAILED_ERROR_CODE = 'models.discoverFailed';
const ENDPOINT_CREATE_FAILED_ERROR_CODE = 'endpoints.createFailed';
const ENDPOINT_DELETE_FAILED_ERROR_CODE = 'endpoints.deleteFailed';
const ENDPOINT_TEST_FAILED_ERROR_CODE = 'endpoints.testFailed';
const AUTH_LOGIN_REQUIRED_ERROR_CODE = 'auth.loginRequired';
const VERSION_INFO_UNAVAILABLE_ERROR_CODE = 'version.infoUnavailable';
const VERSION_LOOKUP_FAILED_ERROR_CODE = 'version.lookupFailed';
const OPENCLAW_VERSION_LOOKUP_FAILED_ERROR_CODE = 'openclawVersion.lookupFailed';
const UPDATE_START_FAILED_ERROR_CODE = 'update.startFailed';
const UPDATE_ALREADY_RUNNING_ERROR_CODE = 'update.alreadyRunning';
const UPDATE_NO_NEW_VERSION_ERROR_CODE = 'update.noNewVersion';
const UPDATE_CANCEL_FAILED_ERROR_CODE = 'update.cancelFailed';
const UPDATE_NOT_RUNNING_ERROR_CODE = 'update.notRunning';
const UPDATE_CANNOT_CANCEL_PHASE_ERROR_CODE = 'update.cannotCancelCurrentPhase';
const UPDATE_RESET_FAILED_ERROR_CODE = 'update.resetFailed';
const UPDATE_RESTART_FAILED_ERROR_CODE = 'update.restartFailed';
const UPDATE_RESTART_NOT_READY_ERROR_CODE = 'update.restartNotReady';
const UPDATE_SERVICE_NOT_FOUND_ERROR_CODE = 'update.serviceNotFound';
const OPENCLAW_UPDATE_START_FAILED_ERROR_CODE = 'openclawUpdate.startFailed';
const OPENCLAW_UPDATE_ALREADY_RUNNING_ERROR_CODE = 'openclawUpdate.alreadyRunning';
const OPENCLAW_UPDATE_NO_NEW_VERSION_ERROR_CODE = 'openclawUpdate.noNewVersion';
const OPENCLAW_UPDATE_CANCEL_FAILED_ERROR_CODE = 'openclawUpdate.cancelFailed';
const OPENCLAW_UPDATE_NOT_RUNNING_ERROR_CODE = 'openclawUpdate.notRunning';
const OPENCLAW_UPDATE_RESET_FAILED_ERROR_CODE = 'openclawUpdate.resetFailed';
const OPENCLAW_UPDATE_STATUS_FAILED_ERROR_CODE = 'openclawUpdate.statusFailed';
const DEFAULT_HISTORY_PAGE_LIMIT = 200;
const MAX_HISTORY_PAGE_LIMIT = 200;
const CHAT_STREAM_COMPLETION_PROBE_DELAY_MS = 400;
const CHAT_STREAM_COMPLETION_WAIT_TIMEOUT_MS = 1500;
const CHAT_HISTORY_COMPLETION_PROBE_LIMIT = 60;
const CHAT_REGENERATE_LOOKBACK_LIMIT = 60;
const CHAT_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS = 30000;
const CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS = 500;
const CHAT_FINAL_EVENT_SETTLE_GRACE_MS = 1500;
const CHAT_EMPTY_COMPLETION_RETRY_WINDOW_MS = 5 * 60 * 1000;
const CHAT_HISTORY_ACTIVITY_GRACE_MS = 2 * 60 * 1000;
const CHAT_ORPHAN_ABORT_TIMEOUT_MS = 5000;
const CHAT_ABORT_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];
const CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS = 1000;
const CHAT_GATEWAY_RECONNECT_PROBE_RETRY_DELAY_MS = 3000;
const GROUP_SSE_KEEPALIVE_MS = 15000;
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
const BROWSER_SELF_HEAL_GATEWAY_READY_TIMEOUT_MS = 2 * 60 * 1000;
const BROWSER_SELF_HEAL_PLUGIN_REGISTRY_REFRESH_TIMEOUT_MS = 45 * 1000;
const BROWSER_SELF_HEAL_STOP_TIMEOUT_MS = 8000;
const BROWSER_SELF_HEAL_RESET_PROFILE_TIMEOUT_MS = 45000;
const BROWSER_POST_RESTART_WARMUP_DELAY_MS = 8000;
const BROWSER_POST_RESTART_WARMUP_MARKER_MAX_AGE_MS = 30 * 60 * 1000;
const BROWSER_HEADED_MODE_RESTART_TIMEOUT_MS = 3 * 60 * 1000;
const BROWSER_HEADED_MODE_RESTART_POLL_INTERVAL_MS = 1500;
const UPDATE_SCRIPT_URL = 'https://raw.githubusercontent.com/whotto/ClawOPT/main/update.sh';
const UPDATE_PHASE_MARKER_PREFIX = '::clawopt-update-phase::';
const UPDATE_LOG_LIMIT = 200;
const UPDATE_CANCEL_KILL_TIMEOUT_MS = 5000;
const UPDATE_RESTART_DELAY_MS = 250;
const UPDATE_CANCELLABLE_PHASES = new Set(['downloading-script', 'detect-service', 'git-pull']);
const CLAWOPT_SERVICE_FILE_REGEX = /^clawopt(?:-\d+)?\.service$/;
const UPDATE_RESTART_RESUME_POLL_INTERVAL_MS = 1500;
const UPDATE_RESTART_RESUME_TIMEOUT_MS = 3 * 60 * 1000;

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

type HostTakeoverMode =
  | 'disabled'
  | 'ready'
  | 'needs_install'
  | 'broken';

type HostTakeoverAutoInstallMode =
  | 'root'
  | 'sudo'
  | 'pkexec'
  | 'manual';

type HostTakeoverStatus = {
  enabled: boolean;
  mode: HostTakeoverMode;
  ready: boolean;
  helperInstalled: boolean;
  helperReachable: boolean;
  servicePathPatched: boolean;
  execPreflightBypassReady: boolean;
  execPreflightTargetCount: number;
  execPreflightPatchedCount: number;
  currentUser: string;
  wrapperDir: string;
  hostRootPath: string;
  helperPath: string;
  autoInstallSupported: boolean;
  autoInstallMode: HostTakeoverAutoInstallMode;
  manualInstallCommand: string | null;
  rawDetail: string | null;
};

type DevicePairingPendingRequestSummary = {
  requestId: string;
  deviceId: string | null;
  displayName: string | null;
  clientId: string | null;
  clientMode: string | null;
  role: string | null;
  roles: string[];
  scopes: string[];
  remoteIp: string | null;
  isRepair: boolean;
  ts: number | null;
};

type DevicePairingStatusSnapshot = {
  pending: DevicePairingPendingRequestSummary[];
  latestPending: DevicePairingPendingRequestSummary | null;
  pairedCount: number | null;
  rawDetail: string | null;
};

type OpenClawLocalDevicePairingList = {
  pending?: unknown[];
  paired?: unknown[];
};

type OpenClawLocalDevicePairingApproveResult =
  | {
      status: 'approved';
      device?: {
        deviceId?: string;
        displayName?: string;
      } | null;
    }
  | {
      status: 'forbidden';
      missingScope?: string;
    }
  | null;

type OpenClawLocalDevicePairingApi = {
  listDevicePairing: () => Promise<OpenClawLocalDevicePairingList>;
  approveDevicePairing: (
    requestId: string,
    options?: { callerScopes?: readonly string[] },
  ) => Promise<OpenClawLocalDevicePairingApproveResult>;
};

type ActiveOpenClawUpdateProcess = {
  child: ReturnType<typeof spawn>;
  cancelRequested: boolean;
  cancelTimer: NodeJS.Timeout | null;
  phaseTimer: NodeJS.Timeout | null;
};

const appRepoRoot = path.resolve(__dirname, '..', '..');
const UPDATE_RESTART_STEP_IDS: UpdateRestartStepId[] = [
  'restart_openclaw',
  'restart_project',
  'warmup_browser',
];
const OPENCLAW_LATEST_VERSION_CACHE_TTL_MS = 60 * 1000;
const OPENCLAW_GATEWAY_HEALTH_PROBE_TIMEOUTS_MS = [700, 1000] as const;
const OPENCLAW_GATEWAY_READY_PROBE_TIMEOUT_MS = 20000;
const OPENCLAW_GATEWAY_READY_PROBE_STEP_TIMEOUT_MS = 5000;
const OPENCLAW_GATEWAY_READY_RESULT_CACHE_TTL_MS = 3000;
const OPENCLAW_GATEWAY_RESTART_STABLE_WINDOW_MS = 20 * 1000;
const OPENCLAW_GATEWAY_MANUAL_RESTART_STABLE_WINDOW_MS = 5 * 1000;
const OPENCLAW_UPDATE_RUNTIME_RECONCILE_INTERVAL_MS = 1200;
const OPENCLAW_UPDATE_GATEWAY_RECOVERY_POLL_INTERVAL_MS = 5 * 1000;
const OPENCLAW_UPDATE_SUCCESS_AUTO_RESET_MS = 5000;
const OPENCLAW_GATEWAY_SERVICE_NAME = 'openclaw-gateway.service';
const HOST_TAKEOVER_SYSTEM_HELPER_PATH = '/usr/local/lib/openclaw-host-takeover/run';
const HOST_TAKEOVER_WRAPPER_DIR = path.join(os.homedir(), '.openclaw', 'host-takeover', 'bin');
const HOST_TAKEOVER_HOST_ROOT_PATH = path.join(HOST_TAKEOVER_WRAPPER_DIR, 'host-root');
const HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH = path.join(
  os.homedir(),
  '.config',
  'systemd',
  'user',
  `${OPENCLAW_GATEWAY_SERVICE_NAME}.d`,
  '90-host-takeover.conf'
);
const HOST_TAKEOVER_INSTALLER_SCRIPT_PATH = path.join(appRepoRoot, 'backend', 'scripts', 'install-host-takeover.sh');
const OPENCLAW_UPDATE_CANCELLABLE_PHASES = new Set([
  'download-package',
  'install-package',
  'running-update',
]);

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

let updateSnapshot = readPersistedUpdateRestartSnapshot() || createDefaultUpdateSnapshot();
let gatewayRestartSnapshot = readPersistedGatewayRestartSnapshot() || createDefaultGatewayRestartSnapshot();
let activeUpdateProcess: ActiveUpdateProcess | null = null;
let cachedLatestVersionInfo: AppLatestVersionInfo | null = null;
let openClawUpdateSnapshot = createDefaultOpenClawUpdateSnapshot();
let activeOpenClawUpdateProcess: ActiveOpenClawUpdateProcess | null = null;
let cachedOpenClawLatestVersionInfo: OpenClawLatestVersionInfo | null = null;
let cachedOpenClawLatestVersionCheckedAt = 0;
let openClawUpdateRuntimeReconcileInFlight: Promise<void> | null = null;
let openClawUpdateSuccessFinalizeTask: Promise<void> | null = null;
let lastOpenClawUpdateRuntimeReconcileAt = 0;
let openClawUpdateSuccessResetTimer: NodeJS.Timeout | null = null;
let updateRestartResumeTask: Promise<void> | null = null;
let activeGatewayRestartTask: Promise<void> | null = null;
let cachedGatewayProbeKey: string | null = null;
let cachedGatewayProbeResult:
  | { checkedAt: number; result: GatewayConnectionProbeResult }
  | null = null;
const gatewayProbeInflight = new Map<string, Promise<GatewayConnectionProbeResult>>();
let gatewayRestartReconcileStableSinceMs: number | null = null;

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

function buildStructuredApiError(
  errorCode: string,
  errorDetail?: string | null,
  errorParams?: StructuredMessageParams | null
) {
  return {
    success: false as const,
    errorCode,
    errorParams: errorParams || null,
    errorDetail: typeof errorDetail === 'string' && errorDetail.trim() ? errorDetail.trim() : null,
  };
}

class StructuredRequestError extends Error {
  status: number;
  payload: ReturnType<typeof buildStructuredApiError>;

  constructor(
    status: number,
    errorCode: string,
    errorDetail?: string | null,
    errorParams?: StructuredMessageParams | null
  ) {
    super(errorDetail || errorCode);
    this.status = status;
    this.payload = buildStructuredApiError(errorCode, errorDetail, errorParams);
  }
}

function isStructuredRequestError(error: unknown): error is StructuredRequestError {
  return error instanceof StructuredRequestError;
}

function normalizeCliText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeGatewayHostname(hostname: string): string {
  const normalized = normalizeCliText(hostname).toLowerCase();
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeGatewayHostname(hostname);
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1';
}

function isLocalGatewayHostname(hostname: string): boolean {
  const normalized = normalizeGatewayHostname(hostname);
  if (!normalized) return false;
  if (isLoopbackHostname(normalized)) return true;

  const localNames = new Set<string>([
    normalizeGatewayHostname(os.hostname()),
    '0.0.0.0',
    '::',
  ]);

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      localNames.add(normalizeGatewayHostname(entry.address));
    }
  }

  return localNames.has(normalized);
}

function parseGatewayUrlForStatusProbe(gatewayUrl: string): { hostname: string; port: number | null } | null {
  const normalized = normalizeCliText(gatewayUrl);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized.replace(/^ws/i, 'http'));
    const port = parsed.port
      ? Number(parsed.port)
      : (parsed.protocol === 'https:' ? 443 : 80);

    return {
      hostname: parsed.hostname,
      port: Number.isFinite(port) ? port : null,
    };
  } catch {
    return null;
  }
}

function buildGatewayHttpBaseUrl(gatewayUrl: string): string | null {
  const normalized = normalizeCliText(gatewayUrl);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized.replace(/^ws/i, 'http'));
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function readLocalGatewayRuntimeConfig(): {
  port: number | null;
  token: string;
  password: string;
} | null {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = readOpenClawConfigSafe();
    const gateway = raw?.gateway;
    if (!gateway || typeof gateway !== 'object') return null;

    const parsedPort = Number(gateway.port);
    return {
      port: Number.isFinite(parsedPort) ? parsedPort : null,
      token: normalizeCliText(gateway.auth?.token),
      password: normalizeCliText(gateway.auth?.password),
    };
  } catch {
    return null;
  }
}

async function probeGatewayHealth(gatewayUrl: string): Promise<{ ok: boolean; message?: string }> {
  const baseUrl = buildGatewayHttpBaseUrl(gatewayUrl);
  if (!baseUrl) {
    return { ok: false, message: 'Invalid gateway URL' };
  }

  let lastFailure = 'Gateway health probe failed';
  for (let index = 0; index < OPENCLAW_GATEWAY_HEALTH_PROBE_TIMEOUTS_MS.length; index += 1) {
    try {
      const response = await axios.get(`${baseUrl}/health`, {
        timeout: OPENCLAW_GATEWAY_HEALTH_PROBE_TIMEOUTS_MS[index],
        validateStatus: () => true,
      });
      const statusText = normalizeCliText((response.data as any)?.status).toLowerCase();
      const ok = response.status >= 200
        && response.status < 300
        && (((response.data as any)?.ok === true) || statusText === 'live' || statusText === 'ok');

      if (ok) {
        return { ok: true };
      }

      lastFailure = `Gateway health probe returned HTTP ${response.status}`;
    } catch (error: any) {
      lastFailure = readCliErrorDetail(error) || 'Gateway health probe failed';
    }

    if (index < OPENCLAW_GATEWAY_HEALTH_PROBE_TIMEOUTS_MS.length - 1) {
      await sleep(250);
    }
  }

  return {
    ok: false,
    message: lastFailure,
  };
}

function evaluateLocalGatewayCredentialMatch(
  params: { gatewayUrl: string; token?: string; password?: string },
  gatewayTarget: { hostname: string; port: number | null } | null,
): boolean | null {
  const localConfig = readLocalGatewayRuntimeConfig();
  if (!localConfig) return null;

  if (
    gatewayTarget?.port != null
    && localConfig.port != null
    && gatewayTarget.port !== localConfig.port
  ) {
    return null;
  }

  if (!localConfig.token && !localConfig.password) {
    return true;
  }

  const tokenMatches = !localConfig.token || normalizeCliText(params.token) === localConfig.token;
  const passwordMatches = !localConfig.password || normalizeCliText(params.password) === localConfig.password;
  return tokenMatches && passwordMatches;
}

function readCliErrorDetail(error: any): string {
  return [
    normalizeCliText(error?.stderr),
    normalizeCliText(error?.stdout),
    normalizeCliText(error?.message),
  ].find(Boolean) || '';
}

function normalizeFallbackMode(value: unknown): 'inherit' | 'custom' | 'disabled' | undefined {
  return value === 'inherit' || value === 'custom' || value === 'disabled' ? value : undefined;
}

function normalizeAgentRuntimeMode(value: unknown): AgentRuntimeMode {
  return value === 'direct' ? 'direct' : 'configured';
}

function normalizeAgentSystemPromptMode(value: unknown): AgentSystemPromptMode {
  return value === 'agent' ? 'agent' : 'system';
}

function normalizeAgentToolMode(value: unknown): AgentToolMode {
  if (value === 'coding' || value === 'messaging' || value === 'minimal' || value === 'off') {
    return value;
  }
  return 'full';
}

function normalizeFallbackList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

type OpenClawImageProviderEntry = {
  id: string;
  label: string;
  available: boolean;
  configured: boolean;
  selected: boolean;
  defaultModel: string | null;
  models: string[];
  capabilities: Record<string, any>;
};

type OpenClawImageProviderSnapshot = {
  providers: OpenClawImageProviderEntry[];
  models: Array<{
    id: string;
    alias: string;
    providerId: string;
    providerLabel: string;
    model: string;
    available: boolean;
    configured: boolean;
    selected: boolean;
    input: string[];
  }>;
  updatedAt: string;
  cache?: {
    source: 'database' | 'openclaw';
    status: 'success' | 'error';
    updatedAt: string | null;
    openclawVersion: string | null;
    errorDetail: string | null;
  };
};

const IMAGE_PROVIDER_CACHE_KEY = 'image_generation_providers';
const IMAGE_PROVIDER_LIST_TIMEOUT_MS = 45000;
const IMAGE_GENERATION_TIMEOUT_MS = 600000;
const SUPPORTED_IMAGE_ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
let imageProviderListRefreshInFlight: Promise<OpenClawImageProviderSnapshot> | null = null;

type DirectImageGenerationResult = {
  content: string;
  processContent: string;
  modelUsed: string;
  imagePath: string;
};

function parseCliJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('OpenClaw image provider list returned no JSON output.');
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const firstArray = trimmed.indexOf('[');
  const lastArray = trimmed.lastIndexOf(']');
  if (firstArray !== -1 && lastArray > firstArray) {
    return JSON.parse(trimmed.slice(firstArray, lastArray + 1));
  }

  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject !== -1 && lastObject > firstObject) {
    return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
  }

  throw new Error('OpenClaw image provider list did not contain parseable JSON.');
}

async function runOpenClawImageProviderListCli(timeoutMs = IMAGE_PROVIDER_LIST_TIMEOUT_MS): Promise<unknown> {
  const executablePath = await ensureResolvedOpenClawExecutablePath();
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ['infer', 'image', 'providers', '--json'], {
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timedOut = false;

    const signalChildGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };

    const terminateChildGroup = () => {
      signalChildGroup('SIGTERM');
      killTimer = setTimeout(() => signalChildGroup('SIGKILL'), 1000);
      killTimer.unref();
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    const finishSuccess = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateChildGroup();
      resolve(value);
    };

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateChildGroup();
      reject(error);
    };

    const tryFinishFromStdout = () => {
      try {
        finishSuccess(parseCliJsonOutput(stdout));
      } catch {}
    };

    const timer = setTimeout(() => {
      try {
        finishSuccess(parseCliJsonOutput(stdout));
        return;
      } catch {}

      timedOut = true;
      signalChildGroup('SIGTERM');
      killTimer = setTimeout(() => signalChildGroup('SIGKILL'), 35000);
      killTimer.unref();
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) {
        finishError(new Error('OpenClaw image provider list output is too large.'));
        return;
      }
      tryFinishFromStdout();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024) {
        stderr = stderr.slice(-1024 * 1024);
      }
    });

    child.on('error', (error) => {
      finishError(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      try {
        finishSuccess(parseCliJsonOutput(stdout));
        return;
      } catch {}

      const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}`;
      finishError(new Error(timedOut
        ? `OpenClaw image provider list timed out. ${detail}`
        : `OpenClaw image provider list failed: ${detail}`));
    });
  });
}

function normalizeImageProviderSnapshot(raw: unknown): OpenClawImageProviderSnapshot {
  const entries: any[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.providers)
      ? (raw as any).providers
      : [];

  const providers: OpenClawImageProviderEntry[] = entries
    .map((entry: any) => {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id) return null;
      const label = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : id;
      const models: string[] = Array.isArray(entry?.models)
        ? Array.from(new Set(entry.models.filter((model: unknown): model is string => typeof model === 'string' && model.trim().length > 0).map((model: string) => model.trim())))
        : [];
      return {
        id,
        label,
        available: entry?.available !== false,
        configured: entry?.configured === true,
        selected: entry?.selected === true,
        defaultModel: typeof entry?.defaultModel === 'string' && entry.defaultModel.trim() ? entry.defaultModel.trim() : null,
        models,
        capabilities: entry?.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {},
      };
    })
    .filter((entry): entry is OpenClawImageProviderEntry => Boolean(entry));

  const models = providers.flatMap((provider) => provider.models.map((model) => ({
    id: `${provider.id}/${model}`,
    alias: `${provider.label} / ${model}`,
    providerId: provider.id,
    providerLabel: provider.label,
    model,
    available: provider.available,
    configured: provider.configured,
    selected: provider.selected,
    input: ['image_generation'],
  })));

  return {
    providers,
    models,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeImageProviderCacheMeta(row: CapabilityCacheRow): OpenClawImageProviderSnapshot['cache'] {
  return {
    source: 'database',
    status: row.status === 'error' ? 'error' : 'success',
    updatedAt: normalizeCliText(row.updated_at) || null,
    openclawVersion: normalizeCliText(row.openclaw_version) || null,
    errorDetail: normalizeCliText(row.error_detail) || null,
  };
}

function parseCachedOpenClawImageProviderSnapshot(row: CapabilityCacheRow | undefined): OpenClawImageProviderSnapshot | null {
  if (!row) return null;

  try {
    const parsed = JSON.parse(row.value) as Partial<OpenClawImageProviderSnapshot>;
    if (!Array.isArray(parsed.providers) || !Array.isArray(parsed.models)) {
      return null;
    }

    return {
      providers: parsed.providers as OpenClawImageProviderEntry[],
      models: parsed.models as OpenClawImageProviderSnapshot['models'],
      updatedAt: normalizeCliText(parsed.updatedAt) || normalizeCliText(row.updated_at) || new Date().toISOString(),
      cache: normalizeImageProviderCacheMeta(row),
    };
  } catch {
    return null;
  }
}

function readCachedOpenClawImageProviderSnapshot(): OpenClawImageProviderSnapshot | null {
  return parseCachedOpenClawImageProviderSnapshot(db.getCapabilityCache(IMAGE_PROVIDER_CACHE_KEY));
}

async function readOpenClawVersionForImageProviderCache(): Promise<string | null> {
  try {
    const executablePath = await ensureResolvedOpenClawExecutablePath();
    const { stdout } = await execFilePromise(executablePath, ['--version'], {
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    const raw = normalizeCliText(stdout);
    const matched = raw.match(/OpenClaw\s+([^\s(]+)/i);
    return matched?.[1] || raw || null;
  } catch {
    return null;
  }
}

async function refreshOpenClawImageProviderSnapshot(): Promise<OpenClawImageProviderSnapshot> {
  if (imageProviderListRefreshInFlight) {
    return imageProviderListRefreshInFlight;
  }

  imageProviderListRefreshInFlight = (async () => {
    const openclawVersion = await readOpenClawVersionForImageProviderCache();
    try {
      const raw = await runOpenClawImageProviderListCli();
      const snapshot = normalizeImageProviderSnapshot(raw);
      db.upsertCapabilityCache({
        key: IMAGE_PROVIDER_CACHE_KEY,
        value: JSON.stringify(snapshot),
        openclawVersion,
        status: 'success',
        errorDetail: null,
      });
      return {
        ...snapshot,
        cache: {
          source: 'openclaw' as const,
          status: 'success' as const,
          updatedAt: snapshot.updatedAt,
          openclawVersion,
          errorDetail: null,
        },
      };
    } catch (error) {
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      db.markCapabilityCacheError(IMAGE_PROVIDER_CACHE_KEY, detail, openclawVersion);
      throw error;
    }
  })().finally(() => {
    imageProviderListRefreshInFlight = null;
  });

  return imageProviderListRefreshInFlight;
}

async function readOpenClawImageProviderSnapshot(options?: {
  refresh?: boolean;
  allowStaleOnError?: boolean;
}): Promise<OpenClawImageProviderSnapshot> {
  if (!options?.refresh) {
    const cached = readCachedOpenClawImageProviderSnapshot();
    if (cached) {
      return cached;
    }
  }

  try {
    return await refreshOpenClawImageProviderSnapshot();
  } catch (error) {
    if (options?.allowStaleOnError !== false) {
      const cached = readCachedOpenClawImageProviderSnapshot();
      if (cached) {
        return cached;
      }
    }
    throw error;
  }
}

function getConfiguredDirectImageGenerationModel(): string | null {
  const candidates = getConfiguredDirectImageGenerationCandidates();
  return candidates[0] || null;
}

function getConfiguredDirectImageGenerationCandidates(): string[] {
  const config = agentProvisioner.readImageGenerationModelConfig();
  const primary = normalizeCliText(config.primary);
  if (!primary) return [];

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const modelId of [primary, ...config.fallbacks]) {
    const normalized = normalizeCliText(modelId);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(normalized);
  }
  return candidates;
}

function buildInlineLocalFileUrl(absolutePath: string): string {
  const encodedPath = Buffer.from(absolutePath).toString('base64');
  return `/api/files/download?path=${encodeURIComponent(encodedPath)}&disposition=inline`;
}

function buildImageGenerationOutputPath(outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 10);
  return path.join(outputDir, `image-${safeTimestamp}-${suffix}.png`);
}

function buildImageGenerationStartProcessContent(modelId: string): string {
  const locale = normalizeGroupToolProgressLocale(configManager.getConfig().language);
  if (locale === 'en') {
    return `Calling image generation model: ${modelId}`;
  }
  if (locale === 'zh-TW') {
    return `正在呼叫圖像生成模型：${modelId}`;
  }
  return `正在调用图像生成模型：${modelId}`;
}

function resolveImageGenerationAspectRatioHint(prompt: string): string | null {
  const normalized = prompt.replace(/[：]/g, ':');
  const ratioMatch = normalized.match(/(?:^|[^\d])(\d{1,2}\s*:\s*\d{1,2})(?=$|[^\d])/);
  if (!ratioMatch) return null;

  const ratio = ratioMatch[1].replace(/\s+/g, '');
  return SUPPORTED_IMAGE_ASPECT_RATIOS.has(ratio) ? ratio : null;
}

function resolveImageGenerationSize(prompt: string): string {
  const aspectRatio = resolveImageGenerationAspectRatioHint(prompt);
  if (aspectRatio === '1:1') return '1024x1024';
  if (aspectRatio === '3:2' || aspectRatio === '4:3' || aspectRatio === '5:4' || aspectRatio === '16:9' || aspectRatio === '21:9') {
    return '1536x1024';
  }
  if (aspectRatio === '2:3' || aspectRatio === '3:4' || aspectRatio === '4:5' || aspectRatio === '9:16') {
    return '1024x1536';
  }
  return '1024x1024';
}

function buildImageGenerationProcessContent(modelId: string, imagePath: string): string {
  const locale = normalizeGroupToolProgressLocale(configManager.getConfig().language);
  if (locale === 'en') {
    return `Calling image generation model: ${modelId}\nImage generated: ${imagePath}`;
  }
  if (locale === 'zh-TW') {
    return `正在呼叫圖像生成模型：${modelId}\n圖像已生成：${imagePath}`;
  }
  return `正在调用图像生成模型：${modelId}\n图像已生成：${imagePath}`;
}

function buildImageGenerationRequestUrl(endpoint: ImageGenerationEndpointModelSnapshot): string {
  return `${endpoint.baseUrl.replace(/\/+$/, '')}/images/generations`;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function buildImageGenerationRequestHeaders(endpoint: ImageGenerationEndpointModelSnapshot): Record<string, string> {
  const headers: Record<string, string> = {
    ...(endpoint.headers || {}),
    'Content-Type': 'application/json',
  };

  const authHeader = endpoint.authHeader || 'Authorization';
  if (!hasHeader(headers, authHeader)) {
    headers[authHeader] = authHeader.toLowerCase() === 'authorization'
      ? `Bearer ${endpoint.apiKey}`
      : endpoint.apiKey;
  }

  return headers;
}

function sanitizeImageGenerationErrorDetail(detail: string, endpoint?: ImageGenerationEndpointModelSnapshot): string {
  const normalized = normalizeCliText(detail);
  if (!normalized) return 'Image generation request failed.';

  let sanitized = normalized;
  const secret = endpoint?.apiKey;
  if (secret && secret.length >= 6) {
    sanitized = sanitized.split(secret).join('[redacted]');
  }

  return sanitized.length > 2000 ? `${sanitized.slice(0, 2000)}...` : sanitized;
}

function getHttpErrorResponse(error: any): { status?: number; statusText?: string; data?: unknown } | null {
  if (axios.isAxiosError(error)) {
    return error.response || null;
  }
  if (error?.response && typeof error.response === 'object') {
    return error.response;
  }
  return null;
}

function extractImageGenerationErrorDetail(error: any, endpoint?: ImageGenerationEndpointModelSnapshot): string {
  const response = getHttpErrorResponse(error);
  if (response) {
    const status = response.status;
    const statusText = normalizeCliText(response.statusText);
    const data = response.data;
    const bodyText = (() => {
      if (!data) return '';
      if (typeof data === 'string') return data;
      if (data instanceof Buffer) return data.toString('utf8');
      const message = normalizeCliText((data as any)?.error?.message)
        || normalizeCliText((data as any)?.message)
        || normalizeCliText((data as any)?.detail)
        || normalizeCliText((data as any)?.error);
      return message || JSON.stringify(data);
    })();

    if (status) {
      return sanitizeImageGenerationErrorDetail(
        `HTTP ${status}${statusText ? ` ${statusText}` : ''}${bodyText ? ` - ${bodyText}` : ''}`,
        endpoint,
      );
    }
  }

  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') {
      return `Image generation request timed out after ${IMAGE_GENERATION_TIMEOUT_MS}ms.`;
    }

    return sanitizeImageGenerationErrorDetail(error.message, endpoint);
  }

  return sanitizeImageGenerationErrorDetail(error instanceof Error ? error.message : String(error), endpoint);
}

function isRetryableImageGenerationRequestError(error: any): boolean {
  const status = getHttpErrorResponse(error)?.status;
  return status === 400 || status === 422;
}

function parseBase64ImageData(value: string): Buffer | null {
  const normalized = normalizeCliText(value);
  if (!normalized) return null;

  const dataUriMatch = normalized.match(/^data:[^;]+;base64,(.+)$/i);
  const rawBase64 = dataUriMatch ? dataUriMatch[1] : normalized;
  try {
    const buffer = Buffer.from(rawBase64, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

function findGeneratedImageBase64(payload: any): string | null {
  const dataEntries = Array.isArray(payload?.data) ? payload.data : [];
  const imageEntries = Array.isArray(payload?.images) ? payload.images : [];
  const entries = [...dataEntries, ...imageEntries];

  for (const entry of entries) {
    const value = normalizeCliText(entry?.b64_json)
      || normalizeCliText(entry?.base64)
      || normalizeCliText(entry?.image_base64)
      || normalizeCliText(entry?.image?.b64_json)
      || normalizeCliText(entry?.image?.base64);
    if (value) return value;
  }

  return normalizeCliText(payload?.b64_json)
    || normalizeCliText(payload?.base64)
    || normalizeCliText(payload?.image_base64)
    || null;
}

function findGeneratedImageUrl(payload: any): string | null {
  const dataEntries = Array.isArray(payload?.data) ? payload.data : [];
  const imageEntries = Array.isArray(payload?.images) ? payload.images : [];
  const entries = [...dataEntries, ...imageEntries];

  for (const entry of entries) {
    const value = normalizeCliText(entry?.url)
      || normalizeCliText(entry?.image_url?.url)
      || normalizeCliText(entry?.image?.url);
    if (value) return value;
  }

  return normalizeCliText(payload?.url)
    || normalizeCliText(payload?.image_url?.url)
    || null;
}

async function writeGeneratedImageUrlToFile(
  endpoint: ImageGenerationEndpointModelSnapshot,
  imageUrl: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (/^data:[^;]+;base64,/i.test(imageUrl)) {
    const buffer = parseBase64ImageData(imageUrl);
    if (!buffer) throw new Error('Image generation returned an unreadable data URL.');
    fs.writeFileSync(outputPath, buffer);
    return;
  }

  const resolvedUrl = new URL(imageUrl, endpoint.baseUrl).toString();
  const response = await axios.get<ArrayBuffer>(resolvedUrl, {
    responseType: 'arraybuffer',
    timeout: IMAGE_GENERATION_TIMEOUT_MS,
    signal,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Image download failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  }

  fs.writeFileSync(outputPath, Buffer.from(response.data));
}

async function writeOpenAICompatibleImageResponseToFile(
  endpoint: ImageGenerationEndpointModelSnapshot,
  payload: unknown,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const base64Image = findGeneratedImageBase64(payload as any);
  if (base64Image) {
    const buffer = parseBase64ImageData(base64Image);
    if (!buffer) throw new Error('Image generation returned unreadable base64 data.');
    fs.writeFileSync(outputPath, buffer);
    return;
  }

  const imageUrl = findGeneratedImageUrl(payload as any);
  if (imageUrl) {
    await writeGeneratedImageUrlToFile(endpoint, imageUrl, outputPath, signal);
    return;
  }

  throw new Error('Image generation completed without image data.');
}

function buildImageGenerationRequestBodies(endpoint: ImageGenerationEndpointModelSnapshot, prompt: string): Array<Record<string, unknown>> {
  const baseBody = {
    model: endpoint.modelName,
    prompt,
    n: 1,
  };
  const size = resolveImageGenerationSize(prompt);

  return [
    { ...baseBody, size, response_format: 'b64_json' },
    { ...baseBody, size },
    { ...baseBody, response_format: 'b64_json' },
    baseBody,
  ];
}

async function generateImageThroughEndpoint(
  endpoint: ImageGenerationEndpointModelSnapshot,
  prompt: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = buildImageGenerationRequestUrl(endpoint);
  const headers = buildImageGenerationRequestHeaders(endpoint);
  let lastError: unknown = null;

  for (const body of buildImageGenerationRequestBodies(endpoint, prompt)) {
    try {
      const response = await axios.post(url, body, {
        headers,
        timeout: IMAGE_GENERATION_TIMEOUT_MS,
        signal,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 300) {
        const error: any = new Error(`HTTP ${response.status}`);
        error.response = response;
        throw error;
      }

      await writeOpenAICompatibleImageResponseToFile(endpoint, response.data, outputPath, signal);
      if (!fs.existsSync(outputPath)) {
        throw new Error('Image generation completed without a readable output file.');
      }
      return outputPath;
    } catch (error) {
      lastError = error;
      if (!isRetryableImageGenerationRequestError(error)) {
        break;
      }
    }
  }

  throw new Error(extractImageGenerationErrorDetail(lastError, endpoint));
}

async function tryGenerateImageForPrompt(params: {
  prompt: string;
  intentText?: string;
  intentContext?: Array<string | null | undefined> | string | null;
  outputDir: string;
  signal?: AbortSignal;
}): Promise<DirectImageGenerationResult | null> {
  const candidates = getConfiguredDirectImageGenerationCandidates();
  if (candidates.length === 0) {
    return null;
  }

  const intentText = normalizeCliText(params.intentText) || params.prompt;
  if (!shouldUseConfiguredImageGenerationModel(intentText, params.intentContext)) {
    return null;
  }

  const prompt = normalizeCliText(params.prompt);
  if (!prompt) {
    return null;
  }

  const outputPath = buildImageGenerationOutputPath(params.outputDir);
  const attempts: string[] = [];

  for (const modelId of candidates) {
    const endpoint = agentProvisioner.readImageGenerationEndpointModel(modelId);
    if (!endpoint) {
      attempts.push(`${modelId}: endpoint configuration is incomplete.`);
      continue;
    }

    try {
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
      const imagePath = await generateImageThroughEndpoint(endpoint, prompt, outputPath, params.signal);
      const filename = path.basename(imagePath);
      return {
        content: `![${filename}](${buildInlineLocalFileUrl(imagePath)})`,
        processContent: buildImageGenerationProcessContent(modelId, imagePath),
        modelUsed: modelId,
        imagePath,
      };
    } catch (error: any) {
      attempts.push(`${modelId}: ${extractImageGenerationErrorDetail(error, endpoint)}`);
    }
  }

  const detail = attempts.length > 0
    ? `Image generation failed. ${attempts.join(' | ')}`
    : 'Image generation failed.';
  const nextError = new Error(detail);
  (nextError as Error & { rawDetail?: string }).rawDetail = detail;
  throw nextError;
}

function scheduleOpenClawImageProviderCacheRefresh(reason: string) {
  refreshOpenClawImageProviderSnapshot().catch((error) => {
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    console.warn(`[OpenClawImageProviders] Failed to refresh provider cache during ${reason}: ${detail}`);
  });
}

function findImageProviderModel(snapshot: OpenClawImageProviderSnapshot, modelRef: string) {
  const normalizedRef = modelRef.trim();
  if (!normalizedRef) return null;
  return snapshot.models.find((model) => model.id === normalizedRef) || null;
}

function collectImageProviderModelNameCandidates(value: string): string[] {
  const normalizedName = value.trim().replace(/^\/+|\/+$/g, '');
  if (!normalizedName) return [];

  const candidates = [normalizedName];
  const firstSlashIndex = normalizedName.indexOf('/');
  if (firstSlashIndex >= 0) {
    const suffix = normalizedName.slice(firstSlashIndex + 1).replace(/^\/+|\/+$/g, '');
    if (suffix) {
      candidates.push(suffix);
    }
  }

  const lastSlashIndex = normalizedName.lastIndexOf('/');
  if (lastSlashIndex > firstSlashIndex) {
    const suffix = normalizedName.slice(lastSlashIndex + 1).replace(/^\/+|\/+$/g, '');
    if (suffix) {
      candidates.push(suffix);
    }
  }

  return Array.from(new Set(candidates));
}

function findImageProviderModelByName(snapshot: OpenClawImageProviderSnapshot, modelName: string) {
  const candidates = collectImageProviderModelNameCandidates(modelName);
  if (candidates.length === 0) return null;
  return snapshot.models.find((model) => candidates.includes(model.model)) || null;
}

function summarizeImageProviderModels(snapshot: OpenClawImageProviderSnapshot, limit = 16): string {
  const ids = snapshot.models.map((model) => model.id);
  if (ids.length === 0) return 'No image generation models were reported by OpenClaw.';
  const visible = ids.slice(0, limit).join(', ');
  return ids.length > limit ? `${visible}, ...` : visible;
}

function getOpenClawConfigPath() {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

function getExecApprovalsPath() {
  return path.join(os.homedir(), '.openclaw', 'exec-approvals.json');
}

const OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER = 'openclaw-chat-gateway:max-permissions-exec-preflight-bypass';
const OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE = 'async function validateScriptFileForShellBleed(params) {';
const OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE_PATTERN = /async function validateScriptFileForShellBleed\s*\(\s*[^)]*\)\s*\{/;
const OPENCLAW_EXEC_PREFLIGHT_PATCHED_SIGNATURE = `async function validateScriptFileForShellBleed(params) { return; /* ${OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER} */`;
const OPENCLAW_EXEC_PREFLIGHT_PATCH_BACKUP_SUFFIX = '.clawopt-max-permissions.exec-preflight.bak';
const OPENCLAW_BROWSER_FILL_COMPAT_MARKER = 'openclaw-chat-gateway:browser-fill-compat';
const OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER = `${OPENCLAW_BROWSER_FILL_COMPAT_MARKER}:value-alias`;
const OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER = `${OPENCLAW_BROWSER_FILL_COMPAT_MARKER}:fields-alias`;
const OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER = `${OPENCLAW_BROWSER_FILL_COMPAT_MARKER}:cli-text-alias`;
const OPENCLAW_BROWSER_FILL_COMPAT_PATCH_BACKUP_SUFFIX = '.clawopt-browser-fill-compat.bak';
const OPENCLAW_BROWSER_FILL_CANDIDATE_ENTRY_PATTERNS = [
  /^browser-cli-actions-input-.*\.js$/i,
  /^client-fetch-.*\.js$/i,
  /^plugin-service-.*\.js$/i,
  /^pw-role-snapshot-.*\.js$/i,
  /^routes-.*\.js$/i,
  /^snapshot-urls-.*\.js$/i,
] as const;
const OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE = 'const value = normalizeBrowserFormFieldValue(record.value);';
const OPENCLAW_BROWSER_FILL_CLIENT_FIELD_PATCHED_SIGNATURE = `const value = normalizeBrowserFormFieldValue(record.value !== void 0 ? record.value : record.text); /* ${OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER} */`;
const OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE = 'const fields = (Array.isArray(body.fields) ? body.fields : []).map((field) => {';
const OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_PATCHED_SIGNATURE = [
  'const fallbackRef = normalizeBrowserFormFieldRef(body.ref);',
  '\t\t\t\t\t\tconst rawFields = Array.isArray(body.fields) ? body.fields : fallbackRef ? [{',
  '\t\t\t\t\t\t\tref: fallbackRef,',
  '\t\t\t\t\t\t\ttype: body.type,',
  '\t\t\t\t\t\t\tvalue: body.value !== void 0 ? body.value : body.text',
  `\t\t\t\t\t\t}] : []; /* ${OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER} */`,
  '\t\t\t\t\t\tconst fields = rawFields.map((field) => {',
].join('\n');
const OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE = 'const fields = normalizeFields(body.fields);';
const OPENCLAW_BROWSER_FILL_ROUTE_ACTION_PATCHED_SIGNATURE = [
  `const fallbackRef = toStringOrEmpty(body.ref) || void 0; /* ${OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER} */`,
  '\t\t\tconst rawFields = Array.isArray(body.fields) ? body.fields : fallbackRef ? [{',
  '\t\t\t\tref: fallbackRef,',
  '\t\t\t\ttype: body.type,',
  '\t\t\t\tvalue: body.value !== void 0 ? body.value : body.text',
  '\t\t\t}] : [];',
  '\t\t\tconst fields = normalizeFields(rawFields);',
].join('\n');
const OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE = 'if (rec.value === void 0 || rec.value === null || normalizeBrowserFormFieldValue(rec.value) !== void 0) return parsedField;';
const OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_PATCHED_SIGNATURE = [
  `const rawValue = rec.value !== void 0 ? rec.value : rec.text; /* ${OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER} */`,
  '\t\tif (rawValue === void 0 || rawValue === null || normalizeBrowserFormFieldValue(rawValue) !== void 0) return parsedField;',
].join('\n');

type HostTakeoverOverrideSnapshot = {
  existed: boolean;
  content: string | null;
};

type TextFileSnapshot = {
  existed: boolean;
  content: string | null;
};

type FilePathSnapshot = {
  filePath: string;
  snapshot: TextFileSnapshot;
};

type OpenClawExecPreflightPatchTarget = {
  packageRoot: string;
  targetPath: string;
  backupPath: string;
};

type OpenClawExecPreflightBypassStatus = {
  ready: boolean;
  targetCount: number;
  patchedCount: number;
  rawDetail: string | null;
  targets: OpenClawExecPreflightPatchTarget[];
};

type OpenClawBrowserFillCompatPatchTargetKind = 'browser-fill-source';

type OpenClawBrowserFillCompatPatchTarget = {
  packageRoot: string;
  targetPath: string;
  backupPath: string;
  kind: OpenClawBrowserFillCompatPatchTargetKind;
};

type OpenClawBrowserFillCompatStatus = {
  ready: boolean;
  targetCount: number;
  patchedCount: number;
  rawDetail: string | null;
  targets: OpenClawBrowserFillCompatPatchTarget[];
};

function getCurrentUserName() {
  const envUser = normalizeCliText(process.env.USER);
  if (envUser) return envUser;
  try {
    return normalizeCliText(os.userInfo().username) || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getHostTakeoverSudoersPath(userName = getCurrentUserName()) {
  return `/etc/sudoers.d/openclaw-host-takeover-${userName}`;
}

function buildHostTakeoverManualInstallCommand(userName = getCurrentUserName()) {
  if (!fs.existsSync(HOST_TAKEOVER_INSTALLER_SCRIPT_PATH)) {
    return null;
  }

  return [
    'sudo',
    '/bin/bash',
    shellQuote(HOST_TAKEOVER_INSTALLER_SCRIPT_PATH),
    '--user',
    shellQuote(userName),
    '--helper-path',
    shellQuote(HOST_TAKEOVER_SYSTEM_HELPER_PATH),
    '--sudoers-path',
    shellQuote(getHostTakeoverSudoersPath(userName)),
  ].join(' ');
}

function getHostTakeoverAutoInstallMode(): HostTakeoverAutoInstallMode {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return 'root';
  }
  if (fs.existsSync('/usr/bin/sudo')) {
    return 'sudo';
  }
  return 'manual';
}

function isHostTakeoverAutoInstallSupported() {
  return getHostTakeoverAutoInstallMode() !== 'manual';
}

function needsSudoPassword(detail: string) {
  const normalized = normalizeCliText(detail).toLowerCase();
  const sudoPromptDetected = normalized.includes('sudo:') || normalized.includes('sudo：') || normalized.includes('[sudo]');
  const passwordPromptDetected = normalized.includes('password')
    || normalized.includes('密码')
    || normalized.includes('口令')
    || normalized.includes('passphrase');
  const terminalPromptDetected = normalized.includes('terminal') || normalized.includes('终端');
  const authPromptDetected = normalized.includes('authentication') || normalized.includes('认证');

  return normalized.includes('password is required')
    || normalized.includes('a terminal is required')
    || normalized.includes('no askpass program specified')
    || normalized.includes('authentication is required')
    || normalized.includes('需要密码')
    || normalized.includes('需要提供密码')
    || normalized.includes('需要输入密码')
    || normalized.includes('密码是必需的')
    || normalized.includes('必须输入密码')
    || normalized.includes('需要口令')
    || normalized.includes('需要终端')
    || normalized.includes('需要认证')
    || (sudoPromptDetected && passwordPromptDetected)
    || (sudoPromptDetected && terminalPromptDetected)
    || (sudoPromptDetected && authPromptDetected);
}

function normalizePathEntries(pathValue: string | null | undefined) {
  return (pathValue || '')
    .split(':')
    .map((entry) => normalizeCliText(entry))
    .filter(Boolean);
}

function prependPathEntry(pathValue: string, entry: string) {
  return [entry, ...normalizePathEntries(pathValue).filter((item) => item !== entry)].join(':');
}

function snapshotHostTakeoverOverride(): HostTakeoverOverrideSnapshot {
  if (!fs.existsSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH)) {
    return {
      existed: false,
      content: null,
    };
  }

  return {
    existed: true,
    content: fs.readFileSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, 'utf-8'),
  };
}

function restoreHostTakeoverOverride(snapshot: HostTakeoverOverrideSnapshot) {
  if (snapshot.existed) {
    fs.mkdirSync(path.dirname(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH), { recursive: true });
    fs.writeFileSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, snapshot.content || '');
    return;
  }

  fs.rmSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, { force: true });
}

function snapshotTextFile(filePath: string): TextFileSnapshot {
  if (!fs.existsSync(filePath)) {
    return {
      existed: false,
      content: null,
    };
  }

  // 走网关：这一行上没有 JSON.parse，所以既躲过了网关也躲过了当时那条按行匹配的
  // 守卫。一个命名管道就能让 POST /api/config/max-permissions 永久挂住整个后端。
  const text = readTextFileSafe(filePath);
  return {
    existed: true,
    content: text.exists ? (text.value as string) : '',
  };
}

function restoreTextFile(filePath: string, snapshot: TextFileSnapshot) {
  if (snapshot.existed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomicSync(filePath, snapshot.content || '');
    return;
  }

  fs.rmSync(filePath, { force: true });
}

function snapshotFilePaths(filePaths: string[]): FilePathSnapshot[] {
  const uniquePaths = Array.from(new Set(filePaths.map((filePath) => path.resolve(filePath))));
  return uniquePaths.map((filePath) => ({
    filePath,
    snapshot: snapshotTextFile(filePath),
  }));
}

function restoreFilePathSnapshots(snapshots: FilePathSnapshot[]) {
  for (const entry of snapshots) {
    restoreTextFile(entry.filePath, entry.snapshot);
  }
}

function getOpenClawExecPreflightPatchBackupPath(targetPath: string) {
  return `${targetPath}${OPENCLAW_EXEC_PREFLIGHT_PATCH_BACKUP_SUFFIX}`;
}

function readOpenClawExecPreflightSource(targetPath: string) {
  return fs.readFileSync(targetPath, 'utf-8');
}

function isOpenClawExecPreflightBypassPatched(source: string) {
  return source.includes(OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER)
    || source.includes(OPENCLAW_EXEC_PREFLIGHT_PATCHED_SIGNATURE);
}

function detectOpenClawExecPreflightValidatorSignature(source: string): string | null {
  if (source.includes(OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE)) {
    return OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE;
  }
  const match = source.match(OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE_PATTERN);
  return match?.[0] || null;
}

function collectOpenClawExecPreflightPatchTargets(): OpenClawExecPreflightPatchTarget[] {
  const targets: OpenClawExecPreflightPatchTarget[] = [];
  const seen = new Set<string>();

  for (const packageRoot of collectOpenClawPackageRoots()) {
    const distDir = path.join(packageRoot, 'dist');
    if (!fs.existsSync(distDir)) continue;

    let entryNames: string[] = [];
    try {
      entryNames = fs.readdirSync(distDir)
        .filter((entryName) => entryName.endsWith('.js') || entryName.endsWith('.mjs'))
        .sort((left, right) => {
          const leftPriority = /^pi-embedded-.*\.js$/i.test(left) ? 0 : 1;
          const rightPriority = /^pi-embedded-.*\.js$/i.test(right) ? 0 : 1;
          if (leftPriority !== rightPriority) return leftPriority - rightPriority;
          return left.localeCompare(right);
        });
    } catch {
      continue;
    }

    for (const entryName of entryNames) {
      const targetPath = path.join(distDir, entryName);
      if (seen.has(targetPath)) continue;

      const backupPath = getOpenClawExecPreflightPatchBackupPath(targetPath);
      let shouldInclude = fs.existsSync(backupPath);

      if (!shouldInclude) {
        try {
          const source = readOpenClawExecPreflightSource(targetPath);
          shouldInclude = detectOpenClawExecPreflightValidatorSignature(source) !== null
            || isOpenClawExecPreflightBypassPatched(source);
        } catch {
          shouldInclude = false;
        }
      }

      if (!shouldInclude) continue;

      seen.add(targetPath);
      targets.push({
        packageRoot,
        targetPath,
        backupPath,
      });
    }
  }

  return targets;
}

function snapshotOpenClawExecPreflightPatchFiles(
  targets = collectOpenClawExecPreflightPatchTargets(),
): FilePathSnapshot[] {
  return snapshotFilePaths(targets.flatMap((target) => [target.targetPath, target.backupPath]));
}

function patchOpenClawExecPreflightBypassTarget(target: OpenClawExecPreflightPatchTarget) {
  const source = readOpenClawExecPreflightSource(target.targetPath);
  if (isOpenClawExecPreflightBypassPatched(source)) {
    return;
  }

  const validatorSignature = detectOpenClawExecPreflightValidatorSignature(source);
  if (!validatorSignature) {
    throw new Error(`OpenClaw exec preflight validator signature not found in ${target.targetPath}.`);
  }

  if (!fs.existsSync(target.backupPath)) {
    fs.writeFileSync(target.backupPath, source);
  }

  const patchedSource = source.replace(
    validatorSignature,
    `${validatorSignature} return; /* ${OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER} */`,
  );
  if (patchedSource === source) {
    throw new Error(`Failed to patch OpenClaw exec preflight validator in ${target.targetPath}.`);
  }

  fs.writeFileSync(target.targetPath, patchedSource);
}

function restoreOpenClawExecPreflightBypassTarget(target: OpenClawExecPreflightPatchTarget) {
  if (fs.existsSync(target.backupPath)) {
    fs.writeFileSync(target.targetPath, fs.readFileSync(target.backupPath, 'utf-8'));
    fs.rmSync(target.backupPath, { force: true });
    return;
  }

  if (!fs.existsSync(target.targetPath)) {
    return;
  }

  const source = readOpenClawExecPreflightSource(target.targetPath);
  if (!isOpenClawExecPreflightBypassPatched(source)) {
    return;
  }

  const restoredSource = source.replace(
    OPENCLAW_EXEC_PREFLIGHT_PATCHED_SIGNATURE,
    OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE,
  ).replace(
    new RegExp(`\\s*return; /\\* ${escapeRegExpForPattern(OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER)} \\*/`),
    '',
  );
  if (restoredSource !== source && !isOpenClawExecPreflightBypassPatched(restoredSource)) {
    fs.writeFileSync(target.targetPath, restoredSource);
  }
}

function readOpenClawExecPreflightBypassStatus(): OpenClawExecPreflightBypassStatus {
  const targets = collectOpenClawExecPreflightPatchTargets();
  if (targets.length === 0) {
    return {
      ready: false,
      targetCount: 0,
      patchedCount: 0,
      rawDetail: 'Could not locate the OpenClaw exec preflight bundle to patch.',
      targets,
    };
  }

  let patchedCount = 0;
  const unpatchedTargets: string[] = [];

  for (const target of targets) {
    try {
      const source = readOpenClawExecPreflightSource(target.targetPath);
      if (isOpenClawExecPreflightBypassPatched(source)) {
        patchedCount += 1;
      } else {
        unpatchedTargets.push(path.basename(target.targetPath));
      }
    } catch {
      unpatchedTargets.push(path.basename(target.targetPath));
    }
  }

  if (patchedCount === targets.length) {
    return {
      ready: true,
      targetCount: targets.length,
      patchedCount,
      rawDetail: null,
      targets,
    };
  }

  return {
    ready: false,
    targetCount: targets.length,
    patchedCount,
    rawDetail: `The OpenClaw exec preflight bypass is not active for: ${unpatchedTargets.join(', ')}`,
    targets,
  };
}

function applyOpenClawExecPreflightBypass(enabled: boolean) {
  const targets = collectOpenClawExecPreflightPatchTargets();

  if (enabled && targets.length === 0) {
    throw new Error('Could not locate the OpenClaw exec preflight bundle for maximum permissions.');
  }

  for (const target of targets) {
    if (enabled) {
      patchOpenClawExecPreflightBypassTarget(target);
    } else {
      restoreOpenClawExecPreflightBypassTarget(target);
    }
  }

  if (enabled) {
    const status = readOpenClawExecPreflightBypassStatus();
    if (!status.ready) {
      throw new Error(status.rawDetail || 'Failed to activate the OpenClaw exec preflight bypass.');
    }
  }
}

function synchronizeOpenClawExecPreflightBypassBestEffort(enabled: boolean) {
  try {
    applyOpenClawExecPreflightBypass(enabled);
  } catch (error) {
    console.error('Failed to synchronize the OpenClaw exec preflight bypass:', error);
  }
}

function getOpenClawBrowserFillCompatPatchBackupPath(targetPath: string) {
  return `${targetPath}${OPENCLAW_BROWSER_FILL_COMPAT_PATCH_BACKUP_SUFFIX}`;
}

function readOpenClawBrowserFillCompatSource(targetPath: string) {
  return fs.readFileSync(targetPath, 'utf-8');
}

function isOpenClawBrowserFillCompatCandidateEntryName(entryName: string) {
  return OPENCLAW_BROWSER_FILL_CANDIDATE_ENTRY_PATTERNS.some((pattern) => pattern.test(entryName));
}

function sourceHasOpenClawBrowserFillCompatSignatureOrMarker(source: string) {
  return source.includes(OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER)
    || source.includes(OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER)
    || source.includes(OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER);
}

function isOpenClawBrowserFillCompatPatched(_target: OpenClawBrowserFillCompatPatchTarget, source: string) {
  const needsValueAlias = source.includes(OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER);
  const needsFieldsAlias = source.includes(OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER);
  const needsCliAlias = source.includes(OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER);

  if (!needsValueAlias && !needsFieldsAlias && !needsCliAlias) {
    return false;
  }

  return (!needsValueAlias || source.includes(OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER))
    && (!needsFieldsAlias || source.includes(OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER))
    && (!needsCliAlias || source.includes(OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER));
}

function collectOpenClawBrowserFillCompatPatchTargets(): OpenClawBrowserFillCompatPatchTarget[] {
  const targets: OpenClawBrowserFillCompatPatchTarget[] = [];
  const seen = new Set<string>();

  for (const packageRoot of collectOpenClawPackageRoots()) {
    const distDir = path.join(packageRoot, 'dist');
    if (!fs.existsSync(distDir)) continue;

    let entryNames: string[] = [];
    try {
      entryNames = fs.readdirSync(distDir)
        .filter((entryName) => entryName.endsWith('.js'))
        .sort((left, right) => left.localeCompare(right));
    } catch {
      continue;
    }

    for (const entryName of entryNames) {
      if (!isOpenClawBrowserFillCompatCandidateEntryName(entryName)) continue;

      const targetPath = path.join(distDir, entryName);
      if (seen.has(targetPath)) continue;

      const backupPath = getOpenClawBrowserFillCompatPatchBackupPath(targetPath);
      const target: OpenClawBrowserFillCompatPatchTarget = {
        packageRoot,
        targetPath,
        backupPath,
        kind: 'browser-fill-source',
      };

      let shouldInclude = fs.existsSync(backupPath);
      if (!shouldInclude) {
        try {
          const source = readOpenClawBrowserFillCompatSource(targetPath);
          shouldInclude = sourceHasOpenClawBrowserFillCompatSignatureOrMarker(source);
        } catch {
          shouldInclude = false;
        }
      }

      if (!shouldInclude) continue;

      seen.add(targetPath);
      targets.push(target);
    }
  }

  return targets;
}

function patchOpenClawBrowserFillCompatTarget(target: OpenClawBrowserFillCompatPatchTarget) {
  const source = readOpenClawBrowserFillCompatSource(target.targetPath);
  if (isOpenClawBrowserFillCompatPatched(target, source)) {
    return;
  }

  let patchedSource = source;

  if (!patchedSource.includes(OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER)
    && patchedSource.includes(OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE)) {
    const nextSource = patchedSource.replace(
      OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE,
      OPENCLAW_BROWSER_FILL_CLIENT_FIELD_PATCHED_SIGNATURE,
    );
    if (nextSource === patchedSource) {
      throw new Error(`Failed to patch the OpenClaw browser fill value alias in ${target.targetPath}.`);
    }
    patchedSource = nextSource;
  }

  if (!patchedSource.includes(OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER)) {
    if (patchedSource.includes(OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE)) {
      const nextSource = patchedSource.replace(
        OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE,
        OPENCLAW_BROWSER_FILL_ROUTE_ACTION_PATCHED_SIGNATURE,
      );
      if (nextSource === patchedSource) {
        throw new Error(`Failed to patch the OpenClaw browser fill fields alias in ${target.targetPath}.`);
      }
      patchedSource = nextSource;
    } else if (patchedSource.includes(OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE)) {
      const nextSource = patchedSource.replace(
        OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE,
        OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_PATCHED_SIGNATURE,
      );
      if (nextSource === patchedSource) {
        throw new Error(`Failed to patch the OpenClaw browser fill legacy fields alias in ${target.targetPath}.`);
      }
      patchedSource = nextSource;
    }
  }

  if (!patchedSource.includes(OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER)
    && patchedSource.includes(OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE)) {
    const nextSource = patchedSource.replace(
      OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE,
      OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_PATCHED_SIGNATURE,
    );
    if (nextSource === patchedSource) {
      throw new Error(`Failed to patch the OpenClaw browser fill CLI alias in ${target.targetPath}.`);
    }
    patchedSource = nextSource;
  }

  if (patchedSource === source) {
    if (!isOpenClawBrowserFillCompatPatched(target, source)) {
      throw new Error(`OpenClaw browser fill compatibility signature not found in ${target.targetPath}.`);
    }
    return;
  }

  if (!fs.existsSync(target.backupPath)) {
    fs.writeFileSync(target.backupPath, source);
  }

  fs.writeFileSync(target.targetPath, patchedSource);
}

function readOpenClawBrowserFillCompatStatus(): OpenClawBrowserFillCompatStatus {
  const targets = collectOpenClawBrowserFillCompatPatchTargets();
  if (targets.length === 0) {
    return {
      ready: false,
      targetCount: 0,
      patchedCount: 0,
      rawDetail: 'Could not locate the OpenClaw browser fill bundle to patch.',
      targets,
    };
  }

  let patchedCount = 0;
  const unpatchedTargets: string[] = [];

  for (const target of targets) {
    try {
      const source = readOpenClawBrowserFillCompatSource(target.targetPath);
      if (isOpenClawBrowserFillCompatPatched(target, source)) {
        patchedCount += 1;
      } else {
        unpatchedTargets.push(path.basename(target.targetPath));
      }
    } catch {
      unpatchedTargets.push(path.basename(target.targetPath));
    }
  }

  if (patchedCount === targets.length) {
    return {
      ready: true,
      targetCount: targets.length,
      patchedCount,
      rawDetail: null,
      targets,
    };
  }

  return {
    ready: false,
    targetCount: targets.length,
    patchedCount,
    rawDetail: `The OpenClaw browser fill compatibility patch is not active for: ${unpatchedTargets.join(', ')}`,
    targets,
  };
}

function applyOpenClawBrowserFillCompatPatch() {
  const targets = collectOpenClawBrowserFillCompatPatchTargets();
  if (targets.length === 0) {
    throw new Error('Could not locate the OpenClaw browser fill bundle to patch.');
  }

  for (const target of targets) {
    patchOpenClawBrowserFillCompatTarget(target);
  }

  const status = readOpenClawBrowserFillCompatStatus();
  if (!status.ready) {
    throw new Error(status.rawDetail || 'Failed to activate the OpenClaw browser fill compatibility patch.');
  }
}

function synchronizeOpenClawBrowserFillCompatBestEffort() {
  try {
    applyOpenClawBrowserFillCompatPatch();
  } catch (error) {
    console.error('Failed to synchronize the OpenClaw browser fill compatibility patch:', error);
  }
}

function buildHostTakeoverHostRootScript() {
  return `#!/bin/bash
set -euo pipefail

HELPER_PATH=${shellQuote(HOST_TAKEOVER_SYSTEM_HELPER_PATH)}

die() {
  echo "$1" >&2
  exit 126
}

target_user=""
if [[ "\${1:-}" == "--as-user" ]]; then
  shift
  target_user="\${1:-}"
  if [[ -z "$target_user" ]]; then
    echo "Missing user after --as-user" >&2
    exit 64
  fi
  shift
fi

if [[ "\${1:-}" == "--" ]]; then
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: host-root [--as-user USER] -- <command> [args...]" >&2
  exit 64
fi

if [[ "$(id -u)" -eq 0 ]]; then
  if [[ -n "$target_user" && "$target_user" != "root" ]]; then
    if command -v runuser >/dev/null 2>&1; then
      exec runuser -u "$target_user" -- "$@"
    fi
    exec su -s /bin/sh "$target_user" -c "$(printf '%q ' "$@")"
  fi
  exec "$@"
fi

if [[ ! -x /usr/bin/sudo ]]; then
  die "OpenClaw host takeover requires /usr/bin/sudo on the host."
fi

if [[ -x "$HELPER_PATH" ]]; then
  if [[ -n "$target_user" && "$target_user" != "root" ]]; then
    exec /usr/bin/sudo -n "$HELPER_PATH" --as-user "$target_user" -- "$@"
  fi
  exec /usr/bin/sudo -n "$HELPER_PATH" "$@"
fi

if [[ -n "$target_user" && "$target_user" != "root" ]]; then
  exec /usr/bin/sudo -n -u "$target_user" -- "$@"
fi

exec /usr/bin/sudo -n -- "$@"
`;
}

function buildHostTakeoverSudoScript() {
  return `#!/bin/bash
set -euo pipefail

WRAPPER_DIR=${shellQuote(HOST_TAKEOVER_WRAPPER_DIR)}
orig=("$@")
target_user=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|-H|-E|-k|-S)
      shift
      ;;
    -u)
      shift
      target_user="\${1:-}"
      if [[ -z "$target_user" ]]; then
        echo "Missing user after -u" >&2
        exit 64
      fi
      shift
      ;;
    -u*)
      target_user="\${1#-u}"
      if [[ -z "$target_user" ]]; then
        echo "Missing user after -u" >&2
        exit 64
      fi
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      exec /usr/bin/sudo -n "\${orig[@]}"
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  if [[ -n "$target_user" && "$target_user" != "root" ]]; then
    exec "$WRAPPER_DIR/host-root" --as-user "$target_user" -- /bin/sh
  fi
  exec "$WRAPPER_DIR/host-root" /bin/sh
fi

if [[ -n "$target_user" && "$target_user" != "root" ]]; then
  exec "$WRAPPER_DIR/host-root" --as-user "$target_user" -- "$@"
fi

exec "$WRAPPER_DIR/host-root" "$@"
`;
}

function buildHostTakeoverRootCommandScript(
  commandName: string,
  candidatePaths: string[],
  options?: { bypassUserFlag?: string }
) {
  const candidateLines = candidatePaths
    .map((candidate) => candidate)
    .join('\n');
  const bypassBlock = options?.bypassUserFlag
    ? `
for arg in "$@"; do
  if [[ "$arg" == ${shellQuote(options.bypassUserFlag)} ]]; then
    exec "$target" "$@"
  fi
done
`
    : '';

  return `#!/bin/bash
set -euo pipefail

WRAPPER_DIR=${shellQuote(HOST_TAKEOVER_WRAPPER_DIR)}
target=""
while IFS= read -r candidate; do
  if [[ -x "$candidate" ]]; then
    target="$candidate"
    break
  fi
done <<'EOF'
${candidateLines}
EOF

if [[ -z "$target" ]]; then
  echo "OpenClaw host takeover could not find ${commandName} on this host." >&2
  exit 127
fi
${bypassBlock}
exec "$WRAPPER_DIR/host-root" "$target" "$@"
`;
}

function buildHostTakeoverPipScript(preferredCommand: 'pip' | 'pip3') {
  const primaryPath = preferredCommand === 'pip3' ? '/usr/bin/pip3' : '/usr/bin/pip';
  return `#!/bin/bash
set -euo pipefail

WRAPPER_DIR=${shellQuote(HOST_TAKEOVER_WRAPPER_DIR)}
target=""
if [[ -x ${shellQuote(primaryPath)} ]]; then
  target=${shellQuote(primaryPath)}
elif [[ -x /usr/bin/python3 ]]; then
  exec "$WRAPPER_DIR/host-root" /usr/bin/python3 -m pip "$@"
else
  echo "OpenClaw host takeover could not find ${preferredCommand} or python3 on this host." >&2
  exit 127
fi

exec "$WRAPPER_DIR/host-root" "$target" "$@"
`;
}

function buildHostTakeoverPythonScript(commandName: 'python' | 'python3') {
  const candidates = commandName === 'python'
    ? ['/usr/bin/python', '/usr/bin/python3']
    : ['/usr/bin/python3', '/usr/local/bin/python3'];
  const candidateLines = candidates
    .map((candidate) => candidate)
    .join('\n');

  return `#!/bin/bash
set -euo pipefail

WRAPPER_DIR=${shellQuote(HOST_TAKEOVER_WRAPPER_DIR)}
target=""
while IFS= read -r candidate; do
  if [[ -x "$candidate" ]]; then
    target="$candidate"
    break
  fi
done <<'EOF'
${candidateLines}
EOF

if [[ -z "$target" ]]; then
  echo "OpenClaw host takeover could not find ${commandName} on this host." >&2
  exit 127
fi

if [[ "\${1:-}" == "-m" && ( "\${2:-}" == "pip" || "\${2:-}" == "ensurepip" ) ]]; then
  exec "$WRAPPER_DIR/host-root" "$target" "$@"
fi

exec "$target" "$@"
`;
}

function ensureHostTakeoverWrappers() {
  fs.mkdirSync(HOST_TAKEOVER_WRAPPER_DIR, { recursive: true });

  const scripts = new Map<string, string>([
    ['host-root', buildHostTakeoverHostRootScript()],
    ['sudo', buildHostTakeoverSudoScript()],
    ['apt', buildHostTakeoverRootCommandScript('apt', ['/usr/bin/apt'])],
    ['apt-get', buildHostTakeoverRootCommandScript('apt-get', ['/usr/bin/apt-get'])],
    ['apt-cache', buildHostTakeoverRootCommandScript('apt-cache', ['/usr/bin/apt-cache'])],
    ['dpkg', buildHostTakeoverRootCommandScript('dpkg', ['/usr/bin/dpkg'])],
    ['dnf', buildHostTakeoverRootCommandScript('dnf', ['/usr/bin/dnf'])],
    ['yum', buildHostTakeoverRootCommandScript('yum', ['/usr/bin/yum'])],
    ['pacman', buildHostTakeoverRootCommandScript('pacman', ['/usr/bin/pacman'])],
    ['apk', buildHostTakeoverRootCommandScript('apk', ['/sbin/apk', '/usr/sbin/apk'])],
    ['zypper', buildHostTakeoverRootCommandScript('zypper', ['/usr/bin/zypper'])],
    ['rpm', buildHostTakeoverRootCommandScript('rpm', ['/usr/bin/rpm'])],
    ['snap', buildHostTakeoverRootCommandScript('snap', ['/usr/bin/snap'])],
    ['flatpak', buildHostTakeoverRootCommandScript('flatpak', ['/usr/bin/flatpak'])],
    ['systemctl', buildHostTakeoverRootCommandScript('systemctl', ['/usr/bin/systemctl'], { bypassUserFlag: '--user' })],
    ['service', buildHostTakeoverRootCommandScript('service', ['/usr/sbin/service', '/usr/bin/service'])],
    ['loginctl', buildHostTakeoverRootCommandScript('loginctl', ['/usr/bin/loginctl'])],
    ['journalctl', buildHostTakeoverRootCommandScript('journalctl', ['/usr/bin/journalctl'], { bypassUserFlag: '--user' })],
    ['mount', buildHostTakeoverRootCommandScript('mount', ['/usr/bin/mount', '/bin/mount'])],
    ['umount', buildHostTakeoverRootCommandScript('umount', ['/usr/bin/umount', '/bin/umount'])],
    ['chown', buildHostTakeoverRootCommandScript('chown', ['/usr/bin/chown', '/bin/chown'])],
    ['chmod', buildHostTakeoverRootCommandScript('chmod', ['/usr/bin/chmod', '/bin/chmod'])],
    ['chgrp', buildHostTakeoverRootCommandScript('chgrp', ['/usr/bin/chgrp', '/bin/chgrp'])],
    ['tee', buildHostTakeoverRootCommandScript('tee', ['/usr/bin/tee'])],
    ['pip', buildHostTakeoverPipScript('pip')],
    ['pip3', buildHostTakeoverPipScript('pip3')],
    ['python', buildHostTakeoverPythonScript('python')],
    ['python3', buildHostTakeoverPythonScript('python3')],
  ]);

  for (const [fileName, content] of scripts.entries()) {
    const filePath = path.join(HOST_TAKEOVER_WRAPPER_DIR, fileName);
    fs.writeFileSync(filePath, content, { mode: 0o755 });
    fs.chmodSync(filePath, 0o755);
  }
}

async function readOpenClawGatewayServiceEnvironmentPath() {
  const { stdout } = await execFilePromise(
    'systemctl',
    ['--user', 'show', OPENCLAW_GATEWAY_SERVICE_NAME, '-p', 'Environment', '--value'],
    {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }
  );
  const normalized = normalizeCliText(stdout);
  const matched = normalized.match(/(?:^|\s)PATH=([^\s]+)/);
  return normalizeCliText(matched?.[1]) || null;
}

async function reloadOpenClawGatewayUserSystemd() {
  await execFilePromise('systemctl', ['--user', 'daemon-reload'], {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
}

async function setHostTakeoverSystemdOverrideEnabled(enabled: boolean) {
  if (enabled) {
    const currentPath = await readOpenClawGatewayServiceEnvironmentPath();
    if (!currentPath) {
      throw new StructuredRequestError(
        500,
        GATEWAY_HOST_TAKEOVER_SERVICE_NOT_FOUND_ERROR_CODE,
        `Could not detect ${OPENCLAW_GATEWAY_SERVICE_NAME} or its PATH environment.`
      );
    }

    const nextPath = prependPathEntry(currentPath, HOST_TAKEOVER_WRAPPER_DIR);
    fs.mkdirSync(path.dirname(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH), { recursive: true });
    fs.writeFileSync(
      HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH,
      `[Service]\nEnvironment=PATH=${nextPath}\n`
    );
  } else {
    fs.rmSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, { force: true });
  }

  await reloadOpenClawGatewayUserSystemd();
}

async function installHostTakeoverHelper(password?: string | null) {
  const userName = getCurrentUserName();
  if (!fs.existsSync(HOST_TAKEOVER_INSTALLER_SCRIPT_PATH)) {
    throw new StructuredRequestError(
      500,
      GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE,
      `Host takeover installer script not found at ${HOST_TAKEOVER_INSTALLER_SCRIPT_PATH}.`
    );
  }

  const installerArgs = [
    '/bin/bash',
    HOST_TAKEOVER_INSTALLER_SCRIPT_PATH,
    '--user',
    userName,
    '--helper-path',
    HOST_TAKEOVER_SYSTEM_HELPER_PATH,
    '--sudoers-path',
    getHostTakeoverSudoersPath(userName),
  ];

  if (fs.existsSync(HOST_TAKEOVER_SYSTEM_HELPER_PATH)) {
    try {
      const { stdout } = await execFilePromise('sudo', ['-n', HOST_TAKEOVER_SYSTEM_HELPER_PATH, '/usr/bin/id', '-u'], {
        timeout: 5000,
        maxBuffer: 16 * 1024,
      });
      if (normalizeCliText(stdout) === '0') {
        return;
      }
    } catch {}
  }

  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    try {
      await execFilePromise(installerArgs[0], installerArgs.slice(1), {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      return;
    } catch (error: any) {
      throw new StructuredRequestError(
        500,
        GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE,
        readCliErrorDetail(error) || error?.message || 'Failed to install the host takeover helper.'
      );
    }
  }

  try {
    await execFilePromise('sudo', ['-n', ...installerArgs], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return;
  } catch (error: any) {
    const detail = readCliErrorDetail(error) || error?.message || 'Failed to install the host takeover helper.';
    if (!password && needsSudoPassword(detail)) {
      throw new StructuredRequestError(
        409,
        GATEWAY_HOST_TAKEOVER_CREDENTIALS_REQUIRED_ERROR_CODE,
        'Installing host takeover needs the current system user password.',
        { userName }
      );
    }

    if (!password) {
      throw new StructuredRequestError(
        500,
        GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE,
        detail
      );
    }
  }

  try {
    await execFileWithInput(
      'sudo',
      ['-S', '-k', '-p', '', ...installerArgs],
      `${password}\n`,
      { timeout: 20000 }
    );
  } catch (error: any) {
    const detail = readCliErrorDetail(error) || error?.message || 'Failed to install the host takeover helper.';
    throw new StructuredRequestError(
      500,
      GATEWAY_HOST_TAKEOVER_INSTALL_FAILED_ERROR_CODE,
      detail
    );
  }
}

async function readHostTakeoverStatus(enabled = readMaxPermissionsEnabled() === true): Promise<HostTakeoverStatus> {
  const currentUser = getCurrentUserName();
  const autoInstallMode = getHostTakeoverAutoInstallMode();
  const autoInstallSupported = isHostTakeoverAutoInstallSupported();
  const execPreflightBypassStatus = enabled
    ? readOpenClawExecPreflightBypassStatus()
    : {
        ready: false,
        targetCount: 0,
        patchedCount: 0,
        rawDetail: null,
        targets: [],
      } satisfies OpenClawExecPreflightBypassStatus;
  const helperInstalled = fs.existsSync(HOST_TAKEOVER_SYSTEM_HELPER_PATH);
  const overrideContent = fs.existsSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH)
    ? fs.readFileSync(HOST_TAKEOVER_SYSTEMD_OVERRIDE_PATH, 'utf-8')
    : '';
  const overridePathPatched = normalizeCliText(overrideContent).includes(HOST_TAKEOVER_WRAPPER_DIR);
  let helperReachable = false;
  let servicePathPatched = false;
  let rawDetail: string | null = null;

  if (helperInstalled) {
    try {
      const { stdout } = await execFilePromise(
        'sudo',
        ['-n', HOST_TAKEOVER_SYSTEM_HELPER_PATH, '/usr/bin/id', '-u'],
        {
          timeout: 5000,
          maxBuffer: 16 * 1024,
        }
      );
      helperReachable = normalizeCliText(stdout) === '0';
      if (!helperReachable) {
        rawDetail = 'The host takeover helper responded, but did not confirm root execution.';
      }
    } catch (error: any) {
      rawDetail = normalizeCliText(error?.stderr) || normalizeCliText(error?.message) || 'The host takeover helper is installed but not reachable.';
    }
  }

  try {
    const servicePath = await readOpenClawGatewayServiceEnvironmentPath();
    servicePathPatched = normalizePathEntries(servicePath).includes(HOST_TAKEOVER_WRAPPER_DIR) || overridePathPatched;
  } catch (error: any) {
    servicePathPatched = overridePathPatched;
    rawDetail = rawDetail || normalizeCliText(error?.stderr) || normalizeCliText(error?.message) || `Could not inspect ${OPENCLAW_GATEWAY_SERVICE_NAME}.`;
  }

  const ready = helperReachable
    && servicePathPatched
    && (!enabled || execPreflightBypassStatus.ready);
  let mode: HostTakeoverMode = 'disabled';

  if (!enabled) {
    mode = 'disabled';
  } else if (ready) {
    mode = 'ready';
  } else if (!helperInstalled) {
    mode = 'needs_install';
    rawDetail = rawDetail || 'The host takeover helper has not been installed yet.';
  } else {
    mode = 'broken';
    rawDetail = rawDetail
      || execPreflightBypassStatus.rawDetail
      || 'The host takeover chain is incomplete.';
  }

  return {
    enabled,
    mode,
    ready,
    helperInstalled,
    helperReachable,
    servicePathPatched,
    execPreflightBypassReady: enabled && execPreflightBypassStatus.ready,
    execPreflightTargetCount: execPreflightBypassStatus.targetCount,
    execPreflightPatchedCount: execPreflightBypassStatus.patchedCount,
    currentUser,
    wrapperDir: HOST_TAKEOVER_WRAPPER_DIR,
    hostRootPath: HOST_TAKEOVER_HOST_ROOT_PATH,
    helperPath: HOST_TAKEOVER_SYSTEM_HELPER_PATH,
    autoInstallSupported,
    autoInstallMode,
    manualInstallCommand: buildHostTakeoverManualInstallCommand(),
    rawDetail,
  };
}

async function safeReadHostTakeoverStatus(enabled = readMaxPermissionsEnabled() === true): Promise<HostTakeoverStatus> {
  try {
    return await readHostTakeoverStatus(enabled);
  } catch (error: any) {
    const execPreflightBypassStatus = enabled
      ? readOpenClawExecPreflightBypassStatus()
      : {
          ready: false,
          targetCount: 0,
          patchedCount: 0,
          rawDetail: null,
          targets: [],
        } satisfies OpenClawExecPreflightBypassStatus;
    return {
      enabled,
      mode: enabled ? 'broken' : 'disabled',
      ready: false,
      helperInstalled: fs.existsSync(HOST_TAKEOVER_SYSTEM_HELPER_PATH),
      helperReachable: false,
      servicePathPatched: false,
      execPreflightBypassReady: enabled && execPreflightBypassStatus.ready,
      execPreflightTargetCount: execPreflightBypassStatus.targetCount,
      execPreflightPatchedCount: execPreflightBypassStatus.patchedCount,
      currentUser: getCurrentUserName(),
      wrapperDir: HOST_TAKEOVER_WRAPPER_DIR,
      hostRootPath: HOST_TAKEOVER_HOST_ROOT_PATH,
      helperPath: HOST_TAKEOVER_SYSTEM_HELPER_PATH,
      autoInstallSupported: isHostTakeoverAutoInstallSupported(),
      autoInstallMode: getHostTakeoverAutoInstallMode(),
      manualInstallCommand: buildHostTakeoverManualInstallCommand(),
      rawDetail: execPreflightBypassStatus.rawDetail
        || normalizeCliText(error?.stderr)
        || normalizeCliText(error?.message)
        || 'Failed to inspect host takeover status.',
    };
  }
}

function normalizeCliStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeCliText(entry))
    .filter(Boolean);
}

function normalizeDevicePairingPendingRequest(value: any): DevicePairingPendingRequestSummary | null {
  const requestId = normalizeCliText(value?.requestId);
  if (!requestId) {
    return null;
  }

  const roles = normalizeCliStringArray(value?.roles);
  const scopes = normalizeCliStringArray(value?.scopes);
  const ts = Number.isFinite(value?.ts) ? Number(value.ts) : null;

  return {
    requestId,
    deviceId: normalizeCliText(value?.deviceId) || null,
    displayName: normalizeCliText(value?.displayName) || null,
    clientId: normalizeCliText(value?.clientId) || null,
    clientMode: normalizeCliText(value?.clientMode) || null,
    role: normalizeCliText(value?.role) || (roles[0] || null),
    roles,
    scopes,
    remoteIp: normalizeCliText(value?.remoteIp) || null,
    isRepair: value?.isRepair === true,
    ts,
  };
}

function selectLatestPendingDevicePairingRequest(pending: DevicePairingPendingRequestSummary[]) {
  if (pending.length === 0) {
    return null;
  }

  return pending.reduce((latest, current) => {
    const latestTs = latest.ts ?? 0;
    const currentTs = current.ts ?? 0;
    return currentTs > latestTs ? current : latest;
  });
}

function normalizeDevicePairingStatusSnapshot(raw: any, rawDetail?: string | null): DevicePairingStatusSnapshot {
  const pending = Array.isArray(raw?.pending)
    ? raw.pending
        .map((entry: any) => normalizeDevicePairingPendingRequest(entry))
        .filter((entry: DevicePairingPendingRequestSummary | null): entry is DevicePairingPendingRequestSummary => !!entry)
    : [];

  return {
    pending,
    latestPending: selectLatestPendingDevicePairingRequest(pending),
    pairedCount: Array.isArray(raw?.paired) ? raw.paired.length : 0,
    rawDetail: normalizeCliText(rawDetail) || null,
  };
}

let cachedOpenClawLocalDevicePairingApiPromise: Promise<OpenClawLocalDevicePairingApi> | null = null;

const importOpenClawEsmModule = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<unknown>;

async function loadOpenClawLocalDevicePairingApi(): Promise<OpenClawLocalDevicePairingApi> {
  if (!cachedOpenClawLocalDevicePairingApiPromise) {
    cachedOpenClawLocalDevicePairingApiPromise = (async () => {
      const packageRoots = new Set<string>(collectOpenClawPackageRoots());

      try {
        const executablePath = await ensureResolvedOpenClawExecutablePath();
        const resolvedExecutablePath = fs.realpathSync(executablePath);
        if (path.basename(resolvedExecutablePath) === 'openclaw.mjs') {
          packageRoots.add(path.dirname(resolvedExecutablePath));
        }
      } catch {}

      for (const packageRoot of packageRoots) {
        const apiPath = path.join(packageRoot, 'dist', 'extensions', 'device-pair', 'api.js');
        if (!fs.existsSync(apiPath)) {
          continue;
        }

        const imported = await importOpenClawEsmModule(pathToFileURL(apiPath).href) as Partial<OpenClawLocalDevicePairingApi>;
        if (
          typeof imported.listDevicePairing === 'function'
          && typeof imported.approveDevicePairing === 'function'
        ) {
          return imported as OpenClawLocalDevicePairingApi;
        }
      }

      throw new Error('OpenClaw official device-pair API is not available in the local install.');
    })();
  }

  try {
    return await cachedOpenClawLocalDevicePairingApiPromise;
  } catch (error) {
    cachedOpenClawLocalDevicePairingApiPromise = null;
    throw error;
  }
}

async function listLocalDevicePairingStatus() {
  const localApi = await loadOpenClawLocalDevicePairingApi();
  const localList = await localApi.listDevicePairing();
  return normalizeDevicePairingStatusSnapshot(localList);
}

async function approveLocalDevicePairingRequest(requestId: string) {
  const localApi = await loadOpenClawLocalDevicePairingApi();
  return await localApi.approveDevicePairing(requestId, { callerScopes: ['operator.admin'] });
}

async function readDevicePairingStatus(): Promise<DevicePairingStatusSnapshot> {
  return listLocalDevicePairingStatus();
}

async function safeReadDevicePairingStatus(): Promise<DevicePairingStatusSnapshot> {
  try {
    return await readDevicePairingStatus();
  } catch (error: any) {
    return {
      pending: [],
      latestPending: null,
      pairedCount: null,
      rawDetail: readCliErrorDetail(error) || 'Failed to inspect device pairing status.',
    };
  }
}

async function approveLatestDevicePairingRequest() {
  const currentStatus = await readDevicePairingStatus();
  const latestPending = currentStatus.latestPending;
  if (!latestPending) {
    throw new StructuredRequestError(
      409,
      GATEWAY_DEVICE_PAIRING_NO_PENDING_ERROR_CODE,
      'No pending device pairing requests to approve.',
    );
  }

  const approved = await approveLocalDevicePairingRequest(latestPending.requestId);
  if (approved?.status === 'forbidden') {
    throw new StructuredRequestError(
      403,
      GATEWAY_DEVICE_PAIRING_APPROVE_FAILED_ERROR_CODE,
      normalizeCliText(approved.missingScope)
        ? `Missing scope: ${approved.missingScope}`
        : 'Failed to approve the latest device pairing request.',
    );
  }

  if (approved == null) {
    throw new StructuredRequestError(
      409,
      GATEWAY_DEVICE_PAIRING_NO_PENDING_ERROR_CODE,
      'No pending device pairing requests to approve.',
    );
  }

  return {
    approvedRequestId: latestPending.requestId,
    approvedDeviceId: normalizeCliText(approved?.device?.deviceId) || latestPending.deviceId,
    approvedDeviceName: normalizeCliText(approved?.device?.displayName) || latestPending.displayName,
    devicePairing: await safeReadDevicePairingStatus(),
  };
}

function buildHostTakeoverChatInstruction() {
  const currentUser = getCurrentUserName();
  return [
    '【Host takeover】',
    'Maximum permissions are enabled. You can directly operate this Linux host and use root when required.',
    'Treat installed host tools as part of your execution environment: if a command-line tool exists on this machine, you should discover it from PATH and use it directly instead of claiming the product lacks that capability.',
    'For uploaded files or workspace files, use their absolute paths. When the model cannot natively understand a file type, first call the appropriate local tool to inspect, transcribe, convert, extract, or summarize it, then continue the task.',
    'Under maximum permissions, OpenClaw internal exec/script preflight interception is also bypassed, so complex shell and interpreter command sequences may be executed directly when needed.',
    buildManagedDocumentToolingInstruction(),
    `Immediate root entrypoint: ${HOST_TAKEOVER_HOST_ROOT_PATH}`,
    `Run a single root command with: ${HOST_TAKEOVER_HOST_ROOT_PATH} /usr/bin/id -u`,
    `Run a complex root shell with: ${HOST_TAKEOVER_HOST_ROOT_PATH} /bin/sh -lc '<command>'`,
    `To drop back to the normal user, run: ${HOST_TAKEOVER_HOST_ROOT_PATH} --as-user ${currentUser} -- <command>`,
    'After the OpenClaw gateway restarts, common commands such as sudo, apt, apt-get, pip, python -m pip, systemctl, journalctl, mount, umount, chmod, chown, and tee will also flow through the takeover wrappers automatically.',
  ].join('\n');
}

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
let gatewayRestartTask: Promise<void> | null = null;
let gatewayRestartQueued = false;
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

function markBrowserWarmupRequested() {
  try {
    fs.mkdirSync(path.dirname(browserWarmupMarkerPath), { recursive: true });
    fs.writeFileSync(browserWarmupMarkerPath, `${Date.now()}\n`);
  } catch (error) {
    console.warn('[BrowserWarmup] Failed to persist warmup marker:', error);
  }
}

function consumeBrowserWarmupRequest() {
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

function collectOpenClawPackageRoots() {
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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

async function ensureOpenClawShellEntrypoint(resolvedExecutablePath: string) {
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

async function ensureResolvedOpenClawExecutablePath(preferredRepairVersion?: string | null) {
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

async function readOpenClawVersion() {
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

function buildGatewayProbeCacheKey(params: {
  gatewayUrl: string;
  token?: string;
  password?: string;
}) {
  return JSON.stringify({
    gatewayUrl: normalizeCliText(params.gatewayUrl),
    token: normalizeCliText(params.token) || '',
    password: normalizeCliText(params.password) || '',
  });
}

type GatewayConnectionProbeResult = {
  connected: boolean;
  message?: string;
  source: 'local-runtime' | 'auth-probe' | 'active-session';
};

async function probeGatewayConnectionStatus(params: {
  gatewayUrl: string;
  token?: string;
  password?: string;
}, options: {
  preferLocalHealth?: boolean;
  allowRpcProbe?: boolean;
} = {}): Promise<GatewayConnectionProbeResult> {
  const allowRpcProbe = options.allowRpcProbe !== false;
  const probeKey = [
    buildGatewayProbeCacheKey(params),
    `preferLocalHealth=${options.preferLocalHealth ? '1' : '0'}`,
    `allowRpcProbe=${allowRpcProbe ? '1' : '0'}`,
  ].join('|');
  const now = Date.now();
  if (
    cachedGatewayProbeKey === probeKey
    && cachedGatewayProbeResult
    && (now - cachedGatewayProbeResult.checkedAt) <= OPENCLAW_GATEWAY_READY_RESULT_CACHE_TTL_MS
  ) {
    return cachedGatewayProbeResult.result;
  }

  const inflightProbe = gatewayProbeInflight.get(probeKey);
  if (inflightProbe) {
    return inflightProbe;
  }

  const probePromise: Promise<GatewayConnectionProbeResult> = (async () => {
    const gatewayTarget = parseGatewayUrlForStatusProbe(params.gatewayUrl);
    const isLocalGatewayTarget = gatewayTarget ? isLocalGatewayHostname(gatewayTarget.hostname) : false;
    let localHealthFailureMessage: string | null = null;
    let localHealthOk = false;

    if (isLocalGatewayTarget) {
      const health = await probeGatewayHealth(params.gatewayUrl);
      if (!health.ok) {
        // Older OpenClaw builds may not respond to /health reliably.
        // Fall back to a real gateway RPC probe before declaring disconnected.
        localHealthFailureMessage = health.message || 'Local OpenClaw gateway is not responding';
      } else {
        localHealthOk = true;
      }

      const credentialMatches = evaluateLocalGatewayCredentialMatch(params, gatewayTarget);
      if (credentialMatches === false) {
        return {
          connected: false,
          message: 'Gateway credentials do not match local OpenClaw config',
          source: 'local-runtime',
        };
      }

      if (options?.preferLocalHealth && localHealthOk) {
        return {
          connected: true,
          message: 'Local OpenClaw gateway ready',
          source: 'local-runtime',
        };
      }

      if (!allowRpcProbe) {
        return {
          connected: localHealthOk,
          message: localHealthOk
            ? 'Local OpenClaw gateway ready'
            : (localHealthFailureMessage || 'Local OpenClaw gateway is not responding'),
          source: 'local-runtime',
        };
      }
    } else if (!allowRpcProbe) {
      return {
        connected: false,
        message: 'Gateway HTTP health probe is only available for a local OpenClaw gateway.',
        source: 'auth-probe',
      };
    }

    const attemptGatewayReadyProbe = async (options?: {
      totalTimeoutMs?: number;
      stepTimeoutMs?: number;
    }): Promise<GatewayConnectionProbeResult> => {
      const client = new OpenClawClient({
        gatewayUrl: params.gatewayUrl,
        token: params.token,
        password: params.password,
      });
      client.on('error', () => {});
      let timeoutId: NodeJS.Timeout | null = null;

      try {
        await Promise.race([
          client.getGatewayStatus(options?.stepTimeoutMs ?? OPENCLAW_GATEWAY_READY_PROBE_STEP_TIMEOUT_MS),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('Gateway readiness probe timeout')),
              options?.totalTimeoutMs ?? OPENCLAW_GATEWAY_READY_PROBE_TIMEOUT_MS
            );
          }),
        ]);
        return {
          connected: true,
          message: isLocalGatewayTarget
            ? (localHealthFailureMessage
              ? 'Local OpenClaw gateway ready after HTTP health probe failed'
              : 'Local OpenClaw gateway ready')
            : undefined,
          source: isLocalGatewayTarget ? 'local-runtime' : 'auth-probe',
        };
      } catch (error: any) {
        return {
          connected: false,
          message: readCliErrorDetail(error) || error?.message || localHealthFailureMessage || 'Connection failed',
          source: isLocalGatewayTarget ? 'local-runtime' : 'auth-probe',
        };
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        client.disconnect();
      }
    };

    return attemptGatewayReadyProbe();
  })();

  gatewayProbeInflight.set(probeKey, probePromise);
  try {
    const result = await probePromise;
    cachedGatewayProbeKey = probeKey;
    cachedGatewayProbeResult = {
      checkedAt: Date.now(),
      result,
    };
    return result;
  } finally {
    gatewayProbeInflight.delete(probeKey);
  }
}

function readOpenClawConfig(): any | null {
  try {
    const configPath = getOpenClawConfigPath();
    if (!fs.existsSync(configPath)) {
      return null;
    }
    return readOpenClawConfigSafe();
  } catch (error) {
    return null;
  }
}

function writeOpenClawConfig(config: any) {
  const configPath = getOpenClawConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeJsonAtomicSync(configPath, config);
}

function isMaxPermissionsConfigEnabled(config: any): boolean {
  return !config?.tools?.profile && config?.tools?.exec?.security === 'full';
}

function readMaxPermissionsEnabled(): boolean | null {
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

function normalizeConfiguredBrowserProfile(config: any): string {
  return normalizeCliText(config?.browser?.defaultProfile)
    || normalizeCliText(config?.browser?.profile)
    || BROWSER_HEALTH_PROFILE;
}

function applyBrowserRepairSettingsToOpenClawConfig(config: any): boolean {
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

function synchronizeConfiguredBrowserRepairSettings() {
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

function synchronizeConfiguredBrowserRepairSettingsBestEffort() {
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
function readBrowserUnavailableReason(): string | null {
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

function readBrowserHeadedModeConfig(): BrowserHeadedModeConfig {
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

function setBrowserHeadedModeEnabled(headedModeEnabled: boolean): BrowserHeadedModeConfig {
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

function patchExecApprovals(enabled: boolean) {
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

  writeJsonAtomicSync(configPath, config);
  patchExecApprovals(enabled);

  return { enabled };
}

async function configureMaxPermissionsState(enabled: boolean, options?: { systemPassword?: string | null }) {
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

setImmediate(() => {
  const maxPermissionsEnabled = readMaxPermissionsEnabled() === true;
  patchExecApprovals(maxPermissionsEnabled);
  synchronizeOpenClawExecPreflightBypassBestEffort(maxPermissionsEnabled);
  synchronizeOpenClawBrowserFillCompatBestEffort();
  if (maxPermissionsEnabled) {
    synchronizeConfiguredBrowserRepairSettingsBestEffort();
    warmManagedHostToolingInBackground();
  }
});

async function runOpenClawBrowserCommand(args: string[], timeoutMs: number) {
  const executablePath = await ensureResolvedOpenClawExecutablePath();
  return execFilePromise(executablePath, ['browser', ...args], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

async function refreshOpenClawPluginRegistryForBrowserSelfHeal() {
  const executablePath = await ensureResolvedOpenClawExecutablePath();
  await execFilePromise(executablePath, ['plugins', 'registry', '--refresh'], {
    timeout: BROWSER_SELF_HEAL_PLUGIN_REGISTRY_REFRESH_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
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

async function stopOpenClawBrowserBestEffort() {
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

async function resetOpenClawBrowserProfile() {
  const browserConfig = readBrowserConfigState();
  await runOpenClawBrowserCommand(
    buildBrowserProfileArgs(browserConfig, ['--timeout', String(BROWSER_SELF_HEAL_RESET_PROFILE_TIMEOUT_MS), 'reset-profile']),
    BROWSER_SELF_HEAL_RESET_PROFILE_TIMEOUT_MS + 3000
  );
}

function shouldRetryBrowserRepairWithProfileReset(lastKnownIssue: BrowserHealthIssue | null) {
  const browserConfig = readBrowserConfigState();
  if (browserConfig.attachOnly === true) {
    return false;
  }

  return lastKnownIssue === 'detect-error'
    || lastKnownIssue === 'timeout'
    || lastKnownIssue === 'unknown';
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type BrowserTaskProgressReporter = (phase: string, rawDetail?: string | null) => void;

type BrowserRuntimeReadiness = {
  ready: boolean;
  terminalFailure: boolean;
  diagnostics: BrowserHealthDiagnostics;
  detail: string | null;
};

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

async function readOpenClawGatewayServiceRuntimeState() {
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

function isGatewayRuntimeStateKnown(runtimeState: OpenClawGatewayServiceRuntimeState) {
  return runtimeState.execMainPid !== null
    || runtimeState.activeState !== null
    || runtimeState.subState !== null
    || runtimeState.activeEnterTimestampMonotonic !== null
    || runtimeState.execMainStartTimestampMonotonic !== null
    || runtimeState.stateChangeTimestampMonotonic !== null;
}

async function probeGatewayRestartReadinessStatus() {
  return probeGatewayConnectionStatus(buildGatewayStatusProbeParams(), {
    preferLocalHealth: true,
    allowRpcProbe: false,
  });
}

function getGatewayRestartStableWindowMs(trigger: GatewayRestartTrigger | null) {
  return trigger === 'gateway'
    ? OPENCLAW_GATEWAY_MANUAL_RESTART_STABLE_WINDOW_MS
    : OPENCLAW_GATEWAY_RESTART_STABLE_WINDOW_MS;
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

function buildUpdateCommand(targetPort: string) {
  return `set -o pipefail; curl -fsSL ${JSON.stringify(UPDATE_SCRIPT_URL)} | bash -s -- ${JSON.stringify(targetPort)}`;
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

/**
 * 只读展示路径上取 agent 模型名：配置读不动时退回 `undefined`，**并出声**。
 *
 * 为什么需要它（Gemini 评审 CRITICAL，本机复现）：`readConfigFile()` 三态化之后
 * `readAgentModel()` 从「永不抛」变成「会抛」，而 `reconcileInactiveGroupLatestMessage()`
 * 里的两处调用是裸的，外层 `app.get('/api/groups/:id/messages')` 只有一个笼统的
 * `catch → 500`。净效果是**把一条本来能用的接口改坏了**：
 * 改动前 `null || undefined` 兜得住、群消息列表照常返回；改动后配置一坏，
 * 整个群的历史消息打不开。这比本 sprint 要修的原始 bug 更糟。
 *
 * 这里退回旧语义，但不静默——红线 C 管的是「失败要出声」，不是「失败必须致命」。
 * 模型名只是消息上的一个标签，为它牺牲整条历史是错误的取舍。
 */
function readAgentModelForDisplay(agentId: string): string | undefined {
  try {
    return agentProvisioner.readAgentModel(agentId) || undefined;
  } catch (error) {
    if (!(error instanceof ConfigReadError)) throw error;
    console.warn(
      `[GroupMessages] 取模型名失败（${error.reason}），该条消息的模型标签留空：agentId=${agentId}`,
    );
    return undefined;
  }
}

/**
 * 在「已经在报错」的路径里，给结构化错误消息挑一个 model 标签用——纯展示用途，
 * 不代表任何"成功"。`readAgentModel()` / `readAvailableModels()` 现在对配置读不动
 * 会抛 ConfigReadError（这正是本 sprint 要的：别把「读不动」伪装成「没有模型」），
 * 但这里已经在 catch 块里构建一条错误消息了——这个调用点自己再抛一次不会让用户
 * 看到更多信息，只会让本该发出的错误响应发不出去（这个 catch 块之外没人再兜底）。
 * 所以这里显式吞掉 ConfigReadError，退回到空字符串。
 */
function resolveModelTagForErrorReport(agentProvisioner: AgentProvisioner, agentId: string): string {
  try {
    return agentProvisioner.readAgentModel(agentId)
      || agentProvisioner.readAvailableModels().find(m => m.primary)?.id
      || '';
  } catch (err) {
    if (err instanceof ConfigReadError) return '';
    throw err;
  }
}

/**
 * 纯展示型只读接口（GET /api/sessions、/api/characters、/api/sessions/:id/configs、
 * GET /api/models）不该因为"模型标签读不到"就整条 500——用户还是要能打开列表看到
 * 别的字段。同 `resolveModelTagForErrorReport()` 一样显式吞掉 ConfigReadError，
 * 退回调用方给的退化值，但额外报出 `configReadFailed`，让前端能分辨出
 * "这不是没配模型，是配置读不动"，不把两者混成一件事。
 */
function withConfigReadFallback<T>(fallback: T, read: () => T): { value: T; configReadFailed: boolean } {
  try {
    return { value: read(), configReadFailed: false };
  } catch (err) {
    if (err instanceof ConfigReadError) return { value: fallback, configReadFailed: true };
    throw err;
  }
}

// `readAgentRuntimeConfig()`（`readEffectiveAgentRuntimeSettings()` 内部调它）在配置
// 损坏时也会抛 ConfigReadError——和 model 字段是同一类"读不动"，同样不该让这几个只读
// 接口整体 500。退化形状照抄它自己对"配置文件不存在"这个合法状态给出的默认值。
const RUNTIME_SETTINGS_CONFIG_READ_FALLBACK = { systemPromptMode: 'system' as const, toolMode: 'full' as const };

function createStructuredChatError(rawDetail?: string | null, forcedCode?: string) {
  const detail = typeof rawDetail === 'string' && rawDetail.trim() ? rawDetail.trim() : 'Unknown error';
  const messageCode = forcedCode
    || (detail === CHAT_GATEWAY_DISCONNECTED_DETAIL
      ? CHAT_GATEWAY_DISCONNECTED_CODE
      : CHAT_RUN_ERROR_CODE);

  return {
    content: `${CHAT_RUN_ERROR_PREFIX}${detail}`,
    messageCode,
    messageParams: undefined as StructuredMessageParams | undefined,
    rawDetail: detail,
    role: 'system' as const,
    agent_id: 'system',
    agent_name: 'System',
  };
}

function resolveStructuredChatErrorInput(error: any): { rawDetail: string | null; messageCode?: string } {
  const rawDetail = typeof error?.rawDetail === 'string' && error.rawDetail.trim()
    ? error.rawDetail.trim()
    : (typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : null);

  const messageCode = typeof error?.messageCode === 'string' && error.messageCode.trim()
    ? error.messageCode.trim()
    : undefined;

  return {
    rawDetail,
    messageCode,
  };
}

function buildStructuredChatHttpError(rawDetail?: string | null, forcedCode?: string) {
  const structured = createStructuredChatError(rawDetail, forcedCode);
  return {
    success: false as const,
    message: structured.content,
    error: structured.content,
    messageCode: structured.messageCode,
    messageParams: structured.messageParams || null,
    rawDetail: structured.rawDetail,
    role: structured.role,
  };
}

function buildStructuredChatErrorStreamEvent(structuredError: ReturnType<typeof createStructuredChatError>) {
  return {
    type: 'error',
    text: structuredError.content,
    messageCode: structuredError.messageCode,
    messageParams: structuredError.messageParams,
    rawDetail: structuredError.rawDetail,
    role: structuredError.role,
  };
}

function getStructuredChatMessage(content?: string | null) {
  if (!content || !content.startsWith(CHAT_RUN_ERROR_PREFIX)) return {};

  const detail = content.slice(CHAT_RUN_ERROR_PREFIX.length).trim();
  if (!detail) return {};

  return {
    messageCode: detail === CHAT_GATEWAY_DISCONNECTED_DETAIL
      ? CHAT_GATEWAY_DISCONNECTED_CODE
      : CHAT_RUN_ERROR_CODE,
    messageParams: undefined as StructuredMessageParams | undefined,
    rawDetail: detail,
    role: 'system' as const,
    agent_id: 'system',
    agent_name: 'System',
  };
}

function withStructuredGroupMessage<T extends {
  content?: string | null;
  process_content?: string | null;
  process_streaming?: boolean | null;
  messageCode?: string;
  messageParams?: StructuredMessageParams | null;
  rawDetail?: string | null;
  sender_id?: string | null;
  sender_name?: string | null;
}>(
  message: T,
  options?: { groupId?: string | null }
): T & {
  messageCode?: string;
  messageParams?: StructuredMessageParams;
  rawDetail?: string | null;
  sender_id?: string | null;
  sender_name?: string | null;
  process_content?: string | null;
  process_streaming?: boolean | null;
} {
  const content = typeof message.content === 'string'
    ? rewriteOpenClawMediaPaths(message.content, options?.groupId ? getGroupWorkspacePath(options.groupId) : undefined)
    : message.content;
  const processContent = typeof message.process_content === 'string'
    ? rewriteOpenClawMediaPaths(message.process_content, options?.groupId ? getGroupWorkspacePath(options.groupId) : undefined)
    : message.process_content;
  const structured = getStructuredGroupMessage(content);
  return {
    ...message,
    content,
    process_content: processContent,
    messageCode: message.messageCode ?? structured.messageCode,
    messageParams: message.messageParams ?? structured.messageParams,
    rawDetail: message.rawDetail ?? structured.rawDetail,
    sender_id: structured.forceSystemMessage ? 'system' : (message.sender_id ?? null),
    sender_name: structured.forceSystemMessage ? '系统' : (message.sender_name ?? null),
  };
}

function withStructuredChatMessage<T extends { content?: string | null; process_content?: string | null; process_streaming?: boolean | number | null; role?: 'user' | 'assistant' | 'system'; messageCode?: string; messageParams?: StructuredMessageParams | null; rawDetail?: string | null; agent_id?: string | null; agent_name?: string | null }>(
  message: T,
  options?: { sessionId?: string | null }
): T & { process_content?: string | null; process_streaming?: boolean | number | null; role?: 'user' | 'assistant' | 'system'; messageCode?: string; messageParams?: StructuredMessageParams; rawDetail?: string | null; agent_id?: string | null; agent_name?: string | null } {
  const content = typeof message.content === 'string'
    ? rewriteOpenClawMediaPaths(message.content, options?.sessionId ? getSessionWorkspacePath(options.sessionId) : undefined)
    : message.content;
  const processContent = typeof message.process_content === 'string'
    ? rewriteOpenClawMediaPaths(message.process_content, options?.sessionId ? getSessionWorkspacePath(options.sessionId) : undefined)
    : message.process_content;
  const processStreaming = Boolean(message.process_streaming);
  const structured = getStructuredChatMessage(content);
  return {
    ...message,
    content,
    process_content: processContent,
    process_streaming: structured.messageCode ? false : processStreaming,
    role: structured.role ?? message.role,
    messageCode: message.messageCode ?? structured.messageCode,
    messageParams: message.messageParams ?? structured.messageParams,
    rawDetail: message.rawDetail ?? structured.rawDetail,
    agent_id: structured.agent_id ?? (message.agent_id ?? null),
    agent_name: structured.agent_name ?? (message.agent_name ?? null),
  };
}

function resolveGroupMemberDisplayName(member: { agent_id: string; display_name: string }): string {
  const linkedSession = db.getSessionByAgentId(member.agent_id) || db.getSession(member.agent_id);
  const latestName = linkedSession?.name?.trim();
  return latestName || member.display_name;
}

function withResolvedGroupMemberDisplayName<T extends { agent_id: string; display_name: string }>(member: T): T {
  const latestName = resolveGroupMemberDisplayName(member);
  return latestName === member.display_name ? member : { ...member, display_name: latestName };
}

function parsePositiveIntegerQueryParam(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getHistoryPageQueryParams(query: Record<string, unknown>) {
  const beforeId = parsePositiveIntegerQueryParam(query.beforeId);
  const requestedLimit = parsePositiveIntegerQueryParam(query.limit);
  const limit = Math.min(requestedLimit ?? DEFAULT_HISTORY_PAGE_LIMIT, MAX_HISTORY_PAGE_LIMIT);
  return { beforeId, limit };
}

function buildHistoryPageResponse<T>(rows: T[], pageInfo: MessagePageInfo) {
  return {
    success: true as const,
    messages: rows,
    pageInfo,
  };
}

function buildHistorySearchResponse(matches: MessageSearchMatch[]) {
  return {
    success: true as const,
    matches: matches.map((match) => ({
      messageId: String(match.id),
      anchorBeforeId: match.anchorBeforeId ?? null,
    })),
  };
}

function repairLegacyGroupMessageRoots() {
  for (const group of db.getGroupChats()) {
    const rootIds = db.getGroupRootMessageIds(group.id);
    if (rootIds.length <= 1) continue;

    for (const rootId of rootIds.slice(1)) {
      const previousMessageId = db.getLatestGroupMessageId(group.id, rootId);
      if (!previousMessageId) continue;

      db.updateGroupMessageParent(rootId, previousMessageId);
      console.log(`[Startup] Repaired extra group root ${group.id}:${rootId} -> parent ${previousMessageId}`);
    }
  }
}

// Auto-heal legacy group members that stored session IDs instead of OpenClaw agent IDs.
// This mainly affects the default "main" session whose session ID is random but agentId is "main".
for (const group of db.getGroupChats()) {
  for (const member of db.getGroupMembers(group.id)) {
    const linkedSession = db.getSession(member.agent_id);
    if (linkedSession && linkedSession.agentId && linkedSession.agentId !== member.agent_id) {
      db.updateGroupMemberAgentId(member.id, linkedSession.agentId);
      console.log(`[Startup] Repaired group member ${member.id}: ${member.agent_id} -> ${linkedSession.agentId}`);
    }
  }
}

repairLegacyGroupMessageRoots();

// Ensure main agent workspace is registered in openclaw.json at startup
const mainRegistered = agentProvisioner.ensureMainAgent();
if (mainRegistered) {
  console.log('[Startup] Main agent workspace registered in openclaw.json');
}

const connections = new Map<string, OpenClawClient>();

function getActiveGatewayConnectionStatus(): GatewayConnectionProbeResult | null {
  const activeConnectionCount = Array.from(connections.values())
    .filter((client) => client.isConnected())
    .length;

  if (activeConnectionCount === 0) {
    return null;
  }

  return {
    connected: true,
    message: `OpenClaw gateway has ${activeConnectionCount} active session connection${activeConnectionCount === 1 ? '' : 's'}`,
    source: 'active-session',
  };
}

for (const group of db.getGroupChats()) {
  try {
    cleanupLegacyGroupRuntimeArtifacts(group.id);
    removeGroupWorkspaceBootstrapFiles(group.id);
  } catch (error) {
    console.error(`[Startup] Failed to cleanup legacy runtime artifacts for group ${group.id}:`, error);
  }
}

// LibreOffice detection
let hasLibreOffice = false;
const previewCacheDir = path.join(process.env.HOME || '.', '.clawopt_preview_cache');
const previewConversionPromises = new Map<string, Promise<string>>();
fs.mkdirSync(previewCacheDir, { recursive: true });

(async () => {
  try {
    await execPromise('which libreoffice');
    hasLibreOffice = true;
    console.log('[Preview] ✅ LibreOffice detected - high-fidelity preview enabled');
  } catch {
    hasLibreOffice = false;
    console.log('[Preview] ⚠️  LibreOffice not found - using client-side preview fallback');
  }
})();

// Host checking middleware for reverse proxies
app.use((req, res, next) => {
  const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '') as string;
  const hostName = reqHost.split(':')[0]; // get hostname without port
  
  // Allow local connections and pure IPs
  if (!hostName || hostName === 'localhost' || hostName === '127.0.0.1' || net.isIP(hostName)) {
    return next();
  }

  const config = configManager.getConfig();
  const allowedHosts = config.allowedHosts || [];
  
  if (!allowedHosts.includes(hostName)) {
    return res.status(403).send(`Blocked request. This host ("${hostName}") is not allowed.`);
  }
  
  next();
});

// Helper to rewrite outgoing messages: extract /uploads/ images as attachments for the Vision API,
// keep non-image file references as absolute paths in the message text, and inject automatic
// transcripts for referenced audio uploads when this host has a usable audio transcription provider.
async function prepareOutgoingMessage(
  message: string,
  agentId: string,
  options: { includeDocumentToolingContext?: boolean } = {},
): Promise<{ text: string; attachments: { type: string; mimeType: string; content: string }[] }> {
  const workspacePath = agentProvisioner.getWorkspacePath(agentId);
  const absoluteUploadsDir = path.join(workspacePath, 'uploads');
  const rewritten = rewriteMessageWithWorkspaceUploads(message, absoluteUploadsDir, { extractImageAttachments: true });
  const includeDocumentToolingContext = options.includeDocumentToolingContext !== false;
  if (includeDocumentToolingContext && readMaxPermissionsEnabled() === true && hasDocumentUploads(rewritten.linkedUploads)) {
    try {
      await ensureManagedDocumentToolingReady();
    } catch (error) {
      console.error('Failed to prepare managed document tooling runtime for outgoing message:', error);
    }
  }
  const imageInspectionContext = buildImageUploadInspectionContext(rewritten.linkedUploads);
  const documentToolingContext = includeDocumentToolingContext ? buildDocumentToolingContext(rewritten.linkedUploads) : '';
  const transcripts = await prepareAudioTranscriptsFromUploads(rewritten.linkedUploads, agentId);
  const audioTranscriptContext = buildAudioTranscriptContext(transcripts);

  return {
    text: [rewritten.text, imageInspectionContext, documentToolingContext, audioTranscriptContext].filter(Boolean).join('\n\n').trim(),
    attachments: rewritten.attachments,
  };
}

function readEffectiveAgentRuntimeSettings(sessionInfo: SessionRow | undefined, agentId: string): {
  runtimeMode: AgentRuntimeMode;
  systemPromptMode: AgentSystemPromptMode;
  toolMode: AgentToolMode;
} {
  const openClawRuntime = agentProvisioner.readAgentRuntimeConfig(agentId);
  return {
    runtimeMode: normalizeAgentRuntimeMode(sessionInfo?.runtime_mode),
    systemPromptMode: openClawRuntime.systemPromptMode,
    toolMode: openClawRuntime.toolMode,
  };
}

function shouldInjectHostTakeoverInstruction(sessionInfo: SessionRow | undefined, agentId: string): boolean {
  if (readMaxPermissionsEnabled() !== true) return false;
  const runtimeSettings = readEffectiveAgentRuntimeSettings(sessionInfo, agentId);
  if (runtimeSettings.runtimeMode === 'direct') return false;
  return runtimeSettings.toolMode === 'full' || runtimeSettings.toolMode === 'coding';
}

function buildDirectChatRequestUrl(endpoint: ImageGenerationEndpointModelSnapshot): string {
  return `${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function buildDirectModelRequestHeaders(endpoint: ImageGenerationEndpointModelSnapshot): Record<string, string> {
  const headers: Record<string, string> = {
    ...(endpoint.headers || {}),
    'Content-Type': 'application/json',
  };

  const authHeader = endpoint.authHeader || 'Authorization';
  if (!hasHeader(headers, authHeader)) {
    headers[authHeader] = authHeader.toLowerCase() === 'authorization'
      ? `Bearer ${endpoint.apiKey}`
      : endpoint.apiKey;
  }

  return headers;
}

function sanitizeDirectModelErrorDetail(detail: string, endpoint?: ImageGenerationEndpointModelSnapshot): string {
  const normalized = normalizeCliText(detail);
  if (!normalized) return 'Direct model request failed.';

  let sanitized = normalized;
  const secret = endpoint?.apiKey;
  if (secret && secret.length >= 6) {
    sanitized = sanitized.split(secret).join('[redacted]');
  }

  return sanitized.length > 2000 ? `${sanitized.slice(0, 2000)}...` : sanitized;
}

async function readDirectModelErrorDetail(response: Response, endpoint: ImageGenerationEndpointModelSnapshot): Promise<string> {
  const bodyText = await response.text().catch(() => '');
  let bodyDetail = bodyText.trim();
  try {
    const parsed = JSON.parse(bodyText);
    bodyDetail = normalizeCliText(parsed?.error?.message)
      || normalizeCliText(parsed?.message)
      || normalizeCliText(parsed?.detail)
      || normalizeCliText(parsed?.error)
      || bodyDetail;
  } catch {}

  return sanitizeDirectModelErrorDetail(
    `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${bodyDetail ? ` - ${bodyDetail}` : ''}`,
    endpoint,
  );
}

function normalizeDirectModelText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (typeof (value as any)?.text === 'string') return (value as any).text;
  if (typeof (value as any)?.content === 'string') return (value as any).content;
  return '';
}

function extractDirectModelDeltaText(payload: any): string {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  return normalizeDirectModelText(choice?.delta?.content)
    || normalizeDirectModelText(choice?.message?.content)
    || normalizeDirectModelText(payload?.delta?.content)
    || normalizeDirectModelText(payload?.content);
}

function buildDirectChatMessages(params: {
  sessionId: string;
  agentId: string;
  userMessageId: number;
  assistantMessageId: number;
  currentUserText: string;
  attachments: { type: string; mimeType: string; content: string }[];
}): Array<{ role: 'system' | 'user' | 'assistant'; content: any }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [];
  const systemPrompt = agentProvisioner.buildAgentSystemPromptOverride(params.agentId).trim();
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  const history = db.getMessages(params.sessionId, 40);
  for (const row of history) {
    if (row.id === params.assistantMessageId) continue;
    if (row.role !== 'user' && row.role !== 'assistant') continue;

    let content = row.id === params.userMessageId ? params.currentUserText : row.content;
    content = normalizeCliText(content);
    if (!content) continue;

    if (row.role === 'user' && row.id === params.userMessageId && params.attachments.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: content },
          ...params.attachments
            .filter((attachment) => attachment.type === 'image' && attachment.content)
            .map((attachment) => ({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType || 'image/png'};base64,${attachment.content}`,
              },
            })),
        ],
      });
      continue;
    }

    messages.push({ role: row.role, content });
  }

  return messages;
}

async function runDirectChatCompletion(params: {
  sessionId: string;
  agentId: string;
  userMessageId: number;
  assistantMessageId: number;
  message: string;
  modelUsed: string;
  response: ExpressResponse;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
  processStartTag?: string;
  processEndTag?: string;
  sessionInterruptionEpoch: number;
}): Promise<void> {
  const endpoint = agentProvisioner.readEndpointModel(params.modelUsed);
  if (!endpoint) {
    throw new Error(`Direct runtime model is not configured: ${params.modelUsed}`);
  }
  if (!endpoint.api.toLowerCase().includes('openai')) {
    throw new Error(`Direct runtime currently supports OpenAI-compatible chat endpoints only: ${endpoint.api}`);
  }

  const outgoingMessage = await prepareOutgoingMessage(params.message, params.agentId, {
    includeDocumentToolingContext: false,
  });
  const messages = buildDirectChatMessages({
    sessionId: params.sessionId,
    agentId: params.agentId,
    userMessageId: params.userMessageId,
    assistantMessageId: params.assistantMessageId,
    currentUserText: outgoingMessage.text,
    attachments: outgoingMessage.attachments,
  });
  if (messages.length === 0) {
    throw new Error('Direct runtime has no message content to send.');
  }

  let rawText = '';
  let lastVisibleText = '';
  let lastVisibleProcessContent = '';
  let lastVisibleProcessStreaming = false;

  const emitSnapshot = (type: 'delta' | 'final') => {
    const split = splitChatProcessOutput(rawText, params.processStartTag, params.processEndTag);
    const visibleText = rewriteOpenClawMediaPaths(split.finalContent, getSessionWorkspacePath(params.sessionId));
    const visibleProcessContent = rewriteOpenClawMediaPaths(split.processContent, getSessionWorkspacePath(params.sessionId));
    const visibleProcessStreaming = type === 'final' ? false : split.processStreaming;
    const changed = visibleText !== lastVisibleText
      || visibleProcessContent !== lastVisibleProcessContent
      || visibleProcessStreaming !== lastVisibleProcessStreaming;

    if (type === 'delta' && !changed) return;

    lastVisibleText = visibleText;
    lastVisibleProcessContent = visibleProcessContent;
    lastVisibleProcessStreaming = visibleProcessStreaming;
    db.updateMessage(params.assistantMessageId, visibleText, params.modelUsed, visibleProcessContent, visibleProcessStreaming);
    const event = {
      type,
      text: visibleText,
      process_content: visibleProcessContent,
      process_streaming: visibleProcessStreaming,
      modelUsed: params.modelUsed,
      model_used: params.modelUsed,
    };
    if (isStreamingClientOpen(params.response)) {
      try {
        params.response.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {}
    }
    params.onEvent?.(event);
  };

  try {
    assertSessionInterruptionEpoch(params.sessionId, params.sessionInterruptionEpoch);
    const response = await fetch(buildDirectChatRequestUrl(endpoint), {
      method: 'POST',
      headers: buildDirectModelRequestHeaders(endpoint),
      body: JSON.stringify({
        model: endpoint.modelName,
        messages,
        stream: true,
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(await readDirectModelErrorDetail(response, endpoint));
    }

    if (!response.body) {
      const payload = await response.json().catch(() => null) as any;
      rawText = normalizeDirectModelText(payload?.choices?.[0]?.message?.content);
      if (!rawText.trim()) {
        throw new Error('Direct runtime returned an empty response.');
      }
      emitSnapshot('final');
      params.response.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      assertSessionInterruptionEpoch(params.sessionId, params.sessionInterruptionEpoch);
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const eventBlock = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of eventBlock.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = extractDirectModelDeltaText(parsed);
            if (delta) {
              rawText += delta;
              emitSnapshot('delta');
            }
          } catch {}
        }

        boundary = buffer.indexOf('\n\n');
      }
    }

    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = extractDirectModelDeltaText(parsed);
          if (delta) rawText += delta;
        } catch {}
      }
    }

    if (!rawText.trim()) {
      throw new Error('Direct runtime returned an empty response.');
    }

    assertSessionInterruptionEpoch(params.sessionId, params.sessionInterruptionEpoch);
    emitSnapshot('final');
    params.response.end();
  } catch (error) {
    throw error;
  }
}

const AGENT_WORKSPACE_RESET_PRESERVED_ROOT_ENTRIES = new Set([
  'AGENTS.md',
  'BOOTSTRAP.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
]);
const AGENT_STATE_RESET_PRESERVED_RELATIVE_FILE_PATHS = [
  path.join('agent', 'auth-profiles.json'),
] as const;
const sessionInterruptionEpochs = new Map<string, number>();

class SessionInterruptedError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was interrupted during processing.`);
    this.name = 'SessionInterruptedError';
  }
}

function getSessionInterruptionEpoch(sessionId: string): number {
  return sessionInterruptionEpochs.get(sessionId) ?? 0;
}

function bumpSessionInterruptionEpoch(sessionId: string): number {
  const nextEpoch = getSessionInterruptionEpoch(sessionId) + 1;
  sessionInterruptionEpochs.set(sessionId, nextEpoch);
  return nextEpoch;
}

function assertSessionInterruptionEpoch(sessionId: string, expectedEpoch: number): void {
  if (getSessionInterruptionEpoch(sessionId) !== expectedEpoch) {
    throw new SessionInterruptedError(sessionId);
  }
}

function disconnectConnection(sessionId: string): void {
  const client = connections.get(sessionId);
  if (!client) return;
  connections.delete(sessionId);
  client.disconnect();
}

function resetAgentWorkspaceToInitialState(workspacePath: string): void {
  fs.mkdirSync(workspacePath, { recursive: true });

  for (const entry of fs.readdirSync(workspacePath, { withFileTypes: true })) {
    if (AGENT_WORKSPACE_RESET_PRESERVED_ROOT_ENTRIES.has(entry.name)) {
      continue;
    }

    fs.rmSync(path.join(workspacePath, entry.name), { recursive: true, force: true });
  }

  fs.mkdirSync(path.join(workspacePath, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'memory'), { recursive: true });
}

function readPreservedAgentStateFiles(agentStatePath: string): Map<string, Buffer> {
  const preservedFiles = new Map<string, Buffer>();

  for (const relativePath of AGENT_STATE_RESET_PRESERVED_RELATIVE_FILE_PATHS) {
    const absolutePath = path.join(agentStatePath, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    try {
      if (fs.statSync(absolutePath).isFile()) {
        preservedFiles.set(relativePath, fs.readFileSync(absolutePath));
      }
    } catch {}
  }

  return preservedFiles;
}

function restorePreservedAgentStateFiles(agentStatePath: string, preservedFiles: Map<string, Buffer>): void {
  for (const [relativePath, fileContent] of preservedFiles) {
    const absolutePath = path.join(agentStatePath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, fileContent);
  }
}

function resetAgentRuntimeStateToInitialState(agentId: string): void {
  disconnectConnection(agentId);

  const agentStatePath = getAgentStatePath(agentId);
  const preservedFiles = readPreservedAgentStateFiles(agentStatePath);
  if (fs.existsSync(agentStatePath)) {
    fs.rmSync(agentStatePath, { recursive: true, force: true });
  }
  restorePreservedAgentStateFiles(agentStatePath, preservedFiles);

  const memoryDbPath = getAgentMemoryDbPath(agentId);
  if (fs.existsSync(memoryDbPath)) {
    fs.rmSync(memoryDbPath, { force: true });
  }
}

/**
 * `sessionFilePath` 来自 `sessions.json` **里面的一个字段**，不是我们构造的路径。
 *
 * 第五轮对抗测试正是从这里进来的，而它揭示的判据比前几轮都更普适：
 * **闸门守的是容器，守不住那只从容器里伸出来指向别处的手。**
 * `sessions.json` 本身已经过网关了，但它内容里的那个路径没有——
 * 在那儿放一个命名管道，发一条群消息就让整个后端永久挂住：
 * 端口还 LISTEN、日志一声不吭、要 kill -9
 * （栈：`node::fs::ReadFileUtf8 → uv_fs_open → open`）。而默认安装不开登录，匿名可达。
 *
 * 判据因此不是「这个文件是不是配置」，而是「**这个路径是不是数据给的**」。
 * 凡是数据给的路径，都要过闸门。
 */
function readRuntimeSessionCwd(sessionFilePath: string): string | null {
  if (!fs.existsSync(sessionFilePath)) return null;

  try {
    const read = readTextFileSafe(sessionFilePath);
    if (!read.exists) return null;
    const firstLine = (read.value as string).split('\n')[0]?.trim();
    if (!firstLine) return null;
    const payload = JSON.parse(firstLine);
    return typeof payload?.cwd === 'string' ? payload.cwd : null;
  } catch {
    return null;
  }
}

function runtimeAgentSessionsNeedWorkspaceReset(agentId: string, workspacePath: string): boolean {
  const sessionsDir = path.join(getAgentStatePath(agentId), 'sessions');
  if (!fs.existsSync(sessionsDir)) return false;

  const expectedWorkspace = path.resolve(workspacePath);
  const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');

  if (fs.existsSync(sessionsJsonPath)) {
    try {
      const sessionsRead = readJsonConfigSafe(sessionsJsonPath);
      const payload = sessionsRead.exists ? (sessionsRead.value as any) : null;
      for (const record of Object.values(payload || {})) {
        if (!record || typeof record !== 'object') continue;

        const workspaceDir = typeof (record as { workspaceDir?: unknown }).workspaceDir === 'string'
          ? path.resolve((record as { workspaceDir: string }).workspaceDir)
          : null;
        if (workspaceDir && workspaceDir !== expectedWorkspace) {
          return true;
        }

        const sessionFile = typeof (record as { sessionFile?: unknown }).sessionFile === 'string'
          ? (record as { sessionFile: string }).sessionFile
          : null;
        if (sessionFile && !fs.existsSync(sessionFile)) {
          return true;
        }
        const cwd = sessionFile ? readRuntimeSessionCwd(sessionFile) : null;
        if (cwd && path.resolve(cwd) !== expectedWorkspace) {
          return true;
        }
      }
    } catch {
      return true;
    }
  }

  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const cwd = readRuntimeSessionCwd(path.join(sessionsDir, entry.name));
    if (cwd && path.resolve(cwd) !== expectedWorkspace) {
      return true;
    }
  }

  return false;
}

function resetRuntimeAgentSessions(agentId: string): void {
  disconnectConnection(agentId);

  const sessionsDir = path.join(getAgentStatePath(agentId), 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
}

// Rewrite absolute local file paths in AI responses to HTTP-accessible download URLs
function getSessionWorkspacePath(sessionId: string): string {
  const sessionInfo = sessionManager.getSession(sessionId);
  const agentId = sessionInfo?.agentId || 'main';
  return agentProvisioner.getWorkspacePath(agentId);
}

function readAgentBootstrapIntentContext(agentId: string): string {
  return readAgentBootstrapContextFromWorkspace(agentProvisioner.getWorkspacePath(agentId));
}

function buildOpenClawChatSessionKey(sessionId: string, agentId: string): string {
  return sessionId.startsWith('agent:') ? sessionId : `agent:${agentId}:chat:${sessionId}`;
}

function cleanupChatProcessText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findTrailingIncompleteChatProcessTagFragment(content: string, tag?: string): string {
  const normalizedTag = tag?.trim() || '';
  if (!content || !normalizedTag || content.endsWith(normalizedTag)) {
    return '';
  }

  const minFragmentLength = Math.min(3, Math.max(1, normalizedTag.length - 1));
  const maxFragmentLength = Math.min(content.length, normalizedTag.length - 1);

  for (let length = maxFragmentLength; length >= minFragmentLength; length -= 1) {
    const fragment = normalizedTag.slice(0, length);
    if (content.endsWith(fragment)) {
      return fragment;
    }
  }

  return '';
}

function stripChatProcessTagArtifacts(
  content: string,
  processStartTag?: string,
  processEndTag?: string,
): string {
  if (!content) return content;

  const tags = [processStartTag?.trim(), processEndTag?.trim()]
    .filter((tag): tag is string => Boolean(tag));
  let cleanedContent = content.replace(/\r\n?/g, '\n');

  for (const tag of tags) {
    cleanedContent = cleanedContent.replace(new RegExp(escapeRegExpForPattern(tag), 'g'), '');
  }

  cleanedContent = cleanedContent
    .split('\n')
    .map((line) => {
      let nextLine = line;

      while (true) {
        const startFragment = findTrailingIncompleteChatProcessTagFragment(nextLine, processStartTag);
        const endFragment = findTrailingIncompleteChatProcessTagFragment(nextLine, processEndTag);
        const fragment = startFragment.length >= endFragment.length ? startFragment : endFragment;

        if (!fragment) {
          return nextLine;
        }

        nextLine = nextLine
          .slice(0, nextLine.length - fragment.length)
          .replace(/[ \t]+$/g, '');
      }
    })
    .join('\n');

  return cleanupChatProcessText(cleanedContent);
}

function splitChatProcessOutput(
  content: string,
  processStartTag?: string,
  processEndTag?: string,
): SplitChatProcessOutputResult {
  const normalizedContent = content.replace(/\r\n?/g, '\n');
  const startTag = processStartTag?.trim();
  const endTag = processEndTag?.trim();

  if (!normalizedContent || !startTag || !endTag) {
    return {
      finalContent: stripChatProcessTagArtifacts(cleanupChatProcessText(normalizedContent), processStartTag, processEndTag),
      processContent: '',
      processStreaming: false,
    };
  }

  const startPattern = escapeRegExpForPattern(startTag);
  const endPattern = escapeRegExpForPattern(endTag);
  const processRegex = new RegExp(`${startPattern}([\\s\\S]*?)(?:${endPattern}|$)`, 'g');
  const processBlocks: string[] = [];
  let processStreaming = false;
  let match: RegExpExecArray | null;

  while ((match = processRegex.exec(normalizedContent)) !== null) {
    processBlocks.push(match[1] || '');
    if (!match[0].endsWith(endTag)) {
      processStreaming = true;
    }
  }

  if (processBlocks.length === 0) {
    return {
      finalContent: stripChatProcessTagArtifacts(cleanupChatProcessText(normalizedContent), processStartTag, processEndTag),
      processContent: '',
      processStreaming: false,
    };
  }

  const processContent = stripChatProcessTagArtifacts(
    cleanupChatProcessText(processBlocks.join('\n\n')),
    processStartTag,
    processEndTag,
  );
  const finalContent = stripChatProcessTagArtifacts(
    cleanupChatProcessText(
      normalizedContent
        .replace(processRegex, '\n\n')
        .replace(new RegExp(`(?:${startPattern}|${endPattern})`, 'g'), '\n\n'),
    ),
    processStartTag,
    processEndTag,
  );

  return {
    finalContent,
    processContent,
    processStreaming,
  };
}

function combineChatProcessContent(toolContent: string, modelContent: string): string {
  return [toolContent, modelContent]
    .map((value) => cleanupChatProcessText(value || ''))
    .filter(Boolean)
    .join('\n\n');
}

function rewriteOpenClawMediaPaths(text: string, workspacePath?: string): string {
  return rewriteVisibleFileLinks(text, { workspacePath });
}

function getGroupWorkspaceForDisplay(groupId: string): string {
  return getGroupWorkspacePath(groupId);
}

type UploadTarget = {
  contextType: 'session' | 'group';
  sessionKey: string;
  workspacePath: string;
  uploadsPath: string;
  agentId?: string;
  groupId?: string;
};

function createGroupIdValidationError(rawId: unknown): StructuredRequestError {
  const validation = validateGroupId(rawId);
  switch (validation.issue) {
    case 'required':
      return new StructuredRequestError(400, GROUP_ID_REQUIRED_ERROR_CODE);
    case 'whitespace':
      return new StructuredRequestError(400, GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE);
    default:
      return new StructuredRequestError(400, GROUP_ID_INVALID_ERROR_CODE, null, {
        groupId: validation.normalizedId || String(rawId || ''),
      });
  }
}

function resolveUploadTargetFromBody(body: Record<string, unknown> | undefined): UploadTarget {
  const contextType = typeof body?.contextType === 'string' ? body.contextType.trim() : '';
  const rawGroupId = typeof body?.groupId === 'string' ? body.groupId : '';

  if (contextType === 'group' || rawGroupId) {
    const validation = validateGroupId(rawGroupId);
    if (validation.issue) {
      throw createGroupIdValidationError(rawGroupId);
    }

    const groupId = validation.normalizedId;
    const group = db.getGroupChat(groupId);
    if (!group) {
      throw new StructuredRequestError(404, GROUP_NOT_FOUND_ERROR_CODE, null, { groupId });
    }

    const { workspacePath, uploadsPath } = ensureGroupWorkspace(groupId);
    return {
      contextType: 'group',
      sessionKey: groupId,
      workspacePath,
      uploadsPath,
      groupId,
    };
  }

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const sessionInfo = sessionManager.getSession(sessionId);
  const agentId = sessionInfo?.agentId || 'main';
  const workspacePath = agentProvisioner.getWorkspacePath(agentId);

  return {
    contextType: 'session',
    sessionKey: sessionId,
    workspacePath,
    uploadsPath: path.join(workspacePath, 'uploads'),
    agentId,
  };
}

function removeStoredFilesFromDisk(files: StoredFileRow[]): void {
  for (const file of files) {
    if (!file.stored_path) continue;
    try {
      if (fs.existsSync(file.stored_path)) {
        fs.rmSync(file.stored_path, { force: true });
      }
    } catch (error) {
      console.error(`[Files] Failed to remove stored file ${file.stored_path}:`, error);
    }
  }
}

function clearStoredFilesBySessionKey(sessionKey: string): void {
  const files = db.getFilesBySession(sessionKey);
  removeStoredFilesFromDisk(files);
  db.deleteFilesBySession(sessionKey);
}

type GroupReconciliationAction =
  | { type: 'delete'; id: number; parent_id: number | null }
  | {
      type: 'edit';
      data: {
        groupId: string;
        id: number;
        parent_id: number | null;
        sender_type: 'agent';
        sender_id: string;
        sender_name: string;
        content: string;
        model_used?: string;
        messageCode?: string;
        messageParams?: StructuredMessageParams;
        rawDetail?: string;
        created_at: string;
      };
    };

const DEFAULT_PROCESS_START_TAG = '[执行工作_Start]';
const DEFAULT_PROCESS_END_TAG = '[执行工作_End]';
const GROUP_RECONCILIATION_RETRY_COOLDOWN_MS = 8000;
const groupReconciliationInFlight = new Map<string, Promise<GroupReconciliationAction[]>>();
const groupReconciliationCooldown = new Map<string, { fingerprint: string; attemptedAt: number }>();

function escapeRegExpForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getGroupReconciliationFingerprint(
  latestMessageId: number,
  currentContent: string,
  sourceAgentId: string,
  staleMessageIds: number[],
  isFailureRecovery: boolean,
): string {
  const normalized = currentContent.trim();
  const head = normalized.slice(0, 120);
  const tail = normalized.length > 120 ? normalized.slice(-120) : normalized;
  const staleIdsKey = staleMessageIds.length > 0 ? staleMessageIds.join(',') : '-';
  return [
    latestMessageId,
    sourceAgentId || '-',
    isFailureRecovery ? 'failure' : 'history',
    normalized.length,
    staleIdsKey,
    head,
    tail,
  ].join('|');
}

function shouldSkipGroupReconciliation(groupId: string, fingerprint: string): boolean {
  const cached = groupReconciliationCooldown.get(groupId);
  if (!cached) return false;
  if (cached.fingerprint !== fingerprint) return false;
  return (Date.now() - cached.attemptedAt) < GROUP_RECONCILIATION_RETRY_COOLDOWN_MS;
}

function rememberGroupReconciliationAttempt(groupId: string, fingerprint: string): void {
  groupReconciliationCooldown.set(groupId, {
    fingerprint,
    attemptedAt: Date.now(),
  });
}

function createNextGroupRuntimeSessionEpoch(previousEpoch?: number | null): number {
  const current = Date.now();
  const normalizedPrevious = Number.isFinite(previousEpoch as number) ? Math.floor(Number(previousEpoch)) : 0;
  return current > normalizedPrevious ? current : normalizedPrevious + 1;
}

function getGroupRuntimeContext(groupId: string, sourceAgentId: string): {
  runtimeAgentId: string;
  workspacePath: string;
  uploadsPath: string;
  outputPath: string;
} {
  const { workspacePath, uploadsPath, outputPath } = ensureGroupWorkspace(groupId);
  return {
    runtimeAgentId: getGroupRuntimeAgentId(groupId, sourceAgentId),
    workspacePath,
    uploadsPath,
    outputPath,
  };
}

async function readGroupRuntimeHistoryForReconciliation(groupId: string, sourceAgentId: string): Promise<{
  runtimeContext: {
    runtimeAgentId: string;
    workspacePath: string;
    uploadsPath: string;
    outputPath: string;
  };
  history: any[];
}> {
  const runtimeContext = getGroupRuntimeContext(groupId, sourceAgentId);
  const group = db.getGroupChat(groupId);
  const finalSessionKey = `agent:${runtimeContext.runtimeAgentId}:chat:${getGroupRuntimeSessionKey(groupId, group?.runtime_session_epoch)}`;

  try {
    const client = await getConnection(runtimeContext.runtimeAgentId);
    const history = await client.getChatHistory(finalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
    return { runtimeContext, history };
  } catch (error) {
    const preparedRuntimeContext = await prepareGroupRuntimeAgent(groupId, sourceAgentId);
    const preparedGroup = db.getGroupChat(groupId);
    const preparedFinalSessionKey = `agent:${preparedRuntimeContext.runtimeAgentId}:chat:${getGroupRuntimeSessionKey(groupId, preparedGroup?.runtime_session_epoch)}`;
    const client = await getConnection(preparedRuntimeContext.runtimeAgentId);
    const history = await client.getChatHistory(preparedFinalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
    return { runtimeContext: preparedRuntimeContext, history };
  }
}

function getGroupProcessTagPairs(groupId: string, agentId?: string): Array<{ startTag: string; endTag: string }> {
  const pairs: Array<{ startTag: string; endTag: string }> = [];
  const appendPair = (startTag?: string | null, endTag?: string | null) => {
    const normalizedStart = typeof startTag === 'string' ? startTag.trim() : '';
    const normalizedEnd = typeof endTag === 'string' ? endTag.trim() : '';
    if (!normalizedStart || !normalizedEnd) return;
    if (pairs.some((pair) => pair.startTag === normalizedStart && pair.endTag === normalizedEnd)) return;
    pairs.push({ startTag: normalizedStart, endTag: normalizedEnd });
  };

  const group = db.getGroupChat(groupId);
  appendPair(group?.process_start_tag, group?.process_end_tag);

  if (agentId) {
    const session = db.getSessionByAgentId(agentId) || db.getSession(agentId);
    appendPair(session?.process_start_tag, session?.process_end_tag);
  }

  appendPair(DEFAULT_PROCESS_START_TAG, DEFAULT_PROCESS_END_TAG);
  return pairs;
}

function stripProcessBlocks(content: string, pairs: Array<{ startTag: string; endTag: string }>): string {
  let cleaned = content;

  for (const pair of pairs) {
    const startPattern = escapeRegExpForPattern(pair.startTag);
    const endPattern = escapeRegExpForPattern(pair.endTag);
    const blockRegex = new RegExp(`${startPattern}[\\s\\S]*?(?:${endPattern}|$)`, 'g');
    cleaned = cleaned.replace(blockRegex, '\n\n');
    cleaned = cleaned.replace(new RegExp(`(?:${startPattern}|${endPattern})`, 'g'), '\n\n');
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function hasUnclosedProcessBlock(content: string, pairs: Array<{ startTag: string; endTag: string }>): boolean {
  return pairs.some((pair) => {
    const lastStartIndex = content.lastIndexOf(pair.startTag);
    if (lastStartIndex === -1) return false;
    const lastEndIndex = content.lastIndexOf(pair.endTag);
    return lastEndIndex < lastStartIndex;
  });
}

function isLikelyStaleInactiveGroupMessage(content: string, pairs: Array<{ startTag: string; endTag: string }>): boolean {
  const normalized = content.trim();
  if (!normalized) return true;
  if (hasUnclosedProcessBlock(normalized, pairs)) return true;

  const containsProcessBlock = pairs.some((pair) => normalized.includes(pair.startTag));
  if (!containsProcessBlock) return false;

  return stripProcessBlocks(normalized, pairs).length === 0;
}

async function reconcileInactiveGroupLatestMessage(groupId: string): Promise<GroupReconciliationAction[]> {
  const runState = groupChatEngine.getGroupRunState(groupId);
  if (runState.active) {
    return [];
  }

  const recentMessages = db.getRecentGroupMessages(groupId, 100);
  const actions: GroupReconciliationAction[] = [];
  const staleMessageIds = recentMessages
    .filter((message) => (
      message.sender_type === 'agent'
      && typeof message.content === 'string'
      && message.content.trim() === ''
      && typeof message.id === 'number'
    ))
    .map((message) => message.id as number);

  for (const messageId of staleMessageIds) {
    const staleMessage = recentMessages.find((message) => message.id === messageId);
    db.deleteGroupMessage(messageId);
    actions.push({
      type: 'delete',
      id: messageId,
      parent_id: typeof staleMessage?.parent_id === 'number' ? staleMessage.parent_id : null,
    });
  }

  const latestAgentLikeMessage = [...recentMessages].reverse().find((message) => (
    message.sender_type === 'agent'
    && typeof message.id === 'number'
  ));

  if (!latestAgentLikeMessage?.id) {
    return actions;
  }
  const latestAgentLikeMessageId = latestAgentLikeMessage.id;

  const latestNonSystemAgentMessage = [...recentMessages].reverse().find((message) => (
    message.sender_type === 'agent'
    && typeof message.id === 'number'
    && !!message.sender_id
    && message.sender_id !== 'system'
  ));
  const currentContent = typeof latestAgentLikeMessage.content === 'string' ? latestAgentLikeMessage.content : '';
  const currentStructured = getStructuredGroupMessage(currentContent);
  const isLatestSystemFailureMessage = latestAgentLikeMessage.sender_id === 'system'
    && currentStructured.messageCode === 'group.agentResponseFailed';
  const sourceAgentName = typeof currentStructured.messageParams?.agentName === 'string'
    ? currentStructured.messageParams.agentName.trim()
    : '';
  const groupMembers = db.getGroupMembers(groupId);
  const matchedMember = sourceAgentName
    ? groupMembers.find((member) => {
      const session = db.getSessionByAgentId(member.agent_id) || db.getSession(member.agent_id);
      const latestDisplayName = session?.name?.trim();
      return member.display_name === sourceAgentName || latestDisplayName === sourceAgentName;
    })
    : undefined;
  const sourceAgentId = latestAgentLikeMessage.sender_id && latestAgentLikeMessage.sender_id !== 'system'
    ? latestAgentLikeMessage.sender_id
    : (matchedMember?.agent_id || latestNonSystemAgentMessage?.sender_id || '');

  if (!sourceAgentId) {
    return actions;
  }

  const sourceAgentDisplayName = latestAgentLikeMessage.sender_id && latestAgentLikeMessage.sender_id !== 'system'
    ? (latestAgentLikeMessage.sender_name || sourceAgentId)
    : (matchedMember?.display_name || sourceAgentName || latestNonSystemAgentMessage?.sender_name || sourceAgentId);
  const processTagPairs = getGroupProcessTagPairs(groupId, sourceAgentId);
  const currentMessageLooksStale = isLikelyStaleInactiveGroupMessage(currentContent, processTagPairs);
  const shouldAttemptHistoryReconciliation = actions.length > 0 || currentMessageLooksStale;
  const shouldAttemptFailureRecovery = isLatestSystemFailureMessage;

  if (!shouldAttemptHistoryReconciliation && !shouldAttemptFailureRecovery) {
    return actions;
  }

  const reconciliationFingerprint = getGroupReconciliationFingerprint(
    latestAgentLikeMessageId,
    currentContent,
    sourceAgentId,
    staleMessageIds,
    shouldAttemptFailureRecovery,
  );
  if (shouldSkipGroupReconciliation(groupId, reconciliationFingerprint)) {
    return actions;
  }

  const inFlightKey = `${groupId}:${reconciliationFingerprint}`;
  const existingInFlight = groupReconciliationInFlight.get(inFlightKey);
  if (existingInFlight) {
    const sharedActions = await existingInFlight;
    return actions.concat(sharedActions);
  }

  const reconciliationPromise = (async (): Promise<GroupReconciliationAction[]> => {
    const reconciliationActions: GroupReconciliationAction[] = [];
    try {
      const { history } = await readGroupRuntimeHistoryForReconciliation(groupId, sourceAgentId);
      const latestOutcomeRecord = extractLatestAssistantOutcomeRecord(history);
      const latestOutcome = latestOutcomeRecord.kind === 'text'
        ? { kind: 'text' as const, text: latestOutcomeRecord.text }
        : latestOutcomeRecord.kind === 'error'
          ? { kind: 'error' as const, error: latestOutcomeRecord.error }
          : { kind: 'none' as const };
      const latestMessageCreatedAtMs = Date.parse(latestAgentLikeMessage.created_at || '');
      const historyIsNewerThanCurrentMessage = latestOutcomeRecord.timestampMs !== null
        && Number.isFinite(latestMessageCreatedAtMs)
        && latestOutcomeRecord.timestampMs > latestMessageCreatedAtMs;

      if (latestOutcome.kind === 'none') {
        return reconciliationActions;
      }

      if (latestOutcome.kind === 'error') {
        const { content, messageCode, messageParams, rawDetail } = createAgentResponseFailedMessage(
          sourceAgentDisplayName,
          latestOutcome.error,
        );

        if (
          latestAgentLikeMessage.content.trim() !== content.trim()
          || latestAgentLikeMessage.sender_id !== 'system'
          || latestAgentLikeMessage.sender_name !== '系统'
        ) {
          const modelUsed = latestAgentLikeMessage.model_used || readAgentModelForDisplay(sourceAgentId);
          db.updateGroupMessage(latestAgentLikeMessageId, content, modelUsed, null);
          db.updateGroupMessageSender(latestAgentLikeMessageId, 'system', '系统');
          reconciliationActions.push({
            type: 'edit',
            data: {
              groupId,
              id: latestAgentLikeMessageId,
              parent_id: typeof latestAgentLikeMessage.parent_id === 'number' ? latestAgentLikeMessage.parent_id : null,
              sender_type: 'agent',
              sender_id: 'system',
              sender_name: '系统',
              content,
              model_used: modelUsed,
              messageCode,
              messageParams,
              rawDetail,
              created_at: latestAgentLikeMessage.created_at || new Date().toISOString(),
            },
          });
        }

        return reconciliationActions;
      }

      const allowShorterHistoryReplacement = isLatestSystemFailureMessage && historyIsNewerThanCurrentMessage;
      const preferredLatestText = selectPreferredTextSnapshot(currentContent, latestOutcome.text, {
        allowShorterReplacement: allowShorterHistoryReplacement,
      });
      const shouldReplaceWithHistoryText = preferredLatestText === latestOutcome.text && (
        shouldPreferSettledAssistantText(currentContent, latestOutcome.text)
        || (
          currentMessageLooksStale
          && latestOutcome.text.trim() !== currentContent.trim()
        )
        || allowShorterHistoryReplacement
      );

      if (shouldReplaceWithHistoryText) {
        const modelUsed = latestAgentLikeMessage.model_used || readAgentModelForDisplay(sourceAgentId);
        db.updateGroupMessage(latestAgentLikeMessageId, preferredLatestText, modelUsed, latestAgentLikeMessage.mentions || null);
        db.updateGroupMessageSender(latestAgentLikeMessageId, sourceAgentId, sourceAgentDisplayName);
        reconciliationActions.push({
          type: 'edit',
          data: {
            groupId,
            id: latestAgentLikeMessageId,
            parent_id: typeof latestAgentLikeMessage.parent_id === 'number' ? latestAgentLikeMessage.parent_id : null,
            sender_type: 'agent',
            sender_id: sourceAgentId,
            sender_name: sourceAgentDisplayName,
            content: preferredLatestText,
            model_used: modelUsed,
            created_at: latestAgentLikeMessage.created_at || new Date().toISOString(),
          },
        });
      }
    } catch (error) {
      console.warn(`[GroupReconcile] Failed to reconcile latest inactive message for group ${groupId}:`, error);
    } finally {
      rememberGroupReconciliationAttempt(groupId, reconciliationFingerprint);
      groupReconciliationInFlight.delete(inFlightKey);
    }

    return reconciliationActions;
  })();

  groupReconciliationInFlight.set(inFlightKey, reconciliationPromise);
  const reconciliationActions = await reconciliationPromise;
  return actions.concat(reconciliationActions);
}

function broadcastGroupReconciliationActions(groupId: string, actions: GroupReconciliationAction[], targetClients?: Iterable<express.Response>) {
  if (actions.length === 0) return;

  const clients = targetClients ? Array.from(targetClients) : Array.from(groupSSEClients.get(groupId) || []);
  for (const action of actions) {
    const payload = action.type === 'delete'
      ? { type: 'delete', id: action.id, parent_id: action.parent_id }
      : { type: 'edit', ...withStructuredGroupMessage(action.data, { groupId }) };
    const data = JSON.stringify(payload);

    for (const client of clients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {}
    }
  }
}

function removeAgentRuntimeState(agentId: string): void {
  disconnectConnection(agentId);

  const agentStatePath = getAgentStatePath(agentId);
  if (fs.existsSync(agentStatePath)) {
    fs.rmSync(agentStatePath, { recursive: true, force: true });
  }

  const memoryDbPath = getAgentMemoryDbPath(agentId);
  if (fs.existsSync(memoryDbPath)) {
    fs.rmSync(memoryDbPath, { force: true });
  }
}

function cleanupLegacyGroupRuntimeArtifacts(groupId: string): void {
  const groupWorkspacePath = getGroupWorkspacePath(groupId);
  const legacyRuntimeAgentIds = [
    getLegacyGroupRuntimeAgentId(groupId),
    getSharedGroupRuntimeAgentId(groupId),
  ];

  for (const legacyRuntimeAgentId of legacyRuntimeAgentIds) {
    removeAgentRuntimeState(legacyRuntimeAgentId);
    agentProvisioner.removeConfigEntry(legacyRuntimeAgentId);

    const legacyWorkspacePath = agentProvisioner.getWorkspacePath(legacyRuntimeAgentId);
    if (legacyWorkspacePath !== groupWorkspacePath && fs.existsSync(legacyWorkspacePath)) {
      fs.rmSync(legacyWorkspacePath, { recursive: true, force: true });
    }
  }
}

function collectGroupRuntimeAgentIds(groupId: string): string[] {
  const collected = new Set<string>([
    getLegacyGroupRuntimeAgentId(groupId),
    getSharedGroupRuntimeAgentId(groupId),
  ]);

  const runtimeAgentPrefix = getGroupRuntimeAgentPrefix(groupId);
  const openClawRoot = path.join(os.homedir(), '.openclaw');
  const agentStateRoot = path.join(openClawRoot, 'agents');
  if (fs.existsSync(agentStateRoot)) {
    for (const entry of fs.readdirSync(agentStateRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(runtimeAgentPrefix)) {
        collected.add(entry.name);
      }
    }
  }

  const memoryRoot = path.join(openClawRoot, 'memory');
  if (fs.existsSync(memoryRoot)) {
    for (const entry of fs.readdirSync(memoryRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sqlite')) continue;
      const agentId = entry.name.slice(0, -'.sqlite'.length);
      if (agentId.startsWith(runtimeAgentPrefix)) {
        collected.add(agentId);
      }
    }
  }

  const configPath = path.join(openClawRoot, 'openclaw.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = readOpenClawConfigSafe() ?? {};
      // 走门面：契约只说了「agent-provisioner.ts 里现有四处」，按那句话永远找不到这一处。
      // 2.x 上旧写法返回空集，于是删群/重置群时**不清理任何运行时 agent**，
      // 工作区与配置条目全部残留。
      const rosterShape = resolveRosterShape(config as Record<string, unknown>).shape;
      const agentList = listRosterEntries(config as Record<string, unknown>, rosterShape);
      for (const entry of agentList) {
        if (typeof entry?.id === 'string' && entry.id.startsWith(runtimeAgentPrefix)) {
          collected.add(entry.id);
        }
      }
    } catch (error) {
      console.warn(`[GroupRuntime] Failed to read openclaw.json while collecting runtime agents for group ${groupId}:`, error);
    }
  }

  return Array.from(collected);
}

/**
 * 清理一个群的运行时 Agent。
 *
 * 返回**清理没能完成的 agentId**——注意措辞：不是「配置里还留着条目」。
 *
 * 这个区别是对抗测试第四轮挑出来的，而且它两个方向都错过：
 * 配置读不动时，我们**根本无法知道**里面到底有没有这个条目——
 * 可能压根没写进去过（那就没有残留），也可能确实留着。
 * 上一版把「清理失败」当成「有残留」上报，等于把一件不知道的事说成了知道。
 *
 * 反方向同样：`removeConfigEntry()` 在「条目本来就不存在」时返回 false 而不抛，
 * 那不是失败，不该进这个列表。
 *
 * 所以这里只报**我们确实知道的那件事**：这几个 agentId 的配置清理没跑完，
 * 需要人去看一眼。调用方的文案也要照这个措辞，不能写成「配置里还留着」。
 *
 * 为什么不让它抛：`removeConfigEntry()` 现在会对「配置读不动」抛 ConfigReadError
 * （这是对的，删除报成功而一个字节没删是红线 C 禁止的形状）。但如果让它在这里
 * 直接往上冒，循环后面的工作区删除、以及调用方的 `db.deleteGroupChat()` 全都
 * 不会执行——用户想删一个群，结果因为配置文件坏了，群、工作区、数据库行**一样都没删掉**，
 * 只拿到一个 500。这是把「配置读不动」升级成了「群删不掉」。
 *
 * 与 `readAgentModelForDisplay()` 同一个取舍：外围失败不该杀掉主操作，但必须出声。
 */
function cleanupGroupRuntimeAgent(groupId: string, options: { removeConfig?: boolean } = {}): string[] {
  const configCleanupFailed: string[] = [];
  for (const runtimeAgentId of collectGroupRuntimeAgentIds(groupId)) {
    removeAgentRuntimeState(runtimeAgentId);
    if (options.removeConfig) {
      try {
        agentProvisioner.removeConfigEntry(runtimeAgentId);
      } catch (error) {
        if (!(error instanceof ConfigReadError)) throw error;
        configCleanupFailed.push(runtimeAgentId);
        console.error(
          `[cleanupGroupRuntimeAgent] 无法从 openclaw.json 清除运行时 Agent（${error.reason}：${error.detail}）：${runtimeAgentId}`,
        );
      }
    }

    const runtimeWorkspacePath = agentProvisioner.getWorkspacePath(runtimeAgentId);
    if (fs.existsSync(runtimeWorkspacePath)) {
      fs.rmSync(runtimeWorkspacePath, { recursive: true, force: true });
    }
  }

  return configCleanupFailed;
}

async function prepareGroupRuntimeAgent(groupId: string, sourceAgentId: string): Promise<{
  runtimeAgentId: string;
  workspacePath: string;
  uploadsPath: string;
  outputPath: string;
  bootstrapContext: string;
}> {
  const { workspacePath, uploadsPath, outputPath } = ensureGroupWorkspace(groupId);
  const runtimeAgentId = getGroupRuntimeAgentId(groupId, sourceAgentId);
  const runtimeWorkspacePath = agentProvisioner.getWorkspacePath(sourceAgentId);
  const sourceModelConfig = agentProvisioner.readAgentModelConfig(sourceAgentId);
  const sourceRuntimeConfig = agentProvisioner.readAgentRuntimeConfig(sourceAgentId);

  cleanupLegacyGroupRuntimeArtifacts(groupId);
  removeGroupWorkspaceBootstrapFiles(groupId);

  if (runtimeAgentSessionsNeedWorkspaceReset(runtimeAgentId, runtimeWorkspacePath)) {
    resetRuntimeAgentSessions(runtimeAgentId);
  }

  await agentProvisioner.provision({
    agentId: runtimeAgentId,
    workspaceDir: runtimeWorkspacePath,
    soulContent: agentProvisioner.readSoul(sourceAgentId) || undefined,
    userContent: agentProvisioner.readAgentFile(sourceAgentId, 'USER.md', ''),
    agentsContent: agentProvisioner.readAgentFile(sourceAgentId, 'AGENTS.md', ''),
    toolsContent: agentProvisioner.readAgentFile(sourceAgentId, 'TOOLS.md', ''),
    heartbeatContent: agentProvisioner.readAgentFile(sourceAgentId, 'HEARTBEAT.md', ''),
    identityContent: agentProvisioner.readAgentFile(sourceAgentId, 'IDENTITY.md', ''),
    model: sourceModelConfig.modelOverride || undefined,
    fallbackMode: sourceModelConfig.fallbackMode,
    fallbacks: sourceModelConfig.fallbacks,
    systemPromptMode: sourceRuntimeConfig.systemPromptMode,
    toolMode: sourceRuntimeConfig.toolMode,
  });

  return {
    runtimeAgentId,
    workspacePath,
    uploadsPath,
    outputPath,
    bootstrapContext: readAgentBootstrapContextFromWorkspace(runtimeWorkspacePath),
  };
}

// Helper to get or create connection
async function getConnection(sessionId: string): Promise<OpenClawClient> {
  const cachedClient = connections.get(sessionId);
  if (cachedClient) {
    if (cachedClient.isConnected()) {
      return cachedClient;
    }
    connections.delete(sessionId);
    cachedClient.disconnect();
  }

  const config = configManager.getConfig();
  const client = new OpenClawClient({
    gatewayUrl: config.gatewayUrl,
    token: config.token,
    password: config.password,
  });
  client.on('error', (err) => {
    console.error(`[OpenClawClient Error for session ${sessionId}]`, err.message);
  });

  try {
    await client.connect();
  } catch (error) {
    connections.delete(sessionId);
    client.disconnect();
    throw error;
  }
  connections.set(sessionId, client);

  client.on('disconnected', () => {
    connections.delete(sessionId);
  });

  return client;
}

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: connections.size,
  });
});

// API Routes
app.get('/api/version', (_req, res) => {
  (async () => {
    try {
      res.json({
        ...getCurrentAppVersionInfo(),
        openclawVersion: await readOpenClawVersion(),
      });
    } catch (error: any) {
      res.status(500).json(buildStructuredApiError(
        VERSION_INFO_UNAVAILABLE_ERROR_CODE,
        error instanceof Error ? error.message : String(error),
      ));
    }
  })().catch((error: any) => {
    res.status(500).json(buildStructuredApiError(
      VERSION_INFO_UNAVAILABLE_ERROR_CODE,
      error instanceof Error ? error.message : String(error),
    ));
  });
});

app.get('/api/version/latest', async (_req, res) => {
  try {
    const latestInfo = await getLatestVersionInfo();
    rememberLatestVersionInfo(latestInfo);
    res.json(latestInfo);
  } catch (error: any) {
    console.error('[VersionCheck] Failed to fetch latest release:', error instanceof Error ? error.message : String(error));
    res.status(502).json(buildStructuredApiError(
      VERSION_LOOKUP_FAILED_ERROR_CODE,
      error instanceof Error ? error.message : String(error),
    ));
  }
});

app.get('/api/openclaw/version/latest', async (_req, res) => {
  try {
    const latestInfo = await getOpenClawLatestVersionInfo();
    res.json(latestInfo);
  } catch (error: any) {
    console.error('[OpenClawVersionCheck] Failed to fetch latest version:', error instanceof Error ? error.message : String(error));
    res.status(502).json(buildStructuredApiError(
      OPENCLAW_VERSION_LOOKUP_FAILED_ERROR_CODE,
      error instanceof Error ? error.message : String(error),
    ));
  }
});

app.get('/api/openclaw/update/status', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await buildOpenClawUpdateStatusResponseAsync();
    res.json({
      success: true,
      update,
    });
  })().catch((error: any) => {
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_STATUS_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/openclaw/update/start', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await startOpenClawUpdateTask();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_START_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/openclaw/update/cancel', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await cancelOpenClawUpdateTask();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_CANCEL_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/openclaw/update/reset', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await resetOpenClawUpdateTaskState();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_RESET_FAILED_ERROR_CODE, detail));
  });
});

app.get('/api/update/status', requireAdminAuth, (_req, res) => {
  res.json({
    success: true,
    update: buildUpdateStatusResponse(),
  });
});

app.post('/api/update/start', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await startUpdateTask();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(UPDATE_START_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/update/cancel', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await cancelUpdateTask();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(UPDATE_CANCEL_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/update/reset', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await resetUpdateTaskState();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(UPDATE_RESET_FAILED_ERROR_CODE, detail));
  });
});

app.post('/api/update/restart-service', requireAdminAuth, (_req, res) => {
  (async () => {
    const update = await restartClawUiService();
    res.json({ success: true, update });
  })().catch((error: any) => {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
    res.status(500).json(buildStructuredApiError(UPDATE_RESTART_FAILED_ERROR_CODE, detail));
  });
});

app.get('/api/config', (_req, res) => {
  const config = configManager.getConfig();
  res.json({
    gatewayUrl: config.gatewayUrl,
    defaultAgent: config.defaultAgent,
    language: config.language || 'zh-CN',
    // 凭据只报「配没配」，不报值。这个路由无需登录即可访问——一个未鉴权的接口
    // 把登录密码明文吐出来，等于登录页形同虚设。要改凭据走 POST，不需要先读回来。
    hasToken: !!config.token,
    hasPassword: !!config.password,
    hasLoginPassword: !!config.loginPassword,
    aiName: config.aiName || 'OpenClaw',
    loginEnabled: config.loginEnabled || false,
    allowedHosts: config.allowedHosts || [],
    historyPageRounds: config.historyPageRounds || 30,
    previewConversionTimeoutSeconds: config.previewConversionTimeoutSeconds || 60,
  });
});

app.post('/api/config', requireAdminAuth, (req, res) => {
  // 写配置必须鉴权：这个路由能改登录密码、能把 loginEnabled 关掉、能改网关指向。
  // 未开启登录时 requireAdminAuth 直接放行，所以默认部署的行为不变。
  //
  // 凭据字段留空视为「不修改」而不是「清空」。GET 不再回读密钥值，前端表单起手就是
  // 空的；若把空串当清空，用户改个 AI 名字就会顺手把网关口令抹掉。
  const incoming = { ...req.body } as Record<string, unknown>;
  for (const field of ['token', 'password', 'loginPassword']) {
    if (typeof incoming[field] === 'string' && incoming[field] === '') delete incoming[field];
  }

  // 新口令一律哈希后落盘；改口令即作废所有既有会话——否则「改了密码」这个动作
  // 挡不住已经拿到令牌的人，用户会以为自己已经处理了泄露。
  const passwordChanged = typeof incoming.loginPassword === 'string' && incoming.loginPassword !== '';
  if (passwordChanged) {
    incoming.loginPassword = hashPassword(incoming.loginPassword as string);
  }
  configManager.setConfig(incoming);
  if (passwordChanged || incoming.loginEnabled === false) {
    authStore.revokeAll();
  }
  res.json({ success: true });
});

app.get('/api/sidebar/favorites', (_req, res) => {
  const config = configManager.getConfig();
  res.json({
    success: true,
    favorites: config.sidebarFavorites || {
      agents: [],
      groups: [],
      order: [],
    },
  });
});

app.post('/api/sidebar/favorites', (req, res) => {
  configManager.setConfig({
    sidebarFavorites: req.body?.favorites ?? req.body,
  });
  const config = configManager.getConfig();
  res.json({
    success: true,
    favorites: config.sidebarFavorites || {
      agents: [],
      groups: [],
      order: [],
    },
  });
});

import crypto from 'crypto';

function generateAuthToken(password: string): string {
  return crypto.createHash('sha256').update(password + '_clawopt_salt').digest('hex');
}

function readRequestAuthToken(req: express.Request): string {
  const forwarded = req.header('x-clawopt-auth-token');
  if (forwarded) return normalizeCliText(forwarded);
  const authorization = normalizeCliText(req.header('authorization'));
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  // Cookie 是 Web 端的主通道：SSE 的 EventSource 设不了自定义头，而前端有 80 处
  // fetch 调用点——逐个加头既慢又必漏。同源请求自动带 cookie，一次覆盖全部。
  // 头这条保留给 CLI 与脚本（CLAWOPT_TOKEN）。
  return readCookie(req.headers.cookie, AUTH_COOKIE_NAME);
}

function issueAuthCookie(res: express.Response, token: string, maxAgeMs: number): void {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',            // 关键：JS 读不到，XSS 偷不走
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res: express.Response): void {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requireAdminAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const config = configManager.getConfig();
  if (!config.loginEnabled) {
    return next();
  }

  if (authStore.verify(readRequestAuthToken(req))) {
    return next();
  }

  return next(new StructuredRequestError(401, AUTH_LOGIN_REQUIRED_ERROR_CODE, 'Login is required to perform this action.'));
}

/**
 * 全局 API 鉴权。
 *
 * 之前鉴权是逐路由手挂的，108 个路由只挂了 15 个——数据面（建会话、发消息、删会话、
 * 建群、传文件）全部裸奔，登录页只挡住了「改配置」和「装包」。手挂的名单不可能不漏，
 * 所以改成默认全保护 + 白名单放行。新增路由自动受保护，这是这次改动真正的收益。
 */
const AUTH_PUBLIC_PATHS = new Set([
  '/api/auth/check',
  '/api/auth/login',
  '/api/version',
]);

function requireSessionAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const config = configManager.getConfig();
  if (!config.loginEnabled) return next();
  if (authStore.verify(readRequestAuthToken(req))) return next();
  return next(new StructuredRequestError(401, AUTH_LOGIN_REQUIRED_ERROR_CODE, 'Login is required to perform this action.'));
}

app.use('/api', (req, res, next) => {
  const routePath = req.path.startsWith('/') ? `/api${req.path}` : `/api/${req.path}`;
  if (AUTH_PUBLIC_PATHS.has(routePath)) return next();
  return requireSessionAuth(req, res, next);
});

// /openclaw 与 /uploads 不在 /api 前缀下，得单独挂——它们出的是工作区文件与
// 用户上传，正是开了登录之后最不该匿名可取的东西。浏览器加载 <img src="/uploads/...">
// 是同源请求，cookie 会自动带上，所以加了鉴权也不会打断图片显示。
app.use('/openclaw', requireSessionAuth);
app.use('/uploads', requireSessionAuth);

// Auth endpoints
app.get('/api/auth/check', (req, res) => {
  const config = configManager.getConfig();
  if (!config.loginEnabled) {
    return res.json({ loginRequired: false });
  }
  // 令牌从 cookie / 头里读，不再走 query——查询串会进访问日志、代理日志和浏览器历史。
  res.json({ loginRequired: !authStore.verify(readRequestAuthToken(req)) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = readRequestAuthToken(req);
  if (token) authStore.revoke(token);
  clearAuthCookie(res);
  res.json({ success: true });
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const config = configManager.getConfig();

  if (!config.loginEnabled) {
    return res.json({ success: true, token: 'disabled' });
  }

  const stored = config.loginPassword || '123456';
  if (typeof password === 'string' && verifyPassword(password, stored)) {
    // 令牌是随机数、服务端存储、30 天过期、可吊销——不再是口令的哈希。
    const session = authStore.issue('web');
    issueAuthCookie(res, session.token, session.expiresAt - Date.now());
    return res.json({ success: true, token: session.token });
  }

  res.status(401).json({
    success: false,
    errorCode: 'auth.invalidPassword',
    errorParams: null,
    errorDetail: null,
  });
});

app.get('/api/gateway/status', async (_req, res) => {
  try {
    const activeConnectionStatus = getActiveGatewayConnectionStatus();
    if (activeConnectionStatus) {
      return res.json({
        connected: activeConnectionStatus.connected,
        message: activeConnectionStatus.message,
        source: activeConnectionStatus.source,
      });
    }

    const result = await probeGatewayConnectionStatus(buildGatewayStatusProbeParams(), { preferLocalHealth: true });
    res.json({
      connected: result.connected,
      message: result.message,
      source: result.source,
    });
  } catch (error: any) {
    res.json({ connected: false, message: error?.message || 'Connection failed' });
  }
});

app.post('/api/config/test', async (req, res) => {
  const { gatewayUrl, token, password } = req.body;

  if (!gatewayUrl) {
    return res.status(400).json(buildStructuredApiError(GATEWAY_TEST_FAILED_ERROR_CODE, 'Gateway URL is required'));
  }

  try {
    const result = await probeGatewayConnectionStatus({ gatewayUrl, token, password });
    if (result.connected) {
      return res.json({ success: true, message: 'Connection successful', source: result.source });
    }

    res.json(buildStructuredApiError(
      GATEWAY_TEST_FAILED_ERROR_CODE,
      result.message || 'Connection failed',
    ));
  } catch (error: any) {
    console.error('[API] /api/config/test - Connection failed:', error);
    res.json(buildStructuredApiError(GATEWAY_TEST_FAILED_ERROR_CODE, error?.message || 'Connection failed'));
  }
});

app.get('/api/config/detect-all', async (_req, res) => {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    let gatewayUrl = '';
    let token = '';
    let password = '';
    const openclawVersion = await readOpenClawVersion();

    if (fs.existsSync(configPath)) {
      const config = readOpenClawConfigSafe() ?? {};
      if (config.gateway) {
        gatewayUrl = `ws://127.0.0.1:${config.gateway.port || 18789}`;
        token = config.gateway.auth?.token || '';
        password = config.gateway.auth?.password || '';
      }
    }

    if (!gatewayUrl) {
      return res.json(buildStructuredApiError(GATEWAY_DETECT_FAILED_ERROR_CODE, 'Could not detect gateway config'));
    }

    res.json({
      success: true,
      data: {
        gatewayUrl,
        token,
        password,
        openclawVersion,
      }
    });
  } catch (error: any) {
    res.json(buildStructuredApiError(GATEWAY_DETECT_FAILED_ERROR_CODE, error?.message || 'Error detecting config'));
  }
});

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

app.get('/api/config/browser-health/status', (_req, res) => {
  res.json({
    success: true,
    task: getBrowserTaskSnapshot(),
  });
});

app.get('/api/config/browser-health', async (_req, res) => {
  let taskStarted = false;
  try {
    ensureBrowserTaskIdle();
    updateBrowserTaskSnapshot({
      status: 'checking',
      phase: 'read-config',
      rawDetail: null,
    });
    taskStarted = true;
    const health = await runBrowserHealthCheck((phase, rawDetail) => {
      updateBrowserTaskSnapshot({
        status: 'checking',
        phase,
        rawDetail: normalizeCliText(rawDetail) || null,
      });
    });
    res.json({ success: true, health });
  } catch (error: any) {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    res.json(buildStructuredApiError(
      BROWSER_HEALTH_FAILED_ERROR_CODE,
      readCliErrorDetail(error) || error?.message || 'Browser health check failed'
    ));
  } finally {
    if (taskStarted) {
      resetBrowserTaskSnapshot();
    }
  }
});

app.get('/api/config/browser-headed-mode', (_req, res) => {
  try {
    res.json({
      success: true,
      config: readBrowserHeadedModeConfig(),
    });
  } catch (error: any) {
    res.status(500).json(buildStructuredApiError(
      BROWSER_HEADED_MODE_LOAD_FAILED_ERROR_CODE,
      error?.message || 'Failed to load browser headed mode config'
    ));
  }
});

app.get('/api/config/restart/status', async (_req, res) => {
  res.json({
    success: true,
    restart: await reconcileGatewayRestartSnapshot(),
  });
});

app.post('/api/config/restart/status/reset', (_req, res) => {
  if (gatewayRestartSnapshot.status === 'restarting') {
    return res.status(409).json({
      ...buildStructuredApiError(
        GATEWAY_RESTART_FAILED_ERROR_CODE,
        'OpenClaw gateway restart is still running.'
      ),
      restart: getGatewayRestartSnapshot(),
    });
  }

  resetGatewayRestartSnapshot();
  res.json({
    success: true,
    restart: getGatewayRestartSnapshot(),
  });
});

app.post('/api/config/browser-headed-mode', (req, res) => {
  const { headedModeEnabled } = req.body ?? {};
  if (typeof headedModeEnabled !== 'boolean') {
    return res.status(400).json(buildStructuredApiError(
      BROWSER_HEADED_MODE_UPDATE_FAILED_ERROR_CODE,
      'headedModeEnabled must be a boolean'
    ));
  }

  void (async () => {
    try {
      const currentConfig = readBrowserHeadedModeConfig();
      if (currentConfig.headedModeEnabled === headedModeEnabled) {
        return res.json({
          success: true,
          config: currentConfig,
          restartCompleted: false,
        });
      }

      const previousRuntimeState = await readOpenClawGatewayServiceRuntimeState();
      const config = setBrowserHeadedModeEnabled(headedModeEnabled);
      const restart = runTrackedGatewayRestart({
        trigger: 'browser-headed-mode',
        previousRuntimeState,
        targetHeadedModeEnabled: headedModeEnabled,
      });

      res.json({
        success: true,
        config,
        restartCompleted: false,
        restart,
      });
    } catch (error: any) {
      res.status(500).json({
        ...buildStructuredApiError(
          BROWSER_HEADED_MODE_UPDATE_FAILED_ERROR_CODE,
          error?.message || 'Failed to update browser headed mode config'
        ),
        restart: getGatewayRestartSnapshot(),
      });
    }
  })();
});

app.post('/api/config/browser-health/self-heal', async (_req, res) => {
  let taskStarted = false;
  try {
    const lastKnownIssue = _req.body?.lastKnownIssue;
    ensureBrowserTaskIdle();
    updateBrowserTaskSnapshot({
      status: 'repairing',
      phase: 'inspect-current',
      rawDetail: null,
    });
    taskStarted = true;

    const reportRepairProgress = (phase: string, rawDetail?: string | null) => {
      updateBrowserTaskSnapshot({
        status: 'repairing',
        phase,
        rawDetail: normalizeCliText(rawDetail) || null,
      });
    };

    reportRepairProgress('enable-permissions');
    await configureMaxPermissionsState(true);
    reportRepairProgress('sync-browser-settings');
    synchronizeConfiguredBrowserRepairSettings();
    reportRepairProgress('refresh-plugins');
    try {
      await refreshOpenClawPluginRegistryForBrowserSelfHeal();
    } catch (error) {
      reportRepairProgress('refresh-plugins', readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error)));
    }
    reportRepairProgress('restart-gateway');
    await restartGatewayService();
    await waitForBrowserGatewayReady(BROWSER_SELF_HEAL_GATEWAY_READY_TIMEOUT_MS, reportRepairProgress);
    reportRepairProgress('stop-browser');
    await stopOpenClawBrowserBestEffort();

    const shouldResetProfile = shouldRetryBrowserRepairWithProfileReset(
      lastKnownIssue === 'permissions'
      || lastKnownIssue === 'disabled'
      || lastKnownIssue === 'stopped'
      || lastKnownIssue === 'detect-error'
      || lastKnownIssue === 'timeout'
      || lastKnownIssue === 'unknown'
        ? lastKnownIssue
        : null
    );

    if (shouldResetProfile) {
      reportRepairProgress('reset-profile');
      await stopOpenClawBrowserBestEffort();
      await resetOpenClawBrowserProfile();
    }

    reportRepairProgress('finalize');
    const health = await runBrowserHealthCheck(reportRepairProgress);

    res.json({
      success: true,
      gatewayRestarted: true,
      resetProfile: shouldResetProfile,
      health,
    });
  } catch (error: any) {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    res.json(buildStructuredApiError(
      BROWSER_SELF_HEAL_FAILED_ERROR_CODE,
      readCliErrorDetail(error) || error?.message || 'Browser self-heal failed'
    ));
  } finally {
    if (taskStarted) {
      resetBrowserTaskSnapshot();
    }
  }
});

app.get('/api/config/max-permissions', async (_req, res) => {
  const enabled = readMaxPermissionsEnabled() === true;
  const [hostTakeover, devicePairing] = await Promise.all([
    safeReadHostTakeoverStatus(enabled),
    safeReadDevicePairingStatus(),
  ]);
  res.json({ enabled, hostTakeover, devicePairing });
});

app.post('/api/config/max-permissions', async (req, res) => {
  const requestedEnabled = Boolean(req.body?.enabled);
  const systemPassword = normalizeCliText(req.body?.systemPassword) || null;

  try {
    const result = await configureMaxPermissionsState(requestedEnabled, { systemPassword });
    const devicePairing = await safeReadDevicePairingStatus();
    res.json({
      success: true,
      enabled: result.enabled,
      restartRequired: true,
      hostTakeover: result.hostTakeover,
      devicePairing,
    });
  } catch (error: any) {
    const currentEnabled = readMaxPermissionsEnabled() === true;
    const [hostTakeover, devicePairing] = await Promise.all([
      safeReadHostTakeoverStatus(requestedEnabled || currentEnabled),
      safeReadDevicePairingStatus(),
    ]);
    hostTakeover.enabled = currentEnabled;

    if (isStructuredRequestError(error)) {
      return res.status(error.status).json({
        ...error.payload,
        enabled: currentEnabled,
        hostTakeover,
        devicePairing,
      });
    }

    res.status(500).json({
      ...buildStructuredApiError(
        GATEWAY_MAX_PERMISSIONS_UPDATE_FAILED_ERROR_CODE,
        readCliErrorDetail(error) || error?.message || 'Failed to update maximum permissions.'
      ),
      enabled: currentEnabled,
      hostTakeover,
      devicePairing,
    });
  }
});

app.post('/api/config/max-permissions/device-pairing/approve', async (_req, res) => {
  try {
    const result = await approveLatestDevicePairingRequest();
    res.json({
      success: true,
      approvedRequestId: result.approvedRequestId,
      approvedDeviceId: result.approvedDeviceId,
      approvedDeviceName: result.approvedDeviceName,
      devicePairing: result.devicePairing,
    });
  } catch (error: any) {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }

    res.status(500).json(buildStructuredApiError(
      GATEWAY_DEVICE_PAIRING_APPROVE_FAILED_ERROR_CODE,
      readCliErrorDetail(error) || error?.message || 'Failed to approve the latest device pairing request.',
    ));
  }
});

app.post('/api/config/restart', async (_req, res) => {
  try {
    const previousRuntimeState = await readOpenClawGatewayServiceRuntimeState();
    const restart = runTrackedGatewayRestart({
      trigger: 'gateway',
      previousRuntimeState,
    });

    res.json({
      success: true,
      message: 'Gateway restart started',
      restart,
    });
  } catch (error: any) {
    console.error('Failed to restart gateway:', error);
    res.status(500).json({
      ...buildStructuredApiError(GATEWAY_RESTART_FAILED_ERROR_CODE, error?.message),
      restart: getGatewayRestartSnapshot(),
    });
  }
});

app.get('/api/models', (_req, res) => {
  // 配置读不动时退回空列表的旧降级行为，不让这条首屏必调的接口整体 500。
  const { value: models, configReadFailed } = withConfigReadFallback(
    [] as ReturnType<typeof agentProvisioner.readAvailableModels>,
    () => agentProvisioner.readAvailableModels(),
  );
  res.json({ success: true, models, configReadFailed });
});

app.get('/api/models/fallbacks', (_req, res) => {
  try {
    res.json({
      success: true,
      config: agentProvisioner.readGlobalModelConfig(),
    });
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.put('/api/models/fallbacks', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.fallbacks)) {
      return res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'fallbacks must be an array'));
    }

    const success = await agentProvisioner.updateGlobalFallbacks(normalizeFallbackList(req.body.fallbacks));
    res.json({
      success: true,
      changed: success,
      config: agentProvisioner.readGlobalModelConfig(),
    });
  } catch (err: any) {
    const detail = typeof err?.message === 'string' ? err.message : '';
    res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, detail || 'Failed to update fallback models'));
  }
});

app.get('/api/models/image-generation', (_req, res) => {
  try {
    res.json({
      success: true,
      config: agentProvisioner.readImageGenerationModelConfig(),
    });
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.get('/api/models/image-generation/providers', async (req, res) => {
  try {
    const snapshot = await readOpenClawImageProviderSnapshot({
      refresh: req.query.refresh === '1',
      allowStaleOnError: true,
    });
    res.json({
      success: true,
      providers: snapshot.providers,
      models: snapshot.models,
      updatedAt: snapshot.updatedAt,
      cache: snapshot.cache || null,
    });
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, err?.message || 'Failed to read OpenClaw image generation providers'));
  }
});

app.put('/api/models/image-generation', async (req, res) => {
  try {
    const primary = typeof req.body?.primary === 'string' ? req.body.primary : null;
    if (!Array.isArray(req.body?.fallbacks)) {
      return res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'fallbacks must be an array'));
    }

    const success = await agentProvisioner.updateImageGenerationModelConfig(
      primary,
      normalizeFallbackList(req.body.fallbacks),
    );
    res.json({
      success: true,
      changed: success,
      config: agentProvisioner.readImageGenerationModelConfig(),
    });
  } catch (err: any) {
    const detail = typeof err?.message === 'string' ? err.message : '';
    res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, detail || 'Failed to update image generation model'));
  }
});

app.post('/api/models/test-image-generation', async (req, res) => {
  try {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
    const modelName = typeof req.body?.modelName === 'string' ? req.body.modelName.trim() : '';
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
    const modelRef = modelId || (endpoint && modelName ? `${endpoint}/${modelName}` : '');
    if (!modelRef) {
      return res.status(400).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, 'endpoint/modelName or modelId required'));
    }

    const startTime = Date.now();
    const snapshot = await readOpenClawImageProviderSnapshot();
    const matchedNameInput = modelName || modelId || modelRef;
    const matched = findImageProviderModel(snapshot, modelRef) || findImageProviderModelByName(snapshot, matchedNameInput);
    if (!matched) {
      return res.json(buildStructuredApiError(
        MODEL_TEST_FAILED_ERROR_CODE,
        `OpenClaw image_generate provider list does not include "${modelRef}" or model name "${matchedNameInput}". Available image models: ${summarizeImageProviderModels(snapshot)}`
      ));
    }

    const provider = snapshot.providers.find((entry) => entry.id === matched.providerId) || null;
    const exactMatch = matched.id === modelRef;
    res.json({
      success: true,
      lightweight: true,
      message: 'OpenClaw recognizes this image generation model',
      latency: Date.now() - startTime,
      model: matched,
      provider,
      cache: snapshot.cache || null,
      matchMode: exactMatch ? 'exact' : 'modelName',
      warning: !exactMatch
        ? `Model name "${matchedNameInput}" is recognized by OpenClaw image providers as "${matched.id}". Endpoint prefix "${endpoint}" and credentials are not verified by the lightweight check.`
        : provider?.configured === false
          ? 'Provider/model is recognized by OpenClaw. Credentials are not verified by the lightweight check.'
        : null,
    });
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, err?.message || 'Failed to validate image generation model'));
  }
});

app.post('/api/models/test', async (req, res) => {
  try {
    const { endpoint, modelName } = req.body;
    if (!endpoint || !modelName) {
      return res.status(400).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, 'endpoint and modelName required'));
    }

    const endpoints = agentProvisioner.getEndpoints();
    const config = endpoints.find((e: any) => e.id === endpoint);
    if (!config) {
      return res.status(404).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, 'Endpoint not found'));
    }

    let baseUrl = config.baseUrl;
    const apiKey = config.apiKey || '';
    const apiType = config.api.toLowerCase();

    let testUrl = '';
    let headers: any = {
      'Content-Type': 'application/json'
    };
    let body: any = {};

    if (apiType.includes('anthropic')) {
      testUrl = `${baseUrl.replace(/\/$/, '')}/messages`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: modelName,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 5
      };
    } else if (apiType.includes('gemini') || apiType.includes('google')) {
      testUrl = `${baseUrl.replace(/\/$/, '')}/models/${modelName}:generateContent?key=${apiKey}`;
      body = {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        generationConfig: { maxOutputTokens: 5 }
      };
    } else if (apiType.includes('ollama')) {
      testUrl = `${baseUrl.replace(/\/$/, '')}/api/chat`; 
      body = {
        model: modelName,
        messages: [{ role: 'user', content: 'hello' }],
        stream: false
      };
    } else {
      // Fallback for OpenAI, Ark, DeepSeek, Minimax, etc.
      testUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = {
        model: modelName,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 5,
        stream: false
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const startTime = Date.now();
    try {
      const resp = await fetch(testUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const latency = Date.now() - startTime;
      if (resp.ok) {
        return res.json({ success: true, message: '模型有效连通', latency });
      } else {
        const errorText = await (await resp.blob()).text();
        let errMsg = `HTTP ${resp.status} ${resp.statusText}`;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed.error?.message) errMsg += ` - ${parsed.error.message}`;
          else if (parsed.error) errMsg += ` - ${JSON.stringify(parsed.error)}`;
          else if (parsed.message) errMsg += ` - ${parsed.message}`;
        } catch {
          if (errorText.length > 0) errMsg += ` - ${errorText.substring(0, 100)}`;
        }
        return res.json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, errMsg));
      }
    } catch (e: any) {
      clearTimeout(timeoutId);
      return res.json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, e?.message || 'Network connection failed'));
    }
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, err?.message));
  }
});

app.get('/api/models/discover', async (req, res) => {
  try {
    const endpoint = req.query.endpoint as string;
    if (!endpoint) {
      return res.status(400).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, 'endpoint required'));
    }

    const endpoints = agentProvisioner.getEndpoints();
    const config = endpoints.find((e: any) => e.id === endpoint);
    if (!config) {
      return res.status(404).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, 'Endpoint not found'));
    }

    const baseUrl = config.baseUrl.replace(/\/$/, '');
    const apiKey = config.apiKey || '';
    const apiType = config.api.toLowerCase();

    let discoverUrl = '';
    const headers: any = {
      'Content-Type': 'application/json'
    };

    if (apiType.includes('anthropic')) {
      discoverUrl = `${baseUrl}/models`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (apiType.includes('gemini') || apiType.includes('google')) {
      discoverUrl = `${baseUrl}/models?key=${apiKey}`;
    } else if (apiType.includes('ollama')) {
      discoverUrl = `${baseUrl}/api/tags`;
    } else {
      // Fallback for OpenAI, Ark, DeepSeek, Minimax, etc.
      discoverUrl = `${baseUrl}/models`;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch(discoverUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errorText = await resp.text();
      return res.status(resp.status).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, `Failed to discover models: HTTP ${resp.status} - ${errorText.substring(0, 100)}`));
    }

    const data: any = await resp.json();
    let models: string[] = [];

    if (apiType.includes('ollama')) {
      if (data.models && Array.isArray(data.models)) {
        models = data.models.map((m: any) => m.name);
      }
    } else if (apiType.includes('gemini') || apiType.includes('google')) {
      if (data.models && Array.isArray(data.models)) {
        models = data.models.map((m: any) => m.name.replace('models/', ''));
      }
    } else {
      // OpenAI / Anthropic format
      if (data.data && Array.isArray(data.data)) {
        models = data.data.map((m: any) => m.id);
      } else if (Array.isArray(data)) {
         models = data.map((m: any) => m.id || m.name);
      }
    }

    return res.json({ success: true, models: models.filter(Boolean) });
  } catch (err: any) {
    return res.status(500).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, err?.message || 'Network error during discovery'));
  }
});

app.post('/api/models/manage', async (req, res) => {
  try {
    const { endpoint, modelName, alias, input } = req.body;
    if (!endpoint || !modelName) {
      return res.status(400).json(buildStructuredApiError(MODEL_CREATE_FAILED_ERROR_CODE, 'endpoint and modelName required'));
    }
    const success = await agentProvisioner.addModelConfig(endpoint, modelName, alias, Array.isArray(input) ? input : undefined);
    if (success) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true });
    }
    return res.status(400).json(buildStructuredApiError(MODEL_CREATE_FAILED_ERROR_CODE, 'Model may already exist or config invalid'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_CREATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.delete('/api/models/manage', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json(buildStructuredApiError(MODEL_DELETE_FAILED_ERROR_CODE, 'id required'));
    
    const success = await agentProvisioner.deleteModelConfig(id);
    if (success) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true });
    }
    return res.status(404).json(buildStructuredApiError(MODEL_DELETE_FAILED_ERROR_CODE, 'Model not found'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_DELETE_FAILED_ERROR_CODE, err?.message));
  }
});

app.put('/api/models/manage/default', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });

    const success = await agentProvisioner.setDefaultModel(id);
    if (success) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true });
    }
    return res.status(404).json({ success: false, error: 'Model not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/models/manage', async (req, res) => {
  try {
    const { id, alias, input } = req.body;
    if (!id) return res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'id required'));

    const success = await agentProvisioner.updateModelConfig(id, alias, Array.isArray(input) ? input : undefined);
    if (success) {
      return res.json({ success: true });
    }
    return res.status(404).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'Model not found'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.delete('/api/endpoints/manage', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, 'endpoint required'));

    const count = await agentProvisioner.deleteEndpointConfig(endpoint);
    if (count > 0) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true, deleted: count });
    }
    return res.status(404).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, 'Endpoint not found or no models under it'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, err?.message));
  }
});
app.get('/api/endpoints', (_req, res) => {
  try {
    const endpoints = agentProvisioner.getEndpoints();
    res.json({ success: true, endpoints });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/endpoints/test', async (req, res) => {
  try {
    const { baseUrl, apiKey, api } = req.body;
    if (!baseUrl || !api) {
      return res.status(400).json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, 'baseUrl and api are required'));
    }

    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const apiType = api.toLowerCase();

    let discoverUrl = '';
    const headers: any = {
      'Content-Type': 'application/json'
    };

    if (apiType.includes('anthropic')) {
      discoverUrl = `${cleanBaseUrl}/models`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (apiType.includes('gemini') || apiType.includes('google')) {
      discoverUrl = `${cleanBaseUrl}/models?key=${apiKey}`;
    } else if (apiType.includes('ollama')) {
      discoverUrl = `${cleanBaseUrl}/api/tags`;
    } else {
      discoverUrl = `${cleanBaseUrl}/models`;
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch(discoverUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (resp.ok) {
        return res.json({ success: true });
    } else {
        const errText = await resp.text();
        return res.json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, `Status ${resp.status}: ${errText.substring(0, 100)}`));
    }
  } catch (err: any) {
    return res.json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, err?.message || 'Connection failed'));
  }
});

app.post('/api/endpoints', async (req, res) => {
  try {
    const { id, baseUrl, apiKey, api } = req.body;
    if (!id || !baseUrl || !api) {
      return res.status(400).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, 'id, baseUrl, and api are required'));
    }

    const success = await agentProvisioner.saveEndpoint(id, { baseUrl, apiKey, api });
    if (success) {
      // Gateway auto-reloads config files on change
      return res.json({ success: true });
    }
    return res.status(400).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, 'Failed to save endpoint'));
  } catch (err: any) {
    res.status(500).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.get('/api/characters', (_req, res) => {
  let configReadFailed = false;
  const characters = db.getCharacters().map(char => {
    const diskSoul = agentProvisioner.readSoul(char.agentId);
    if (diskSoul !== null) {
      char.systemPrompt = diskSoul;
    }
    // Always read the actual model from openclaw.json (source of truth)——但配置读不动
    // 时退回旧的降级行为（保留数据库里已有的 char.model），不让整个列表 500。
    const { value: actualModel, configReadFailed: failed } = withConfigReadFallback(
      null,
      () => agentProvisioner.readAgentModel(char.agentId),
    );
    if (failed) configReadFailed = true;
    if (actualModel) {
      char.model = actualModel;
    }
    return char;
  });
  res.json({ success: true, characters, configReadFailed });
});

app.post('/api/characters', async (req, res) => {
  try {
    const char = req.body;
    if (!char.id) char.id = 'char_' + Date.now();

    // Validate agentId
    if (!char.agentId) {
      return res.status(400).json({ success: false, error: '智能体 ID 不能为空' });
    }
    if (/\s/.test(char.agentId)) {
      return res.status(400).json({ success: false, error: '智能体 ID 不允许包含空格' });
    }
    
    // Check for duplicate agentId (excluding the current character being edited)
    const existingChars = db.getCharacters();
    const isDuplicate = existingChars.some(c => c.agentId === char.agentId && c.id !== char.id);
    if (isDuplicate) {
      return res.status(400).json({ success: false, error: `智能体 ID "${char.agentId}" 已存在，请使用其他 ID` });
    }

    // Provision full isolated environment in OpenClaw (workspace, SOUL.md, USER.md, etc.)
    const configChanged = await agentProvisioner.provision({
      agentId: char.agentId,
      soulContent: char.systemPrompt,
      model: char.model,
    });
    
    // Also update SOUL.md if this is an existing character being re-saved
    if (!configChanged) {
      await agentProvisioner.updateSoul(char.agentId, char.systemPrompt);
      // Update model in config if changed
      const modelChanged = await agentProvisioner.updateModel(char.agentId, char.model);
      if (modelChanged) {
        // Gateway auto-reloads config
      }
    }
    
    db.saveCharacter(char);

    if (configChanged) {
        console.log('OpenClaw config changed for new agent, auto-reloading...');
    }

    res.json({ success: true, character: char });
  } catch (err: any) {
    res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.delete('/api/characters/:id', async (req, res) => {
  try {
    const character = db.getCharacters().find(c => c.id === req.params.id);
    if (!character) {
      return res.status(404).json({ success: false, error: 'Character not found' });
    }

    db.deleteCharacter(req.params.id);

    // Deprovision agent: remove from OpenClaw config + delete workspace & state dirs
    if (character.agentId && character.agentId !== 'main') {
      const configChanged = await agentProvisioner.deprovision(character.agentId);
      if (configChanged) {
        console.log(`Agent "${character.agentId}" fully removed, gateway auto-reloading...`);
      }
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting character:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// USER.md read/write API for per-character user profile
app.get('/api/characters/:agentId/user-md', (req, res) => {
  const content = agentProvisioner.readUserMd(req.params.agentId);
  res.json({ success: true, content });
});

app.put('/api/characters/:agentId/user-md', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing content' });
  }
  agentProvisioner.writeUserMd(req.params.agentId, content);
  res.json({ success: true });
});

app.get('/api/sessions', (_req, res) => {
  const sessions = sessionManager.getAllSessions();
  const sessionsWithModel = sessions.map(session => {
    // 配置读不动时退回旧的降级行为（model 空字符串、运行时设置退回默认值），
    // 不让整条列表 500——这里返回的是数组，没有顶层字段可挂标记位，所以
    // configReadFailed 挂在每一行上。
    const { value: runtimeSettingsValue, configReadFailed: runtimeFailed } = withConfigReadFallback(
      { runtimeMode: normalizeAgentRuntimeMode(session.runtime_mode), ...RUNTIME_SETTINGS_CONFIG_READ_FALLBACK },
      () => readEffectiveAgentRuntimeSettings(session, session.agentId),
    );
    const { value: model, configReadFailed: modelFailed } = withConfigReadFallback(
      '',
      () => agentProvisioner.readAgentModel(session.agentId) || '',
    );
    return {
      ...session,
      runtimeMode: runtimeSettingsValue.runtimeMode,
      systemPromptMode: runtimeSettingsValue.systemPromptMode,
      toolMode: runtimeSettingsValue.toolMode,
      model,
      configReadFailed: runtimeFailed || modelFailed,
    };
  });
  res.json(sessionsWithModel);
});

// ── 预设装配（内容层）────────────────────────────────────────────────────
// 「一键复制一支 AI 团队」的实际入口。装配分两条路，因为 API 只覆盖一半：
//   ① 建 Agent + 写 6 份 markdown（走 sessionManager + agentProvisioner，与手工建 Agent 同一条链路）
//   ② MEMORY.md / BOOTSTRAP.md / skills/ / reference/ / automations.sh 直接写工作区
// 详见 docs/preset-gap.md。

// ── 智能体 / 团队打包（.clawpack）─────────────────────────────────────────
// 把这台机器上的一个 Agent 或一个团队打成包发给别人，对方在自己的 ClawOPT 上装回去。
// 导入侧的三道闸门：路径白名单（agent-pack.ts）、装之前先预演、导入不执行任何东西。

const packUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PACK_BYTES } });

/** 这个字面量地址是不是内网/回环。 */
function isPrivateAddress(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '::' || host.endsWith('.local') || host.endsWith('.internal')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) || /^0\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)
    || /^::ffff:(127|10|0)\./.test(host)
    // 100.64/10 是运营商级 NAT，也是 Tailscale 等内网组网的常用段；
    // 198.18/15 是基准测试保留段，被一些代理与沙箱网络当作内部地址用。
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    || /^198\.1[89]\./.test(host);
}

/**
 * 主机名是否指向内网。字面量检查不够：`localtest.me`、`127.0.0.1.nip.io` 这类域名
 * 长得像公网，解析出来却是回环地址。所以还要把名字解出来再查一遍。
 *
 * 这挡不住 DNS rebinding（校验之后、连接之前改解析结果），那需要在连接层锁定 IP。
 * 这里堵的是随手就能用的那一类。
 */
async function resolvesToPrivateHost(hostname: string): Promise<string | null> {
  if (isPrivateAddress(hostname)) return hostname;
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const record of records) {
      if (isPrivateAddress(record.address)) return record.address;
    }
  } catch {
    // 解析不了的名字交给后续请求自己失败，不在这里下结论
  }
  return null;
}

/** 只允许 http/https 的公网地址；**重定向后的最终地址也要再查一次**。 */
function assertFetchableUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PackError(PACK_FETCH_FAILED_ERROR_CODE, rawUrl);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PackError(PACK_URL_BLOCKED_ERROR_CODE, parsed.protocol);
  }
  return parsed;
}

/** 语法检查 + 解析检查，两道都过才允许服务端去拉。 */
async function assertFetchableUrlResolved(rawUrl: string): Promise<URL> {
  const parsed = assertFetchableUrl(rawUrl);
  const privateAddress = await resolvesToPrivateHost(parsed.hostname);
  if (privateAddress !== null) {
    throw new PackError(PACK_URL_BLOCKED_ERROR_CODE, privateAddress);
  }
  return parsed;
}

/**
 * 拉取远端包。只允许 http/https 的公网地址。
 *
 * 只查首个地址是不够的：一个公网 URL 可以 302 到 127.0.0.1，服务端就成了跳板。
 * gist 的 /raw/ 本身就会跨主机跳到 gist.githubusercontent.com，所以这条路径上
 * 重定向是常态而不是异常——最终落点必须再查一次。
 */
async function fetchRemotePack(rawUrl: string): Promise<Buffer> {
  const parsed = await assertFetchableUrlResolved(rawUrl);

  const response = await axios.get<ArrayBuffer>(parsed.toString(), {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: MAX_PACK_BYTES,
    maxBodyLength: MAX_PACK_BYTES,
    maxRedirects: 3,
    validateStatus: status => status >= 200 && status < 300,
  });
  const finalUrl = (response.request as any)?.res?.responseUrl;
  if (typeof finalUrl === 'string' && finalUrl && finalUrl !== parsed.toString()) {
    await assertFetchableUrlResolved(finalUrl);
  }
  return Buffer.from(response.data);
}

/** 请求体或上传文件里取出包。两种入口，一套解析。 */
async function readPackFromRequest(req: express.Request): Promise<ClawPack> {
  const uploaded = (req as any).file as { buffer?: Buffer } | undefined;
  if (uploaded?.buffer?.length) {
    return parsePack(uploaded.buffer);
  }
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (url) {
    return parsePack(await fetchRemotePack(url));
  }
  throw new PackError(PACK_SOURCE_REQUIRED_ERROR_CODE);
}

function buildPackAgentEntry(agentId: string, displayName: string, options: any, warnings: PackWarning[]): PackAgent {
  const entry = buildAgentEntry(agentId, displayName, agentProvisioner.getWorkspacePath(agentId), options, warnings);
  const session = sessionManager.getSession(agentId);
  const runtimeSettings = readEffectiveAgentRuntimeSettings(session, agentId);
  entry.runtime = {
    runtimeMode: runtimeSettings.runtimeMode,
    systemPromptMode: runtimeSettings.systemPromptMode,
    toolMode: runtimeSettings.toolMode,
    processStartTag: session?.process_start_tag || '',
    processEndTag: session?.process_end_tag || '',
  };
  if (options.includeModelConfig) {
    const modelConfig = agentProvisioner.readAgentModelConfig(agentId);
    entry.model = {
      model: modelConfig.modelOverride,
      fallbackMode: modelConfig.fallbackMode,
      fallbacks: modelConfig.fallbacks,
    };
  }
  return entry;
}

/**
 * 按请求组装一个包。导出与分享共用同一条组装路径——两条路各拼一次的话，
 * 迟早出现「下载下来的包」和「分享出去的包」内容不一致。
 */
function buildPackFromRequest(body: any): { pack: ClawPack; name: string } | { error: string; params?: Record<string, string> } {
  const kind = body?.kind === 'team' ? 'team' : 'agent';
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const options = {
    includeMemory: body?.includeMemory === true,
    includeAutomations: body?.includeAutomations !== false,
    includeModelConfig: body?.includeModelConfig === true,
  };
  const warnings: PackWarning[] = [];

  let agents: PackAgent[] = [];
  let team: PackTeam | null = null;
  let name = '';
  let summary = '';

  if (kind === 'agent') {
    const session = sessionManager.getSession(id);
    if (!session) return { error: PACK_AGENT_NOT_FOUND_ERROR_CODE, params: { agentId: id } };
    agents = [buildPackAgentEntry(id, session.name, options, warnings)];
    name = session.name;
    summary = '';
  } else {
    const group = db.getGroupChat(id);
    if (!group) return { error: PACK_TEAM_NOT_FOUND_ERROR_CODE, params: { groupId: id } };
    const members = db.getGroupMembers(id);
    agents = members.map(member => {
      const session = sessionManager.getSession(member.agent_id);
      if (!session) {
        warnings.push({ code: 'memberMissing', detail: member.agent_id });
        return null;
      }
      return buildPackAgentEntry(member.agent_id, session.name, options, warnings);
    }).filter((entry): entry is PackAgent => entry !== null);
    team = {
      id: group.id,
      name: group.name,
      description: group.description || '',
      systemPrompt: group.system_prompt || '',
      processStartTag: group.process_start_tag || '',
      processEndTag: group.process_end_tag || '',
      maxChainDepth: group.max_chain_depth ?? 6,
      members: members.map((member, index) => ({
        agentId: member.agent_id,
        displayName: member.display_name,
        roleDescription: member.role_description || '',
        position: index,
      })),
    };
    name = group.name;
    summary = group.description || '';
  }

  if (!agents.length) return { error: PACK_AGENT_NOT_FOUND_ERROR_CODE, params: { agentId: id } };

  return {
    name,
    pack: buildPack({
      kind,
      name,
      summary,
      appVersion: getCurrentAppVersionInfo().version,
      agents,
      team,
      options,
      warnings,
    }),
  };
}

app.post('/api/packs/export', requireAdminAuth, async (req, res) => {
  try {
    const built = buildPackFromRequest(req.body);
    if ('error' in built) {
      return res.status(404).json(buildStructuredApiError(built.error, null, built.params || null));
    }
    const body = serializePack(built.pack);
    const fileName = `${sanitizeFileName(built.name)}.clawpack`;

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('X-Clawpack-Manifest', encodeURIComponent(JSON.stringify(built.pack.manifest)));
    res.send(body);
  } catch (error: any) {
    res.status(500).json(buildStructuredApiError(PRESET_INSTALL_FAILED_ERROR_CODE, error?.message || String(error)));
  }
});

/**
 * 分享：把包上传成一个**你自己账号下的**私密 gist，换一条链接回来。
 *
 * 为什么走 `gh` 而不是自建中转：托管成本、包的有效期、以及「别人上传的东西经我们
 * 的服务器分发」这份责任，都不该由本项目背。用分享者自己的 GitHub 账号，这三样
 * 一起消失，我们只负责把文件递过去。
 *
 * 上传的是**未压缩的 JSON**：gist 是文本载体，塞 gzip 二进制会被破坏；而 JSON 本身
 * 就是这个包格式的可读形态，对方在网页上就能看清里面有什么再决定装不装。
 * 导入侧的 parsePack 同时接受 gzip 与纯 JSON，两条路一份解析。
 */
app.post('/api/packs/share', requireAdminAuth, async (req, res) => {
  let tempPath = '';
  let tempDir = '';
  try {
    const built = buildPackFromRequest(req.body);
    if ('error' in built) {
      return res.status(404).json(buildStructuredApiError(built.error, null, built.params || null));
    }

    // 探针用 `gh api user` 而不是 `gh auth status`：后者在旧版 gh 里强制校验
    // `repo` + `read:org` 两个 scope，于是一个只带 `gist`（分享真正需要的那个）的
    // 令牌会被判成不可用——探针比它守护的操作更严，就会拦下本来能跑的调用。
    // `gh api user` 只要求令牌本身有效，与建 gist 的实际要求对齐。
    const ghReady = await new Promise<{ ok: boolean; detail: string }>(resolve => {
      const probe = spawn('gh', ['api', 'user', '-q', '.login']);
      let stderr = '';
      probe.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      probe.on('error', () => resolve({ ok: false, detail: 'notInstalled' }));
      probe.on('close', code => resolve({ ok: code === 0, detail: stderr.trim() }));
    });
    if (!ghReady.ok) {
      const code = ghReady.detail === 'notInstalled' ? PACK_GH_MISSING_ERROR_CODE : PACK_GH_UNAUTHENTICATED_ERROR_CODE;
      return res.status(400).json(buildStructuredApiError(code, ghReady.detail === 'notInstalled' ? null : ghReady.detail));
    }

    // 放进一个临时目录而不是给文件名加前缀：gist 里的文件名就是这个文件的 basename，
    // 对方看到的是「科学决策.clawpack.json」还是「clawpack-1787402967113-科学决策.clawpack.json」，
    // 差别全在这里。目录名带随机后缀足够避免撞车。
    const fileName = `${sanitizeFileName(built.name)}.clawpack.json`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpack-'));
    tempPath = path.join(tempDir, fileName);
    fs.writeFileSync(tempPath, JSON.stringify(built.pack, null, 1), 'utf-8');

    const manifest = built.pack.manifest;
    const description = `${built.pack.kind === 'team' ? 'ClawOPT team' : 'ClawOPT agent'}: ${built.name} · ${manifest.agentCount} agents · ${manifest.skillCount} skills`;

    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(resolve => {
      const proc = spawn('gh', ['gist', 'create', '--public=false', '--desc', description, tempPath]);
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', chunk => { stdout += chunk.toString(); });
      proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      proc.on('error', () => resolve({ stdout: '', stderr: 'spawn failed', code: 1 }));
      proc.on('close', code => resolve({ stdout, stderr, code }));
    });

    if (result.code !== 0) {
      return res.status(502).json(buildStructuredApiError(PACK_GIST_FAILED_ERROR_CODE, result.stderr.trim() || null));
    }

    const gistUrl = result.stdout.trim().split(/\s+/).pop() || '';
    if (!/^https:\/\/gist\.github\.com\//.test(gistUrl)) {
      return res.status(502).json(buildStructuredApiError(PACK_GIST_FAILED_ERROR_CODE, result.stdout.trim() || null));
    }
    // gist 的 /raw/<file> 会 302 到 gist.githubusercontent.com，导入侧照常拉得到
    const rawUrl = `${gistUrl}/raw/${path.basename(tempPath)}`;

    res.json({ success: true, gistUrl, rawUrl, manifest });
  } catch (error: any) {
    res.status(500).json(buildStructuredApiError(PACK_GIST_FAILED_ERROR_CODE, error?.message || String(error)));
  } finally {
    // 临时文件里是完整的智能体内容，别留在 /tmp
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch { /* 已经不在就算了 */ } }
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 同上 */ } }
  }
});

/** 预演：解析包、报清楚里面有什么、哪些 ID 会撞车。一个字节都不写。 */
app.post('/api/packs/inspect', requireAdminAuth, packUpload.single('file'), async (req, res) => {
  try {
    const pack = await readPackFromRequest(req);
    const agents = pack.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      skills: agent.skills,
      fileCount: agent.files.length,
      hasAutomations: agent.files.some(file => file.path === 'automations.sh'),
      hasMemory: agent.files.some(file => file.path === 'MEMORY.md'),
      conflict: Boolean(sessionManager.getSession(agent.id)),
      // 只报事实：这个显示名现在有没有人在用。会不会真的撞车取决于用户接下来
      // 是覆盖同一个 ID（不会多出一条）还是改名另存（会），那是前端才知道的事。
      nameConflict: sessionManager.getAllSessions().some(existing => existing.name === agent.name),
      soulPreview: readPackFile(agent, 'SOUL.md').slice(0, 400),
    }));
    res.json({
      success: true,
      kind: pack.kind,
      exportedAt: pack.exportedAt,
      exportedBy: pack.exportedBy,
      manifest: pack.manifest,
      team: pack.team ? { ...pack.team, conflict: Boolean(db.getGroupChat(pack.team.id)) } : null,
      agents,
    });
  } catch (error: any) {
    const code = error instanceof PackError ? error.code : PRESET_INSTALL_FAILED_ERROR_CODE;
    const detail = error instanceof PackError ? error.detail : (error?.message || String(error));
    res.status(400).json(buildStructuredApiError(code, detail || null));
  }
});

app.post('/api/packs/install', requireAdminAuth, packUpload.single('file'), async (req, res) => {
  try {
    const pack = await readPackFromRequest(req);
    const rawRename = req.body?.rename;
    const rename: Record<string, string> = typeof rawRename === 'string'
      ? JSON.parse(rawRename || '{}')
      : (rawRename && typeof rawRename === 'object' ? rawRename : {});
    const rawRenameNames = req.body?.renameNames;
    const renameNames: Record<string, string> = typeof rawRenameNames === 'string'
      ? JSON.parse(rawRenameNames || '{}')
      : (rawRenameNames && typeof rawRenameNames === 'object' ? rawRenameNames : {});
    const overwrite = req.body?.overwrite === true || req.body?.overwrite === 'true';
    const installTeam = req.body?.installTeam !== false && req.body?.installTeam !== 'false';
    const applyModel = req.body?.applyModel === true || req.body?.applyModel === 'true';

    const idMap: Record<string, string> = {};
    const results: any[] = [];

    for (const agent of pack.agents) {
      const requestedId = typeof rename[agent.id] === 'string' && rename[agent.id].trim() ? rename[agent.id].trim() : agent.id;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(requestedId)) {
        results.push({ sourceId: agent.id, targetId: requestedId, status: 'failed', error: 'invalid id' });
        continue;
      }
      const existing = sessionManager.getSession(requestedId);
      if (existing && !overwrite) {
        results.push({ sourceId: agent.id, targetId: requestedId, status: 'skipped', skills: agent.skills });
        continue;
      }
      const displayName = typeof renameNames[agent.id] === 'string' && renameNames[agent.id].trim()
        ? renameNames[agent.id].trim()
        : agent.name;
      try {
        if (!existing) {
          sessionManager.createSession({
            id: requestedId,
            name: displayName,
            process_start_tag: agent.runtime?.processStartTag,
            process_end_tag: agent.runtime?.processEndTag,
            runtime_mode: normalizeAgentRuntimeMode(agent.runtime?.runtimeMode),
            system_prompt_mode: normalizeAgentSystemPromptMode(agent.runtime?.systemPromptMode),
            tool_mode: normalizeAgentToolMode(agent.runtime?.toolMode),
          });
        }
        await agentProvisioner.provision({
          agentId: requestedId,
          identityContent: readPackFile(agent, 'IDENTITY.md') || undefined,
          soulContent: readPackFile(agent, 'SOUL.md') || undefined,
          agentsContent: readPackFile(agent, 'AGENTS.md') || undefined,
          userContent: readPackFile(agent, 'USER.md') || undefined,
          toolsContent: readPackFile(agent, 'TOOLS.md') || undefined,
          heartbeatContent: readPackFile(agent, 'HEARTBEAT.md') || undefined,
          model: applyModel ? (agent.model?.model || undefined) : undefined,
          fallbackMode: applyModel ? normalizeFallbackMode(agent.model?.fallbackMode) ?? 'inherit' : undefined,
          fallbacks: applyModel ? normalizeFallbackList(agent.model?.fallbacks) : undefined,
          systemPromptMode: normalizeAgentSystemPromptMode(agent.runtime?.systemPromptMode),
          toolMode: normalizeAgentToolMode(agent.runtime?.toolMode),
        });
        sessionManager.updateSession(requestedId, { agentId: requestedId, name: displayName });
        const written = writeAgentFiles(agent, agentProvisioner.getWorkspacePath(requestedId));
        idMap[agent.id] = requestedId;
        results.push({
          sourceId: agent.id,
          targetId: requestedId,
          targetName: displayName,
          status: existing ? 'updated' : 'created',
          fileCount: written,
          skills: agent.skills,
        });
      } catch (error: any) {
        results.push({ sourceId: agent.id, targetId: requestedId, status: 'failed', error: error?.message || String(error) });
      }
    }

    let teamResult: any = null;
    if (pack.kind === 'team' && pack.team && installTeam) {
      const sourceTeam = pack.team;
      const requestedTeamId = typeof rename[`team:${sourceTeam.id}`] === 'string' && rename[`team:${sourceTeam.id}`].trim()
        ? rename[`team:${sourceTeam.id}`].trim()
        : sourceTeam.id;
      const validation = validateGroupId(requestedTeamId);
      if (validation.issue) {
        teamResult = { targetId: requestedTeamId, status: 'failed', error: validation.issue };
      } else if (db.getGroupChat(validation.normalizedId) && !overwrite) {
        teamResult = { targetId: validation.normalizedId, status: 'skipped' };
      } else {
        const teamId = validation.normalizedId;
        const now = new Date().toISOString();
        const existingTeam = db.getGroupChat(teamId);
        const allGroups = db.getGroupChats();
        const maxPosition = allGroups.length > 0 ? Math.max(...allGroups.map(group => group.position || 0)) : -1;
        db.saveGroupChat({
          id: teamId,
          name: sourceTeam.name,
          description: sourceTeam.description || '',
          system_prompt: sourceTeam.systemPrompt || '',
          process_start_tag: sourceTeam.processStartTag || '',
          process_end_tag: sourceTeam.processEndTag || '',
          max_chain_depth: sourceTeam.maxChainDepth ?? 6,
          runtime_session_epoch: existingTeam?.runtime_session_epoch ?? createNextGroupRuntimeSessionEpoch(),
          position: existingTeam?.position ?? maxPosition + 1,
          created_at: existingTeam?.created_at || now,
          updated_at: now,
        });
        const members = sourceTeam.members
          .map(member => ({ ...member, targetId: idMap[member.agentId] }))
          .filter(member => Boolean(member.targetId));
        members.forEach((member, index) => {
          db.saveGroupMember({
            id: `gm_${teamId}_${member.targetId}`,
            group_id: teamId,
            agent_id: member.targetId as string,
            display_name: member.displayName || (member.targetId as string),
            role_description: member.roleDescription || '',
            position: index,
          });
        });
        ensureGroupWorkspace(teamId);
        teamResult = {
          targetId: teamId,
          status: existingTeam ? 'updated' : 'created',
          memberCount: members.length,
          droppedMembers: sourceTeam.members.length - members.length,
        };
      }
    }

    const failed = results.filter(result => result.status === 'failed');
    res.json({
      success: failed.length === 0,
      results,
      team: teamResult,
      manifest: pack.manifest,
    });
  } catch (error: any) {
    const code = error instanceof PackError ? error.code : PRESET_INSTALL_FAILED_ERROR_CODE;
    const detail = error instanceof PackError ? error.detail : (error?.message || String(error));
    res.status(400).json(buildStructuredApiError(code, detail || null));
  }
});

app.get('/api/presets', (_req, res) => {
  if (!presetsDirExists()) {
    return res.json({ success: true, presets: [] });
  }
  const summaries = listPresets().map(summary => {
    const detail = loadPreset(summary.id);
    // 坏掉的预设也回给前端：目录还占着这个 id，静默过滤会让界面上无迹可寻。
    if (!detail || summary.broken) {
      return {
        id: summary.id,
        name: summary.name,
        version: '',
        tagline: summary.tagline || '',
        description: '',
        author: '',
        roles: [],
        params: [],
        postInstall: [],
        broken: summary.broken || 'preset.json 无法读取',
      };
    }
    const roles = detail.roles.map(role => ({
      id: role.id,
      name: role.name,
      emoji: role.emoji || '',
      position: role.position || '',
      slogan: role.slogan || '',
      skills: role.skills || [],
      externalSkills: role.externalSkills || [],
      recommended: role.recommended !== false,
      note: role.note || '',
      installed: Boolean(sessionManager.getSession(role.id)),
    }));
    return {
      broken: undefined as string | undefined,
      id: detail.id,
      name: detail.name,
      version: detail.version || '',
      tagline: detail.tagline || '',
      description: detail.description || '',
      author: detail.author || '',
      roles,
      params: detail.params.map(param => ({
        key: param.key,
        label: param.label || param.key,
        hint: param.hint || '',
        default: param.default || '',
        examples: Array.isArray(param.examples) ? param.examples : [],
      })),
      postInstall: Array.isArray(detail.postInstall) ? detail.postInstall : [],
    };
  }).filter(Boolean);

  res.json({ success: true, presets: summaries });
});

app.post('/api/presets/:presetId/install', requireAdminAuth, async (req, res) => {
  const preset = loadPreset(req.params.presetId);
  if (!preset) {
    return res.status(404).json(buildStructuredApiError(PRESET_NOT_FOUND_ERROR_CODE, null, { presetId: req.params.presetId }));
  }

  const dryRun = req.body?.dryRun === true;
  const overwrite = req.body?.overwrite === true;
  const requestedIds: string[] = Array.isArray(req.body?.roleIds)
    ? req.body.roleIds.filter((id: unknown): id is string => typeof id === 'string')
    : [];
  const roles = requestedIds.length
    ? preset.roles.filter(role => requestedIds.includes(role.id))
    : preset.roles.filter(role => role.recommended !== false);

  if (!roles.length) {
    return res.status(400).json(buildStructuredApiError(PRESET_NO_ROLE_SELECTED_ERROR_CODE));
  }

  const vals = resolveParamValues(preset, req.body?.params);
  const results: any[] = [];

  for (const role of roles) {
    const workspaceDir = agentProvisioner.getWorkspacePath(role.id);
    const existing = sessionManager.getSession(role.id);
    const plan = planRole(preset.id, preset, role, vals, workspaceDir, Boolean(existing));

    if (dryRun) {
      results.push({ ...plan, status: existing ? (overwrite ? 'willUpdate' : 'willSkip') : 'willCreate' });
      continue;
    }

    if (existing && !overwrite) {
      results.push({ ...plan, status: 'skipped' });
      continue;
    }

    try {
      const payload = buildRolePayload(preset.id, role, vals);
      if (!existing) {
        sessionManager.createSession({ id: role.id, name: role.name });
      } else {
        sessionManager.updateSession(role.id, { name: role.name });
      }
      await agentProvisioner.provision({ agentId: role.id, ...payload });
      sessionManager.updateSession(role.id, { agentId: role.id });
      const written = writeWorkspaceExtras(preset.id, preset, role, vals, workspaceDir);
      results.push({ ...plan, workspaceFileCount: written, status: existing ? 'updated' : 'created' });
    } catch (error: any) {
      // 失败要把这一轮刚建的 session 撤掉。留着的话，下次重试会被判成
      // 「已存在 → 跳过」，界面还显示「已安装」——用户不勾覆盖就永远修不好。
      if (!existing) {
        try { sessionManager.deleteSession(role.id); } catch { /* 撤不掉就让结果里的失败信息说话 */ }
      }
      results.push({ ...plan, status: 'failed', error: error?.message || String(error) });
    }
  }

  const failed = results.filter(r => r.status === 'failed');
  res.json({
    success: failed.length === 0,
    dryRun,
    errorCode: failed.length ? PRESET_INSTALL_FAILED_ERROR_CODE : undefined,
    results,
    postInstall: Array.isArray(preset.postInstall) ? preset.postInstall : [],
  });
});

app.post('/api/sessions', async (req, res) => {
  const { id, name, soulContent, userContent, agentsContent, toolsContent, heartbeatContent, identityContent, model, process_start_tag, process_end_tag } = req.body;
  const fallbackMode = normalizeFallbackMode(req.body?.fallbackMode) ?? 'inherit';
  const fallbacks = normalizeFallbackList(req.body?.fallbacks);
  const runtimeMode = normalizeAgentRuntimeMode(req.body?.runtimeMode ?? req.body?.runtime_mode);
  const systemPromptMode = normalizeAgentSystemPromptMode(req.body?.systemPromptMode ?? req.body?.system_prompt_mode);
  const toolMode = normalizeAgentToolMode(req.body?.toolMode ?? req.body?.tool_mode);

  const rawId = typeof id === 'string' ? id : '';
  const normalizedId = rawId.trim();

  if (!normalizedId) {
    return res.status(400).json(buildStructuredApiError(AGENT_ID_REQUIRED_ERROR_CODE));
  }

  if (/\s/.test(rawId)) {
    return res.status(400).json(buildStructuredApiError(AGENT_ID_CONTAINS_WHITESPACE_ERROR_CODE));
  }

  if (sessionManager.getSession(normalizedId)) {
    return res.status(400).json(buildStructuredApiError(AGENT_ID_ALREADY_EXISTS_ERROR_CODE, null, { agentId: normalizedId }));
  }

  // Provide basic default for first session if it doesn't exist
  //
  // 这一步单独包一层 try：Express 4（backend/package.json 钉的 ^4.18.2）不会替
  // async handler 接管同步/异步抛错——如果 createSession() 留在下面那个大 try
  // 之外抛错，Express 4 既不会走 error middleware 也不会回一个响应，请求会一直
  // 悬挂到客户端超时，而不是拿到结构化的 400/500。装配失败的回滚逻辑（依赖
  // newSession 已经建好）留在下面第二层 try，不受影响。
  let newSession;
  try {
    newSession = sessionManager.createSession({
      id: normalizedId,
      name,
      process_start_tag,
      process_end_tag,
      runtime_mode: runtimeMode,
      system_prompt_mode: systemPromptMode,
      tool_mode: toolMode,
    });
  } catch (err: any) {
    return res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
  const agentId = newSession.id;

  try {
    // Provision agent workspace
    await agentProvisioner.provision({
      agentId,
      soulContent,
      userContent,
      agentsContent,
      toolsContent,
      heartbeatContent,
      identityContent,
      model,
      fallbackMode,
      fallbacks,
      systemPromptMode,
      toolMode,
    });

    // Update session record with the auto-generated agentId
    sessionManager.updateSession(newSession.id, { agentId });
    const finalSession = sessionManager.getSession(newSession.id);

    res.json({ success: true, session: finalSession });
  } catch (err: any) {
    // provision() 失败要把上面刚建的 session 撤掉（同一个模式见 9989 行的角色包装配）。
    // 留着就是个孤儿 session：这个 ID 已经"存在"，用户改完配置重试会被 10029 行
    // 的 AGENT_ID_ALREADY_EXISTS 挡住，永远重试不了同一个 ID。
    // 红线 C：回滚本身也可能失败——裸 catch {} 会让这条静默吞掉，用户看到的仍是
    // "配置读不动"，真正卡住他的却是那条删不掉的孤儿行，日志里一点痕迹都没有。
    // 这里必须出声：打日志，并把这件事写进错误响应，让用户知道该换个 ID 而不是
    // 反复用同一个 ID 重试。
    let rollbackFailed = false;
    try {
      sessionManager.deleteSession(newSession.id);
    } catch (rollbackErr) {
      rollbackFailed = true;
      console.error('[POST /api/sessions] 回滚孤儿 session 失败，该 ID 已被锁死：', newSession.id, rollbackErr);
    }

    // ConfigReadError 是"配置读不动"，不是"装配失败"这一件笼统的事——给它自己的
    // errorCode，而不是把它的中文 message 塞进 MODEL_UPDATE_FAILED 的 detail 里，
    // 让前端和这里的测试都能在 errorCode 上分辨出这是哪一种失败。
    if (err instanceof ConfigReadError) {
      const detail = rollbackFailed
        ? `${err.reason}: ${err.detail}（该 ID 未能撤销，请换一个 ID 或手动清理）`
        : `${err.reason}: ${err.detail}`;
      return res.status(500).json(
        buildStructuredApiError(AGENT_CONFIG_READ_FAILED_ERROR_CODE, detail),
      );
    }
    const detail = rollbackFailed
      ? `${err?.message}（该 ID 未能撤销，请换一个 ID 或手动清理）`
      : err?.message;
    res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, detail));
  }
});

app.put('/api/sessions/:id', async (req, res) => {
  const { name, soulContent, userContent, agentsContent, toolsContent, heartbeatContent, identityContent, model, process_start_tag, process_end_tag } = req.body;
  const fallbackMode = normalizeFallbackMode(req.body?.fallbackMode) ?? 'inherit';
  const fallbacks = normalizeFallbackList(req.body?.fallbacks);
  const runtimeMode = normalizeAgentRuntimeMode(req.body?.runtimeMode ?? req.body?.runtime_mode);
  const systemPromptMode = normalizeAgentSystemPromptMode(req.body?.systemPromptMode ?? req.body?.system_prompt_mode);
  const toolMode = normalizeAgentToolMode(req.body?.toolMode ?? req.body?.tool_mode);
  const session = sessionManager.getSession(req.params.id);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const updated = sessionManager.updateSession(req.params.id, {
      name,
      process_start_tag,
      process_end_tag,
      runtime_mode: runtimeMode,
      system_prompt_mode: systemPromptMode,
      tool_mode: toolMode,
    });
    
    if (session.agentId) {
      await agentProvisioner.updateSoul(session.agentId, soulContent || '');
      if (userContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'USER.md', userContent);
      if (agentsContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'AGENTS.md', agentsContent);
      if (toolsContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'TOOLS.md', toolsContent);
      if (heartbeatContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'HEARTBEAT.md', heartbeatContent);
      if (identityContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'IDENTITY.md', identityContent);
      
      // Model update might require gateway restart
      const modelChanged = await agentProvisioner.updateModel(session.agentId, model, { mode: fallbackMode, fallbacks });
      agentProvisioner.updateAgentRuntimeConfig(session.agentId, { systemPromptMode, toolMode });
      if (modelChanged) {
        // Gateway auto-reloads config
      }
    }

    res.json({ success: true, session: updated });
  } catch (err: any) {
    res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  if (session.id === 'main' || session.agentId === 'main') {
    return res.status(400).json({ success: false, error: 'Cannot delete the main agent session' });
  }

  const agentId = session.agentId;
  const interruptedEpoch = getSessionInterruptionEpoch(req.params.id);
  bumpSessionInterruptionEpoch(req.params.id);
  pendingChatPreparationManager.cancel(req.params.id, interruptedEpoch);
  localChatOperationManager.abort(req.params.id, interruptedEpoch);
  try {
    await activeRunManager.abortRun(req.params.id);
  } catch {}
  try {
    const client = await getConnection(req.params.id);
    await abortOpenClawSessionRuns(
      client,
      buildOpenClawChatSessionKey(req.params.id, agentId || 'main'),
      `session ${req.params.id} delete`,
      { retryOnMiss: true },
    );
  } catch (error) {
    console.warn(`[chat] Failed to abort orphan OpenClaw runs while deleting session ${req.params.id}:`, error);
  }
  disconnectConnection(req.params.id);
  const success = sessionManager.deleteSession(req.params.id);
  
  if (success) {
    sessionInterruptionEpochs.delete(req.params.id);
    if (agentId && agentId !== 'main') {
      // deprovision() 现在会对「配置读不动」抛 ConfigReadError（原来是静默
      // `return false`，于是这条路由报 200 success 而配置条目、工作区、状态目录、
      // 记忆库一个都没删）。这里必须接住：本路由此前**完全没有 try/catch**，
      // 一个异步抛错会变成未处理的 Promise 拒绝，请求悬着、进程可能被带崩。
      try {
        const configChanged = await agentProvisioner.deprovision(agentId);
        if (configChanged) {
          // Gateway auto-reloads config
        }
      } catch (error) {
        if (error instanceof ConfigReadError) {
          // session 行已经删掉了，但 openclaw.json 里的条目还在——如实说出来，
          // 不要报成完全成功。用户需要知道去修配置，否则那个 agentId 再也建不回来。
          console.error(
            `[DELETE /api/sessions/:id] session 已删除，但清理 openclaw.json 失败（${error.reason}）：`,
            req.params.id,
          );
          return res.status(500).json(
            buildStructuredApiError(AGENT_CONFIG_READ_FAILED_ERROR_CODE, error.detail, {
              reason: error.reason,
            }),
          );
        }
        throw error;
      }
    }
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// Reset session back to its initialized runtime state while keeping the session entity.
app.post('/api/sessions/:id/reset', async (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const agentId = session.agentId;
    const interruptedEpoch = getSessionInterruptionEpoch(req.params.id);
    bumpSessionInterruptionEpoch(req.params.id);
    pendingChatPreparationManager.cancel(req.params.id, interruptedEpoch);
    localChatOperationManager.abort(req.params.id, interruptedEpoch);

    try {
      await activeRunManager.abortRun(req.params.id);
    } catch {}
    try {
      const client = await getConnection(req.params.id);
      await abortOpenClawSessionRuns(
        client,
        buildOpenClawChatSessionKey(req.params.id, agentId || 'main'),
        `session ${req.params.id} reset`,
        { retryOnMiss: true },
      );
    } catch (error) {
      console.warn(`[chat] Failed to abort orphan OpenClaw runs while resetting session ${req.params.id}:`, error);
    }
    disconnectConnection(req.params.id);

    // Clear database records
    db.deleteMessagesBySession(req.params.id);
    clearStoredFilesBySessionKey(req.params.id);

    // Clear agent workspace uploads directory
    if (agentId) {
      const workspacePath = agentProvisioner.getWorkspacePath(agentId);
      const modelConfig = agentProvisioner.readAgentModelConfig(agentId);
      const runtimeConfig = agentProvisioner.readAgentRuntimeConfig(agentId);
      resetAgentWorkspaceToInitialState(workspacePath);
      resetAgentRuntimeStateToInitialState(agentId);
      await agentProvisioner.provision({
        agentId,
        workspaceDir: workspacePath,
        model: modelConfig.modelOverride || undefined,
        fallbackMode: modelConfig.fallbackMode,
        fallbacks: modelConfig.fallbacks,
        systemPromptMode: runtimeConfig.systemPromptMode,
        toolMode: runtimeConfig.toolMode,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to reset session:', err);
    res.status(500).json({ success: false, error: 'Failed to reset session' });
  }
});

// Endpoint to fetch all configuring MD files for a given session's agent
app.get('/api/sessions/:id/configs', async (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  const agentId = session.agentId;
  // 配置读不动时退回"没配模型"的旧降级形状，不让这条详情页整体 500——
  // 界面上其余六份 markdown 内容依然是真实数据，不该因为模型标签读不到就全部拿不到。
  const { value: modelConfig, configReadFailed: modelReadFailed } = withConfigReadFallback(
    { model: null, modelOverride: null, fallbackMode: 'inherit' as const, fallbacks: [] as string[], resolvedModel: null },
    () => agentProvisioner.readAgentModelConfig(agentId),
  );
  const { value: runtimeSettings, configReadFailed: runtimeReadFailed } = withConfigReadFallback(
    { runtimeMode: normalizeAgentRuntimeMode(session.runtime_mode), ...RUNTIME_SETTINGS_CONFIG_READ_FALLBACK },
    () => readEffectiveAgentRuntimeSettings(session, agentId),
  );
  const configReadFailed = modelReadFailed || runtimeReadFailed;
  const runtimeMetrics = agentProvisioner.readAgentRuntimeMetrics(agentId);
  res.json({
    success: true,
    configs: {
      soulContent: agentProvisioner.readSoul(agentId) || '',
      userContent: agentProvisioner.readAgentFile(agentId, 'USER.md', ''),
      agentsContent: agentProvisioner.readAgentFile(agentId, 'AGENTS.md', ''),
      toolsContent: agentProvisioner.readAgentFile(agentId, 'TOOLS.md', ''),
      heartbeatContent: agentProvisioner.readAgentFile(agentId, 'HEARTBEAT.md', ''),
      identityContent: agentProvisioner.readAgentFile(agentId, 'IDENTITY.md', ''),
      model: modelConfig.model,
      modelOverride: modelConfig.modelOverride,
      resolvedModel: modelConfig.resolvedModel,
      fallbackMode: modelConfig.fallbackMode,
      fallbacks: modelConfig.fallbacks,
      runtimeMode: runtimeSettings.runtimeMode,
      systemPromptMode: runtimeSettings.systemPromptMode,
      toolMode: runtimeSettings.toolMode,
      runtimeMetrics,
      configReadFailed,
    }
  });
});

app.post('/api/sessions/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) {
    return res.status(400).json({ success: false, error: 'Invalid ids format' });
  }
  sessionManager.reorderSessions(ids);
  res.json({ success: true });
});

app.get('/api/history/:sessionId', async (req, res) => {
  try {
    const { beforeId, limit } = getHistoryPageQueryParams(req.query as Record<string, unknown>);
    if (beforeId === null) {
      await reconcileInactiveChatLatestMessage(req.params.sessionId);
    }
    const result = db.getMessagesPage(req.params.sessionId, { beforeId, limit });
    res.json(buildHistoryPageResponse(
      result.rows.map((row) => withStructuredChatMessage(row, { sessionId: req.params.sessionId })),
      result.pageInfo,
    ));
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/history/:sessionId/search', (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(buildHistorySearchResponse(db.searchMessages(req.params.sessionId, query)));
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/chat/:sessionId/active-run', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const pendingPreparation = pendingChatPreparationManager.get(sessionId);
    const run = activeRunManager.getRun(sessionId);
    const localOperation = localChatOperationManager.get(sessionId);
    if (!run && !pendingPreparation && !localOperation) {
      await reconcileInactiveChatLatestMessage(sessionId);
    }
    const active = !!(run || pendingPreparation || localOperation);
    res.json({
      success: true,
      active,
      runState: {
        active,
        messageId: run?.messageId ?? pendingPreparation?.messageId ?? localOperation?.messageId ?? null,
        runId: run?.runId ?? null,
        agentId: run?.agentId ?? pendingPreparation?.agentId ?? localOperation?.agentId ?? null,
        startedAt: run?.startedAt ?? pendingPreparation?.startedAt ?? localOperation?.startedAt ?? null,
        kind: localOperation?.kind ?? (run ? 'openclaw-run' : (pendingPreparation ? 'openclaw-preparation' : null)),
      },
    });
  } catch (error: any) {
    res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to read chat run state.'));
  }
});

app.put('/api/messages/:id', (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  if (!content) return res.status(400).json({ success: false, error: 'Content is required' });
  try {
    db.updateMessageContent(Number(id), content);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/messages/:id', (req, res) => {
  const { id } = req.params;
  try {
    const deletedIds = db.deleteMessage(Number(id));
    res.json({ success: true, deletedIds });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

interface ActiveRun {
  sessionId: string;
  runId: string;
  agentId: string;
  agentName: string;
  modelUsed: string;
  messageId: number;
  startedAt: number;
  workspacePath: string;
  finalSessionKey: string;
  processStartTag?: string;
  processEndTag?: string;
  historySnapshot: ChatHistorySnapshot;
  rawText: string;
  text: string;
  modelProcessContent: string;
  modelProcessStreaming: boolean;
  toolProcessContent: string;
  processContent: string;
  processStreaming: boolean;
  clients: express.Response[]; // Active SSE clients listening to this run
  idleTimeout?: NodeJS.Timeout;
  completionProbeTimer?: NodeJS.Timeout;
  completionProbeInFlight?: boolean;
  completionProbePending?: boolean;
  firstCompletionWaitResolvedAt?: number;
  visibleFinalText?: string;
  visibleProcessContent?: string;
  visibleProcessStreaming?: boolean;
  finalEventText?: string;
  finalEventGeneration: number;
  settledCalibrationGeneration: number;
  latestFinalEventAt?: number;
  lastObservedHistoryLength: number;
  lastObservedHistorySignature: string;
  lastObservedHistoryActivityAt?: number;
  pendingErrorDetail?: string;
  toolProgressLines: string[];
  activeToolCallIds: Set<string>;
  toolProgressById: Map<string, GroupToolProgressState>;
  sessionEventsSubscribed?: boolean;
  clientRef?: OpenClawClient;
  cleanedUp?: boolean;
  gatewayReconnectTimer?: NodeJS.Timeout;
  gatewayReconnectInFlight?: boolean;
  gatewayDisconnectedAt?: number;
}

type SplitChatProcessOutputResult = {
  finalContent: string;
  processContent: string;
  processStreaming: boolean;
};

interface PendingChatPreparation {
  sessionId: string;
  epoch: number;
  messageId: number;
  agentId: string;
  agentName: string;
  modelUsed: string;
  startedAt: number;
  clients: express.Response[];
}

type LocalChatOperationKind = 'image-generation' | 'direct-runtime' | 'local';

interface LocalChatOperation {
  sessionId: string;
  epoch: number;
  messageId: number;
  agentId: string;
  agentName: string;
  modelUsed: string;
  startedAt: number;
  kind: LocalChatOperationKind;
  abortController?: AbortController;
  clients: express.Response[];
  cleanedUp?: boolean;
}

function resolveChatFinalTextSnapshot(text: string, message: any): string {
  if (isNonTerminalAssistantMessage(message)) {
    return '';
  }
  return selectPreferredTextSnapshot(text, extractOpenClawMessageText(message));
}

function warmManagedHostToolingInBackground() {
  void ensureManagedLocalAudioRuntimeReady().catch((error) => {
    console.error('Failed to prepare managed local audio transcription runtime:', error);
  });
  void ensureManagedDocumentToolingReady().catch((error) => {
    console.error('Failed to prepare managed document tooling runtime:', error);
  });
}

function isStreamingClientOpen(res: express.Response): boolean {
  return !res.writableEnded && !res.destroyed;
}

function isRecoverableGatewayDisconnectDetail(detail?: string | null): boolean {
  const normalized = normalizeCliText(detail);
  if (!normalized) return false;
  return /Client disconnected|connection is not open|ECONNREFUSED|ECONNRESET|EPIPE|gateway connect timeout|Gateway connect failed|WebSocket/i.test(normalized);
}

class PendingChatPreparationManager {
  private pending = new Map<string, PendingChatPreparation>();

  private matchesEpoch(preparation: PendingChatPreparation | undefined, expectedEpoch?: number): preparation is PendingChatPreparation {
    if (!preparation) return false;
    return expectedEpoch === undefined || preparation.epoch === expectedEpoch;
  }

  get(sessionId: string, expectedEpoch?: number): PendingChatPreparation | undefined {
    const preparation = this.pending.get(sessionId);
    return this.matchesEpoch(preparation, expectedEpoch) ? preparation : undefined;
  }

  start(preparation: Omit<PendingChatPreparation, 'clients'>): PendingChatPreparation {
    const nextPreparation: PendingChatPreparation = {
      ...preparation,
      clients: [],
    };
    this.pending.set(preparation.sessionId, nextPreparation);
    return nextPreparation;
  }

  attachClient(sessionId: string, res: express.Response, options?: { announceAttach?: boolean; expectedEpoch?: number }): boolean {
    const preparation = this.get(sessionId, options?.expectedEpoch);
    if (!preparation || !isStreamingClientOpen(res)) return false;

    preparation.clients.push(res);
    res.on('close', () => {
      const current = this.get(sessionId, preparation.epoch);
      if (!current) return;
      current.clients = current.clients.filter((client) => client !== res);
    });
    if (options?.announceAttach) {
      res.write(`data: ${JSON.stringify({
        type: 'attached',
        messageId: preparation.messageId,
        agentId: preparation.agentId,
        agentName: preparation.agentName,
        modelUsed: preparation.modelUsed,
      })}\n\n`);
    }
    return true;
  }

  promoteClients(sessionId: string, expectedEpoch?: number): express.Response[] {
    const preparation = this.get(sessionId, expectedEpoch);
    if (!preparation) return [];
    this.pending.delete(sessionId);
    return preparation.clients.filter((client) => isStreamingClientOpen(client));
  }

  cancel(sessionId: string, expectedEpoch?: number) {
    const preparation = this.get(sessionId, expectedEpoch);
    if (!preparation) return;

    this.pending.delete(sessionId);
    preparation.clients
      .filter((client) => isStreamingClientOpen(client))
      .forEach((res) => {
        try {
          res.end();
        } catch {}
      });
  }

  fail(sessionId: string, payload: {
    content: string;
    messageCode?: string;
    messageParams?: Record<string, any>;
    rawDetail?: string | null;
    role: string;
  }, expectedEpoch?: number) {
    const preparation = this.get(sessionId, expectedEpoch);
    if (!preparation) return;

    this.pending.delete(sessionId);
    preparation.clients
      .filter((client) => isStreamingClientOpen(client))
      .forEach((res) => {
        try {
          res.write(`data: ${JSON.stringify({
            type: 'error',
            text: payload.content,
            messageCode: payload.messageCode,
            messageParams: payload.messageParams,
            rawDetail: payload.rawDetail,
            role: payload.role,
          })}\n\n`);
          res.end();
        } catch {}
      });
  }
}

class LocalChatOperationManager {
  private operations = new Map<string, LocalChatOperation>();

  private matchesEpoch(operation: LocalChatOperation | undefined, expectedEpoch?: number): operation is LocalChatOperation {
    if (!operation) return false;
    return expectedEpoch === undefined || operation.epoch === expectedEpoch;
  }

  get(sessionId: string, expectedEpoch?: number): LocalChatOperation | undefined {
    const operation = this.operations.get(sessionId);
    return this.matchesEpoch(operation, expectedEpoch) ? operation : undefined;
  }

  start(operation: Omit<LocalChatOperation, 'clients'>): LocalChatOperation {
    const previous = this.operations.get(operation.sessionId);
    if (previous) {
      previous.abortController?.abort();
      this.cleanup(previous);
    }

    const nextOperation: LocalChatOperation = {
      ...operation,
      clients: [],
    };
    this.operations.set(operation.sessionId, nextOperation);
    return nextOperation;
  }

  attachClient(sessionId: string, res: express.Response, options?: { announceAttach?: boolean; expectedEpoch?: number }): boolean {
    const operation = this.get(sessionId, options?.expectedEpoch);
    if (!operation || !isStreamingClientOpen(res)) return false;

    operation.clients.push(res);
    res.on('close', () => {
      const current = this.get(sessionId, operation.epoch);
      if (!current) return;
      current.clients = current.clients.filter((client) => client !== res);
    });

    if (options?.announceAttach) {
      res.write(`data: ${JSON.stringify({
        type: 'attached',
        messageId: operation.messageId,
        agentId: operation.agentId,
        agentName: operation.agentName,
        modelUsed: operation.modelUsed,
      })}\n\n`);
    }

    return true;
  }

  emit(sessionId: string, event: Record<string, unknown>, expectedEpoch?: number): void {
    const operation = this.get(sessionId, expectedEpoch);
    if (!operation) return;

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    operation.clients = operation.clients.filter((res) => {
      if (!isStreamingClientOpen(res)) return false;
      try {
        res.write(payload);
        return isStreamingClientOpen(res);
      } catch {
        return false;
      }
    });
  }

  finish(sessionId: string, expectedEpoch?: number): void {
    const operation = this.get(sessionId, expectedEpoch);
    if (!operation) return;
    this.cleanup(operation);
  }

  abort(sessionId: string, expectedEpoch?: number): { aborted: boolean } {
    const operation = this.get(sessionId, expectedEpoch);
    if (!operation) return { aborted: false };

    operation.abortController?.abort();
    this.cleanup(operation);
    return { aborted: true };
  }

  private cleanup(operation: LocalChatOperation): void {
    if (operation.cleanedUp) {
      if (this.operations.get(operation.sessionId) === operation) {
        this.operations.delete(operation.sessionId);
      }
      return;
    }

    operation.cleanedUp = true;
    operation.clients
      .filter((client) => isStreamingClientOpen(client))
      .forEach((res) => {
        try {
          res.end();
        } catch {}
      });
    operation.clients = [];
    if (this.operations.get(operation.sessionId) === operation) {
      this.operations.delete(operation.sessionId);
    }
  }
}

class ActiveRunManager {
  private runs = new Map<string, ActiveRun>();
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  getRun(sessionId: string): ActiveRun | undefined {
    return this.runs.get(sessionId);
  }

  private writeRunEvent(run: ActiveRun, payload: Record<string, unknown>, options?: { end?: boolean }) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    run.clients = run.clients.filter((res) => {
      if (!isStreamingClientOpen(res)) {
        return false;
      }

      try {
        res.write(frame);
        if (options?.end) {
          res.end();
          return false;
        }
        return isStreamingClientOpen(res);
      } catch {
        return false;
      }
    });
  }

  private writeSingleRunEvent(res: express.Response, payload: Record<string, unknown>, options?: { end?: boolean }): boolean {
    if (!isStreamingClientOpen(res)) return false;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (options?.end) {
        res.end();
        return false;
      }
      return isStreamingClientOpen(res);
    } catch {
      return false;
    }
  }

  private persistVisibleSnapshot(run: ActiveRun, visible: { text: string; process_content: string; process_streaming: boolean }) {
    this.db.updateMessage(
      run.messageId,
      visible.text,
      run.modelUsed,
      visible.process_content,
      visible.process_streaming,
    );
  }

  private scheduleGatewayReconnectProbe(run: ActiveRun, delay = CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS) {
    if (!this.isCurrentRun(run) || !run.clientRef) return;
    run.gatewayDisconnectedAt = run.gatewayDisconnectedAt ?? Date.now();
    if (run.gatewayReconnectTimer) {
      clearTimeout(run.gatewayReconnectTimer);
    }
    run.gatewayReconnectTimer = setTimeout(() => {
      run.gatewayReconnectTimer = undefined;
      if (!this.isCurrentRun(run) || run.gatewayReconnectInFlight || !run.clientRef) {
        return;
      }

      run.gatewayReconnectInFlight = true;
      void run.clientRef.connect()
        .then(async () => {
          if (!this.isCurrentRun(run) || !run.clientRef) return;
          connections.set(run.sessionId, run.clientRef);
          run.gatewayDisconnectedAt = undefined;
          if (isRecoverableGatewayDisconnectDetail(run.pendingErrorDetail)) {
            run.pendingErrorDetail = undefined;
          }
          if (run.sessionEventsSubscribed) {
            try {
              await run.clientRef.subscribeSessionEvents();
            } catch (error) {
              console.warn(`[chat] Failed to resubscribe session events after gateway reconnect for session ${run.sessionId}:`, error);
            }
          }
          this.scheduleCompletionProbe(run, 0);
        })
        .catch((error) => {
          if (!this.isCurrentRun(run)) return;
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[chat] Waiting for gateway reconnect for session ${run.sessionId}, run ${run.runId}: ${detail}`);
          this.scheduleGatewayReconnectProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_RETRY_DELAY_MS);
        })
        .finally(() => {
          run.gatewayReconnectInFlight = false;
        });
    }, delay);
    run.gatewayReconnectTimer.unref?.();
  }

  private isCurrentRun(run: ActiveRun | undefined): run is ActiveRun {
    if (!run) return false;
    const current = this.runs.get(run.sessionId);
    return !!current && current.runId === run.runId && current.messageId === run.messageId;
  }

  async abortRun(sessionId: string): Promise<{ aborted: boolean }> {
    const run = this.runs.get(sessionId);
    if (!run || !run.clientRef) {
      return { aborted: false };
    }

    const clientRef = run.clientRef;
    let aborted = false;
    try {
      const result = await clientRef.abortChat({
        sessionKey: run.finalSessionKey,
        runId: run.runId,
        timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
      });
      aborted = result.aborted;
      if (!result.aborted) {
        scheduleOpenClawSessionAbortRetry(
          clientRef,
          run.finalSessionKey,
          `active run ${run.runId} for session ${sessionId}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[chat] Failed to abort active OpenClaw run ${run.runId} for session ${sessionId}: ${detail}`);
      scheduleOpenClawSessionAbortRetry(
        clientRef,
        run.finalSessionKey,
        `active run ${run.runId} for session ${sessionId}`,
      );
    }

    const canonicalText = canonicalizeAssistantWorkspaceArtifacts(run.text || '', {
      workspacePath: run.workspacePath,
      startedAtMs: run.startedAt,
    });
    const rewritten = rewriteOpenClawMediaPaths(canonicalText, run.workspacePath);
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(run.processContent || '', run.workspacePath);
    this.db.updateMessage(run.messageId, rewritten, run.modelUsed, rewrittenProcessContent, false);

    this.writeRunEvent(run, {
      type: 'final',
      text: rewritten,
      process_content: rewrittenProcessContent,
      process_streaming: false,
    }, { end: true });

    this.cleanupRun(run);
    return { aborted };
  }

  private applyRawTextSnapshot(
    run: ActiveRun,
    candidateText?: string | null,
    options?: { allowShorterReplacement?: boolean },
  ) {
    const nextRawText = selectPreferredTextSnapshot(run.rawText, candidateText, options);
    const rawChanged = nextRawText !== run.rawText;
    if (rawChanged) {
      run.rawText = nextRawText;
    }

    const splitOutput = splitChatProcessOutput(run.rawText, run.processStartTag, run.processEndTag);
    run.text = splitOutput.finalContent;
    run.modelProcessContent = splitOutput.processContent;
    run.modelProcessStreaming = splitOutput.processStreaming;
    run.processContent = combineChatProcessContent(run.toolProcessContent, run.modelProcessContent);
    run.processStreaming = run.modelProcessStreaming || run.activeToolCallIds.size > 0;
    return rawChanged;
  }

  private buildVisibleChatPatch(run: ActiveRun, content: string, processContent = run.processContent, processStreaming = run.processStreaming) {
    const rewritten = rewriteOpenClawMediaPaths(content, run.workspacePath);
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(processContent, run.workspacePath);
    return {
      text: rewritten,
      process_content: rewrittenProcessContent,
      process_streaming: processStreaming,
    };
  }

  private emitVisibleDelta(run: ActiveRun, options?: { force?: boolean }) {
    const visible = this.buildVisibleChatPatch(run, run.text);
    const didVisibleChange = visible.text !== run.visibleFinalText
      || visible.process_content !== run.visibleProcessContent
      || visible.process_streaming !== run.visibleProcessStreaming;

    if (!options?.force && !didVisibleChange) {
      return;
    }

    run.visibleFinalText = visible.text;
    run.visibleProcessContent = visible.process_content;
    run.visibleProcessStreaming = visible.process_streaming;
    this.persistVisibleSnapshot(run, visible);
    this.writeRunEvent(run, { type: 'delta', ...visible });
  }

  private emitVisibleFinal(run: ActiveRun, finalText: string, options?: { end?: boolean; allowShorterReplacement?: boolean }) {
    this.applyRawTextSnapshot(run, finalText, {
      allowShorterReplacement: options?.allowShorterReplacement,
    });
    const canonicalText = options?.end
      ? canonicalizeAssistantWorkspaceArtifacts(run.text, {
          workspacePath: run.workspacePath,
          startedAtMs: run.startedAt,
        })
      : run.text;
    const visible = this.buildVisibleChatPatch(run, canonicalText, run.processContent, options?.end ? false : run.processStreaming);
    const nextVisibleFinalText = selectPreferredTextSnapshot(run.visibleFinalText, visible.text, {
      allowShorterReplacement: options?.allowShorterReplacement,
    });
    const nextVisibleProcessContent = selectPreferredTextSnapshot(run.visibleProcessContent, visible.process_content);
    if (!nextVisibleFinalText.trim() && !nextVisibleProcessContent.trim()) {
      if (options?.end) {
        this.persistVisibleSnapshot(run, {
          text: nextVisibleFinalText,
          process_content: nextVisibleProcessContent,
          process_streaming: false,
        });
        this.writeRunEvent(run, {
          type: 'final',
          text: nextVisibleFinalText,
          process_content: nextVisibleProcessContent,
          process_streaming: false,
        }, { end: true });
      }
      return '';
    }

    const shouldSendFinalEvent = !!options?.end
      || run.visibleFinalText !== nextVisibleFinalText
      || run.visibleProcessContent !== nextVisibleProcessContent
      || run.visibleProcessStreaming !== visible.process_streaming;
    if (shouldSendFinalEvent) {
      run.visibleFinalText = nextVisibleFinalText;
      run.visibleProcessContent = nextVisibleProcessContent;
      run.visibleProcessStreaming = visible.process_streaming;
      const eventPayload = {
        type: 'final',
        text: nextVisibleFinalText,
        process_content: nextVisibleProcessContent,
        process_streaming: visible.process_streaming,
      };
      this.persistVisibleSnapshot(run, eventPayload);
      this.writeRunEvent(run, eventPayload, { end: options?.end });
      return nextVisibleFinalText;
    }

    if (options?.end) {
      this.persistVisibleSnapshot(run, {
        text: nextVisibleFinalText,
        process_content: nextVisibleProcessContent,
        process_streaming: false,
      });
      this.writeRunEvent(run, {
        type: 'final',
        text: nextVisibleFinalText,
        process_content: nextVisibleProcessContent,
        process_streaming: false,
      }, { end: true });
    }

    return nextVisibleFinalText;
  }

  startRun(
    sessionId: string,
    runId: string,
    agentId: string,
    agentName: string,
    modelUsed: string,
    messageId: number,
    workspacePath: string,
    clientRef: OpenClawClient,
    finalSessionKey: string,
    historySnapshot: ChatHistorySnapshot,
    processStartTag?: string,
    processEndTag?: string,
    sessionEventsSubscribed = false
  ): ActiveRun {
    const run: ActiveRun = {
      sessionId,
      runId,
      agentId,
      agentName,
      modelUsed,
      messageId,
      startedAt: Date.now(),
      workspacePath,
      finalSessionKey,
      processStartTag,
      processEndTag,
      historySnapshot,
      rawText: '',
      text: '',
      modelProcessContent: '',
      modelProcessStreaming: false,
      toolProcessContent: '',
      processContent: '',
      processStreaming: !!(processStartTag && processEndTag),
      clients: [],
      completionProbePending: false,
      firstCompletionWaitResolvedAt: undefined,
      finalEventGeneration: 0,
      settledCalibrationGeneration: 0,
      latestFinalEventAt: undefined,
      lastObservedHistoryLength: historySnapshot.length,
      lastObservedHistorySignature: historySnapshot.latestSignature,
      lastObservedHistoryActivityAt: undefined,
      pendingErrorDetail: undefined,
      toolProgressLines: [],
      activeToolCallIds: new Set<string>(),
      toolProgressById: new Map<string, GroupToolProgressState>(),
      sessionEventsSubscribed,
      clientRef
    };
    this.runs.set(sessionId, run);
    this.resetIdleTimeout(run);

    const onDelta = (data: { sessionKey: string; runId: string; text: string }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        this.resetIdleTimeout(run);
        const didTextChange = this.applyRawTextSnapshot(run, data.text);
        if (!didTextChange) {
          return;
        }
        this.emitVisibleDelta(run);
      }
    };

    const onFinal = (data: { sessionKey: string; runId: string; text: string; message: any }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        const finalEventObservedAt = Date.now();
        const terminalFinalText = resolveChatFinalTextSnapshot(data.text, data.message);
        if (terminalFinalText) {
          run.finalEventText = selectPreferredTextSnapshot(run.finalEventText, terminalFinalText, {
            allowShorterReplacement: true,
          });
          this.applyRawTextSnapshot(run, terminalFinalText, {
            allowShorterReplacement: true,
          });
          run.latestFinalEventAt = finalEventObservedAt;
          run.finalEventGeneration += 1;
          this.emitVisibleFinal(run, run.finalEventText || run.rawText, {
            allowShorterReplacement: true,
          });
        } else if (data.text) {
          this.applyRawTextSnapshot(run, data.text);
          this.emitVisibleDelta(run);
        }
        this.resetIdleTimeout(run);
        this.scheduleCompletionProbe(run, 0);
      }
    };

    const onAborted = (data: { sessionKey: string; runId: string; text: string }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        if (data.text) {
          this.applyRawTextSnapshot(run, data.text);
          this.emitVisibleDelta(run);
        }
        this.scheduleCompletionProbe(run, 0);
      }
    };

    const onError = (data: { sessionKey: string; runId: string; error: string }) => {
      if (this.matchesRunEvent(run, data.sessionKey, data.runId)) {
        const detail = normalizeCliText(data.error) || 'Unknown stream error';
        this.resetIdleTimeout(run);
        if (isRecoverableGatewayDisconnectDetail(detail)) {
          this.scheduleGatewayReconnectProbe(run);
          this.scheduleCompletionProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
          return;
        }
        run.pendingErrorDetail = detail;
        this.scheduleCompletionProbe(run, 0);
      }
    };

    const onSessionTool = (payload: {
      sessionKey?: string;
      parentSessionKey?: string;
      runId?: string;
      data?: any;
    }) => {
      const isRelevant = payload.runId === run.runId
        || this.matchesRunEvent(run, payload.sessionKey || '', payload.runId)
        || payload.parentSessionKey === run.finalSessionKey;
      if (!isRelevant) {
        return;
      }

      const eventData = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? payload.data as Record<string, unknown>
        : {};
      const toolName = typeof eventData.name === 'string' && eventData.name.trim()
        ? eventData.name.trim()
        : 'tool';
      const toolCallId = typeof eventData.toolCallId === 'string' && eventData.toolCallId.trim()
        ? eventData.toolCallId.trim()
        : `${payload.runId || run.runId}:${toolName}`;
      const phase = typeof eventData.phase === 'string' ? eventData.phase.trim() : '';
      const existingState = run.toolProgressById.get(toolCallId);
      const nextArgs = normalizeToolArgsRecord(eventData.args) ?? existingState?.args;
      const nextState: GroupToolProgressState = existingState ?? {
        toolName,
        args: nextArgs,
      };
      nextState.toolName = toolName;
      nextState.args = nextArgs;

      const progressLocale = normalizeGroupToolProgressLocale(configManager.getConfig().language);
      if (phase === 'start') {
        run.activeToolCallIds.add(toolCallId);
        appendToolProgressLine(run.toolProgressLines, formatToolStartProgress(progressLocale, toolName, nextArgs));
      } else if (phase === 'update') {
        run.activeToolCallIds.add(toolCallId);
      } else if (phase === 'result') {
        run.activeToolCallIds.delete(toolCallId);
        appendToolProgressLine(run.toolProgressLines, formatToolResultProgress(
          progressLocale,
          toolName,
          nextArgs,
          eventData.isError === true,
        ));
      } else {
        return;
      }

      run.toolProcessContent = run.toolProgressLines.join('\n');
      if (phase === 'result') {
        run.toolProgressById.delete(toolCallId);
      } else {
        run.toolProgressById.set(toolCallId, nextState);
      }
      this.applyRawTextSnapshot(run);
      this.emitVisibleDelta(run, { force: true });
      this.resetIdleTimeout(run);
    };

    const onDisconnect = () => {
      this.scheduleGatewayReconnectProbe(run);
      this.scheduleCompletionProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
    };

    clientRef.on('chat.delta', onDelta);
    clientRef.on('chat.final', onFinal);
    clientRef.on('chat.aborted', onAborted);
    clientRef.on('chat.error', onError);
    clientRef.on('session.tool', onSessionTool);
    clientRef.on('disconnected', onDisconnect);

    // Attach listeners to run for easy cleanup
    (run as any)._onDelta = onDelta;
    (run as any)._onFinal = onFinal;
    (run as any)._onAborted = onAborted;
    (run as any)._onError = onError;
    (run as any)._onSessionTool = onSessionTool;
    (run as any)._onDisconnect = onDisconnect;

    this.scheduleCompletionProbe(run);

    return run;
  }

  attachClient(sessionId: string, res: express.Response, options?: { announceAttach?: boolean }) {
    if (!isStreamingClientOpen(res)) {
      return false;
    }

    const run = this.runs.get(sessionId);
    if (run) {
      run.clients.push(res);
      if (options?.announceAttach) {
        this.writeSingleRunEvent(res, {
          type: 'attached',
          messageId: run.messageId,
          agentId: run.agentId,
          agentName: run.agentName,
          modelUsed: run.modelUsed,
        });
      }
      if (run.visibleFinalText || run.visibleProcessContent) {
        this.writeSingleRunEvent(res, {
          type: 'final',
          text: run.visibleFinalText || '',
          process_content: run.visibleProcessContent || '',
          process_streaming: !!run.visibleProcessStreaming,
        });
      } else if (run.text || run.processContent || run.processStreaming) {
        const visible = this.buildVisibleChatPatch(run, run.text);
        this.writeSingleRunEvent(res, { type: 'delta', ...visible });
      }
      res.on('close', () => {
        run.clients = run.clients.filter(c => c !== res);
      });
      return true;
    }
    return false;
  }

  private resetIdleTimeout(run: ActiveRun) {
    if (run.idleTimeout) clearTimeout(run.idleTimeout);
    run.idleTimeout = setTimeout(() => {
      if (!this.isCurrentRun(run)) {
        this.cleanupRun(run);
        return;
      }
      const errorMsg = run.rawText ? 'Response interrupted (idle timeout).' : 'Response timed out (no connection).';
      const finalText = run.rawText || errorMsg;
      this.applyRawTextSnapshot(run, finalText);
      const canonicalText = canonicalizeAssistantWorkspaceArtifacts(run.text, {
        workspacePath: run.workspacePath,
        startedAtMs: run.startedAt,
      });
      const rewritten = rewriteOpenClawMediaPaths(canonicalText, run.workspacePath);
      const rewrittenProcessContent = rewriteOpenClawMediaPaths(run.processContent, run.workspacePath);
      
      this.db.updateMessage(run.messageId, rewritten, run.modelUsed, rewrittenProcessContent, false);
      this.emitVisibleFinal(run, finalText, { end: true });
      this.abortUnderlyingRunBestEffort(run, 'idle timeout');
      this.cleanupRun(run);
    }, 600000); // 10 minutes
  }

  private matchesRunEvent(run: ActiveRun, sessionKey: string, runId?: string | null) {
    if (runId && runId !== run.runId) {
      return false;
    }
    return sessionKey === run.finalSessionKey
      || sessionKey === run.sessionId
      || sessionKey.endsWith(`:${run.sessionId}`)
      || sessionKey.includes(`:chat:${run.sessionId}`);
  }

  private hasAnyRunEvidence(run: ActiveRun) {
    return !!(
      run.rawText.trim()
      || run.finalEventText?.trim()
      || run.processContent.trim()
      || run.pendingErrorDetail?.trim()
      || run.lastObservedHistoryActivityAt !== undefined
    );
  }

  private scheduleCompletionProbe(run: ActiveRun, delay = CHAT_STREAM_COMPLETION_PROBE_DELAY_MS) {
    if (!this.isCurrentRun(run)) return;
    run.completionProbePending = true;
    if (run.completionProbeTimer) {
      clearTimeout(run.completionProbeTimer);
    }
    run.completionProbeTimer = setTimeout(() => {
      run.completionProbeTimer = undefined;
      if (run.completionProbeInFlight) {
        return;
      }
      run.completionProbePending = false;
      void this.probeCompletion(run);
    }, delay);
  }

  private async probeCompletion(run: ActiveRun) {
    if (!this.isCurrentRun(run) || run.completionProbeInFlight || !run.clientRef) {
      return;
    }

    run.completionProbeInFlight = true;
    const probeFinalGeneration = run.finalEventGeneration;
    const pendingErrorDetail = normalizeCliText(run.pendingErrorDetail) || '';

    try {
      await run.clientRef.waitForRun(run.runId, CHAT_STREAM_COMPLETION_WAIT_TIMEOUT_MS);
      if (run.firstCompletionWaitResolvedAt === undefined) {
        run.firstCompletionWaitResolvedAt = Date.now();
      }
      if (!this.isCurrentRun(run)) return;

      const hasFinalEventText = () => !!run.finalEventText?.trim();
      let completedOutput = selectPreferredTextSnapshot(run.rawText, run.finalEventText, {
        allowShorterReplacement: hasFinalEventText(),
      });
      let settledErrorDetail = '';
      let shouldRetryForEmptyCompletion = false;
      let sawSettledAssistantText = false;
      let bestSettledAssistantText = '';
      const visibleFinalGraceDeadline = probeFinalGeneration > 0
        && completedOutput.trim()
        && run.latestFinalEventAt !== undefined
        ? run.latestFinalEventAt + CHAT_FINAL_EVENT_SETTLE_GRACE_MS
        : null;
      try {
        const historyProbeStartedAt = Date.now();
        while ((Date.now() - historyProbeStartedAt) < CHAT_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS) {
          const history = await run.clientRef.getChatHistory(run.finalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
          const historyTailActivity = getHistoryTailActivity(history, run.historySnapshot);
          if (
            historyTailActivity.hasChanges
            && (
              historyTailActivity.length !== run.lastObservedHistoryLength
              || historyTailActivity.latestSignature !== run.lastObservedHistorySignature
            )
          ) {
            run.lastObservedHistoryLength = historyTailActivity.length;
            run.lastObservedHistorySignature = historyTailActivity.latestSignature;
            run.lastObservedHistoryActivityAt = Date.now();
            this.resetIdleTimeout(run);
          }
          const settledAssistantOutcome = extractSettledAssistantOutcome(history, run.historySnapshot);
          if (settledAssistantOutcome.kind === 'error') {
            settledErrorDetail = settledAssistantOutcome.error;
            break;
          }
          if (settledAssistantOutcome.kind === 'text') {
            sawSettledAssistantText = true;
            bestSettledAssistantText = settledAssistantOutcome.text;
            const settledMatchesCurrent = settledAssistantOutcome.text.trim() === completedOutput.trim();
            if (shouldPreferSettledAssistantText(completedOutput, settledAssistantOutcome.text)) {
              completedOutput = selectPreferredTextSnapshot(completedOutput, settledAssistantOutcome.text);
              break;
            }
            if (settledMatchesCurrent) {
              break;
            }
          }

          if (visibleFinalGraceDeadline !== null) {
            const remainingVisibleFinalGraceMs = visibleFinalGraceDeadline - Date.now();
            if (remainingVisibleFinalGraceMs <= 0) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS, remainingVisibleFinalGraceMs)));
            continue;
          }

          await new Promise((resolve) => setTimeout(resolve, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS));
        }

        if (settledErrorDetail) {
          this.failRun(run, settledErrorDetail);
          return;
        }

        if (shouldPreferSettledAssistantText(completedOutput, bestSettledAssistantText)) {
          completedOutput = selectPreferredTextSnapshot(completedOutput, bestSettledAssistantText);
      }
    } catch (historyError) {
        const historyErrorDetail = historyError instanceof Error ? historyError.message : String(historyError);
        if (isRecoverableGatewayDisconnectDetail(historyErrorDetail)) {
          this.scheduleGatewayReconnectProbe(run);
          this.scheduleCompletionProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
          return;
        }
        console.warn(`[ActiveRunManager] Failed to read final history for session ${run.sessionId}, run ${run.runId}:`, historyError);
        shouldRetryForEmptyCompletion = true;
      }

      if (!completedOutput.trim()) {
        shouldRetryForEmptyCompletion = true;
      }

      completedOutput = selectPreferredTextSnapshot(completedOutput, run.finalEventText, {
        allowShorterReplacement: hasFinalEventText(),
      });

      const hasSettledAssistantText = bestSettledAssistantText.trim().length > 0;
      const hasStableVisibleFinalText = probeFinalGeneration > 0
        && probeFinalGeneration === run.finalEventGeneration
        && completedOutput.trim().length > 0
        && run.latestFinalEventAt !== undefined
        && Date.now() >= (run.latestFinalEventAt + CHAT_FINAL_EVENT_SETTLE_GRACE_MS);

      if (
        probeFinalGeneration > 0
        && probeFinalGeneration === run.finalEventGeneration
        && (hasSettledAssistantText || hasStableVisibleFinalText)
      ) {
        run.settledCalibrationGeneration = Math.max(run.settledCalibrationGeneration, probeFinalGeneration);
      }

      const isAwaitingInitialTerminalEvidence = run.finalEventGeneration === 0 && !hasSettledAssistantText;
      const isAwaitingSettledFinalCalibration = run.finalEventGeneration > run.settledCalibrationGeneration;
      const hasRecentHistoryActivity = run.lastObservedHistoryActivityAt !== undefined
        && (Date.now() - run.lastObservedHistoryActivityAt) < CHAT_HISTORY_ACTIVITY_GRACE_MS;

      if (
        (shouldRetryForEmptyCompletion || isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration)
        && hasRecentHistoryActivity
      ) {
        this.scheduleCompletionProbe(run, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if (
        shouldRetryForEmptyCompletion
        && run.firstCompletionWaitResolvedAt !== undefined
        && (Date.now() - run.firstCompletionWaitResolvedAt) < CHAT_EMPTY_COMPLETION_RETRY_WINDOW_MS
      ) {
        this.scheduleCompletionProbe(run, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if (
        (isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration)
        && run.firstCompletionWaitResolvedAt !== undefined
        && (Date.now() - run.firstCompletionWaitResolvedAt) < CHAT_EMPTY_COMPLETION_RETRY_WINDOW_MS
      ) {
        this.scheduleCompletionProbe(run, CHAT_HISTORY_COMPLETION_SETTLE_POLL_MS);
        return;
      }

      if ((isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration) && completedOutput.trim() && !pendingErrorDetail) {
        console.warn(
          `[ActiveRunManager] Finalizing run ${run.runId} for session ${run.sessionId} using streamed text fallback because terminal assistant evidence never settled.`,
        );
        this.finalizeRun(run, completedOutput);
        return;
      }

      if (isAwaitingInitialTerminalEvidence) {
        this.failRun(run, pendingErrorDetail || 'Run completed without a terminal assistant response.');
        return;
      }

      if (isAwaitingSettledFinalCalibration) {
        this.failRun(run, pendingErrorDetail || 'Run completed but the final assistant response never settled.');
        return;
      }

      if (!completedOutput.trim() && pendingErrorDetail) {
        this.failRun(run, pendingErrorDetail);
        return;
      }

      this.finalizeRun(run, completedOutput);
    } catch (error: any) {
      if (!this.isCurrentRun(run)) return;
      const detail = typeof error?.message === 'string' ? error.message : '';
      if (/timeout/i.test(detail)) {
        this.scheduleCompletionProbe(run);
        return;
      }
      if (isRecoverableGatewayDisconnectDetail(detail)) {
        this.scheduleGatewayReconnectProbe(run);
        this.scheduleCompletionProbe(run, CHAT_GATEWAY_RECONNECT_PROBE_INITIAL_DELAY_MS);
        return;
      }
      this.failRun(run, pendingErrorDetail || detail || 'Failed waiting for run completion.');
    } finally {
      run.completionProbeInFlight = false;
      if (this.isCurrentRun(run) && run.completionProbePending && !run.completionProbeTimer) {
        this.scheduleCompletionProbe(run, 0);
      }
    }
  }

  private finalizeRun(run: ActiveRun, finalText: string) {
    if (!this.isCurrentRun(run)) return;

    const hasFinalEventText = !!run.finalEventText?.trim();
    let protectedRawText = selectPreferredTextSnapshot(run.rawText, finalText);
    protectedRawText = selectPreferredTextSnapshot(protectedRawText, run.finalEventText, {
      allowShorterReplacement: hasFinalEventText,
    });
    this.applyRawTextSnapshot(run, protectedRawText, {
      allowShorterReplacement: hasFinalEventText,
    });
    run.processStreaming = false;

    const canonicalText = canonicalizeAssistantWorkspaceArtifacts(run.text, {
      workspacePath: run.workspacePath,
      startedAtMs: run.startedAt,
    });
    const rewritten = rewriteOpenClawMediaPaths(canonicalText, run.workspacePath);
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(run.processContent, run.workspacePath);
    if (!rewritten.trim()) {
      const canonicalFallbackText = canonicalizeAssistantWorkspaceArtifacts(run.modelProcessContent, {
        workspacePath: run.workspacePath,
        startedAtMs: run.startedAt,
      });
      const rewrittenFallbackText = rewriteOpenClawMediaPaths(canonicalFallbackText, run.workspacePath);
      if (rewrittenFallbackText.trim()) {
        run.text = canonicalFallbackText;
        run.modelProcessContent = '';
        run.processContent = combineChatProcessContent(run.toolProcessContent, run.modelProcessContent);
        run.processStreaming = false;
        const rewrittenFallbackProcessContent = rewriteOpenClawMediaPaths(run.processContent, run.workspacePath);

        this.db.updateMessage(run.messageId, rewrittenFallbackText, run.modelUsed, rewrittenFallbackProcessContent, false);
        run.visibleFinalText = rewrittenFallbackText;
        run.visibleProcessContent = rewrittenFallbackProcessContent;
        run.visibleProcessStreaming = false;
        this.writeRunEvent(run, {
          type: 'final',
          text: rewrittenFallbackText,
          process_content: rewrittenFallbackProcessContent,
          process_streaming: false,
        }, { end: true });
        this.cleanupRun(run);
        return;
      }
      this.failRun(run, 'No text output returned from the run.');
      return;
    }

    this.db.updateMessage(run.messageId, rewritten, run.modelUsed, rewrittenProcessContent, false);
    this.emitVisibleFinal(run, protectedRawText, {
      end: true,
      allowShorterReplacement: hasFinalEventText,
    });
    this.cleanupRun(run);
  }

  private failRun(run: ActiveRun, detail: string, options?: {
    messageCode?: string;
  }) {
    if (!this.isCurrentRun(run)) return;

    const structuredError = createStructuredChatError(detail, options?.messageCode);

    run.processStreaming = false;
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(run.processContent, run.workspacePath);
    this.db.updateMessage(run.messageId, structuredError.content, run.modelUsed, rewrittenProcessContent, false);
    this.db.updateMessageEnvelope(run.messageId, structuredError.role, structuredError.agent_id, structuredError.agent_name);

    this.writeRunEvent(run, {
      type: 'error',
      text: structuredError.content,
      process_content: rewrittenProcessContent,
      process_streaming: false,
      messageCode: structuredError.messageCode,
      messageParams: structuredError.messageParams,
      rawDetail: structuredError.rawDetail,
      role: structuredError.role,
    }, { end: true });
    this.abortUnderlyingRunBestEffort(run, detail);
    this.cleanupRun(run);
  }

  private abortUnderlyingRunBestEffort(run: ActiveRun, reason: string) {
    if (!run.clientRef || !run.finalSessionKey || !run.runId) {
      return;
    }

    const clientRef = run.clientRef;
    void clientRef.abortChat({
      sessionKey: run.finalSessionKey,
      runId: run.runId,
      timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
    }).then((result) => {
      if (!result.aborted) {
        scheduleOpenClawSessionAbortRetry(
          clientRef,
          run.finalSessionKey,
          `run ${run.runId} for session ${run.sessionId} after ${reason}`,
        );
      }
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[chat] Failed to abort OpenClaw run ${run.runId} for session ${run.sessionId} after ${reason}: ${detail}`,
      );
      scheduleOpenClawSessionAbortRetry(
        clientRef,
        run.finalSessionKey,
        `run ${run.runId} for session ${run.sessionId} after ${reason}`,
      );
    });
  }

  private cleanupRun(run: ActiveRun) {
    if (run.cleanedUp) {
      if (this.isCurrentRun(run)) {
        this.runs.delete(run.sessionId);
      }
      return;
    }

    run.cleanedUp = true;
    if (run.idleTimeout) clearTimeout(run.idleTimeout);
    if (run.completionProbeTimer) clearTimeout(run.completionProbeTimer);
    if (run.gatewayReconnectTimer) clearTimeout(run.gatewayReconnectTimer);
    if (run.clientRef) {
      if ((run as any)._onDelta) run.clientRef.off('chat.delta', (run as any)._onDelta);
      if ((run as any)._onFinal) run.clientRef.off('chat.final', (run as any)._onFinal);
      if ((run as any)._onAborted) run.clientRef.off('chat.aborted', (run as any)._onAborted);
      if ((run as any)._onError) run.clientRef.off('chat.error', (run as any)._onError);
      if ((run as any)._onSessionTool) run.clientRef.off('session.tool', (run as any)._onSessionTool);
      if ((run as any)._onDisconnect) run.clientRef.off('disconnected', (run as any)._onDisconnect);
      if (run.sessionEventsSubscribed) {
        run.sessionEventsSubscribed = false;
        void run.clientRef.unsubscribeSessionEvents().catch((error) => {
          console.warn(`[chat] Failed to unsubscribe session events for session ${run.sessionId}:`, error);
        });
      }
    }
    if (this.isCurrentRun(run)) {
      this.runs.delete(run.sessionId);
    }
  }
}

const activeRunManager = new ActiveRunManager(db);
const pendingChatPreparationManager = new PendingChatPreparationManager();
const localChatOperationManager = new LocalChatOperationManager();

// Force overlapping requests for the same session onto a fresh interruption epoch so
// stale pending work or an older run cannot keep mutating state after a newer send begins.
async function interruptSessionStreamingStateForNewRun(sessionId: string): Promise<number> {
  const interruptedEpoch = getSessionInterruptionEpoch(sessionId);
  const nextEpoch = bumpSessionInterruptionEpoch(sessionId);
  const pendingPreparation = pendingChatPreparationManager.get(sessionId, interruptedEpoch);
  const activeRun = activeRunManager.getRun(sessionId);
  const localOperation = localChatOperationManager.get(sessionId);

  if (pendingPreparation) {
    pendingChatPreparationManager.cancel(sessionId, interruptedEpoch);
    try {
      db.deleteMessage(pendingPreparation.messageId);
    } catch (error) {
      console.warn(
        `[chat] Failed to delete interrupted pending assistant message ${pendingPreparation.messageId} for session ${sessionId}:`,
        error,
      );
    }
  }

  if (activeRun) {
    try {
      await activeRunManager.abortRun(sessionId);
    } catch (error) {
      console.warn(`[chat] Failed to abort previous run ${activeRun.runId} for session ${sessionId}:`, error);
    }
  }

  if (localOperation) {
    localChatOperationManager.abort(sessionId);
    try {
      db.deleteMessage(localOperation.messageId);
    } catch (error) {
      console.warn(
        `[chat] Failed to delete interrupted local assistant message ${localOperation.messageId} for session ${sessionId}:`,
        error,
      );
    }
  }

  if (pendingPreparation || activeRun || localOperation) {
    disconnectConnection(sessionId);
  }

  return nextEpoch;
}

function scheduleOpenClawSessionAbortRetry(
  client: OpenClawClient,
  sessionKey: string,
  context: string,
  attempt = 0,
) {
  if (attempt >= CHAT_ABORT_RETRY_DELAYS_MS.length) {
    console.warn(`[chat] Exhausted OpenClaw abort retries for ${context} (${sessionKey}).`);
    return;
  }

  const delay = CHAT_ABORT_RETRY_DELAYS_MS[attempt];
  const timer = setTimeout(() => {
    void client.abortChat({
      sessionKey,
      timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
    }).then((result) => {
      if (result.aborted) {
        return;
      }
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context, attempt + 1);
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[chat] OpenClaw abort retry ${attempt + 1} failed for ${context} (${sessionKey}): ${detail}`);
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context, attempt + 1);
    });
  }, delay);
  timer.unref?.();
}

async function abortOpenClawSessionRuns(
  client: OpenClawClient,
  sessionKey: string,
  context: string,
  options?: { retryOnMiss?: boolean },
): Promise<{ aborted: boolean; runIds: string[] }> {
  try {
    const result = await client.abortChat({
      sessionKey,
      timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
    });
    const runIds = Array.isArray(result.runIds) ? result.runIds : [];
    if (!result.aborted && options?.retryOnMiss) {
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context);
    }
    return {
      aborted: result.aborted,
      runIds,
    };
  } catch (error) {
    console.warn(`[chat] Failed to abort orphan OpenClaw runs for ${context} (${sessionKey}):`, error);
    if (options?.retryOnMiss) {
      scheduleOpenClawSessionAbortRetry(client, sessionKey, context);
    }
    return {
      aborted: false,
      runIds: [],
    };
  }
}

async function reconcileInactiveChatLatestMessage(sessionId: string): Promise<void> {
  if (
    activeRunManager.getRun(sessionId)
    || pendingChatPreparationManager.get(sessionId)
    || localChatOperationManager.get(sessionId)
  ) {
    return;
  }

  const recentMessages = db.getMessages(sessionId, 100);
  if (recentMessages.length === 0) {
    return;
  }

  const latestAssistantLikeMessage = [...recentMessages].reverse().find((message) => (
    (message.role === 'assistant' || message.role === 'system')
    && typeof message.id === 'number'
  ));

  const latestAssistantLikeMessageId = typeof latestAssistantLikeMessage?.id === 'number'
    ? latestAssistantLikeMessage.id
    : null;

  if (!latestAssistantLikeMessageId || !latestAssistantLikeMessage) {
    return;
  }

  const latestStoredMessage = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1] : null;
  if (!latestStoredMessage || latestStoredMessage.id !== latestAssistantLikeMessageId) {
    return;
  }

  const currentContent = typeof latestAssistantLikeMessage.content === 'string'
    ? latestAssistantLikeMessage.content
    : '';
  const currentProcessContent = typeof latestAssistantLikeMessage.process_content === 'string'
    ? latestAssistantLikeMessage.process_content
    : '';
  if (currentContent.trim()) {
    if (latestAssistantLikeMessage.process_streaming) {
      db.updateMessage(
        latestAssistantLikeMessageId,
        currentContent,
        latestAssistantLikeMessage.model_used || undefined,
        currentProcessContent,
        false,
      );
    }
    return;
  }

  const sessionInfo = sessionManager.getSession(sessionId);
  const agentId = latestAssistantLikeMessage.agent_id && latestAssistantLikeMessage.agent_id !== 'system'
    ? latestAssistantLikeMessage.agent_id
    : (sessionInfo?.agentId || 'main');

  if (!agentId) {
    db.deleteMessage(latestAssistantLikeMessageId);
    return;
  }

  try {
    const client = await getConnection(sessionId);
    const finalSessionKey = sessionId.startsWith('agent:')
      ? sessionId
      : `agent:${agentId}:chat:${sessionId}`;
    const history = await client.getChatHistory(finalSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT);
    const latestOutcomeRecord = extractLatestAssistantOutcomeRecord(history);
    const latestMessageCreatedAtMs = Date.parse(latestAssistantLikeMessage.created_at || '');
    const historyIsNewerThanCurrentMessage = latestOutcomeRecord.timestampMs !== null
      && Number.isFinite(latestMessageCreatedAtMs)
      && latestOutcomeRecord.timestampMs > latestMessageCreatedAtMs;

    if (historyIsNewerThanCurrentMessage && latestOutcomeRecord.kind === 'text') {
      const workspacePath = getSessionWorkspacePath(sessionId);
      const startedAtMs = Number.isFinite(latestMessageCreatedAtMs) ? latestMessageCreatedAtMs : Date.now();
      const canonicalText = canonicalizeAssistantWorkspaceArtifacts(latestOutcomeRecord.text, {
        workspacePath,
        startedAtMs,
      });
      const rewritten = rewriteOpenClawMediaPaths(canonicalText, workspacePath);
      if (rewritten.trim()) {
        db.updateMessage(latestAssistantLikeMessageId, rewritten, latestAssistantLikeMessage.model_used || undefined, '', false);
        db.updateMessageEnvelope(
          latestAssistantLikeMessageId,
          'assistant',
          latestAssistantLikeMessage.agent_id && latestAssistantLikeMessage.agent_id !== 'system'
            ? latestAssistantLikeMessage.agent_id
            : agentId,
          latestAssistantLikeMessage.agent_name && latestAssistantLikeMessage.agent_id !== 'system'
            ? latestAssistantLikeMessage.agent_name
            : (sessionInfo?.name || agentId),
        );
        return;
      }
    }

    if (historyIsNewerThanCurrentMessage && latestOutcomeRecord.kind === 'error') {
      const structuredError = createStructuredChatError(latestOutcomeRecord.error);
      db.updateMessage(latestAssistantLikeMessageId, structuredError.content, latestAssistantLikeMessage.model_used || undefined, currentProcessContent, false);
      db.updateMessageEnvelope(
        latestAssistantLikeMessageId,
        structuredError.role,
        structuredError.agent_id,
        structuredError.agent_name,
      );
      return;
    }
  } catch (error) {
    console.warn(`[chat] Failed to reconcile inactive latest message for session ${sessionId}:`, error);
  }

  if (currentProcessContent.trim()) {
    db.updateMessage(
      latestAssistantLikeMessageId,
      currentContent,
      latestAssistantLikeMessage.model_used || undefined,
      currentProcessContent,
      false,
    );
    return;
  }

  db.deleteMessage(latestAssistantLikeMessageId);
}

function getLatestChatRegenerateTarget(sessionId: string): {
  latestUserMessage: ChatRow | null;
  latestReplyMessage: ChatRow | null;
} {
  const recentHistory = db.getMessages(sessionId, CHAT_REGENERATE_LOOKBACK_LIMIT);
  const latestUserMessage = [...recentHistory].reverse().find((message) => message.role === 'user') ?? null;
  const latestUserId = typeof latestUserMessage?.id === 'number' ? latestUserMessage.id : null;
  if (!latestUserMessage || latestUserId === null) {
    return {
      latestUserMessage: null,
      latestReplyMessage: null,
    };
  }

  const latestReplyMessage = [...recentHistory].reverse().find((message) => (
    (message.role === 'assistant' || message.role === 'system')
    && typeof message.id === 'number'
    && message.id > latestUserId
    && Number(message.parent_id) === latestUserId
  )) ?? null;

  return {
    latestUserMessage,
    latestReplyMessage,
  };
}

type ParsedChatCommand = {
  command: string;
  argsText: string;
};

type ResolvedChatCommandResult = {
  content: string;
  clearBeforeSave?: boolean;
};

function parseChatCommand(rawMessage: unknown): ParsedChatCommand | null {
  const normalized = normalizeCliText(rawMessage);
  if (!normalized.startsWith('/')) return null;
  const [token = ''] = normalized.split(/\s+/, 1);
  const command = token.toLowerCase();
  if (!command.startsWith('/') || command.length < 2) return null;
  return {
    command,
    argsText: normalized.slice(token.length).trim(),
  };
}

function listConfiguredQuickCommands() {
  return (db.getQuickCommands() as Array<{ command?: unknown; description?: unknown }>)
    .map((entry) => ({
      command: normalizeCliText(entry.command).toLowerCase(),
      description: normalizeCliText(entry.description),
    }))
    .filter((entry) => entry.command.startsWith('/'));
}

const builtinChatCommandOptions: Record<string, { clearBeforeSave?: boolean }> = {
  '/status': {},
  '/help': {},
  '/models': {},
  '/clear': { clearBeforeSave: true },
};

async function resolveChatCommandResult(
  parsed: ParsedChatCommand,
  sessionId: string,
): Promise<ResolvedChatCommandResult | null> {
  const configuredCommands = listConfiguredQuickCommands();
  const configuredCommandSet = new Set(configuredCommands.map((entry) => entry.command));
  const builtinOptions = builtinChatCommandOptions[parsed.command];
  const shouldExecuteAsNativeCommand = Boolean(builtinOptions) || configuredCommandSet.has(parsed.command);
  if (!shouldExecuteAsNativeCommand) {
    return null;
  }

  const commandLine = parsed.argsText ? `${parsed.command} ${parsed.argsText}` : parsed.command;

  try {
    const client = await getConnection(sessionId);
    const sessionInfo = sessionManager.getSession(sessionId);
    const nativeText = normalizeCliText(await client.sendChatMessage({
      sessionKey: sessionId,
      agentId: sessionInfo?.agentId || 'main',
      message: commandLine,
    }));
    if (!nativeText || nativeText === 'No assistant text found in response.') {
      throw new Error('No response text from native command runtime.');
    }
    return {
      content: nativeText,
      clearBeforeSave: builtinOptions?.clearBeforeSave,
    };
  } catch (error) {
    const detail = readCliErrorDetail(error) || 'Native command execution failed.';
    return {
      content: `❌ ${detail}`,
      clearBeforeSave: builtinOptions?.clearBeforeSave,
    };
  }
}

app.post('/api/chat', async (req, res) => {
  const { sessionId, message, parentId } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json(buildStructuredChatHttpError('Missing sessionId or message'));
  }

  const normalizedSessionId = String(sessionId);
  const sessionInterruptionEpoch = await interruptSessionStreamingStateForNewRun(normalizedSessionId);

  let userMsgId: number | undefined;
  let assistantMsgId: number | undefined;
  let pendingPreparationActive = false;
  let sessionEventsClient: OpenClawClient | null = null;
  let sessionEventsSubscribed = false;

  try {
    const rawMessage = String(message);
    const parsedCommand = parseChatCommand(rawMessage);
    const sessionInfo = sessionManager.getSession(normalizedSessionId);
    let finalMessage = rawMessage;
    let injectedInstructions = '';

    const agentId = sessionInfo?.agentId || 'main';
    const runtimeSettings = readEffectiveAgentRuntimeSettings(sessionInfo, agentId);
    const allCharacters = db.getCharacters();
    const character = allCharacters.find(c => c.agentId === agentId);
    const agentName = sessionInfo?.name || character?.name || agentId;
    const imageIntentContext = readAgentBootstrapIntentContext(agentId);
    const directImageModel = shouldUseConfiguredImageGenerationModel(rawMessage, imageIntentContext)
      ? getConfiguredDirectImageGenerationModel()
      : null;
    const modelUsed = directImageModel || agentProvisioner.readAgentModel(agentId) ||
      agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';

    if (sessionInfo) {
      if (sessionInfo.process_start_tag && sessionInfo.process_end_tag) {
        injectedInstructions += `【极其重要：输出格式规范】\n当前启用了结构化思考输出。你关于后续任务决断的所有内部思考、分析或工作执行过程，必须严格包裹在 ${sessionInfo.process_start_tag} 和 ${sessionInfo.process_end_tag} 之间！\n真正的最终沟通、回复语言写在标签外部。\n\n`;
      }
    }
    if (shouldInjectHostTakeoverInstruction(sessionInfo, agentId)) {
      injectedInstructions += `${buildHostTakeoverChatInstruction()}\n\n`;
    }

    if (injectedInstructions) {
      finalMessage = `${injectedInstructions}${finalMessage}`;
    }

    if (parsedCommand) {
      const commandResult = await resolveChatCommandResult(parsedCommand, normalizedSessionId);
      if (commandResult) {
        if (commandResult.clearBeforeSave) {
          db.deleteMessagesBySession(normalizedSessionId);
          clearStoredFilesBySessionKey(normalizedSessionId);
        }

        let finalParentId = parentId ? Number(parentId) : undefined;
        if (finalParentId === undefined) {
          const history = db.getMessages(normalizedSessionId, 1);
          finalParentId = history.length > 0 ? history[history.length - 1].id : undefined;
        }

        userMsgId = Number(db.saveMessage({
          session_key: normalizedSessionId,
          parent_id: finalParentId,
          role: 'user',
          content: rawMessage,
        }));

        assistantMsgId = Number(db.saveMessage({
          session_key: normalizedSessionId,
          parent_id: userMsgId,
          role: 'assistant',
          content: commandResult.content,
          model_used: modelUsed,
          agent_id: agentId,
          agent_name: agentName,
        }));

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        res.write(':' + Array(2048).fill(' ').join('') + '\n\n');
        res.write(`data: ${JSON.stringify({ type: 'ids', userMsgId, assistantMsgId })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'final', text: commandResult.content })}\n\n`);
        res.end();
        return;
      }

      // Unknown slash command falls back to normal chat flow.
    }

    let finalParentId = parentId ? Number(parentId) : undefined;
    if (finalParentId === undefined) {
      const history = db.getMessages(normalizedSessionId, 1);
      finalParentId = history.length > 0 ? history[history.length - 1].id : undefined;
    }

    userMsgId = Number(db.saveMessage({ session_key: normalizedSessionId, parent_id: finalParentId, role: 'user', content: rawMessage }));

    assistantMsgId = Number(db.saveMessage({
      session_key: normalizedSessionId,
      parent_id: userMsgId,
      role: 'assistant',
      content: '', // empty initially
      model_used: modelUsed,
      agent_id: agentId,
      agent_name: agentName
    }));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Notify frontend of the real DB IDs immediately
    res.write(':' + Array(2048).fill(' ').join('') + '\n\n');
    res.write(`data: ${JSON.stringify({ type: 'ids', userMsgId, assistantMsgId })}\n\n`);

    if (directImageModel) {
      const localImageController = new AbortController();
      const startProcessContent = buildImageGenerationStartProcessContent(directImageModel);
      db.updateMessage(assistantMsgId, '', directImageModel, startProcessContent, true);
      localChatOperationManager.start({
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        messageId: assistantMsgId,
        agentId,
        agentName,
        modelUsed: directImageModel,
        startedAt: Date.now(),
        kind: 'image-generation',
        abortController: localImageController,
      });
      const startEvent = {
        type: 'delta',
        text: '',
        process_content: startProcessContent,
        process_streaming: true,
        modelUsed: directImageModel,
        model_used: directImageModel,
      };
      if (isStreamingClientOpen(res)) {
        try {
          res.write(`data: ${JSON.stringify(startEvent)}\n\n`);
        } catch {}
      }

      const directImageResult = await tryGenerateImageForPrompt({
        prompt: rawMessage,
        intentText: rawMessage,
        intentContext: imageIntentContext,
        outputDir: path.join(getSessionWorkspacePath(normalizedSessionId), 'output', 'image-generations'),
        signal: localImageController.signal,
      });
      if (directImageResult) {
        assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
        db.updateMessage(assistantMsgId, directImageResult.content, directImageResult.modelUsed, directImageResult.processContent, false);
        const finalEvent = {
          type: 'final',
          text: directImageResult.content,
          process_content: directImageResult.processContent,
          process_streaming: false,
          modelUsed: directImageResult.modelUsed,
          model_used: directImageResult.modelUsed,
        };
        if (isStreamingClientOpen(res)) {
          try {
            res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
            res.end();
          } catch {}
        }
        localChatOperationManager.emit(normalizedSessionId, finalEvent, sessionInterruptionEpoch);
        localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
        return;
      }
      localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
    }

    if (runtimeSettings.runtimeMode === 'direct') {
      const localDirectController = new AbortController();
      localChatOperationManager.start({
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        messageId: assistantMsgId,
        agentId,
        agentName,
        modelUsed,
        startedAt: Date.now(),
        kind: 'direct-runtime',
        abortController: localDirectController,
      });
      await runDirectChatCompletion({
        sessionId: normalizedSessionId,
        agentId,
        userMessageId: userMsgId,
        assistantMessageId: assistantMsgId,
        message: finalMessage,
        modelUsed,
        response: res,
        signal: localDirectController.signal,
        onEvent: (event) => localChatOperationManager.emit(normalizedSessionId, event, sessionInterruptionEpoch),
        processStartTag: sessionInfo?.process_start_tag || undefined,
        processEndTag: sessionInfo?.process_end_tag || undefined,
        sessionInterruptionEpoch,
      });
      localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
      return;
    }

    pendingChatPreparationManager.start({
      sessionId: normalizedSessionId,
      epoch: sessionInterruptionEpoch,
      messageId: assistantMsgId,
      agentId,
      agentName,
      modelUsed,
      startedAt: Date.now(),
    });
    pendingPreparationActive = true;
    pendingChatPreparationManager.attachClient(normalizedSessionId, res, {
      announceAttach: true,
      expectedEpoch: sessionInterruptionEpoch,
    });

    const client = await getConnection(normalizedSessionId);
    sessionEventsClient = client;
    assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
    const expectedSessionKey = buildOpenClawChatSessionKey(normalizedSessionId, agentId);
    await abortOpenClawSessionRuns(client, expectedSessionKey, `session ${normalizedSessionId} before send`);
    assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
    try {
      await client.subscribeSessionEvents();
      sessionEventsSubscribed = true;
    } catch (error) {
      console.warn(`[chat] Failed to subscribe session events for session ${normalizedSessionId}:`, error);
    }
    const outgoingMessage = await prepareOutgoingMessage(finalMessage, agentId, {
      includeDocumentToolingContext: runtimeSettings.toolMode === 'full' || runtimeSettings.toolMode === 'coding',
    });
    assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);

    const preRunHistorySnapshot = await client.getChatHistory(expectedSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT)
      .then((history) => getHistorySnapshot(history))
      .catch(() => getUnknownHistorySnapshot());
    assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);

    const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
      sessionKey: normalizedSessionId,
      message: outgoingMessage.text,
      agentId: agentId,
      attachments: outgoingMessage.attachments,
    });
    if (getSessionInterruptionEpoch(normalizedSessionId) !== sessionInterruptionEpoch) {
      try {
        const abortResult = await client.abortChat({
          sessionKey: finalSessionKey,
          runId,
          timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
        });
        if (!abortResult.aborted) {
          scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${normalizedSessionId}`);
        }
      } catch {
        scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${normalizedSessionId}`);
      }
      throw new SessionInterruptedError(normalizedSessionId);
    }

    const run = activeRunManager.startRun(
      normalizedSessionId,
      runId,
      agentId,
      agentName,
      modelUsed,
      assistantMsgId,
      getSessionWorkspacePath(normalizedSessionId),
      client,
      finalSessionKey,
      preRunHistorySnapshot,
      sessionInfo?.process_start_tag || undefined,
      sessionInfo?.process_end_tag || undefined,
      sessionEventsSubscribed
    );
    sessionEventsSubscribed = false;
    const pendingClients = pendingChatPreparationManager.promoteClients(normalizedSessionId, sessionInterruptionEpoch);
    pendingPreparationActive = false;
    pendingClients.forEach((clientRes) => {
      activeRunManager.attachClient(normalizedSessionId, clientRes);
    });

  } catch (error: any) {
    if (sessionEventsSubscribed && sessionEventsClient) {
      sessionEventsSubscribed = false;
      void sessionEventsClient.unsubscribeSessionEvents().catch((unsubscribeError) => {
        console.warn(`[chat] Failed to unsubscribe session events for session ${normalizedSessionId}:`, unsubscribeError);
      });
    }
    const resetInterrupted = error instanceof SessionInterruptedError || getSessionInterruptionEpoch(normalizedSessionId) !== sessionInterruptionEpoch;
    if (resetInterrupted) {
      if (pendingPreparationActive) {
        if (typeof assistantMsgId === 'number') {
          try {
            db.deleteMessage(assistantMsgId);
            assistantMsgId = undefined;
          } catch {}
        }
        pendingChatPreparationManager.cancel(normalizedSessionId, sessionInterruptionEpoch);
        pendingPreparationActive = false;
      } else if (res.headersSent) {
        try {
          res.end();
        } catch {}
      } else {
        res.status(409).json(buildStructuredChatHttpError('Session was interrupted during processing.'));
      }
      return;
    }

    const structuredErrorInput = resolveStructuredChatErrorInput(error);
    const structuredError = createStructuredChatError(
      structuredErrorInput.rawDetail,
      structuredErrorInput.messageCode
    );
    const sessionInfo = db.getSession(normalizedSessionId);
    const agentId = sessionInfo?.agentId || 'main';
    const character = db.getCharacters().find(c => c.agentId === agentId);
    const modelUsed = resolveModelTagForErrorReport(agentProvisioner, agentId);

    if (typeof assistantMsgId === 'number') {
      try {
        db.updateMessage(assistantMsgId, structuredError.content, modelUsed, null, false);
        db.updateMessageEnvelope(assistantMsgId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
      } catch {}
    } else if (typeof userMsgId === 'number') {
      try {
        assistantMsgId = Number(db.saveMessage({
          session_key: normalizedSessionId,
          parent_id: userMsgId,
          role: structuredError.role,
          content: structuredError.content,
          model_used: modelUsed,
          agent_id: structuredError.agent_id,
          agent_name: structuredError.agent_name,
        }));
      } catch {}
    }

    if (!res.headersSent) {
      res.status(500).json(buildStructuredChatHttpError(
        structuredErrorInput.rawDetail,
        structuredErrorInput.messageCode
      ));
    } else {
      if (pendingPreparationActive) {
        pendingChatPreparationManager.fail(normalizedSessionId, structuredError, sessionInterruptionEpoch);
        pendingPreparationActive = false;
      } else {
        const errorEvent = buildStructuredChatErrorStreamEvent(structuredError);
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
        localChatOperationManager.emit(normalizedSessionId, errorEvent, sessionInterruptionEpoch);
        localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
        res.end();
      }
    }
  }
});

app.post('/api/chat/regenerate', async (req, res) => {
  const { sessionId, message, parentId, targetMessageId } = req.body;

  if (!sessionId || !message || !parentId) {
    return res.status(400).json(buildStructuredChatHttpError('Missing sessionId, message, or parentId'));
  }

  const normalizedSessionId = String(sessionId);
  const sessionInterruptionEpoch = await interruptSessionStreamingStateForNewRun(normalizedSessionId);

  let assistantMsgId: number | undefined;
  let pendingPreparationActive = false;
  let sessionEventsClient: OpenClawClient | null = null;
  let sessionEventsSubscribed = false;

  try {
    const requestedParentId = Number(parentId);
    const requestedTargetMessageId = Number(targetMessageId);
    const { latestUserMessage, latestReplyMessage } = getLatestChatRegenerateTarget(normalizedSessionId);
    const latestUserId = Number(latestUserMessage?.id);
    const latestReplyId = Number(latestReplyMessage?.id);
    const latestReplyParentId = Number(latestReplyMessage?.parent_id);
    const latestRoundTargetIds = new Set<number>();
    if (Number.isFinite(latestUserId)) {
      latestRoundTargetIds.add(latestUserId);
    }
    if (Number.isFinite(latestReplyId)) {
      latestRoundTargetIds.add(latestReplyId);
    }

    const requestReferencesLatestRound = [requestedParentId, requestedTargetMessageId].some((candidateId) => (
      Number.isFinite(candidateId) && latestRoundTargetIds.has(candidateId)
    ));
    const numericParentId = latestUserId;

    if (
      !Number.isFinite(numericParentId)
      || !latestUserMessage
      || !requestReferencesLatestRound
    ) {
      return res.status(409).json(buildStructuredChatHttpError(
        CHAT_LATEST_ROUND_ONLY_DETAIL,
        CHAT_LATEST_ROUND_ONLY_CODE,
      ));
    }

    if (
      latestReplyMessage
      && (latestReplyMessage.role === 'assistant' || latestReplyMessage.role === 'system')
      && latestReplyParentId === numericParentId
      && typeof latestReplyMessage.id === 'number'
    ) {
      db.deleteMessage(Number(latestReplyMessage.id));
    }

    const sessionInfo = sessionManager.getSession(normalizedSessionId);
    const rawMessage = String(message);
    let finalMessage = rawMessage;
    let injectedInstructions = '';

    if (sessionInfo) {
      if (sessionInfo.process_start_tag && sessionInfo.process_end_tag) {
        injectedInstructions += `【极其重要：输出格式规范】\n当前启用了结构化思考输出。你关于后续任务决断的所有内部思考、分析或工作执行过程，必须严格包裹在 ${sessionInfo.process_start_tag} 和 ${sessionInfo.process_end_tag} 之间！\n真正的最终沟通、回复语言写在标签外部。\n\n`;
      }
    }
    const agentId = sessionInfo?.agentId || 'main';
    const runtimeSettings = readEffectiveAgentRuntimeSettings(sessionInfo, agentId);

    if (shouldInjectHostTakeoverInstruction(sessionInfo, agentId)) {
      injectedInstructions += `${buildHostTakeoverChatInstruction()}\n\n`;
    }

    if (injectedInstructions) {
      finalMessage = `${injectedInstructions}${finalMessage}`;
    }

    const allCharacters = db.getCharacters();
    const character = allCharacters.find(c => c.agentId === agentId);
    const agentName = sessionInfo?.name || character?.name || agentId;
    const imageIntentContext = readAgentBootstrapIntentContext(agentId);
    const directImageModel = shouldUseConfiguredImageGenerationModel(rawMessage, imageIntentContext)
      ? getConfiguredDirectImageGenerationModel()
      : null;
    const modelUsed = directImageModel || agentProvisioner.readAgentModel(agentId) ||
      agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';

    assistantMsgId = Number(db.saveMessage({
      session_key: normalizedSessionId,
      parent_id: numericParentId,
      role: 'assistant',
      content: '', 
      model_used: modelUsed,
      agent_id: agentId,
      agent_name: agentName
    }));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Notify frontend immediately of the new assistant msg ID
    res.write(':' + Array(2048).fill(' ').join('') + '\n\n');
    res.write(`data: ${JSON.stringify({ type: 'ids', userMsgId: numericParentId, assistantMsgId })}\n\n`);

    if (directImageModel) {
      const localImageController = new AbortController();
      const startProcessContent = buildImageGenerationStartProcessContent(directImageModel);
      db.updateMessage(assistantMsgId, '', directImageModel, startProcessContent, true);
      localChatOperationManager.start({
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        messageId: assistantMsgId,
        agentId,
        agentName,
        modelUsed: directImageModel,
        startedAt: Date.now(),
        kind: 'image-generation',
        abortController: localImageController,
      });
      const startEvent = {
        type: 'delta',
        text: '',
        process_content: startProcessContent,
        process_streaming: true,
        modelUsed: directImageModel,
        model_used: directImageModel,
      };
      if (isStreamingClientOpen(res)) {
        try {
          res.write(`data: ${JSON.stringify(startEvent)}\n\n`);
        } catch {}
      }

      const directImageResult = await tryGenerateImageForPrompt({
        prompt: rawMessage,
        intentText: rawMessage,
        intentContext: imageIntentContext,
        outputDir: path.join(getSessionWorkspacePath(normalizedSessionId), 'output', 'image-generations'),
        signal: localImageController.signal,
      });
      if (directImageResult) {
        assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
        db.updateMessage(assistantMsgId, directImageResult.content, directImageResult.modelUsed, directImageResult.processContent, false);
        const finalEvent = {
          type: 'final',
          text: directImageResult.content,
          process_content: directImageResult.processContent,
          process_streaming: false,
          modelUsed: directImageResult.modelUsed,
          model_used: directImageResult.modelUsed,
        };
        if (isStreamingClientOpen(res)) {
          try {
            res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
            res.end();
          } catch {}
        }
        localChatOperationManager.emit(normalizedSessionId, finalEvent, sessionInterruptionEpoch);
        localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
        return;
      }
      localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
    }

    if (runtimeSettings.runtimeMode === 'direct') {
      const localDirectController = new AbortController();
      localChatOperationManager.start({
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        messageId: assistantMsgId,
        agentId,
        agentName,
        modelUsed,
        startedAt: Date.now(),
        kind: 'direct-runtime',
        abortController: localDirectController,
      });
      await runDirectChatCompletion({
        sessionId: normalizedSessionId,
        agentId,
        userMessageId: numericParentId,
        assistantMessageId: assistantMsgId,
        message: finalMessage,
        modelUsed,
        response: res,
        signal: localDirectController.signal,
        onEvent: (event) => localChatOperationManager.emit(normalizedSessionId, event, sessionInterruptionEpoch),
        processStartTag: sessionInfo?.process_start_tag || undefined,
        processEndTag: sessionInfo?.process_end_tag || undefined,
        sessionInterruptionEpoch,
      });
      localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
      return;
    }

    pendingChatPreparationManager.start({
      sessionId: normalizedSessionId,
      epoch: sessionInterruptionEpoch,
      messageId: assistantMsgId,
      agentId,
      agentName,
      modelUsed,
      startedAt: Date.now(),
    });
    pendingPreparationActive = true;
    pendingChatPreparationManager.attachClient(normalizedSessionId, res, {
      announceAttach: true,
      expectedEpoch: sessionInterruptionEpoch,
    });

    const client = await getConnection(normalizedSessionId);
    sessionEventsClient = client;
    assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
    const expectedSessionKey = buildOpenClawChatSessionKey(normalizedSessionId, agentId);
    await abortOpenClawSessionRuns(client, expectedSessionKey, `session ${normalizedSessionId} before regenerate`);
    assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
    try {
      await client.subscribeSessionEvents();
      sessionEventsSubscribed = true;
    } catch (error) {
      console.warn(`[chat] Failed to subscribe session events for session ${normalizedSessionId}:`, error);
    }
    const outgoingMessage = await prepareOutgoingMessage(finalMessage, agentId, {
      includeDocumentToolingContext: runtimeSettings.toolMode === 'full' || runtimeSettings.toolMode === 'coding',
    });
    assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);

    const preRunHistorySnapshot = await client.getChatHistory(expectedSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT)
      .then((history) => getHistorySnapshot(history))
      .catch(() => getUnknownHistorySnapshot());
    assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);

    const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
      sessionKey: normalizedSessionId,
      message: outgoingMessage.text,
      agentId: agentId,
      attachments: outgoingMessage.attachments,
    });
    if (getSessionInterruptionEpoch(normalizedSessionId) !== sessionInterruptionEpoch) {
      try {
        const abortResult = await client.abortChat({
          sessionKey: finalSessionKey,
          runId,
          timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
        });
        if (!abortResult.aborted) {
          scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${normalizedSessionId}`);
        }
      } catch {
        scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${normalizedSessionId}`);
      }
      throw new SessionInterruptedError(normalizedSessionId);
    }

    const run = activeRunManager.startRun(
      normalizedSessionId,
      runId,
      agentId,
      agentName,
      modelUsed,
      assistantMsgId,
      getSessionWorkspacePath(normalizedSessionId),
      client,
      finalSessionKey,
      preRunHistorySnapshot,
      sessionInfo?.process_start_tag || undefined,
      sessionInfo?.process_end_tag || undefined,
      sessionEventsSubscribed
    );
    sessionEventsSubscribed = false;

    const pendingClients = pendingChatPreparationManager.promoteClients(normalizedSessionId, sessionInterruptionEpoch);
    pendingPreparationActive = false;
    pendingClients.forEach((clientRes) => {
      activeRunManager.attachClient(normalizedSessionId, clientRes);
    });

  } catch (error: any) {
    if (sessionEventsSubscribed && sessionEventsClient) {
      sessionEventsSubscribed = false;
      void sessionEventsClient.unsubscribeSessionEvents().catch((unsubscribeError) => {
        console.warn(`[chat] Failed to unsubscribe session events for session ${normalizedSessionId}:`, unsubscribeError);
      });
    }
    const resetInterrupted = error instanceof SessionInterruptedError || getSessionInterruptionEpoch(normalizedSessionId) !== sessionInterruptionEpoch;
    if (resetInterrupted) {
      if (pendingPreparationActive) {
        if (typeof assistantMsgId === 'number') {
          try {
            db.deleteMessage(assistantMsgId);
            assistantMsgId = undefined;
          } catch {}
        }
        pendingChatPreparationManager.cancel(normalizedSessionId, sessionInterruptionEpoch);
        pendingPreparationActive = false;
      } else if (res.headersSent) {
        try {
          res.end();
        } catch {}
      } else {
        res.status(409).json(buildStructuredChatHttpError('Session was interrupted during processing.'));
      }
      return;
    }

    const structuredErrorInput = resolveStructuredChatErrorInput(error);
    const structuredError = createStructuredChatError(
      structuredErrorInput.rawDetail,
      structuredErrorInput.messageCode
    );
    const sessionInfo = db.getSession(normalizedSessionId);
    const agentId = sessionInfo?.agentId || 'main';
    const modelUsed = resolveModelTagForErrorReport(agentProvisioner, agentId);

    if (typeof assistantMsgId === 'number') {
      try {
        db.updateMessage(assistantMsgId, structuredError.content, modelUsed, null, false);
        db.updateMessageEnvelope(assistantMsgId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
      } catch {}
    } else {
      try {
        assistantMsgId = Number(db.saveMessage({
          session_key: normalizedSessionId,
          parent_id: Number(parentId),
          role: structuredError.role,
          content: structuredError.content,
          model_used: modelUsed,
          agent_id: structuredError.agent_id,
          agent_name: structuredError.agent_name,
        }));
      } catch {}
    }

    if (!res.headersSent) {
      res.status(500).json(buildStructuredChatHttpError(
        structuredErrorInput.rawDetail,
        structuredErrorInput.messageCode
      ));
    } else {
      if (pendingPreparationActive) {
        pendingChatPreparationManager.fail(normalizedSessionId, structuredError, sessionInterruptionEpoch);
        pendingPreparationActive = false;
      } else {
        const errorEvent = buildStructuredChatErrorStreamEvent(structuredError);
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
        localChatOperationManager.emit(normalizedSessionId, errorEvent, sessionInterruptionEpoch);
        localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
        res.end();
      }
    }
  }
});

app.get('/api/chat/attach/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const pendingPreparation = pendingChatPreparationManager.get(sessionId);
    const run = activeRunManager.getRun(sessionId);
    const localOperation = localChatOperationManager.get(sessionId);
    if (!run && !pendingPreparation && !localOperation) {
      await reconcileInactiveChatLatestMessage(sessionId);
      // Return empty payload to indicate no active run
      return res.status(200).json({ active: false });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    if (run) {
      activeRunManager.attachClient(sessionId, res, { announceAttach: true });
      return;
    }

    if (localOperation) {
      localChatOperationManager.attachClient(sessionId, res, { announceAttach: true });
      return;
    }

    pendingChatPreparationManager.attachClient(sessionId, res, { announceAttach: true });
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to attach chat stream.'));
      return;
    }
    try {
      res.end();
    } catch {}
  }
});

app.post('/api/chat/stop', async (req, res) => {
  const { sessionId } = req.body || {};

  if (!sessionId) {
    return res.status(400).json(buildStructuredChatHttpError('Missing sessionId'));
  }

  try {
    const normalizedSessionId = String(sessionId);
    const interruptedEpoch = getSessionInterruptionEpoch(normalizedSessionId);
    bumpSessionInterruptionEpoch(normalizedSessionId);
    pendingChatPreparationManager.cancel(normalizedSessionId, interruptedEpoch);
    const localAbortResult = localChatOperationManager.abort(normalizedSessionId, interruptedEpoch);
    const result = await activeRunManager.abortRun(normalizedSessionId);
    let orphanAbortResult: { aborted: boolean; runIds: string[] } = { aborted: false, runIds: [] };
    try {
      const sessionInfo = sessionManager.getSession(normalizedSessionId);
      const agentId = sessionInfo?.agentId || 'main';
      const client = await getConnection(normalizedSessionId);
      orphanAbortResult = await abortOpenClawSessionRuns(
        client,
        buildOpenClawChatSessionKey(normalizedSessionId, agentId),
        `session ${normalizedSessionId} stop`,
        { retryOnMiss: true },
      );
    } catch (error) {
      console.warn(`[chat] Failed to abort orphan OpenClaw runs while stopping session ${normalizedSessionId}:`, error);
    }
    await reconcileInactiveChatLatestMessage(normalizedSessionId);
    res.json({
      success: true,
      aborted: localAbortResult.aborted || result.aborted || orphanAbortResult.aborted,
      runIds: orphanAbortResult.runIds,
    });
  } catch (error: any) {
    res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to stop chat run.'));
  }
});

app.post('/api/chat/silent', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Missing sessionId or message' });
  }

  try {
    const client = await getConnection(sessionId);
    const rawResponse = await client.sendChatMessage({ sessionKey: sessionId, message });
    // Rewrite absolute OpenClaw media paths to HTTP-accessible URLs
    const response = rewriteOpenClawMediaPaths(rawResponse, getSessionWorkspacePath(sessionId));
    // Note: We intentionally DO NOT save to DB here
    res.json({ success: true, response });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// file upload (doc/image/video/audio), supports multiple files
app.post('/api/files/upload', (req, res) => {
  upload.array('files', 20)(req, res, async (error) => {
    if (error) {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      if (error instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Upload failed' });
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length) return res.status(400).json({ success: false, error: 'No files uploaded' });

    const uploadTarget = resolveUploadTargetFromBody((req.body || {}) as Record<string, unknown>);
    const IMAGE_TARGET_SIZE = 4_500_000; // 4.5MB target for images (OpenClaw has 5MB limit)

    const saved = await Promise.all(files.map(async (f) => {
      let finalSize = f.size;

      if (f.mimetype.startsWith('image/')) {
        try {
          const originalBuffer = fs.readFileSync(f.path);
          const metadata = await sharp(originalBuffer).metadata();
          let width = metadata.width || 2048;
          let height = metadata.height || 2048;
          const maxDimension = 2048;

          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height / width) * maxDimension);
              width = maxDimension;
            } else {
              width = Math.round((width / height) * maxDimension);
              height = maxDimension;
            }
          }

          let quality = 80;

          while (quality >= 10) {
            const nextBuffer = await sharp(originalBuffer)
              .resize(width, height, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality, mozjpeg: true })
              .toBuffer();

            if (nextBuffer.length <= IMAGE_TARGET_SIZE || quality <= 10) {
              fs.writeFileSync(f.path, nextBuffer);
              finalSize = nextBuffer.length;
              break;
            }

            quality -= 10;
          }
        } catch (err) {
          console.error('[Upload] Image compression failed:', err);
        }
      }

      db.saveFile({
        sessionKey: uploadTarget.sessionKey,
        originalName: f.originalname,
        mimeType: f.mimetype,
        size: finalSize,
        storedPath: f.path,
      });

      return {
        name: f.originalname,
        mimeType: f.mimetype,
        size: finalSize,
        url: `/uploads/${path.basename(f.path)}`,
      };
    }));

    res.json({
      success: true,
      files: saved,
    });
  });
});

app.get('/api/files', (_req, res) => {
  res.json({ success: true, files: db.getFiles(300) });
});

app.get('/api/commands', (_req, res) => {
  const commands = db.getQuickCommands();
  res.json({ success: true, commands });
});

app.post('/api/commands', (req, res) => {
  const { command, description } = req.body;
  if (!command || !description) return res.status(400).json({ success: false, error: 'Missing command or description' });
  try {
    db.saveQuickCommand(command, description);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/commands/:id', (req, res) => {
  const { command, description } = req.body;
  const { id } = req.params;
  if (!command || !description) return res.status(400).json({ success: false, error: 'Missing command or description' });
  try {
    db.updateQuickCommand(Number(id), command, description);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/commands/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.deleteQuickCommand(Number(id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  
  // 1. Try to find in database (to support agent workspaces)
  const fileInfo = db.getFileByStoredName(filename);
  if (fileInfo && fs.existsSync(fileInfo.stored_path)) {
    return res.sendFile(fileInfo.stored_path);
  }

  // 2. Fallback to global upload dir
  const globalPath = path.join(uploadDir, filename);
  if (fs.existsSync(globalPath)) {
    return res.sendFile(globalPath);
  }

  res.status(404).send('File not found');
});


// Serve OpenClaw workspace files.
//
// 这里原本是 `express.static(~/.openclaw)`，把整棵目录树挂了出去——`openclaw.json`
// 里的模型 API key、`agents/*/agent/auth-profiles.json` 里的凭据、每个智能体的记忆，
// 未鉴权一次 GET 全拿得到。现在走与 `/api/files/download` 同一道白名单闸门：
// 只有工作区与上传目录下的非凭据文件可以被服务。
app.get(/^\/openclaw\/(.+)/, (req, res) => {
  const relative = decodeURIComponent(req.params[0] || '');
  const verdict = resolveServablePath(path.join(process.env.HOME || '', '.openclaw', relative));
  if (!verdict.ok) {
    return res.status(verdict.reason === 'notFound' ? 404 : 403).send('Not available');
  }
  res.sendFile(verdict.realPath);
});

// Securely serve arbitrary local files via base64 encoded paths
app.get('/api/files/download', (req, res) => {
  const b64Path = req.query.path as string;
  const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
  if (!b64Path) {
    return res.status(400).send('Missing path parameter');
  }

  try {
    const absolutePath = Buffer.from(b64Path, 'base64').toString('utf8');

    // 「是不是绝对路径」不是安全检查：它放行 /etc/passwd、~/.ssh/id_rsa 与
    // auth-profiles.json。真正的判据是这个文件是否落在允许的工作区/上传目录内，
    // 且不是凭据类文件；路径先 realpath 再判归属，符号链接逃不出去。
    const verdict = resolveServablePath(absolutePath);
    if (!verdict.ok) {
      if (verdict.reason === 'notFound') return res.status(404).send('File not found');
      if (verdict.reason === 'notAbsolute') return res.status(403).send('Only absolute paths are allowed');
      console.warn(`[Download Blocked] ${verdict.reason}: ${absolutePath}`);
      return res.status(403).send('This file is not available for download');
    }

    const filename = path.basename(verdict.realPath);
    // Allow inline responses for preview while keeping attachment as the default download behavior.
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.sendFile(verdict.realPath);
  } catch (error: any) {
    console.error(`[Download Error] ${error.message}`);
    res.status(500).send('Failed to serve file');
  }
});

// File preview capabilities
app.get('/api/files/capabilities', (_req, res) => {
  res.json({ libreoffice: hasLibreOffice });
});

const HTML_PREVIEW_ROUTE_PADDING_SEGMENT = '__claw_preview_root__';

function decodeAbsolutePathParam(b64Path: string): string {
  const absolutePath = Buffer.from(b64Path, 'base64').toString('utf8');
  if (!path.isAbsolute(absolutePath)) {
    throw new Error('Only absolute paths are allowed');
  }
  return absolutePath;
}

/**
 * 任何「按路径把文件交给浏览器」的入口都必须过这道闸门。
 *
 * 上一轮只给 /api/files/download 与 /openclaw 补了白名单，紧挨着的
 * preview / preview-data / html-preview 三个入口漏了——同一类洞，堵一个不堵其余
 * 等于没堵（实测可读 ~/.ssh/id_rsa 与 openclaw.json 里的模型 apiKey）。
 * 所以判定收敛到这一个函数，新增出文件的路由只要复用它就不会再漏。
 */
function assertServablePath(absolutePath: string): string {
  const verdict = resolveServablePath(absolutePath);
  if (verdict.ok) return verdict.realPath;
  if (verdict.reason === 'notFound') throw new StructuredRequestError(404, 'files.notFound', 'File not found');
  console.warn(`[ServedPath Blocked] ${verdict.reason}: ${absolutePath}`);
  throw new StructuredRequestError(403, 'files.notServable', 'This file is not available');
}

function decodeBase64UrlUtf8(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function resolveStoredPreviewAbsolutePath(filenameParam?: string): string {
  if (!filenameParam) {
    return '';
  }

  const decodedFilename = decodeURIComponent(filenameParam);
  const fileInfo = db.getFileByStoredName(decodedFilename);
  if (fileInfo && fs.existsSync(fileInfo.stored_path)) {
    return fileInfo.stored_path;
  }

  const globalPath = path.join(uploadDir, decodedFilename);
  if (fs.existsSync(globalPath)) {
    return globalPath;
  }

  return '';
}

function resolvePreviewAbsolutePath(req: express.Request): string {
  const b64Path = req.query.path as string | undefined;
  const filenameParam = req.query.filename as string | undefined;

  if (b64Path) {
    return assertServablePath(decodeAbsolutePathParam(b64Path));
  }

  const stored = resolveStoredPreviewAbsolutePath(filenameParam);
  return stored ? assertServablePath(stored) : stored;
}

async function ensureConvertedPreviewPdf(absolutePath: string): Promise<string> {
  if (!hasLibreOffice) {
    throw new Error('LibreOffice not available');
  }

  const crypto = require('crypto');
  const stat = fs.statSync(absolutePath);
  const cacheKey = crypto.createHash('md5').update(`${absolutePath}:${stat.mtimeMs}`).digest('hex');
  const cachedPdf = path.join(previewCacheDir, `${cacheKey}.pdf`);

  if (fs.existsSync(cachedPdf)) {
    return cachedPdf;
  }

  const inFlight = previewConversionPromises.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const conversionPromise = (async () => {
    const tmpDir = fs.mkdtempSync(path.join(previewCacheDir, `${cacheKey}-`));
    const startedAt = Date.now();
    const timeoutSeconds = configManager.getConfig().previewConversionTimeoutSeconds || 60;
    const timeoutMs = timeoutSeconds * 1000;

    try {
      await execFileWithInput(
        'libreoffice',
        ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, absolutePath],
        '',
        { timeout: timeoutMs }
      );

      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.pdf'));
      if (files.length === 0) {
        throw new Error('LibreOffice conversion produced no PDF output');
      }

      const outputPdf = path.join(tmpDir, files[0]);
      fs.renameSync(outputPdf, cachedPdf);
      console.log(`[Preview] Converted ${path.basename(absolutePath)} in ${Date.now() - startedAt}ms`);

      return cachedPdf;
    } catch (error: any) {
      const detail = [error?.stderr, error?.stdout, error?.message]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' | ');
      if (error?.timedOut) {
        console.error(
          `[Preview] LibreOffice conversion timed out for ${absolutePath} after ${Date.now() - startedAt}ms (configured ${timeoutMs}ms)${detail ? `: ${detail}` : ''}`
        );
        throw new StructuredRequestError(
          504,
          FILE_PREVIEW_CONVERSION_TIMED_OUT_ERROR_CODE,
          detail || null,
          { timeoutSeconds }
        );
      }
      console.error(
        `[Preview] LibreOffice conversion failed for ${absolutePath} after ${Date.now() - startedAt}ms${detail ? `: ${detail}` : ''}`
      );
      throw error;
    } finally {
      previewConversionPromises.delete(cacheKey);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();

  previewConversionPromises.set(cacheKey, conversionPromise);
  return conversionPromise;
}

function resolveHtmlPreviewEntryAbsolutePath(req: express.Request): string {
  if (req.params.encodedPath) {
    const absolutePath = decodeBase64UrlUtf8(req.params.encodedPath);
    if (!path.isAbsolute(absolutePath)) {
      throw new Error('Only absolute paths are allowed');
    }
    return assertServablePath(absolutePath);
  }

  if (req.params.filename) {
    const stored = resolveStoredPreviewAbsolutePath(req.params.filename);
    return stored ? assertServablePath(stored) : stored;
  }

  return '';
}

function resolveHtmlPreviewRequestedPath(entryAbsolutePath: string, relativePath: string | undefined): string {
  const normalizedRelativePath = (relativePath || '')
    .split('/')
    .filter(Boolean)
    .filter((segment) => segment !== HTML_PREVIEW_ROUTE_PADDING_SEGMENT)
    .join('/');

  if (!normalizedRelativePath || normalizedRelativePath === path.basename(entryAbsolutePath)) {
    return entryAbsolutePath;
  }

  // 相对段里过滤了空段与 padding 段，但没过滤 `..`——一个 HTML 里写
  // <img src="../../../../etc/passwd"> 就能越界。子资源必须留在入口文件所在目录内。
  const entryDir = path.dirname(entryAbsolutePath);
  const resolved = path.resolve(entryDir, normalizedRelativePath);
  const relative = path.relative(entryDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StructuredRequestError(403, 'files.notServable', 'This file is not available');
  }
  return resolved;
}

function serveHtmlPreviewRequest(req: express.Request, res: express.Response) {
  try {
    const entryAbsolutePath = resolveHtmlPreviewEntryAbsolutePath(req);
    if (!entryAbsolutePath || !fs.existsSync(entryAbsolutePath)) {
      return res.status(404).send('File not found');
    }

    const requestedPath = assertServablePath(resolveHtmlPreviewRequestedPath(entryAbsolutePath, req.params[0]));
    if (!fs.existsSync(requestedPath)) {
      return res.status(404).send('File not found');
    }

    const stat = fs.statSync(requestedPath);
    if (!stat.isFile()) {
      return res.status(404).send('File not found');
    }

    const filename = path.basename(requestedPath);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.sendFile(requestedPath);
  } catch (error: any) {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    console.error(`[HTML Preview Error] ${error.message}`);
    if (error.message === 'Only absolute paths are allowed') {
      return res.status(403).send(error.message);
    }
    return res.status(500).send('Failed to serve HTML preview');
  }
}

app.get('/api/files/preview-data', async (req, res) => {
  try {
    const mode = req.query.mode === 'converted' ? 'converted' : 'source';
    const absolutePath = resolvePreviewAbsolutePath(req);

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const servedPath = mode === 'converted'
      ? await ensureConvertedPreviewPdf(absolutePath)
      : absolutePath;

    const buffer = fs.readFileSync(servedPath);
    res.json({
      filename: path.basename(servedPath),
      data: buffer.toString('base64'),
      mimeType: mode === 'converted' ? 'application/pdf' : undefined,
    });
  } catch (error: any) {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    console.error(`[Preview Data Error] ${error.message}`);
    if (error.message === 'Only absolute paths are allowed') {
      return res.status(403).json({ error: error.message });
    }
    if (error.message === 'LibreOffice not available') {
      return res.status(501).json({ error: error.message, fallback: true });
    }
    res.status(500).json({ error: 'Preview data failed', message: error.message });
  }
});

app.get('/api/files/html-preview/path/:encodedPath/*', (req, res) => {
  serveHtmlPreviewRequest(req, res);
});

app.get('/api/files/html-preview/upload/:filename/*', (req, res) => {
  serveHtmlPreviewRequest(req, res);
});

app.get('/api/files/preview', async (req, res) => {
  try {
    const mode = req.query.mode === 'source' ? 'source' : 'converted';
    const absolutePath = resolvePreviewAbsolutePath(req);

    if (!absolutePath) {
      return res.status(404).send('File not found');
    }

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).send('File not found');
    }

    const filename = path.basename(absolutePath);

    if (mode === 'source') {
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
      return res.sendFile(absolutePath);
    }

    if (!hasLibreOffice) {
      return res.status(501).json({ error: 'LibreOffice not available', fallback: true });
    }

    const cachedPdf = await ensureConvertedPreviewPdf(absolutePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(cachedPdf))}`);
    res.sendFile(cachedPdf);
  } catch (error: any) {
    if (isStructuredRequestError(error)) {
      return res.status(error.status).json(error.payload);
    }
    console.error(`[Preview Error] ${error.message}`);
    if (error.message === 'Only absolute paths are allowed') {
      return res.status(403).send(error.message);
    }
    res.status(500).json({ error: 'Preview conversion failed', message: error.message });
  }
});

// Serve hashed static assets with long-lived cache (JS/CSS filenames include content hash)
app.use('/assets', express.static(path.join(__dirname, '../../frontend/dist/assets'), {
  maxAge: '1y',
  immutable: true,
}));

// Serve other static files (images, favicon, manifest, etc.) with short cache
app.use(express.static(path.join(__dirname, '../../frontend/dist'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // index.html must NEVER be cached by proxies — always revalidate
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// ========== Group Chat Engine ==========
const groupChatEngine = new GroupChatEngine(db, getConnection, (agentId) => {
  // First, check if there's a custom session for this agent
  const sessions = sessionManager.getAllSessions();
  const session = sessions.find((s: any) => s.agentId === agentId);
  if (session) {
    // group-chat-engine.ts 本 sprint 明确不碰（Sprint 3 范围）——这个 resolver
    // 是它的调用入口，不确定它在哪些调用路径下没有自己的 try/catch，所以这里
    // 显式吞掉 ConfigReadError、退回下面 characters 表的兜底，保持这个入口原有
    // 的容错行为不变；真实失败已经在 readAgentModel 内部往上抛给了其它调用点。
    let customModel: string | null = null;
    try {
      customModel = agentProvisioner.readAgentModel(agentId);
    } catch (err) {
      if (!(err instanceof ConfigReadError)) throw err;
      // 红线 C：退回 characters 表是有意的容错，但**静默地退**不是。
      // 不打这行日志的话，一个「openclaw.json 读不动」会表现为
      // 「这个 Agent 忽然用上了另一个模型」，没有任何东西指向真实原因。
      console.warn(
        `[GroupChat] 读取 agent 模型失败（${err.reason}），回落 characters 表：agentId=${agentId}`,
      );
    }
    if (customModel) return customModel;
  }

  // Fallback to characters table for hardcoded system agents
  const chars = db.getCharacters();
  const c = chars.find(x => x.agentId === agentId);
  return c?.model || '';
}, () => {
  const configuredLanguage = configManager.getConfig().language;
  return configuredLanguage === 'zh-TW' || configuredLanguage === 'en' ? configuredLanguage : 'zh-CN';
}, prepareGroupRuntimeAgent, tryGenerateImageForPrompt, () => {
  const modelId = getConfiguredDirectImageGenerationModel();
  return modelId ? buildImageGenerationStartProcessContent(modelId) : null;
}, (agentId) => {
  const sessionInfo = db.getSessionByAgentId(agentId) || db.getSession(agentId);
  return shouldInjectHostTakeoverInstruction(sessionInfo, agentId);
});

// SSE clients per group
const groupSSEClients = new Map<string, Set<express.Response>>();

groupChatEngine.on('message', (msg: any) => {
  const clients = groupSSEClients.get(msg.groupId);
  if (clients) {
    const data = JSON.stringify({
      type: 'message',
      data: withStructuredGroupMessage(msg, { groupId: msg.groupId }),
    });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('delete', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({ type: 'delete', id: info.id, parent_id: info.parent_id ?? null });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('delta', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({
      type: 'delta',
      ...info,
      content: typeof info.content === 'string'
        ? rewriteOpenClawMediaPaths(info.content, getGroupWorkspaceForDisplay(info.groupId))
        : info.content,
    });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('edit', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({
      type: 'edit',
      ...info,
      content: typeof info.content === 'string'
        ? rewriteOpenClawMediaPaths(info.content, getGroupWorkspaceForDisplay(info.groupId))
        : info.content,
    });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('typing', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({ type: 'typing', data: info });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('typing_done', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({ type: 'typing_done', data: info });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

groupChatEngine.on('run_state', (info: any) => {
  const clients = groupSSEClients.get(info.groupId);
  if (clients) {
    const data = JSON.stringify({ type: 'run_state', data: info });
    for (const client of clients) {
      try { client.write(`data: ${data}\n\n`); } catch {}
    }
  }
});

// --- Group Chat CRUD ---
app.get('/api/groups', (_req, res) => {
  try {
    const groups = db.getGroupChats();
    // Attach members to each group
    const result = groups.map(g => ({
      ...g,
      members: db.getGroupMembers(g.id).map(withResolvedGroupMemberDisplayName),
    }));
    res.json({ success: true, groups: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups', (req, res) => {
  let persistedGroupId: string | null = null;
  try {
    const { id: rawId, name, description, system_prompt, process_start_tag, process_end_tag, max_chain_depth, members } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });

    const validation = validateGroupId(rawId);
    if (validation.issue === 'required') {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_REQUIRED_ERROR_CODE));
    }
    if (validation.issue === 'whitespace') {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE));
    }
    if (validation.issue) {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_INVALID_ERROR_CODE, null, {
        groupId: validation.normalizedId || String(rawId || ''),
      }));
    }

    const id = validation.normalizedId;
    if (db.getGroupChat(id)) {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_ALREADY_EXISTS_ERROR_CODE, null, { groupId: id }));
    }

    const now = new Date().toISOString();
    const allGroups = db.getGroupChats();
    const maxPosition = allGroups.length > 0 ? Math.max(...allGroups.map((group) => group.position || 0)) : -1;
    db.saveGroupChat({
      id,
      name,
      description: description || '',
      system_prompt: system_prompt || '',
      process_start_tag: process_start_tag || '',
      process_end_tag: process_end_tag || '',
      max_chain_depth: max_chain_depth !== undefined ? max_chain_depth : 6,
      runtime_session_epoch: createNextGroupRuntimeSessionEpoch(),
      position: maxPosition + 1,
      created_at: now,
      updated_at: now,
    });
    persistedGroupId = id;

    // Save members
    if (Array.isArray(members)) {
      members.forEach((m: any, idx: number) => {
        db.saveGroupMember({
          id: `gm_${id}_${m.agentId}`,
          group_id: id,
          agent_id: m.agentId,
          display_name: m.displayName || m.agentId,
          role_description: m.roleDescription || '',
          position: idx,
        });
      });
    }

    ensureGroupWorkspace(id);
    res.json({ success: true, id });
  } catch (err: any) {
    if (/UNIQUE constraint failed: group_chats\.id|PRIMARY KEY/i.test(String(err?.message || ''))) {
      return res.status(400).json(buildStructuredApiError(GROUP_ID_ALREADY_EXISTS_ERROR_CODE, null, {
        groupId: typeof req.body?.id === 'string' ? req.body.id.trim() : '',
      }));
    }
    if (persistedGroupId) {
      try {
        db.deleteGroupChat(persistedGroupId);
        deleteGroupWorkspace(persistedGroupId);
      } catch {}
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/groups/:id', (req, res) => {
  try {
    const existing = db.getGroupChat(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Group not found' });

    const { name, description, system_prompt, process_start_tag, process_end_tag, max_chain_depth, members } = req.body;
    db.saveGroupChat({
      ...existing,
      name: name ?? existing.name,
      description: description ?? existing.description,
      system_prompt: system_prompt ?? existing.system_prompt,
      process_start_tag: process_start_tag ?? existing.process_start_tag,
      process_end_tag: process_end_tag ?? existing.process_end_tag,
      max_chain_depth: max_chain_depth ?? existing.max_chain_depth ?? 6,
      runtime_session_epoch: existing.runtime_session_epoch ?? 0,
      position: existing.position ?? 0,
      updated_at: new Date().toISOString(),
    });

    // Replace members if provided
    if (Array.isArray(members)) {
      db.deleteGroupMembers(req.params.id);
      members.forEach((m: any, idx: number) => {
        db.saveGroupMember({
          id: `gm_${req.params.id}_${m.agentId}`,
          group_id: req.params.id,
          agent_id: m.agentId,
          display_name: m.displayName || m.agentId,
          role_description: m.roleDescription || '',
          position: idx,
        });
      });
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) {
    return res.status(400).json({ success: false, error: 'Invalid ids format' });
  }

  try {
    db.updateGroupChatPositions(ids.map((id: string, index: number) => ({ id, position: index })));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  try {
    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    groupChatEngine.markGroupReset(req.params.id);
    try {
      await groupChatEngine.abortGroupRun(req.params.id);
    } catch {}
    groupChatEngine.forceResetGroupState(req.params.id);
    clearStoredFilesBySessionKey(req.params.id);
    const configCleanupFailed = cleanupGroupRuntimeAgent(req.params.id, { removeConfig: true });
    deleteGroupWorkspace(req.params.id);
    db.deleteGroupChat(req.params.id);
    // 群、工作区、库行都删干净了；只有 openclaw.json 的清理没跑完（配置读不动）。
    // 措辞是「没跑完」而不是「还留着」——配置读不动时我们并不知道里面有没有那个条目。
    res.json(configCleanupFailed.length > 0
      ? { success: true, configCleanupFailed, warningCode: AGENT_CONFIG_READ_FAILED_ERROR_CODE }
      : { success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset group back to its initialized runtime state while keeping the team entity and members.
app.post('/api/groups/:id/reset', async (req, res) => {
  try {
    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    groupChatEngine.markGroupReset(req.params.id);
    try {
      await groupChatEngine.abortGroupRun(req.params.id);
    } catch {}
    groupChatEngine.forceResetGroupState(req.params.id);

    // Restore the team runtime baseline while keeping the team definition.
    db.saveGroupChat({
      ...group,
      runtime_session_epoch: createNextGroupRuntimeSessionEpoch(group.runtime_session_epoch),
      updated_at: new Date().toISOString(),
    });
    db.deleteGroupMessagesByGroup(req.params.id);
    clearStoredFilesBySessionKey(req.params.id);
    const configCleanupFailed = cleanupGroupRuntimeAgent(req.params.id, { removeConfig: true });
    resetGroupWorkspace(req.params.id);

    res.json(configCleanupFailed.length > 0
      ? { success: true, configCleanupFailed, warningCode: AGENT_CONFIG_READ_FAILED_ERROR_CODE }
      : { success: true });
  } catch (err: any) {
    console.error('Failed to reset group:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Group Messages ---
app.get('/api/groups/:id/messages', async (req, res) => {
  try {
    await reconcileInactiveGroupLatestMessage(req.params.id);
    const { beforeId, limit } = getHistoryPageQueryParams(req.query as Record<string, unknown>);
    const result = db.getGroupMessagesPage(req.params.id, { beforeId, limit });
    res.json(buildHistoryPageResponse(
      result.rows.map((row) => withStructuredGroupMessage(row, { groupId: req.params.id })),
      result.pageInfo,
    ));
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/groups/:id/active-run', async (req, res) => {
  try {
    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    const runState = groupChatEngine.getGroupRunState(req.params.id);
    const activeMessage = groupChatEngine.getGroupActiveRunMessage(req.params.id);
    if (!runState.active) {
      const actions = await reconcileInactiveGroupLatestMessage(req.params.id);
      if (actions.length > 0) {
        broadcastGroupReconciliationActions(req.params.id, actions);
      }

      const latestMessage = db.getRecentGroupMessages(req.params.id, 1)[0];
      return res.json({
        success: true,
        active: false,
        runState,
        message: latestMessage ? withStructuredGroupMessage(latestMessage, { groupId: req.params.id }) : null,
      });
    }

    res.json({
      success: true,
      active: true,
      runState,
      message: activeMessage ? withStructuredGroupMessage(activeMessage, { groupId: req.params.id }) : null,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/groups/:id/messages/search', (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(buildHistorySearchResponse(db.searchGroupMessages(req.params.id, query)));
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/:id/messages', async (req, res) => {
  try {
    const { content, parentId: rawParentId } = req.body;
    if (!content?.trim()) return res.status(400).json({ success: false, error: 'content is required' });

    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    if (groupChatEngine.isGroupProcessing(req.params.id)) {
      return res.status(409).json({
        // 把「已经跑了多久」一并回去：用户看到「上一轮已经跑了 3 分钟」
        // 和看到一个裸 409，能做的判断完全不同。
        ...buildStructuredApiError(GROUP_RUN_IN_PROGRESS_ERROR_CODE, null, {
          minutes: groupChatEngine.groupLockAgeMinutes(req.params.id) ?? 0,
        }),
        runState: groupChatEngine.getGroupRunState(req.params.id),
      });
    }

    const parsedParentId = (
      typeof rawParentId === 'number' && Number.isFinite(rawParentId) && rawParentId > 0
        ? Math.floor(rawParentId)
        : typeof rawParentId === 'string' && rawParentId.trim()
          ? Number.parseInt(rawParentId, 10)
          : undefined
    );
    const parentId = Number.isFinite(parsedParentId as number) && (parsedParentId as number) > 0
      ? Number(parsedParentId)
      : undefined;

    // Respond immediately, processing happens async
    res.json({ success: true });

    // Process message in background
    (groupChatEngine as any).sendUserMessage(req.params.id, content, parentId).catch((err: any) => {
      console.error('[GroupChat] Error processing message:', err);
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/:id/stop', async (req, res) => {
  try {
    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }

    groupChatEngine.markGroupReset(req.params.id);
    const result = await groupChatEngine.abortGroupRun(req.params.id).catch((error) => {
      console.warn(`[GroupStop] Failed to abort active run for group ${req.params.id}:`, error);
      return { aborted: false };
    });
    groupChatEngine.forceResetGroupState(req.params.id);
    const cleanedMessageIds: number[] = [];

    const recentMessages = db.getRecentGroupMessages(req.params.id, 20);
    const staleMessages = recentMessages.filter((message) => (
      message.sender_type === 'agent'
      && typeof message.content === 'string'
      && message.content.trim() === ''
    ));

    if (staleMessages.length > 0) {
      const clients = groupSSEClients.get(req.params.id);
      for (const staleMessage of staleMessages) {
        if (typeof staleMessage.id !== 'number') continue;
        db.deleteGroupMessage(staleMessage.id);
        cleanedMessageIds.push(staleMessage.id);
        if (clients) {
          const data = JSON.stringify({ type: 'delete', id: staleMessage.id, parent_id: staleMessage.parent_id ?? null });
          for (const client of clients) {
            try { client.write(`data: ${data}\n\n`); } catch {}
          }
        }
      }
    }

    res.json({ success: true, aborted: result.aborted, cleanedMessageIds });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/groups/:id/messages/:msgId', (req, res) => {
  try {
    const { content } = req.body;
    const messageId = Number(req.params.msgId);
    const group = db.getGroupChat(req.params.id);
    if (!group) {
      return res.status(404).json(buildStructuredApiError(GROUP_NOT_FOUND_ERROR_CODE, null, { groupId: req.params.id }));
    }
    if (!content?.trim()) {
      return res.status(400).json({ success: false, error: 'content is required' });
    }

    const existingMessage = db.getGroupMessageById(messageId, req.params.id);
    if (!existingMessage) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    const shouldRerun = existingMessage.sender_type === 'user';
    if (shouldRerun && groupChatEngine.isGroupProcessing(req.params.id)) {
      return res.status(409).json({
        // 把「已经跑了多久」一并回去：用户看到「上一轮已经跑了 3 分钟」
        // 和看到一个裸 409，能做的判断完全不同。
        ...buildStructuredApiError(GROUP_RUN_IN_PROGRESS_ERROR_CODE, null, {
          minutes: groupChatEngine.groupLockAgeMinutes(req.params.id) ?? 0,
        }),
        runState: groupChatEngine.getGroupRunState(req.params.id),
      });
    }

    db.updateGroupMessage(
      messageId,
      content,
      existingMessage.model_used,
      existingMessage.mentions ?? null,
      existingMessage.process_content ?? null,
    );

    const updatedMessage = db.getGroupMessageById(messageId, req.params.id);
    const deletedRows = shouldRerun
      ? db.deleteGroupMessageDescendants(messageId) as Array<{ id: number; parent_id: number | null }>
      : [];
    const deletedIds = deletedRows.map((row) => row.id);

    res.json({ success: true, rerunStarted: shouldRerun, deletedIds });

    const clients = groupSSEClients.get(req.params.id);
    if (clients) {
      clients.forEach(client => {
        if (updatedMessage) {
          client.write(`data: ${JSON.stringify({ type: 'edit', ...withStructuredGroupMessage(updatedMessage, { groupId: req.params.id }) })}\n\n`);
        }
        if (deletedIds.length > 0) {
          client.write(`data: ${JSON.stringify({ type: 'delete', deletedIds, fallbackParentId: messageId })}\n\n`);
        }
      });
    }

    if (shouldRerun) {
      void groupChatEngine.rerunUserMessage(req.params.id, messageId).catch((err: any) => {
        console.error('[GroupChat] Error rerunning edited user message:', err);
      });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/groups/:id/messages/:msgId', (req, res) => {
  try {
    const deletedRows = db.deleteGroupMessage(Number(req.params.msgId)) as Array<{ id: number; parent_id: number | null }>;
    if (!deletedRows.length) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    const deletedIds = deletedRows.map((row) => row.id);
    const fallbackParentId = deletedRows[0]?.parent_id ?? null;
    res.json({ success: true, deletedIds, fallbackParentId });

    // Broadcast delete event
    const clients = groupSSEClients.get(req.params.id);
    if (clients) {
      clients.forEach(client => {
        client.write(`data: ${JSON.stringify({ type: 'delete', deletedIds, fallbackParentId })}\n\n`);
      });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/:id/messages/regenerate', async (req, res) => {
  try {
    const { msgId } = req.body; // The message we want to regenerate
    if (!msgId) return res.status(400).json({ success: false, error: 'msgId required' });
    
    const targetMsg = db.getGroupMessageById(Number(msgId), req.params.id) as any;
    
    if (!targetMsg || targetMsg.sender_type !== 'agent' || !targetMsg.sender_id) {
       return res.status(400).json({ success: false, error: 'Cannot regenerate this message' });
    }

    // In linear group history, regenerate reuses the parent trigger message.
    let promptContext = "继续";
    let validParentId = targetMsg.parent_id || null;
    if (validParentId) {
       const triggerMsg = db.getGroupMessageById(validParentId) as any;
       if (triggerMsg) {
         promptContext = triggerMsg.content;
       } else {
         validParentId = null; // SAFEGUARD: Prevent FOREIGN KEY constraint fail if parent is orphaned
       }
    }

    db.deleteGroupMessage(Number(msgId));
    const clients = groupSSEClients.get(req.params.id);
    if (clients) {
      clients.forEach(client => {
        client.write(`data: ${JSON.stringify({ type: 'delete', id: Number(msgId), parent_id: validParentId })}\n\n`);
      });
    }

    res.json({ success: true });

    // Inform engine to resend request as a sibling response
    const groupName = db.getGroupChat(req.params.id)?.name || '团队';
    // Emulate a new trigger directly targeting that agent without advancing depth too quickly, using promptContext
    (groupChatEngine as any).sendToAgent(req.params.id, groupName, targetMsg.sender_id, promptContext, targetMsg.sender_name || 'Agent', 0, validParentId || undefined).catch((err: any) => {
      console.error('[GroupChat] Error regenerating message:', err);
    });

  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SSE endpoint for real-time updates
app.get('/api/groups/:id/events', async (req, res) => {
  const groupId = req.params.id;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write('retry: 1000\n\n');
  // Send initial ping
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'run_state', data: groupChatEngine.getGroupRunState(groupId) })}\n\n`);

  const keepaliveTimer = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {}
  }, GROUP_SSE_KEEPALIVE_MS);

  if (!groupSSEClients.has(groupId)) {
    groupSSEClients.set(groupId, new Set());
  }
  groupSSEClients.get(groupId)!.add(res);

  try {
    const actions = await reconcileInactiveGroupLatestMessage(groupId);
    broadcastGroupReconciliationActions(groupId, actions);
  } catch (error) {
    console.warn(`[GroupEvents] Failed to reconcile group ${groupId} on SSE connect:`, error);
  }

  req.on('close', () => {
    clearInterval(keepaliveTimer);
    groupSSEClients.get(groupId)?.delete(res);
    if (groupSSEClients.get(groupId)?.size === 0) {
      groupSSEClients.delete(groupId);
    }
  });
});

// Fallback for SPA — also no-cache
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
});

// Error handling
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Express error:', err);
  if (isStructuredRequestError(err)) {
    return res.status(err.status).json(err.payload);
  }
  res.status(500).json({ success: false, error: err.message });
});

// Start server
const PORT = Number(process.env.PORT) || 3100;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ClawOPT backend listening on http://0.0.0.0:${PORT}`);
  scheduleOpenClawImageProviderCacheRefresh('startup');
  if (consumeBrowserWarmupRequest()) {
    console.log('[BrowserWarmup] Scheduling deferred browser warmup after restart.');
    void scheduleDeferredBrowserWarmup();
  }
  if (updateSnapshot.status === 'restarting') {
    console.log('[UpdateRestart] Resuming persisted restart flow after service restart.');
    void resumePersistedUpdateRestartFlow();
  }
});
