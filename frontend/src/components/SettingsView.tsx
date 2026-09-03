import { useState, useEffect, useRef, Fragment, type ChangeEvent } from 'react';
import { Eye, EyeOff, Check, X, Loader2, Edit2, Trash2, Plus, Menu, Activity, Globe, Zap, Wrench, ArrowUpDown, Link2, ChevronDown, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SettingsTab } from '../App';
import { applyLanguagePreference, normalizeLanguage, type SupportedLanguage } from '../i18n';
import {
  normalizeChatHistoryPageRounds,
  persistChatHistoryPageRounds,
  readChatHistoryPageRounds,
} from '../utils/historyPagination';
import ModelFallbackEditor, { type ModelFallbackMode } from './ModelFallbackEditor';
import ModelSinglePicker from './ModelSinglePicker';
import PresetLibrary from './PresetLibrary';

interface SettingsViewProps {
  isConnected: boolean;
  settingsTab: SettingsTab;
  onMenuClick: () => void;
  onModelsChanged?: () => void;
  onAgentsChanged?: () => void;
}

const PREVIEW_TIMEOUT_MIN_SECONDS = 5;
const PREVIEW_TIMEOUT_MAX_SECONDS = 3600;

function normalizePreviewTimeoutSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(PREVIEW_TIMEOUT_MAX_SECONDS, Math.max(PREVIEW_TIMEOUT_MIN_SECONDS, Math.round(value)));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(PREVIEW_TIMEOUT_MAX_SECONDS, Math.max(PREVIEW_TIMEOUT_MIN_SECONDS, parsed));
    }
  }

  return 60;
}

function parsePreviewTimeoutSecondsInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (parsed < PREVIEW_TIMEOUT_MIN_SECONDS || parsed > PREVIEW_TIMEOUT_MAX_SECONDS) {
    return null;
  }

  return parsed;
}

function resolveStructuredErrorDisplay(
  data: { errorCode?: string; errorParams?: Record<string, string | number | boolean | null> | null; errorDetail?: string | null; error?: string; message?: string },
  t: (key: string, options?: any) => string,
  fallbackKey: string
): { message: string; detail: string } {
  let message = '';
  let detail = typeof data.errorDetail === 'string' && data.errorDetail.trim() ? data.errorDetail.trim() : '';

  if (data.errorCode) {
    const translated = t(data.errorCode, (data.errorParams || {}) as any);
    if (translated !== data.errorCode) {
      message = translated;
    }
  }

  if (!message && typeof data.error === 'string' && data.error.trim()) {
    message = data.error.trim();
  }

  if (!message && typeof data.message === 'string' && data.message.trim()) {
    message = data.message.trim();
  }

  if (!message && detail) {
    message = detail;
    detail = '';
  }

  return {
    message: message || t(fallbackKey),
    detail,
  };
}

function responseNeedsHostTakeoverPasswordPrompt(data: {
  errorCode?: string;
  errorDetail?: string | null;
  error?: string;
  message?: string;
}) {
  if (data.errorCode === 'gateway.hostTakeoverCredentialsRequired') {
    return true;
  }

  const detail = [
    typeof data.errorDetail === 'string' ? data.errorDetail : '',
    typeof data.error === 'string' ? data.error : '',
    typeof data.message === 'string' ? data.message : '',
  ].join('\n').toLowerCase();

  const sudoPromptDetected = detail.includes('sudo:') || detail.includes('sudo：') || detail.includes('[sudo]');
  const passwordPromptDetected = detail.includes('password')
    || detail.includes('密码')
    || detail.includes('口令')
    || detail.includes('passphrase');
  const terminalPromptDetected = detail.includes('terminal') || detail.includes('终端');
  const authPromptDetected = detail.includes('authentication') || detail.includes('认证');

  return detail.includes('password is required')
    || detail.includes('a terminal is required')
    || detail.includes('no askpass program specified')
    || detail.includes('authentication is required')
    || detail.includes('需要密码')
    || detail.includes('需要提供密码')
    || detail.includes('需要输入密码')
    || detail.includes('密码是必需的')
    || detail.includes('必须输入密码')
    || detail.includes('需要口令')
    || detail.includes('需要终端')
    || detail.includes('需要认证')
    || (sudoPromptDetected && passwordPromptDetected)
    || (sudoPromptDetected && terminalPromptDetected)
    || (sudoPromptDetected && authPromptDetected);
}

type TestStatus = {
  status: 'testing' | 'success' | 'error';
  message?: string;
  detail?: string;
};

type InlineErrorState = {
  message: string;
  detail: string;
};

type BrowserHealthIssue = 'permissions' | 'disabled' | 'stopped' | 'detect-error' | 'timeout' | 'unknown';

type BrowserHealthConfig = {
  enabled: boolean | null;
  headless: boolean | null;
  profile: string | null;
  executablePath?: string | null;
  noSandbox?: boolean | null;
  attachOnly?: boolean | null;
  cdpPort?: number | null;
};

type BrowserHealthRuntime = {
  profile: string | null;
  running: boolean | null;
  transport: string | null;
  chosenBrowser: string | null;
  detectedBrowser: string | null;
  headless: boolean | null;
  detectError: string | null;
};

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
  validationSucceeded?: boolean | null;
  validationDetail?: string | null;
  config?: BrowserHealthConfig | null;
  runtime?: BrowserHealthRuntime | null;
};

type BrowserHealthNotice = {
  tone: 'success' | 'warning';
  message: string;
};

type GatewayRestartNoticeSource = 'permissions' | 'browser' | null;

type BrowserHeadedModeConfig = {
  headless: boolean;
  headedModeEnabled: boolean;
};

type RestartFlowModalStage = 'confirm' | 'restarting' | 'success' | 'failure' | null;
type BrowserHeadedModeModalStage = RestartFlowModalStage;

type BrowserTaskStatus = 'idle' | 'checking' | 'repairing';

type BrowserTaskInfo = {
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

type GatewayRestartTaskInfo = {
  status: GatewayRestartTaskStatus;
  trigger: GatewayRestartTrigger | null;
  rawDetail: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  targetHeadedModeEnabled: boolean | null;
};

type HostTakeoverMode =
  | 'disabled'
  | 'ready'
  | 'needs_install'
  | 'broken';

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
  autoInstallMode: 'root' | 'sudo' | 'pkexec' | 'manual';
  manualInstallCommand: string | null;
  rawDetail: string | null;
};

type DevicePairingPendingRequest = {
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

type DevicePairingStatus = {
  pending: DevicePairingPendingRequest[];
  latestPending: DevicePairingPendingRequest | null;
  pairedCount: number | null;
  rawDetail: string | null;
};

type AppVersionInfo = {
  appName: string;
  version: string;
  releaseTag: string;
  commit: string | null;
  buildTime: string | null;
  repositoryUrl: string | null;
  openclawVersion: string | null;
};

type LatestVersionInfo = {
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
  canUpgrade: boolean;
  upgradeSupported: boolean;
  upgradeReasonCode?: string | null;
  upgradeReason: string | null;
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

type UpdateStatusInfo = {
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

type OpenClawUpdateStatus =
  | 'idle'
  | 'checking'
  | 'updating'
  | 'stopping'
  | 'update_succeeded'
  | 'update_failed';

type OpenClawUpdateStatusInfo = {
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

const EMPTY_INLINE_ERROR: InlineErrorState = { message: '', detail: '' };

type UpdateProgressTone = 'neutral' | 'brand' | 'success' | 'error';

type UpdatePhaseVisual = {
  progress: number;
  labelKey: string;
};

type UpdateRestartStepId =
  | 'restart_openclaw'
  | 'restart_project'
  | 'warmup_browser';

type UpdateRestartStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  // 这一步被跳过了，且这是正常结果——例如浏览器插件用户根本没启用。
  // 跳过不是失败：一个没开的可选能力不该让整条升级流程报红。
  | 'skipped'
  | 'failed';

type UpdateRestartStep = {
  id: UpdateRestartStepId;
  status: UpdateRestartStepStatus;
  detail: string | null;
  updatedAt: string | null;
};

type PersistedUpdateRestartModalState = {
  stage: 'restarting';
  detail: string;
  stepSnapshot: UpdateRestartStep[] | null;
  startedAtMs: number | null;
};

type BrowserTaskPhaseVisual = {
  progress: number;
  labelKey: string;
};

type UpdateProgressLayout = 'compact' | 'expanded';

const UPDATE_PHASE_VISUALS: Record<string, UpdatePhaseVisual> = {
  'downloading-script': { progress: 10, labelKey: 'settings.about.updateProgressFetchingCode' },
  'detect-service': { progress: 18, labelKey: 'settings.about.updateProgressPreparing' },
  'git-pull': { progress: 26, labelKey: 'settings.about.updateProgressFetchingCode' },
  'install-dependencies': { progress: 40, labelKey: 'settings.about.updateProgressInstallingDependencies' },
  'build': { progress: 58, labelKey: 'settings.about.updateProgressBuilding' },
  'patch-config': { progress: 68, labelKey: 'settings.about.updateProgressApplyingConfig' },
  'restart-openclaw-runtime': { progress: 86, labelKey: 'settings.about.updateProgressRestartingOpenClaw' },
  'reconcile-openclaw-runtime': { progress: 78, labelKey: 'settings.about.updateProgressReconcilingRuntime' },
  'repair-openclaw-device': { progress: 86, labelKey: 'settings.about.updateProgressRepairingDevice' },
  'recover-browser-runtime': { progress: 92, labelKey: 'settings.about.updateProgressRecoveringBrowser' },
  'setup-service': { progress: 96, labelKey: 'settings.about.updateProgressSettingUpService' },
  'service-restart': { progress: 98, labelKey: 'settings.about.updateProgressSettingUpService' },
  'restart-openclaw': { progress: 99, labelKey: 'settings.about.restartStepRestartOpenClaw' },
  'restart-project': { progress: 99, labelKey: 'settings.about.restartStepRestartProject' },
  'warmup-browser': { progress: 100, labelKey: 'settings.about.restartStepWarmupBrowser' },
  'complete': { progress: 100, labelKey: 'settings.about.updateProgressFinishing' },
};

const OPENCLAW_UPDATE_PHASE_VISUALS: Record<string, UpdatePhaseVisual> = {
  'checking-status': { progress: 12, labelKey: 'settings.openclawUpdate.progressChecking' },
  'download-package': { progress: 28, labelKey: 'settings.openclawUpdate.progressDownloading' },
  'install-package': { progress: 52, labelKey: 'settings.openclawUpdate.progressInstalling' },
  'switch-command-entrypoint': { progress: 72, labelKey: 'settings.openclawUpdate.progressSwitchingEntrypoint' },
  'finalize-update': { progress: 84, labelKey: 'settings.openclawUpdate.progressFinalizingPackage' },
  'running-update': { progress: 52, labelKey: 'settings.openclawUpdate.progressInstalling' },
  'stopping-update': { progress: 72, labelKey: 'settings.openclawUpdate.progressStopping' },
  'repair-command-entrypoint': { progress: 92, labelKey: 'settings.openclawUpdate.progressRepairingEntrypoint' },
  'verifying-version': { progress: 96, labelKey: 'settings.openclawUpdate.progressVerifying' },
  'complete': { progress: 100, labelKey: 'settings.openclawUpdate.progressFinishing' },
};

const CONNECTION_STATUS_REFRESH_EVENT = 'clawopt:refresh-connection-status';
const UPDATE_RESTART_MODAL_TIMEOUT_MS = 5 * 60 * 1000;
const UPDATE_RESTART_MODAL_STORAGE_KEY = 'clawopt:update-restart-modal';
const UPDATE_RESTART_STEP_IDS: UpdateRestartStepId[] = [
  'restart_openclaw',
  'restart_project',
  'warmup_browser',
];

const normalizeUpdateRestartSteps = (raw: unknown): UpdateRestartStep[] | null => {
  if (!Array.isArray(raw)) return null;

  return UPDATE_RESTART_STEP_IDS.map((id) => {
    const matched = raw.find((entry) => (
      entry
      && typeof entry === 'object'
      && typeof (entry as { id?: unknown }).id === 'string'
      && (entry as { id: string }).id.trim() === id
    )) as { status?: unknown; detail?: unknown; updatedAt?: unknown } | undefined;

    const status = typeof matched?.status === 'string' ? matched.status.trim() : '';
    return {
      id,
      status: status === 'running' || status === 'completed' || status === 'failed' ? status : 'pending',
      detail: typeof matched?.detail === 'string' && matched.detail.trim() ? matched.detail.trim() : null,
      updatedAt: typeof matched?.updatedAt === 'string' && matched.updatedAt.trim() ? matched.updatedAt.trim() : null,
    };
  });
};

const deriveUpdateRestartStartedAtMs = (update: UpdateStatusInfo | null) => {
  if (!update) return null;

  const stepTimes = (normalizeUpdateRestartSteps(update.restartSteps) || [])
    .filter((step) => step.status !== 'pending')
    .map((step) => parseTimestampMs(step.updatedAt))
    .filter((value): value is number => value !== null);

  if (stepTimes.length) {
    return Math.min(...stepTimes);
  }

  return parseTimestampMs(update.updatedAt);
};

const readPersistedUpdateRestartModalState = (): PersistedUpdateRestartModalState | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(UPDATE_RESTART_MODAL_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PersistedUpdateRestartModalState>;
    if (parsed.stage !== 'restarting') {
      return null;
    }

    const startedAtMs = typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
      ? parsed.startedAtMs
      : null;
    return {
      stage: 'restarting',
      detail: typeof parsed.detail === 'string' ? parsed.detail : '',
      stepSnapshot: normalizeUpdateRestartSteps(parsed.stepSnapshot),
      startedAtMs,
    };
  } catch {
    return null;
  }
};

const writePersistedUpdateRestartModalState = (state: PersistedUpdateRestartModalState | null) => {
  if (typeof window === 'undefined') {
    return;
  }

  if (!state) {
    window.localStorage.removeItem(UPDATE_RESTART_MODAL_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(UPDATE_RESTART_MODAL_STORAGE_KEY, JSON.stringify(state));
};

const isPersistedUpdateRestartModalStateFresh = (state: PersistedUpdateRestartModalState | null) => {
  if (!state?.startedAtMs) {
    return true;
  }

  return Date.now() - state.startedAtMs <= UPDATE_RESTART_MODAL_TIMEOUT_MS + 60 * 1000;
};

const BROWSER_CHECK_PHASE_VISUALS: Record<string, BrowserTaskPhaseVisual> = {
  'read-config': { progress: 12, labelKey: 'settings.gateway.browserTaskPhases.readConfig' },
  'wait-gateway': { progress: 22, labelKey: 'settings.gateway.browserTaskPhases.waitGateway' },
  'read-status': { progress: 32, labelKey: 'settings.gateway.browserTaskPhases.readStatus' },
  'start-browser': { progress: 52, labelKey: 'settings.gateway.browserTaskPhases.startBrowser' },
  'wait-running': { progress: 68, labelKey: 'settings.gateway.browserTaskPhases.waitRunning' },
  'open-validation': { progress: 84, labelKey: 'settings.gateway.browserTaskPhases.openValidation' },
  'capture-snapshot': { progress: 94, labelKey: 'settings.gateway.browserTaskPhases.captureSnapshot' },
  'finalize': { progress: 100, labelKey: 'settings.gateway.browserTaskPhases.finalizeCheck' },
};

const BROWSER_REPAIR_PHASE_VISUALS: Record<string, BrowserTaskPhaseVisual> = {
  'inspect-current': { progress: 8, labelKey: 'settings.gateway.browserTaskPhases.inspectCurrent' },
  'read-config': { progress: 18, labelKey: 'settings.gateway.browserTaskPhases.readConfig' },
  'read-status': { progress: 28, labelKey: 'settings.gateway.browserTaskPhases.readStatus' },
  'enable-permissions': { progress: 42, labelKey: 'settings.gateway.browserTaskPhases.enablePermissions' },
  'sync-browser-settings': { progress: 52, labelKey: 'settings.gateway.browserTaskPhases.syncBrowserSettings' },
  'refresh-plugins': { progress: 56, labelKey: 'settings.gateway.browserTaskPhases.refreshPlugins' },
  'restart-gateway': { progress: 60, labelKey: 'settings.gateway.browserTaskPhases.restartGateway' },
  'wait-gateway': { progress: 66, labelKey: 'settings.gateway.browserTaskPhases.waitGateway' },
  'stop-browser': { progress: 72, labelKey: 'settings.gateway.browserTaskPhases.stopBrowser' },
  'start-browser': { progress: 82, labelKey: 'settings.gateway.browserTaskPhases.startBrowser' },
  'wait-running': { progress: 90, labelKey: 'settings.gateway.browserTaskPhases.waitRunning' },
  'reset-profile': { progress: 96, labelKey: 'settings.gateway.browserTaskPhases.resetProfile' },
  'open-validation': { progress: 96, labelKey: 'settings.gateway.browserTaskPhases.openValidation' },
  'capture-snapshot': { progress: 99, labelKey: 'settings.gateway.browserTaskPhases.captureSnapshot' },
  'finalize': { progress: 100, labelKey: 'settings.gateway.browserTaskPhases.finalizeRepair' },
};

function joinDistinctLines(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(normalized);
  }
  return lines.join('\n');
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGatewayRestartTaskInfo(raw: unknown): GatewayRestartTaskInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Partial<GatewayRestartTaskInfo>;
  const status = typeof candidate.status === 'string' ? candidate.status : 'idle';
  const trigger = typeof candidate.trigger === 'string' ? candidate.trigger : null;

  return {
    status: status === 'restarting' || status === 'failed' ? status : 'idle',
    trigger: trigger === 'gateway' || trigger === 'browser-headed-mode' ? trigger : null,
    rawDetail: typeof candidate.rawDetail === 'string' && candidate.rawDetail.trim() ? candidate.rawDetail.trim() : null,
    startedAt: typeof candidate.startedAt === 'string' && candidate.startedAt.trim() ? candidate.startedAt.trim() : null,
    updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim() ? candidate.updatedAt.trim() : null,
    targetHeadedModeEnabled: typeof candidate.targetHeadedModeEnabled === 'boolean' ? candidate.targetHeadedModeEnabled : null,
  };
}

export default function SettingsView({ isConnected, settingsTab, onMenuClick, onModelsChanged, onAgentsChanged }: SettingsViewProps) {
  const { t, i18n } = useTranslation();

  /**
   * 运行时账号状态。
   *
   * 状态只说得出「我们写的 env key 在不在」。厂商 CLI 是否已在主机上
   * 自行登录过，我们无从判断——所以没有「未登录」这个状态。
   */
  type RuntimeAuthRow = {
    runtimeId: string;
    envKey: string | null;
    state: 'notRequired' | 'configured' | 'unknown' | 'unreadable';
    webConfigurable: boolean;
  };
  const [runtimeAuth, setRuntimeAuth] = useState<RuntimeAuthRow[]>([]);
  const [runtimeAuthLoading, setRuntimeAuthLoading] = useState(false);
  /** 正在编辑的运行时 → 输入框里的值。**值只进不出**，不预填。 */
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [keySaving, setKeySaving] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<Record<string, string>>({});

  const loadRuntimeAuth = () => {
    setRuntimeAuthLoading(true);
    fetch('/api/agent-runtimes/auth')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.success && Array.isArray(d.runtimes)) setRuntimeAuth(d.runtimes); })
      .catch((err) => console.warn('[Settings] 取运行时凭据状态失败：', err))
      .finally(() => setRuntimeAuthLoading(false));
  };

  /**
   * 保存或清除一个厂商 key。
   *
   * 保存会**重启 Gateway**（`.env` 是启动时读的），所以这里必须等后端回话，
   * 并把后端的结构化错误原样显示——包括「写进去了但重启失败」这种
   * 半成功状态。报一个笼统的成功是本仓库红线 C 反对的形状。
   */
  const submitRuntimeKey = async (runtimeId: string, apiKey: string | null) => {
    setKeySaving(runtimeId);
    setKeyError((prev) => ({ ...prev, [runtimeId]: '' }));
    try {
      const res = await fetch(`/api/agent-runtimes/auth/${encodeURIComponent(runtimeId)}`, {
        method: apiKey === null ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: apiKey === null ? undefined : JSON.stringify({ apiKey }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        const code = typeof data?.error === 'string' ? data.error : 'runtimeAuth.writeFailed';
        setKeyError((prev) => ({ ...prev, [runtimeId]: t(`settings.runtimeAuth.err.${code.split('.').pop()}`, { defaultValue: code }) }));
        return;
      }
      if (Array.isArray(data.runtimes)) setRuntimeAuth(data.runtimes);
      setKeyDraft((prev) => ({ ...prev, [runtimeId]: '' }));
    } catch (err) {
      console.warn('[Settings] 保存厂商凭据失败：', err);
      setKeyError((prev) => ({ ...prev, [runtimeId]: t('settings.runtimeAuth.err.writeFailed') }));
    } finally {
      setKeySaving(null);
    }
  };
  useEffect(() => { loadRuntimeAuth(); }, []);


  const openSettingsErrorModal = (message: string, detail = '') => {
    setGatewayErrorMessage(message);
    setGatewayErrorDetail(detail);
    setGatewayErrorModalOpen(true);
  };

  // --- Gateway settings state ---
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  // 后端不再回读密钥值（明文回读等于把凭据发给任何能打开页面的人），
  // 这里只知道「配没配」，输入框留空表示不修改。
  const [hasToken, setHasToken] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [hasLoginPassword, setHasLoginPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ success?: boolean; message?: string } | null>(null);
  const [gatewaySaved, setGatewaySaved] = useState(false);
  const [gatewayError, setGatewayError] = useState(false);
  const [isDetectingAll, setIsDetectingAll] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [detectedOpenClawVersion, setDetectedOpenClawVersion] = useState('');
  const [maxPermissions, setMaxPermissions] = useState(false);
  const [isTogglingPermissions, setIsTogglingPermissions] = useState(false);
  const [hostTakeoverStatus, setHostTakeoverStatus] = useState<HostTakeoverStatus | null>(null);
  const [devicePairingStatus, setDevicePairingStatus] = useState<DevicePairingStatus | null>(null);
  const [hasLoadedMaxPermissionsState, setHasLoadedMaxPermissionsState] = useState(false);
  const [isApprovingDevicePairing, setIsApprovingDevicePairing] = useState(false);
  const [permissionsNotice, setPermissionsNotice] = useState<{ tone: 'success' | 'warning'; message: string } | null>(null);
  const [permissionsError, setPermissionsError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [permissionsPasswordModalOpen, setPermissionsPasswordModalOpen] = useState(false);
  const [permissionsPassword, setPermissionsPassword] = useState('');
  const [permissionsPasswordUser, setPermissionsPasswordUser] = useState('');
  const [permissionsPasswordError, setPermissionsPasswordError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isSubmittingPermissionsPassword, setIsSubmittingPermissionsPassword] = useState(false);
  const [maxPermissionsConfirmPendingEnabled, setMaxPermissionsConfirmPendingEnabled] = useState<boolean | null>(null);
  const [restartAfterPermissionsPasswordSubmit, setRestartAfterPermissionsPasswordSubmit] = useState(false);
  const [allowedHosts, setAllowedHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState('');
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [editHostValue, setEditHostValue] = useState('');
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartSuccess, setRestartSuccess] = useState(false);
  const [browserHealth, setBrowserHealth] = useState<BrowserHealthSnapshot | null>(null);
  const [browserHealthError, setBrowserHealthError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [browserHealthNotice, setBrowserHealthNotice] = useState<BrowserHealthNotice | null>(null);
  const [gatewayRestartNoticeSource, setGatewayRestartNoticeSource] = useState<GatewayRestartNoticeSource>(null);
  const [isCheckingBrowserHealth, setIsCheckingBrowserHealth] = useState(false);
  const [isSelfHealingBrowser, setIsSelfHealingBrowser] = useState(false);
  const [browserTaskInfo, setBrowserTaskInfo] = useState<BrowserTaskInfo | null>(null);
  const [browserHeadedModeEnabled, setBrowserHeadedModeEnabled] = useState<boolean | null>(null);
  const [isLoadingBrowserHeadedMode, setIsLoadingBrowserHeadedMode] = useState(false);
  const [isTogglingBrowserHeadedMode, setIsTogglingBrowserHeadedMode] = useState(false);
  const [browserHeadedModePendingEnabled, setBrowserHeadedModePendingEnabled] = useState<boolean | null>(null);
  const [browserHeadedModeModalStage, setBrowserHeadedModeModalStage] = useState<BrowserHeadedModeModalStage>(null);
  const [browserHeadedModeModalDetail, setBrowserHeadedModeModalDetail] = useState('');
  const [gatewayRestartModalStage, setGatewayRestartModalStage] = useState<RestartFlowModalStage>(null);
  const [gatewayRestartModalDetail, setGatewayRestartModalDetail] = useState('');
  const [gatewayRestartTaskInfo, setGatewayRestartTaskInfo] = useState<GatewayRestartTaskInfo | null>(null);
  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionInfo | null>(null);
  const [appVersionError, setAppVersionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isLoadingAppVersion, setIsLoadingAppVersion] = useState(false);
  const [openClawLatestVersionInfo, setOpenClawLatestVersionInfo] = useState<OpenClawLatestVersionInfo | null>(null);
  const [openClawLatestVersionError, setOpenClawLatestVersionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isCheckingOpenClawLatestVersion, setIsCheckingOpenClawLatestVersion] = useState(false);
  const [openClawUpdateStatusInfo, setOpenClawUpdateStatusInfo] = useState<OpenClawUpdateStatusInfo | null>(null);
  const [isStartingOpenClawUpdate, setIsStartingOpenClawUpdate] = useState(false);
  const [isOpenClawUpdateCancelModalOpen, setIsOpenClawUpdateCancelModalOpen] = useState(false);
  const [isCancellingOpenClawUpdate, setIsCancellingOpenClawUpdate] = useState(false);
  const [latestVersionInfo, setLatestVersionInfo] = useState<LatestVersionInfo | null>(null);
  const [latestVersionError, setLatestVersionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isCheckingLatestVersion, setIsCheckingLatestVersion] = useState(false);
  const [updateStatusInfo, setUpdateStatusInfo] = useState<UpdateStatusInfo | null>(null);
  const [hasLoadedUpdateStatusOnce, setHasLoadedUpdateStatusOnce] = useState(false);
  const [updateRestartModalStage, setUpdateRestartModalStage] = useState<RestartFlowModalStage>(null);
  const [updateRestartModalDetail, setUpdateRestartModalDetail] = useState('');
  const [updateRestartStepSnapshot, setUpdateRestartStepSnapshot] = useState<UpdateRestartStep[] | null>(null);
  const [updateRestartModalStartedAtMs, setUpdateRestartModalStartedAtMs] = useState<number | null>(null);
  const [isUpdateCancelModalOpen, setIsUpdateCancelModalOpen] = useState(false);
  const [isCancellingUpdate, setIsCancellingUpdate] = useState(false);
  const gatewayRestartTaskInfoRef = useRef<GatewayRestartTaskInfo | null>(null);
  const pendingGatewayRestartStartRef = useRef<{ trigger: GatewayRestartTrigger; startedAtMs: number } | null>(null);

  const updateGatewayRestartTaskInfo = (nextTaskInfo: GatewayRestartTaskInfo | null) => {
    gatewayRestartTaskInfoRef.current = nextTaskInfo;
    setGatewayRestartTaskInfo(nextTaskInfo);
  };

  // --- General settings state ---
  const [aiName, setAiName] = useState(() => t('settings.general.aiNamePlaceholder'));
  const [loginEnabled, setLoginEnabled] = useState(false);
  const [loginPassword, setLoginPassword] = useState('123456');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [generalSaved, setGeneralSaved] = useState(false);
  const [generalError, setGeneralError] = useState(false);
  const [aiNameError, setAiNameError] = useState<'' | 'required' | 'tooLong'>('');
  const [historyPageRoundsInput, setHistoryPageRoundsInput] = useState(() => String(readChatHistoryPageRounds()));
  const [previewTimeoutSecondsInput, setPreviewTimeoutSecondsInput] = useState(() => String(normalizePreviewTimeoutSeconds(undefined)));
  const [previewTimeoutError, setPreviewTimeoutError] = useState(false);

  const getVisualLength = (str: string) => {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 127) len += 2;
      else len += 1;
    }
    return len;
  };

  // --- Quick Commands state ---
  const [commands, setCommands] = useState<{ id: number; command: string; description: string }[]>([]);
  const [newCommand, setNewCommand] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);

  // --- Shared Delete Modal State ---
  type DeleteTarget = { type: 'host'; value: string } | { type: 'command'; id: number } | { type: 'model'; id: string } | { type: 'endpoint'; name: string };
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleteModalMessage, setDeleteModalMessage] = useState('');

  // --- Model Management State ---
  const [expandedEndpoints, setExpandedEndpoints] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('openclaw_expandedEndpoints');
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  useEffect(() => {
    localStorage.setItem('openclaw_expandedEndpoints', JSON.stringify(Array.from(expandedEndpoints)));
  }, [expandedEndpoints]);

  const toggleEndpointExpanded = (epName: string) => {
    setExpandedEndpoints(prev => {
      const next = new Set(prev);
      if (next.has(epName)) next.delete(epName);
      else next.add(epName);
      return next;
    });
  };
  const [models, setModels] = useState<{ id: string; alias?: string; primary: boolean; input: string[] }[]>([]);
  const [defaultModelId, setDefaultModelId] = useState('');
  const [defaultModelError, setDefaultModelError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isSavingDefaultModel, setIsSavingDefaultModel] = useState(false);
  const [imageGenerationModelId, setImageGenerationModelId] = useState('');
  const [imageGenerationFallbacks, setImageGenerationFallbacks] = useState<string[]>([]);
  const [imageGenerationFallbackMode, setImageGenerationFallbackMode] = useState<ModelFallbackMode>('disabled');
  const [imageGenerationModelError, setImageGenerationModelError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [isSavingImageGenerationModel, setIsSavingImageGenerationModel] = useState(false);
  const [globalFallbacks, setGlobalFallbacks] = useState<string[]>([]);
  const [globalFallbackMode, setGlobalFallbackMode] = useState<ModelFallbackMode>('disabled');
  const [globalFallbackError, setGlobalFallbackError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  const [, setIsSavingGlobalFallbacks] = useState(false);
  const globalFallbackAutosaveTimerRef = useRef<number | null>(null);
  const globalFallbackAutosaveUnlockTimerRef = useRef<number | null>(null);
  const suppressGlobalFallbackAutosaveRef = useRef(true);
  const [newModelEndpoint, setNewModelEndpoint] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [newModelAlias, setNewModelAlias] = useState('');
  const [newModelInput, setNewModelInput] = useState<string[]>(['text']);
  const [modelError, setModelError] = useState('');

  const modelSupportsImageGeneration = (model: { input?: string[] }) => (
    (model.input || []).some((capability) => {
      const normalized = capability.toLowerCase().replace(/[-\s]+/g, '_');
      return normalized === 'image_generation' || normalized === 'image_generate' || normalized === 'image_output';
    })
  );

  const sortModelsByDisplayName = <T extends { id: string; alias?: string }>(items: T[]) => (
    [...items].sort((a, b) => {
      const labelA = a.alias || a.id;
      const labelB = b.alias || b.id;
      return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
    })
  );

  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editingAlias, setEditingAlias] = useState('');
  const [editingInput, setEditingInput] = useState<string[]>([]);
  const [gatewayErrorModalOpen, setGatewayErrorModalOpen] = useState(false);
  const [gatewayErrorMessage, setGatewayErrorMessage] = useState('');
  const [gatewayErrorDetail, setGatewayErrorDetail] = useState('');
  const [isEndpointDropdownOpen, setIsEndpointDropdownOpen] = useState(false);
  const [endpointSearchQuery, setEndpointSearchQuery] = useState('');

  const [testModelMessage, setTestModelMessage] = useState('');
  
  const [addModelTestStatus, setAddModelTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [addModelTestMessage, setAddModelTestMessage] = useState('');
  const [showForceAddModal, setShowForceAddModal] = useState(false);
  const editAliasInputRef = useRef<HTMLInputElement>(null);
  const [modelActionError, setModelActionError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);

  // --- Model Discovery State ---
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const discoverAbortControllerRef = useRef<AbortController | null>(null);
  const testAllAbortControllerRef = useRef<AbortController | null>(null);
  const [addModelError, setAddModelError] = useState('');
  const [addModelErrorDetail, setAddModelErrorDetail] = useState('');
  const [existingModelTestStatus, setExistingModelTestStatus] = useState<Record<string, TestStatus>>({}); 

  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [showOnlyConnected, setShowOnlyConnected] = useState(false);
  const [individualTestStatus, setIndividualTestStatus] = useState<Record<string, TestStatus>>({});
  
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [modelDropdownMaxHeight, setModelDropdownMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (isModelDropdownOpen && dropdownRef.current) {
      const rect = dropdownRef.current.getBoundingClientRect();
      const availableSpace = window.innerHeight - (rect.top + 80) - 24;
      setModelDropdownMaxHeight(Math.max(200, availableSpace));
    }
  }, [isModelDropdownOpen]);

  // --- Endpoint Management State ---
  type EndpointConfig = { id: string; baseUrl: string; apiKey: string; api: string };
  const [endpoints, setEndpoints] = useState<EndpointConfig[]>([]);
  const [isEndpointModalOpen, setIsEndpointModalOpen] = useState(false);
  const [isAddModelModalOpen, setIsAddModelModalOpen] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointConfig | null>(null);
  const [newEndpointData, setNewEndpointData] = useState<EndpointConfig>({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });
  const [endpointTestStatus, setEndpointTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [endpointTestMessage, setEndpointTestMessage] = useState('');
  const [endpointModalError, setEndpointModalError] = useState<InlineErrorState>(EMPTY_INLINE_ERROR);
  useEffect(() => {
    setTestResult(null);
  }, [url, token, password]);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        setUrl(data.gatewayUrl || '');
        setHasToken(Boolean(data.hasToken));
        setHasPassword(Boolean(data.hasPassword));
        setHasLoginPassword(Boolean(data.hasLoginPassword));
        if (data.aiName) setAiName(data.aiName);
        if (data.loginEnabled !== undefined) setLoginEnabled(data.loginEnabled);
        if (data.allowedHosts) setAllowedHosts(data.allowedHosts);
        if (data.historyPageRounds !== undefined) {
          const nextHistoryPageRounds = normalizeChatHistoryPageRounds(data.historyPageRounds);
          setHistoryPageRoundsInput(String(nextHistoryPageRounds));
          persistChatHistoryPageRounds(nextHistoryPageRounds);
        }
        if (data.previewConversionTimeoutSeconds !== undefined) {
          setPreviewTimeoutSecondsInput(String(normalizePreviewTimeoutSeconds(data.previewConversionTimeoutSeconds)));
        }
        if (data.language) {
          void applyLanguagePreference(data.language);
        }
      })
      .catch(console.error);

    fetchCommands();
    fetchModels();
    fetchImageGenerationModelConfig();
    fetchGlobalFallbacks();
    fetchEndpoints();

    fetchMaxPermissionsState().catch(console.error);
  }, []);

  const fetchCurrentVersionInfo = async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIsLoadingAppVersion(true);
      setAppVersionError(EMPTY_INLINE_ERROR);
    }
    try {
      const res = await fetch('/api/version');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!options?.silent) {
          setAppVersionError(resolveStructuredErrorDisplay(data, t, 'settings.about.currentVersionLoadFailed'));
        }
        setAppVersionInfo(null);
        return null;
      }
      const versionInfo = data as AppVersionInfo;
      setAppVersionInfo(versionInfo);
      setDetectedOpenClawVersion(versionInfo.openclawVersion || '');
      return versionInfo;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      if (!options?.silent) {
        setAppVersionError({
          message: t('settings.about.currentVersionLoadFailed'),
          detail,
        });
      }
      setAppVersionInfo(null);
      return null;
    } finally {
      if (!options?.silent) {
        setIsLoadingAppVersion(false);
      }
    }
  };

  const buildUpdateRequestHeaders = (includeJson = false): HeadersInit => {
    // 鉴权走 httpOnly cookie，同源请求自动带上；这里只管 Content-Type。
    const headers: Record<string, string> = {};
    if (includeJson) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  };

  const fetchUpdateStatus = async (options?: { quiet?: boolean }) => {
    try {
      const res = await fetch('/api/update/status', {
        headers: buildUpdateRequestHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setHasLoadedUpdateStatusOnce(true);
        if (!options?.quiet) {
          const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateStatusLoadFailed');
          setLatestVersionError(display);
        }
        return null;
      }
      const nextUpdate = data.update as UpdateStatusInfo;
      setUpdateStatusInfo(nextUpdate);
      setHasLoadedUpdateStatusOnce(true);
      return nextUpdate;
    } catch (error) {
      setHasLoadedUpdateStatusOnce(true);
      if (!options?.quiet) {
        const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
        setLatestVersionError({
          message: t('settings.about.updateStatusLoadFailed'),
          detail,
        });
      }
      return null;
    }
  };

  const fetchOpenClawUpdateStatus = async (options?: { quiet?: boolean }) => {
    try {
      const res = await fetch('/api/openclaw/update/status', {
        headers: buildUpdateRequestHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!options?.quiet) {
          const display = resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.statusLoadFailed');
          setOpenClawLatestVersionError(display);
        }
        return null;
      }
      const nextUpdate = data.update as OpenClawUpdateStatusInfo;
      setOpenClawUpdateStatusInfo(nextUpdate);
      return nextUpdate;
    } catch (error) {
      if (!options?.quiet) {
        const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
        setOpenClawLatestVersionError({
          message: t('settings.openclawUpdate.statusLoadFailed'),
          detail,
        });
      }
      return null;
    }
  };

  const fetchOpenClawLatestVersion = async (options?: { quiet?: boolean }) => {
    try {
      const res = await fetch('/api/openclaw/version/latest');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!options?.quiet) {
          setOpenClawLatestVersionError(resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.latestVersionLoadFailed'));
        }
        return null;
      }
      const latestData = data as OpenClawLatestVersionInfo;
      setOpenClawLatestVersionInfo(latestData);
      return latestData;
    } catch (error) {
      if (!options?.quiet) {
        const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
        setOpenClawLatestVersionError({
          message: t('settings.openclawUpdate.latestVersionLoadFailed'),
          detail,
        });
      }
      return null;
    }
  };

  const handleCheckOpenClawLatestVersion = async () => {
    setIsCheckingOpenClawLatestVersion(true);
    setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
    try {
      await fetchOpenClawLatestVersion();
    } finally {
      setIsCheckingOpenClawLatestVersion(false);
    }
  };

  const handleStartOpenClawUpdate = async () => {
    if (isStartingOpenClawUpdate || ['checking', 'updating', 'stopping'].includes(openClawUpdateStatusInfo?.status || '')) {
      return;
    }

    const previousUpdateStatusInfo = openClawUpdateStatusInfo;
    setIsStartingOpenClawUpdate(true);
    setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
    setOpenClawUpdateStatusInfo((current) => ({
      status: 'updating',
      phase: 'download-package',
      canCancel: true,
      currentVersion: current?.currentVersion || openClawLatestVersionInfo?.currentVersion || appVersionInfo?.openclawVersion || null,
      latestVersion: current?.latestVersion || openClawLatestVersionInfo?.latestVersion || null,
      message: t('settings.openclawUpdate.progressDownloading'),
      rawDetail: null,
      logs: current?.logs || [],
      startedAt: current?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    try {
      const res = await fetch('/api/openclaw/update/start', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if ((data as { errorCode?: string })?.errorCode === 'openclawUpdate.alreadyRunning') {
          const runningStatus = await fetchOpenClawUpdateStatus({ quiet: true });
          if (runningStatus) {
            setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
            return;
          }
        }
        setOpenClawUpdateStatusInfo(previousUpdateStatusInfo);
        const display = resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.updateStartFailed');
        openSettingsErrorModal(display.message, display.detail);
        return;
      }
      setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
      setOpenClawUpdateStatusInfo(data.update as OpenClawUpdateStatusInfo);
    } catch (error) {
      setOpenClawUpdateStatusInfo(previousUpdateStatusInfo);
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.openclawUpdate.updateStartFailed'), detail);
    } finally {
      setIsStartingOpenClawUpdate(false);
    }
  };

  const handleCancelOpenClawUpdate = async () => {
    setIsCancellingOpenClawUpdate(true);
    try {
      const res = await fetch('/api/openclaw/update/cancel', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.updateCancelFailed');
        openSettingsErrorModal(display.message, display.detail);
        return false;
      }
      setOpenClawUpdateStatusInfo(data.update as OpenClawUpdateStatusInfo);
      return true;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.openclawUpdate.updateCancelFailed'), detail);
      return false;
    } finally {
      setIsCancellingOpenClawUpdate(false);
    }
  };

  const handleResetOpenClawUpdateState = async () => {
    try {
      const res = await fetch('/api/openclaw/update/reset', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.openclawUpdate.updateResetFailed');
        openSettingsErrorModal(display.message, display.detail);
        return false;
      }
      setOpenClawUpdateStatusInfo(data.update as OpenClawUpdateStatusInfo);
      return true;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.openclawUpdate.updateResetFailed'), detail);
      return false;
    }
  };

  const handleOpenClawLatestVersionAction = () => {
    if (isStartingOpenClawUpdate) {
      return;
    }

    if (openClawUpdateStatusInfo?.status === 'checking' || openClawUpdateStatusInfo?.status === 'stopping') {
      return;
    }

    if (openClawUpdateStatusInfo?.status === 'updating') {
      setIsOpenClawUpdateCancelModalOpen(true);
      return;
    }

    if (openClawLatestVersionInfo?.status === 'update_available') {
      void handleStartOpenClawUpdate();
      return;
    }

    if (openClawUpdateStatusInfo?.status === 'update_failed') {
      void (async () => {
        const reset = await handleResetOpenClawUpdateState();
        if (reset) {
          await handleCheckOpenClawLatestVersion();
        }
      })();
      return;
    }

    void handleCheckOpenClawLatestVersion();
  };

  const handleConfirmCancelOpenClawUpdate = async () => {
    if (!openClawUpdateStatusInfo?.canCancel || openClawUpdateStatusInfo.status !== 'updating') {
      return;
    }

    const cancelled = await handleCancelOpenClawUpdate();
    if (cancelled) {
      setIsOpenClawUpdateCancelModalOpen(false);
    }
  };

  const handleCheckLatestVersion = async () => {
    setIsCheckingLatestVersion(true);
    setLatestVersionError(EMPTY_INLINE_ERROR);
    setLatestVersionInfo(null);
    try {
      const res = await fetch('/api/version/latest');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLatestVersionError(resolveStructuredErrorDisplay(data, t, 'settings.about.latestVersionLoadFailed'));
        return;
      }
      const latestData = data as LatestVersionInfo;
      setLatestVersionInfo(latestData);
      setUpdateStatusInfo(prev => {
        if (!prev) return prev;
        if (['checking', 'updating', 'stopping', 'update_succeeded', 'update_failed', 'restarting', 'restart_failed'].includes(prev.status)) {
          return prev;
        }
        return {
          ...prev,
          status: latestData.hasUpdate ? 'has_update' : 'idle',
          currentVersion: latestData.currentVersion || prev.currentVersion,
          latestVersion: latestData.latestVersion || null,
          message: null,
          rawDetail: null,
        };
      });
      if (!appVersionInfo) {
        setAppVersionInfo(prev => prev || {
          appName: latestData.appName,
          version: latestData.currentVersion,
          releaseTag: `v${latestData.currentVersion}`,
          commit: null,
          buildTime: null,
          repositoryUrl: latestData.repositoryUrl,
          openclawVersion: null,
        });
      }
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      setLatestVersionError({
        message: t('settings.about.latestVersionLoadFailed'),
        detail,
      });
    } finally {
      setIsCheckingLatestVersion(false);
    }
  };

  const handleStartUpdate = async () => {
    try {
      const res = await fetch('/api/update/start', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateStartFailed');
        openSettingsErrorModal(display.message, display.detail);
        return;
      }
      setLatestVersionError(EMPTY_INLINE_ERROR);
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.updateStartFailed'), detail);
    }
  };

  const handleCancelUpdate = async () => {
    setIsCancellingUpdate(true);
    try {
      const res = await fetch('/api/update/cancel', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateCancelFailed');
        openSettingsErrorModal(display.message, display.detail);
        return false;
      }
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
      return true;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.updateCancelFailed'), detail);
      return false;
    } finally {
      setIsCancellingUpdate(false);
    }
  };

  const handleResetUpdateState = async () => {
    try {
      const res = await fetch('/api/update/reset', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.updateResetFailed');
        openSettingsErrorModal(display.message, display.detail);
        return;
      }
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
      setLatestVersionInfo(null);
      setLatestVersionError(EMPTY_INLINE_ERROR);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      openSettingsErrorModal(t('settings.about.updateResetFailed'), detail);
    }
  };

  const handleRestartUpdatedService = () => {
    if (updateRestartModalStage || updateStatusInfo?.status !== 'update_succeeded') {
      return;
    }
    setUpdateRestartStepSnapshot(null);
    setUpdateRestartModalDetail('');
    setUpdateRestartModalStage('confirm');
  };

  const closeUpdateRestartModal = () => {
    if (updateRestartModalStage === 'restarting') return;
    setUpdateRestartModalStage(null);
    setUpdateRestartModalDetail('');
    setUpdateRestartStepSnapshot(null);
    setUpdateRestartModalStartedAtMs(null);
    writePersistedUpdateRestartModalState(null);
  };

  const handleConfirmRestartUpdatedService = async () => {
    const startedAtMs = Date.now();
    setUpdateRestartModalDetail('');
    setUpdateRestartModalStage('restarting');
    setUpdateRestartModalStartedAtMs(startedAtMs);
    writePersistedUpdateRestartModalState({
      stage: 'restarting',
      detail: '',
      stepSnapshot: null,
      startedAtMs,
    });
    try {
      const res = await fetch('/api/update/restart-service', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.about.restartServiceFailed');
        setUpdateRestartModalDetail(joinDistinctLines([
          display.message !== t('settings.about.restartServiceFailed') ? display.message : '',
          display.detail,
        ]));
        setUpdateRestartModalStage('failure');
        setUpdateRestartModalStartedAtMs(null);
        writePersistedUpdateRestartModalState(null);
        return;
      }
      setUpdateStatusInfo(data.update as UpdateStatusInfo);
      window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '';
      setUpdateRestartModalDetail(detail);
      setUpdateRestartModalStage('failure');
      setUpdateRestartModalStartedAtMs(null);
      writePersistedUpdateRestartModalState(null);
    }
  };

  const handleLatestVersionAction = () => {
    if (updateStatusInfo?.status === 'checking' || updateStatusInfo?.status === 'stopping' || updateStatusInfo?.status === 'restarting') {
      return;
    }

    if (updateStatusInfo?.status === 'updating') {
      setIsUpdateCancelModalOpen(true);
      return;
    }

    if (updateStatusInfo?.status === 'update_succeeded') {
      handleRestartUpdatedService();
      return;
    }

    if (updateStatusInfo?.status === 'update_failed' || updateStatusInfo?.status === 'restart_failed') {
      void handleResetUpdateState();
      return;
    }

    if (updateStatusInfo?.status === 'has_update' || latestVersionInfo?.status === 'update_available') {
      void handleStartUpdate();
      return;
    }

    void handleCheckLatestVersion();
  };

  const handleConfirmCancelUpdate = async () => {
    if (!updateStatusInfo?.canCancel || updateStatusInfo.status !== 'updating') {
      return;
    }

    const cancelled = await handleCancelUpdate();
    if (cancelled) {
      setIsUpdateCancelModalOpen(false);
    }
  };

  useEffect(() => {
    if (settingsTab !== 'about' && settingsTab !== 'gateway') return;
    void fetchCurrentVersionInfo();
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    void fetchOpenClawUpdateStatus({ quiet: true });
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'gateway') return;
    void fetchBrowserHeadedModeState();
    void fetchBrowserTaskStatus({ quiet: true });
    void fetchGatewayRestartTaskStatus().catch(() => {});
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    void fetchUpdateStatus({ quiet: true });
  }, [settingsTab]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    const activeStatus = updateStatusInfo?.status;
    if (!activeStatus || !['checking', 'updating', 'stopping', 'restarting'].includes(activeStatus)) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const nextUpdate = await fetchUpdateStatus({ quiet: activeStatus === 'restarting' });
      if (cancelled || !nextUpdate) return;

      if (activeStatus === 'restarting' && nextUpdate.status === 'idle') {
        await fetchCurrentVersionInfo();
        await handleCheckLatestVersion();
      }

      if ((activeStatus === 'stopping' || activeStatus === 'updating') && nextUpdate.status === 'idle') {
        setLatestVersionInfo(null);
        setLatestVersionError(EMPTY_INLINE_ERROR);
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settingsTab, updateStatusInfo?.status]);

  useEffect(() => {
    if (settingsTab !== 'about') return;
    const activeStatus = openClawUpdateStatusInfo?.status;
    if (isStartingOpenClawUpdate) {
      return;
    }
    if (activeStatus === 'update_succeeded') {
      void (async () => {
        await fetchCurrentVersionInfo({ silent: true });
        await detectGatewayConfig({ silent: true });
        setOpenClawLatestVersionInfo(null);
        setOpenClawLatestVersionError(EMPTY_INLINE_ERROR);
        window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
        await handleResetOpenClawUpdateState();
      })();
      return;
    }
    if (!activeStatus || !['checking', 'updating', 'stopping'].includes(activeStatus)) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const nextUpdate = await fetchOpenClawUpdateStatus({ quiet: true });
      if (cancelled || !nextUpdate) return;

      if (activeStatus === 'stopping' && nextUpdate.status === 'idle') {
        await fetchCurrentVersionInfo({ silent: true });
        await detectGatewayConfig({ silent: true });
        const latest = await fetchOpenClawLatestVersion({ quiet: true });
        if (latest) {
          setOpenClawLatestVersionInfo(latest);
        }
        window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
        return;
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settingsTab, openClawUpdateStatusInfo?.status, isStartingOpenClawUpdate]);

  useEffect(() => {
    if (settingsTab !== 'gateway') return;
    const activeStatus = browserTaskInfo?.status;
    if (!activeStatus || !['checking', 'repairing'].includes(activeStatus)) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const nextTask = await fetchBrowserTaskStatus({ quiet: true });
      if (cancelled || !nextTask) return;
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settingsTab, browserTaskInfo?.status]);

  useEffect(() => {
    if (settingsTab !== 'gateway' || gatewayRestartTaskInfo?.status !== 'restarting') {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const nextTask = await fetchGatewayRestartTaskStatus();
        if (cancelled || !nextTask || nextTask.status !== 'restarting') {
          return;
        }
      } catch {}
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settingsTab, gatewayRestartTaskInfo?.status]);

  useEffect(() => {
    if (!gatewayRestartTaskInfo) {
      return;
    }

    if (gatewayRestartTaskInfo.status === 'restarting') {
      if (gatewayRestartTaskInfo.trigger === 'browser-headed-mode') {
        if (typeof gatewayRestartTaskInfo.targetHeadedModeEnabled === 'boolean') {
          setBrowserHeadedModePendingEnabled(gatewayRestartTaskInfo.targetHeadedModeEnabled);
        }
        setIsTogglingBrowserHeadedMode(true);
        setBrowserHeadedModeModalDetail('');
        setBrowserHeadedModeModalStage('restarting');
      } else if (gatewayRestartTaskInfo.trigger === 'gateway') {
        setIsRestarting(true);
        setGatewayRestartModalDetail('');
        setGatewayRestartModalStage('restarting');
      }
      return;
    }

    if (gatewayRestartTaskInfo.status === 'failed') {
      const failureDetail = gatewayRestartTaskInfo.rawDetail || '';
      if (gatewayRestartTaskInfo.trigger === 'browser-headed-mode') {
        if (typeof gatewayRestartTaskInfo.targetHeadedModeEnabled === 'boolean') {
          setBrowserHeadedModePendingEnabled(gatewayRestartTaskInfo.targetHeadedModeEnabled);
        }
        setIsTogglingBrowserHeadedMode(false);
        setBrowserHeadedModeModalDetail(failureDetail);
        setBrowserHeadedModeModalStage('failure');
        void fetchBrowserHeadedModeState().catch(() => {});
      } else if (gatewayRestartTaskInfo.trigger === 'gateway') {
        setIsRestarting(false);
        setGatewayRestartModalDetail(failureDetail);
        setGatewayRestartModalStage('failure');
      }
      window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
      return;
    }

    if (browserHeadedModeModalStage === 'restarting') {
      setIsTogglingBrowserHeadedMode(false);
      setBrowserHeadedModeModalDetail('');
      setBrowserHeadedModeModalStage('success');
      void fetchBrowserHeadedModeState().catch(() => {});
      window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
    }

    if (gatewayRestartModalStage === 'restarting') {
      setIsRestarting(false);
      setRestartSuccess(true);
      setGatewayRestartNoticeSource(null);
      setGatewayRestartModalDetail('');
      setGatewayRestartModalStage('success');
      window.setTimeout(() => setRestartSuccess(false), 3000);
      window.dispatchEvent(new Event(CONNECTION_STATUS_REFRESH_EVENT));
    }
  }, [
    browserHeadedModeModalStage,
    gatewayRestartModalStage,
    gatewayRestartTaskInfo,
  ]);

  useEffect(() => {
    if (updateStatusInfo?.status !== 'updating') {
      setIsUpdateCancelModalOpen(false);
      setIsCancellingUpdate(false);
    }
  }, [updateStatusInfo?.status]);

  useEffect(() => {
    const nextSteps = normalizeUpdateRestartSteps(updateStatusInfo?.restartSteps);
    if (nextSteps?.length) {
      setUpdateRestartStepSnapshot(nextSteps);
    }
  }, [updateStatusInfo?.restartSteps]);

  useEffect(() => {
    if (settingsTab !== 'about' || !hasLoadedUpdateStatusOnce) {
      return;
    }

    const persistedState = readPersistedUpdateRestartModalState();
    const freshPersistedState = isPersistedUpdateRestartModalStateFresh(persistedState)
      ? persistedState
      : null;

    if (persistedState && !freshPersistedState) {
      writePersistedUpdateRestartModalState(null);
    }

    if (updateStatusInfo?.status === 'restarting') {
      const startedAtMs = deriveUpdateRestartStartedAtMs(updateStatusInfo)
        ?? freshPersistedState?.startedAtMs
        ?? Date.now();

      setUpdateRestartModalDetail('');
      setUpdateRestartModalStage('restarting');
      setUpdateRestartModalStartedAtMs(startedAtMs);
      return;
    }

    if (updateStatusInfo?.status === 'restart_failed') {
      setUpdateRestartModalDetail(joinDistinctLines([
        updateStatusInfo.message,
        updateStatusInfo.rawDetail,
      ]));
      setUpdateRestartModalStage('failure');
      setUpdateRestartModalStartedAtMs(null);
      return;
    }

    if (freshPersistedState && (updateStatusInfo?.status === 'idle' || !updateStatusInfo) && !isConnected) {
      setUpdateRestartModalDetail(freshPersistedState.detail);
      setUpdateRestartModalStage('restarting');
      setUpdateRestartModalStartedAtMs(freshPersistedState.startedAtMs);
      if (freshPersistedState.stepSnapshot?.length) {
        setUpdateRestartStepSnapshot(freshPersistedState.stepSnapshot);
      }
      return;
    }

    if (freshPersistedState && isConnected) {
      writePersistedUpdateRestartModalState(null);
    }
  }, [
    hasLoadedUpdateStatusOnce,
    isConnected,
    settingsTab,
    updateStatusInfo,
  ]);

  useEffect(() => {
    if (!hasLoadedUpdateStatusOnce && updateRestartModalStage !== 'restarting') {
      return;
    }

    if (updateRestartModalStage !== 'restarting') {
      writePersistedUpdateRestartModalState(null);
      return;
    }

    writePersistedUpdateRestartModalState({
      stage: 'restarting',
      detail: updateRestartModalDetail,
      stepSnapshot: updateRestartStepSnapshot,
      startedAtMs: updateRestartModalStartedAtMs,
    });
  }, [
    hasLoadedUpdateStatusOnce,
    updateRestartModalDetail,
    updateRestartModalStage,
    updateRestartModalStartedAtMs,
    updateRestartStepSnapshot,
  ]);

  useEffect(() => {
    if (openClawUpdateStatusInfo?.status !== 'updating') {
      setIsOpenClawUpdateCancelModalOpen(false);
      setIsCancellingOpenClawUpdate(false);
    }
  }, [openClawUpdateStatusInfo?.status]);

  useEffect(() => {
    if (updateRestartModalStage !== 'restarting') {
      return;
    }

    if (updateStatusInfo?.status !== 'idle' || !isConnected) {
      return;
    }

    let cancelled = false;
    void (async () => {
      setUpdateRestartStepSnapshot((current) => UPDATE_RESTART_STEP_IDS.map((id) => {
        const matched = current?.find((step) => step.id === id) || null;
        return {
          id,
          status: 'completed' as UpdateRestartStepStatus,
          detail: matched?.detail || null,
          updatedAt: new Date().toISOString(),
        };
      }));
      await fetchCurrentVersionInfo({ silent: true });
      if (cancelled) return;
      setUpdateRestartModalDetail('');
      setUpdateRestartModalStage('success');
      setUpdateRestartModalStartedAtMs(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isConnected,
    updateRestartModalStage,
    updateStatusInfo?.status,
  ]);

  useEffect(() => {
    if (updateRestartModalStage !== 'restarting' || !updateRestartModalStartedAtMs) {
      return;
    }

    const timer = window.setInterval(() => {
      if (Date.now() - updateRestartModalStartedAtMs < UPDATE_RESTART_MODAL_TIMEOUT_MS) {
        return;
      }

      setUpdateRestartModalDetail(t('settings.about.restartServiceWaitTimeoutDetail'));
      setUpdateRestartModalStage('failure');
      setUpdateRestartModalStartedAtMs(null);
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [t, updateRestartModalStage, updateRestartModalStartedAtMs]);

  const fetchModels = async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.success) {
        const nextModels = data.models || [];
        const nextDefaultModelId = nextModels.find((model: { id: string; primary: boolean }) => model.primary)?.id || '';
        setModels(nextModels);
        setDefaultModelId(nextDefaultModelId);
        onModelsChanged?.();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchImageGenerationModelConfig = async () => {
    try {
      const res = await fetch('/api/models/image-generation');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        const primary = typeof data?.config?.primary === 'string' ? data.config.primary : '';
        const fallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        setImageGenerationModelId(primary);
        setImageGenerationFallbacks(fallbacks);
        setImageGenerationFallbackMode(fallbacks.length > 0 ? 'custom' : 'disabled');
        setImageGenerationModelError(EMPTY_INLINE_ERROR);
      } else {
        setImageGenerationModelError(resolveStructuredErrorDisplay(data, t, 'settings.models.imageGenerationLoadFailed'));
      }
    } catch (err) {
      setImageGenerationModelError({
        message: t('settings.models.imageGenerationLoadFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    }
  };

  const fetchGlobalFallbacks = async () => {
    try {
      const res = await fetch('/api/models/fallbacks');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        const nextFallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        suppressGlobalFallbackAutosaveRef.current = true;
        if (globalFallbackAutosaveUnlockTimerRef.current !== null) {
          window.clearTimeout(globalFallbackAutosaveUnlockTimerRef.current);
        }
        setGlobalFallbacks(nextFallbacks);
        setGlobalFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        setGlobalFallbackError(EMPTY_INLINE_ERROR);
        globalFallbackAutosaveUnlockTimerRef.current = window.setTimeout(() => {
          suppressGlobalFallbackAutosaveRef.current = false;
          globalFallbackAutosaveUnlockTimerRef.current = null;
        }, 0);
      } else {
        setGlobalFallbackError(resolveStructuredErrorDisplay(data, t, 'settings.models.globalFallbackSaveFailed'));
      }
    } catch (err) {
      setGlobalFallbackError({
        message: t('settings.models.globalFallbackLoadFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    }
  };

  const fetchEndpoints = async () => {
    try {
      const res = await fetch('/api/endpoints');
      const data = await res.json();
      if (data.success) {
        setEndpoints(data.endpoints || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchCommands = async () => {
    try {
      const res = await fetch('/api/commands');
      const data = await res.json();
      if (data.success) setCommands(data.commands);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveGlobalFallbacks = async () => {
    setIsSavingGlobalFallbacks(true);
    setGlobalFallbackError(EMPTY_INLINE_ERROR);

    try {
      const res = await fetch('/api/models/fallbacks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fallbacks: globalFallbackMode === 'disabled' ? [] : globalFallbacks,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        const nextFallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        suppressGlobalFallbackAutosaveRef.current = true;
        if (globalFallbackAutosaveUnlockTimerRef.current !== null) {
          window.clearTimeout(globalFallbackAutosaveUnlockTimerRef.current);
        }
        setGlobalFallbacks(nextFallbacks);
        setGlobalFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        globalFallbackAutosaveUnlockTimerRef.current = window.setTimeout(() => {
          suppressGlobalFallbackAutosaveRef.current = false;
          globalFallbackAutosaveUnlockTimerRef.current = null;
        }, 0);
        return;
      }

      setGlobalFallbackError(resolveStructuredErrorDisplay(data, t, 'settings.models.globalFallbackSaveFailed'));
    } catch (err) {
      setGlobalFallbackError({
        message: t('settings.models.globalFallbackSaveFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsSavingGlobalFallbacks(false);
    }
  };

  const handleSaveImageGenerationModelConfig = async (primary: string, fallbacks: string[]) => {
    const normalizedPrimary = primary.trim();
    const normalizedFallbacks = Array.from(new Set(fallbacks.filter((id) => id && id !== normalizedPrimary)));
    setImageGenerationModelError(EMPTY_INLINE_ERROR);
    setIsSavingImageGenerationModel(true);

    try {
      const res = await fetch('/api/models/image-generation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primary: normalizedPrimary || null,
          fallbacks: normalizedPrimary ? normalizedFallbacks : [],
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        const nextPrimary = typeof data?.config?.primary === 'string' ? data.config.primary : '';
        const nextFallbacks = Array.isArray(data?.config?.fallbacks) ? data.config.fallbacks : [];
        setImageGenerationModelId(nextPrimary);
        setImageGenerationFallbacks(nextFallbacks);
        setImageGenerationFallbackMode(nextFallbacks.length > 0 ? 'custom' : 'disabled');
        return;
      }

      setImageGenerationModelError(resolveStructuredErrorDisplay(data, t, 'settings.models.imageGenerationSaveFailed'));
      await fetchImageGenerationModelConfig();
    } catch (err) {
      setImageGenerationModelError({
        message: t('settings.models.imageGenerationSaveFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
      await fetchImageGenerationModelConfig();
    } finally {
      setIsSavingImageGenerationModel(false);
    }
  };

  useEffect(() => {
    if (suppressGlobalFallbackAutosaveRef.current) return;
    if (globalFallbackMode === 'custom' && globalFallbacks.length === 0) return;

    if (globalFallbackAutosaveTimerRef.current !== null) {
      window.clearTimeout(globalFallbackAutosaveTimerRef.current);
    }

    globalFallbackAutosaveTimerRef.current = window.setTimeout(() => {
      void handleSaveGlobalFallbacks();
      globalFallbackAutosaveTimerRef.current = null;
    }, 180);

    return () => {
      if (globalFallbackAutosaveTimerRef.current !== null) {
        window.clearTimeout(globalFallbackAutosaveTimerRef.current);
        globalFallbackAutosaveTimerRef.current = null;
      }
    };
  }, [globalFallbackMode, globalFallbacks]);

  useEffect(() => {
    return () => {
      if (globalFallbackAutosaveTimerRef.current !== null) {
        window.clearTimeout(globalFallbackAutosaveTimerRef.current);
      }
      if (globalFallbackAutosaveUnlockTimerRef.current !== null) {
        window.clearTimeout(globalFallbackAutosaveUnlockTimerRef.current);
      }
    };
  }, []);

  // Capability definitions
  const CAPABILITIES = [
    { id: 'image',     label: t('settings.models.capability.image'), Icon: Eye,         color: 'text-violet-600 bg-violet-50 border-violet-200' },
    { id: 'image_generation', label: t('settings.models.capability.imageGeneration'), Icon: ImageIcon, color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
    { id: 'reasoning', label: t('settings.models.capability.reasoning'), Icon: Zap,         color: 'text-amber-600 bg-amber-50 border-amber-200' },
    { id: 'tools',     label: t('settings.models.capability.tools'), Icon: Wrench,      color: 'text-pink-600 bg-pink-50 border-pink-200' },
    { id: 'web',       label: t('settings.models.capability.web'), Icon: Globe,       color: 'text-blue-600 bg-blue-50 border-blue-200' },
    { id: 'rerank',    label: t('settings.models.capability.rerank'), Icon: ArrowUpDown, color: 'text-gray-600 bg-gray-50 border-gray-200' },
    { id: 'embed',     label: t('settings.models.capability.embed'), Icon: Link2,       color: 'text-gray-600 bg-gray-50 border-gray-200' },
  ] as const;

  const guessCapabilities = (modelId: string): string[] => {
    const id = modelId.toLowerCase();
    const caps = new Set<string>(['text']);
    if (/vision|4v|claude-3|claude-opus|claude-sonnet|claude-haiku|gpt-4o|gpt-4-turbo|gemini|llava|qwen.*vl|intern.*vl|glm-4v|minicpm.*v|cogvlm|pixtral|phi.*vision|qvq|kimi.*vl|chatglm.*vl|(^|\/)gpt-5\.4$/.test(id)) caps.add('image');
    if (/gpt[-_.]?image|dall[-_.]?e|imagen|flux|sdxl|stable[-_.]?diffusion|seedream|jimeng|image[-_.]?01|grok[-_.]?imagine|gemini.*image|image[-_.]?preview|comfy.*workflow|workflow.*comfy/.test(id)) caps.add('image_generation');
    if (/o1|o3|o4|thinking|reasoning|deepthink|r1|r2/.test(id)) caps.add('reasoning');
    if (/embed|embedding|text-embedding|bge|e5-/.test(id)) caps.add('embed');
    if (/rerank|reranker|bce-reranker/.test(id)) caps.add('rerank');
    return Array.from(caps);
  };

  const handleDiscoverModels = async (endpointId: string) => {
    if (!endpointId) return;
    
    // Abort any ongoing fetch
    if (discoverAbortControllerRef.current) {
      discoverAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    discoverAbortControllerRef.current = controller;

    setIsDiscovering(true);
    setHasFetched(false);
    setDiscoveredModels([]);
    setModelSearchQuery('');
    setIndividualTestStatus({});
    setIsModelDropdownOpen(false); // keep closed until results are back
    setAddModelError('');
    setAddModelErrorDetail('');

    try {
      const res = await fetch(`/api/models/discover?endpoint=${encodeURIComponent(endpointId)}`, {
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setDiscoveredModels(data.models || []);
        setHasFetched(true);
        if ((data.models || []).length > 0) {
          setIsModelDropdownOpen(true);
        }
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.discoverFailed');
        setAddModelError(display.message);
        setAddModelErrorDetail(display.detail);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('Discovery aborted');
      } else {
        const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
        setAddModelError(t('settings.models.discoverFailed'));
        setAddModelErrorDetail(detail);
      }
    } finally {
      if (discoverAbortControllerRef.current === controller) {
        setIsDiscovering(false);
        discoverAbortControllerRef.current = null;
      }
    }
  };

  const cancelDiscovery = () => {
    if (discoverAbortControllerRef.current) {
      discoverAbortControllerRef.current.abort();
      discoverAbortControllerRef.current = null;
      setIsDiscovering(false);
    }
  };

  const handleTestSingleModel = async (modelId: string, e?: React.MouseEvent, signal?: AbortSignal) => {
    if (e) e.stopPropagation();
    const shouldUseImageGenerationTest = guessCapabilities(modelId).includes('image_generation');
    setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'testing', message: '' }}));
    try {
      const res = await fetch(shouldUseImageGenerationTest ? '/api/models/test-image-generation' : '/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: newModelEndpoint.trim(), modelName: modelId }),
        signal
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setIndividualTestStatus(prev => ({
          ...prev,
          [modelId]: {
            status: 'success',
            message: shouldUseImageGenerationTest ? t('settings.models.imageGenerationLightCheckGood') : 'OK',
            detail: typeof data.warning === 'string' && data.warning.trim() ? data.warning.trim() : undefined,
          },
        }));
      } else {
        const display = resolveStructuredErrorDisplay(data, t, shouldUseImageGenerationTest ? 'settings.models.imageGenerationLightCheckFailed' : 'settings.models.connectivityFailed');
        setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'error', message: display.message, detail: display.detail || undefined }}));
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Just clear the testing state if aborted, don't show an error
        setIndividualTestStatus(prev => {
          const next = { ...prev };
          delete next[modelId];
          return next;
        });
      } else {
        const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
        const message = t('settings.models.testNetworkError');
        setIndividualTestStatus(prev => ({...prev, [modelId]: { status: 'error', message, detail: detail || undefined }}));
      }
    }
  };

  const handleTestExistingSingleModel = async (fullModelId: string, endpoint: string, modelName: string) => {
    const shouldUseImageGenerationTest = modelSupportsImageGeneration(models.find((model) => model.id === fullModelId) || {});
    setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'testing' } }));
    try {
      const res = await fetch(shouldUseImageGenerationTest ? '/api/models/test-image-generation' : '/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, modelName })
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        setExistingModelTestStatus(prev => ({
          ...prev,
          [fullModelId]: {
            status: 'success',
            message: shouldUseImageGenerationTest ? t('settings.models.imageGenerationLightCheckGood') : undefined,
            detail: typeof data.warning === 'string' && data.warning.trim() ? data.warning.trim() : undefined,
          },
        }));
      } else {
        const display = resolveStructuredErrorDisplay(data, t, shouldUseImageGenerationTest ? 'settings.models.imageGenerationLightCheckFailed' : 'settings.models.connectivityFailed');
        setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'error', message: display.message, detail: display.detail || undefined } }));
      }
    } catch (err: any) {
      const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
      const message = t('settings.models.testNetworkError');
      setExistingModelTestStatus(prev => ({ ...prev, [fullModelId]: { status: 'error', message, detail: detail || undefined } }));
    }
  };

  const existingModelIds = new Set(models.map(m => m.id));

  const handleTestAllFiltered = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    
    if (testAllAbortControllerRef.current) {
      testAllAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    testAllAbortControllerRef.current = controller;

    const filtered = discoveredModels.filter(m => m.toLowerCase().includes(modelSearchQuery.toLowerCase()));
    const testPromises = filtered.map(async (m) => {
      if (existingModelIds.has(`${newModelEndpoint.trim()}/${m}`)) return;
      await handleTestSingleModel(m, undefined, controller.signal);
    });

    try {
      await Promise.all(testPromises);
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        setAddModelError(error.message || t('settings.models.partialBatchTestFailed'));
        setAddModelErrorDetail('');
      }
    } finally {
      if (testAllAbortControllerRef.current === controller) {
        testAllAbortControllerRef.current = null;
      }
    }
  };

  const cancelTestAll = () => {
    if (testAllAbortControllerRef.current) {
      testAllAbortControllerRef.current.abort();
      testAllAbortControllerRef.current = null;
    }
  };

  const handleSave = async () => {
    setIsLoading(true);
    setGatewayError(false);
    if (!url.trim()) {
      setGatewayErrorMessage(t('settings.gateway.gatewayUrlRequired'));
      setGatewayErrorDetail('');
      setGatewayErrorModalOpen(true);
      setIsLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: JSON.stringify({ gatewayUrl: url, token, password }),
      });
      if (res.ok) {
        setGatewaySaved(true);
        setTimeout(() => setGatewaySaved(false), 2000);
      } else throw new Error(t('settings.gateway.saveFailed'));
    } catch (err) {
      setGatewayError(true);
      setTimeout(() => setGatewayError(false), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const detectGatewayConfig = async (options?: { silent?: boolean }) => {
    setIsDetectingAll(true);
    if (!options?.silent) {
      setDetectError('');
    }
    try {
      const res = await fetch('/api/config/detect-all', { headers: buildUpdateRequestHeaders() });
      const data = await res.json();
      if (data.success && data.data) {
        if (data.data.gatewayUrl) setUrl(data.data.gatewayUrl);
        if (data.data.token) setToken(data.data.token);
        if (data.data.password) setPassword(data.data.password);
        setDetectedOpenClawVersion(typeof data.data.openclawVersion === 'string' ? data.data.openclawVersion : '');
      } else {
        if (options?.silent) {
          return false;
        }
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.detectFailed');
        setDetectError(display.message);
        if (display.detail) {
          openSettingsErrorModal(display.message, display.detail);
        }
      }
    } catch (err) {
      console.error(err);
      if (!options?.silent) {
        setDetectError(t('settings.gateway.detectNetworkError'));
      }
    } finally {
      setIsDetectingAll(false);
    }
    return true;
  };

  const openGatewayRestartConfirm = () => {
    if (
      isRestarting
      || gatewayRestartModalStage
      || browserHeadedModeModalStage === 'restarting'
      || updateRestartModalStage === 'restarting'
    ) {
      return false;
    }
    setRestartSuccess(false);
    setGatewayRestartModalDetail('');
    setGatewayRestartModalStage('confirm');
    return true;
  };

  const handleRestartGateway = () => {
    openGatewayRestartConfirm();
  };

  const applyGatewayRestartTaskState = (data: { restart?: unknown }) => {
    const nextTaskInfo = normalizeGatewayRestartTaskInfo(data.restart);
    const pendingStart = pendingGatewayRestartStartRef.current;
    const currentTaskInfo = gatewayRestartTaskInfoRef.current;

    if (
      pendingStart
      && currentTaskInfo?.status === 'restarting'
      && currentTaskInfo.trigger === pendingStart.trigger
      && nextTaskInfo?.status === 'idle'
    ) {
      const nextUpdatedAtMs = parseTimestampMs(nextTaskInfo.updatedAt);
      if (nextUpdatedAtMs === null || nextUpdatedAtMs < pendingStart.startedAtMs) {
        return currentTaskInfo;
      }
    }

    if (pendingStart) {
      const nextUpdatedAtMs = parseTimestampMs(nextTaskInfo?.updatedAt);
      const acknowledgedProgress = nextTaskInfo?.trigger === pendingStart.trigger
        && (nextTaskInfo.status === 'restarting' || nextTaskInfo.status === 'failed');
      const completedLocalRequest = nextTaskInfo?.status === 'idle'
        && (nextUpdatedAtMs === null || nextUpdatedAtMs >= pendingStart.startedAtMs);

      if (acknowledgedProgress || completedLocalRequest) {
        pendingGatewayRestartStartRef.current = null;
      }
    }

    updateGatewayRestartTaskInfo(nextTaskInfo);
    return nextTaskInfo;
  };

  const fetchGatewayRestartTaskStatus = async () => {
    const res = await fetch('/api/config/restart/status');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.errorDetail === 'string' && data.errorDetail.trim()
        ? data.errorDetail.trim()
        : 'Failed to load gateway restart status');
    }
    return applyGatewayRestartTaskState(data);
  };

  const resetGatewayRestartTaskStatus = async () => {
    const res = await fetch('/api/config/restart/status/reset', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.errorDetail === 'string' && data.errorDetail.trim()
        ? data.errorDetail.trim()
        : 'Failed to reset gateway restart status');
    }
    return applyGatewayRestartTaskState(data);
  };

  const closeGatewayRestartModal = () => {
    if (gatewayRestartModalStage === 'restarting') return;
    setGatewayRestartModalStage(null);
    setGatewayRestartModalDetail('');
    if (gatewayRestartTaskInfo?.status === 'failed' && gatewayRestartTaskInfo.trigger === 'gateway') {
      updateGatewayRestartTaskInfo({
        status: 'idle',
        trigger: null,
        rawDetail: null,
        startedAt: null,
        updatedAt: new Date().toISOString(),
        targetHeadedModeEnabled: null,
      });
      void resetGatewayRestartTaskStatus().catch(() => {});
    }
  };

  const handleConfirmRestartGateway = async () => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    setIsRestarting(true);
    setRestartSuccess(false);
    setGatewayRestartModalDetail('');
    setGatewayRestartModalStage('restarting');
    pendingGatewayRestartStartRef.current = {
      trigger: 'gateway',
      startedAtMs,
    };
    updateGatewayRestartTaskInfo({
      status: 'restarting',
      trigger: 'gateway',
      rawDetail: null,
      startedAt,
      updatedAt: startedAt,
      targetHeadedModeEnabled: null,
    });
    try {
      const res = await fetch('/api/config/restart', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      applyGatewayRestartTaskState(data);
      if (res.ok) {
        await fetchGatewayRestartTaskStatus().catch(() => {});
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.restartFailed');
        setGatewayRestartModalDetail(joinDistinctLines([
          display.message !== t('settings.gateway.restartFailed') ? display.message : '',
          display.detail,
        ]));
        setGatewayRestartModalStage('failure');
      }
    } catch (err) {
      pendingGatewayRestartStartRef.current = null;
      console.error(err);
      const detail = err instanceof Error && err.message.trim() ? err.message.trim() : '';
      setGatewayRestartModalDetail(detail);
      setGatewayRestartModalStage('failure');
      updateGatewayRestartTaskInfo({
        status: 'failed',
        trigger: 'gateway',
        rawDetail: detail || null,
        startedAt: null,
        updatedAt: new Date().toISOString(),
        targetHeadedModeEnabled: null,
      });
    }
  };

  const applyBrowserHealthSnapshot = (snapshot: BrowserHealthSnapshot) => {
    setBrowserHealth(snapshot);
    if (typeof snapshot.maxPermissionsEnabled === 'boolean') {
      setMaxPermissions(snapshot.maxPermissionsEnabled);
    }
    if (typeof snapshot.config?.headless === 'boolean') {
      setBrowserHeadedModeEnabled(snapshot.config.headless !== true);
    }
  };

  const applyBrowserHeadedModeConfig = (config: BrowserHeadedModeConfig) => {
    setBrowserHeadedModeEnabled(config.headedModeEnabled);
    setBrowserHealth(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        config: {
          enabled: prev.config?.enabled ?? prev.enabled,
          headless: config.headless,
          profile: prev.config?.profile ?? prev.profile,
          executablePath: prev.config?.executablePath ?? null,
          noSandbox: prev.config?.noSandbox ?? null,
          attachOnly: prev.config?.attachOnly ?? null,
          cdpPort: prev.config?.cdpPort ?? null,
        },
      };
    });
  };

  const browserHealthRequiresPairing = (snapshot: BrowserHealthSnapshot | null) => {
    if (!snapshot) {
      return false;
    }

    const detail = [
      snapshot.validationDetail,
      snapshot.rawDetail,
      snapshot.runtime?.detectError,
      snapshot.detectError,
    ].filter(Boolean).join('\n').toLowerCase();

    return detail.includes('pairing required');
  };

  const applyMaxPermissionsState = (data: { enabled?: unknown; hostTakeover?: unknown; devicePairing?: unknown }) => {
    setMaxPermissions(!!data.enabled);
    setHostTakeoverStatus((data.hostTakeover as HostTakeoverStatus | null) || null);
    if ('devicePairing' in data) {
      setDevicePairingStatus((data.devicePairing as DevicePairingStatus | null) || null);
    }
  };

  const fetchBrowserHeadedModeState = async () => {
    setIsLoadingBrowserHeadedMode(true);
    try {
      const res = await fetch('/api/config/browser-headed-mode');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.config) {
        applyBrowserHeadedModeConfig(data.config as BrowserHeadedModeConfig);
      } else {
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserHeadedModeLoadFailed'));
      }
    } catch (err) {
      setBrowserHealthError({
        message: t('gateway.browserHeadedModeLoadFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsLoadingBrowserHeadedMode(false);
    }
  };

  const fetchMaxPermissionsState = async () => {
    try {
      const res = await fetch('/api/config/max-permissions');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.maxPermissionsLoadFailed');
        setPermissionsError(display);
        throw new Error(display.detail || display.message);
      }
      applyMaxPermissionsState(data);
      setPermissionsError(EMPTY_INLINE_ERROR);
      return !!data.enabled;
    } finally {
      setHasLoadedMaxPermissionsState(true);
    }
  };

  const handleApproveLatestDevicePairing = async () => {
    setIsApprovingDevicePairing(true);
    setPermissionsError(EMPTY_INLINE_ERROR);
    setPermissionsNotice(null);

    try {
      const res = await fetch('/api/config/max-permissions/device-pairing/approve', {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        if (data.devicePairing) {
          setDevicePairingStatus(data.devicePairing as DevicePairingStatus);
        } else {
          await fetchMaxPermissionsState().catch(() => {});
        }
        setPermissionsNotice({
          tone: 'success',
          message: t('settings.gateway.devicePairingApproveSuccess'),
        });
      } else {
        setPermissionsError(resolveStructuredErrorDisplay(data, t, 'gateway.devicePairingApproveFailed'));
      }
    } catch (err) {
      setPermissionsError({
        message: t('gateway.devicePairingApproveFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsApprovingDevicePairing(false);
    }
  };

  const closePermissionsPasswordModal = () => {
    if (isSubmittingPermissionsPassword) return;
    setPermissionsPasswordModalOpen(false);
    setPermissionsPasswordUser('');
    setPermissionsPassword('');
    setPermissionsPasswordError(EMPTY_INLINE_ERROR);
    setRestartAfterPermissionsPasswordSubmit(false);
  };

  const closeMaxPermissionsConfirmModal = () => {
    if (isTogglingPermissions) return;
    setMaxPermissionsConfirmPendingEnabled(null);
  };

  const requestMaxPermissionsChange = async (nextEnabled: boolean, systemPassword?: string) => {
    const res = await fetch('/api/config/max-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: nextEnabled,
        ...(systemPassword ? { systemPassword } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const applyMaxPermissionsChange = async (
    nextEnabled: boolean,
    options?: { restartAfterSuccess?: boolean },
  ) => {
    setMaxPermissions(nextEnabled);
    setIsTogglingPermissions(true);
    setPermissionsError(EMPTY_INLINE_ERROR);
    setPermissionsNotice(null);
    setBrowserHealthNotice(null);
    setGatewayRestartNoticeSource(null);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    try {
      const { res, data } = await requestMaxPermissionsChange(nextEnabled);
      if (res.ok && data.success) {
        applyMaxPermissionsState(data);
        setPermissionsError(EMPTY_INLINE_ERROR);
        setBrowserHealth(null);
        setGatewayRestartNoticeSource('permissions');
        if (data.restartRequired) {
          if (options?.restartAfterSuccess) {
            void handleConfirmRestartGateway();
          } else {
            openGatewayRestartConfirm();
          }
        }
      } else if (nextEnabled && responseNeedsHostTakeoverPasswordPrompt(data)) {
        setRestartAfterPermissionsPasswordSubmit(!!options?.restartAfterSuccess);
        if (typeof data.enabled === 'boolean' || data.hostTakeover) {
          applyMaxPermissionsState(data);
        } else {
          setMaxPermissions(false);
        }
        setPermissionsPasswordUser(
          typeof data?.errorParams?.userName === 'string' && data.errorParams.userName.trim()
            ? data.errorParams.userName.trim()
            : (data.hostTakeover?.currentUser || hostTakeoverStatus?.currentUser || '')
        );
        setPermissionsPassword('');
        setPermissionsPasswordError(EMPTY_INLINE_ERROR);
        setPermissionsPasswordModalOpen(true);
      } else {
        setPermissionsError(resolveStructuredErrorDisplay(data, t, 'gateway.maxPermissionsUpdateFailed'));
        if (typeof data.enabled === 'boolean' || data.hostTakeover) {
          applyMaxPermissionsState(data);
        } else {
          await fetchMaxPermissionsState().catch(() => {
            setMaxPermissions(!nextEnabled);
          });
        }
      }
    } catch (err) {
      console.error(err);
      setPermissionsError({
        message: t('gateway.maxPermissionsUpdateFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
      await fetchMaxPermissionsState().catch(() => {
        setMaxPermissions(!nextEnabled);
      });
    } finally {
      setIsTogglingPermissions(false);
    }
  };

  const handleToggleMaxPermissions = () => {
    const nextEnabled = !maxPermissions;
    setPermissionsError(EMPTY_INLINE_ERROR);
    setPermissionsNotice(null);
    setBrowserHealthNotice(null);
    setGatewayRestartNoticeSource(null);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setMaxPermissionsConfirmPendingEnabled(nextEnabled);
  };

  const handleConfirmMaxPermissionsToggle = async () => {
    if (maxPermissionsConfirmPendingEnabled === null) return;
    const nextEnabled = maxPermissionsConfirmPendingEnabled;
    setMaxPermissionsConfirmPendingEnabled(null);
    await applyMaxPermissionsChange(nextEnabled, { restartAfterSuccess: true });
  };

  const handleSubmitPermissionsPassword = async () => {
    if (!permissionsPassword.trim()) {
      setPermissionsPasswordError({
        message: t('settings.gateway.hostTakeoverPasswordRequired'),
        detail: '',
      });
      return;
    }

    setIsSubmittingPermissionsPassword(true);
    setPermissionsPasswordError(EMPTY_INLINE_ERROR);
    setPermissionsError(EMPTY_INLINE_ERROR);
    setPermissionsNotice(null);

    try {
      const { res, data } = await requestMaxPermissionsChange(true, permissionsPassword);
      if (res.ok && data.success) {
        applyMaxPermissionsState(data);
        setPermissionsPasswordUser('');
        setPermissionsPassword('');
        setPermissionsPasswordModalOpen(false);
        setPermissionsPasswordError(EMPTY_INLINE_ERROR);
        setBrowserHealth(null);
        setGatewayRestartNoticeSource('permissions');
        if (data.restartRequired) {
          if (restartAfterPermissionsPasswordSubmit) {
            setRestartAfterPermissionsPasswordSubmit(false);
            void handleConfirmRestartGateway();
          } else {
            openGatewayRestartConfirm();
          }
        }
        return;
      }

      if (typeof data.enabled === 'boolean' || data.hostTakeover) {
        applyMaxPermissionsState(data);
      }

      setPermissionsPasswordError(resolveStructuredErrorDisplay(data, t, 'gateway.hostTakeoverInstallFailed'));
    } catch (err) {
      setPermissionsPasswordError({
        message: t('gateway.hostTakeoverInstallFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsSubmittingPermissionsPassword(false);
    }
  };

  const fetchBrowserTaskStatus = async (options?: { quiet?: boolean }) => {
    try {
      const res = await fetch('/api/config/browser-health/status');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success || !data.task) {
        if (!options?.quiet) {
          setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserHealthFailed'));
        }
        return null;
      }
      const nextTask = data.task as BrowserTaskInfo;
      setBrowserTaskInfo(nextTask);
      return nextTask;
    } catch (err) {
      if (!options?.quiet) {
        setBrowserHealthError({
          message: t('gateway.browserHealthFailed'),
          detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
        });
      }
      return null;
    }
  };

  const handleCheckBrowserHealth = async () => {
    setIsCheckingBrowserHealth(true);
    setBrowserTaskInfo({
      status: 'checking',
      phase: 'read-config',
      rawDetail: null,
      updatedAt: null,
    });
    setBrowserHealth(null);
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setBrowserHealthNotice(null);
    try {
      const res = await fetch('/api/config/browser-health');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.health) {
        const snapshot = data.health as BrowserHealthSnapshot;
        applyBrowserHealthSnapshot(snapshot);
        if (browserHealthRequiresPairing(snapshot)) {
          await fetchMaxPermissionsState().catch(() => {});
        }
      } else {
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserHealthFailed'));
      }
    } catch (err) {
      setBrowserHealthError({
        message: t('gateway.browserHealthFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setBrowserTaskInfo({
        status: 'idle',
        phase: null,
        rawDetail: null,
        updatedAt: new Date().toISOString(),
      });
      setIsCheckingBrowserHealth(false);
    }
  };

  const handleToggleBrowserHeadedMode = async () => {
    if (browserHeadedModeEnabled === null) return;
    setBrowserHeadedModePendingEnabled(!browserHeadedModeEnabled);
    setBrowserHeadedModeModalDetail('');
    setBrowserHeadedModeModalStage('confirm');
  };

  const closeBrowserHeadedModeModal = () => {
    if (browserHeadedModeModalStage === 'restarting') return;
    setBrowserHeadedModeModalStage(null);
    setBrowserHeadedModePendingEnabled(null);
    setBrowserHeadedModeModalDetail('');
    if (gatewayRestartTaskInfo?.status === 'failed' && gatewayRestartTaskInfo.trigger === 'browser-headed-mode') {
      updateGatewayRestartTaskInfo({
        status: 'idle',
        trigger: null,
        rawDetail: null,
        startedAt: null,
        updatedAt: new Date().toISOString(),
        targetHeadedModeEnabled: null,
      });
      void resetGatewayRestartTaskStatus().catch(() => {});
    }
  };

  const handleConfirmBrowserHeadedModeToggle = async () => {
    if (browserHeadedModePendingEnabled === null) return;

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    setIsTogglingBrowserHeadedMode(true);
    setBrowserHeadedModeModalDetail('');
    setBrowserHeadedModeModalStage('restarting');
    pendingGatewayRestartStartRef.current = {
      trigger: 'browser-headed-mode',
      startedAtMs,
    };
    updateGatewayRestartTaskInfo({
      status: 'restarting',
      trigger: 'browser-headed-mode',
      rawDetail: null,
      startedAt,
      updatedAt: startedAt,
      targetHeadedModeEnabled: browserHeadedModePendingEnabled,
    });
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setBrowserHealthNotice(null);
    setGatewayRestartNoticeSource(null);
    setBrowserHealth(null);

    try {
      const res = await fetch('/api/config/browser-headed-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headedModeEnabled: browserHeadedModePendingEnabled }),
      });
      const data = await res.json().catch(() => ({}));
      applyGatewayRestartTaskState(data);
      if (res.ok && data.success && data.config) {
        applyBrowserHeadedModeConfig(data.config as BrowserHeadedModeConfig);
        await fetchGatewayRestartTaskStatus().catch(() => {});
      } else {
        await fetchBrowserHeadedModeState().catch(() => {});
        const display = resolveStructuredErrorDisplay(data, t, 'gateway.browserHeadedModeUpdateFailed');
        setBrowserHealthError(display);
        setBrowserHeadedModeModalDetail(display.detail);
        setBrowserHeadedModeModalStage('failure');
      }
    } catch (err) {
      pendingGatewayRestartStartRef.current = null;
      await fetchBrowserHeadedModeState().catch(() => {});
      const detail = err instanceof Error && err.message.trim() ? err.message.trim() : '';
      setBrowserHealthError({
        message: t('gateway.browserHeadedModeUpdateFailed'),
        detail,
      });
      setBrowserHeadedModeModalDetail(detail);
      setBrowserHeadedModeModalStage('failure');
      updateGatewayRestartTaskInfo({
        status: 'failed',
        trigger: 'browser-headed-mode',
        rawDetail: detail || null,
        startedAt: null,
        updatedAt: new Date().toISOString(),
        targetHeadedModeEnabled: browserHeadedModePendingEnabled,
      });
    }
  };

  const handleSelfHealBrowser = async () => {
    setIsSelfHealingBrowser(true);
    setBrowserTaskInfo({
      status: 'repairing',
      phase: 'inspect-current',
      rawDetail: null,
      updatedAt: null,
    });
    setBrowserHealthError(EMPTY_INLINE_ERROR);
    setBrowserHealthNotice(null);
    try {
      const res = await fetch('/api/config/browser-health/self-heal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lastKnownIssue: browserHealth?.issue || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        const snapshot = data.health as BrowserHealthSnapshot | undefined;
        if (snapshot) {
          applyBrowserHealthSnapshot(snapshot);
          if (!snapshot.healthy) {
            setBrowserHealthError({
              message: t('gateway.browserHealthFailed'),
              detail: snapshot.validationDetail || snapshot.rawDetail || snapshot.detectError || '',
            });
            return;
          }
        } else {
          setBrowserHealth(null);
        }
        setBrowserHealthNotice({
          tone: 'success',
          message: t('settings.gateway.browserSelfHealSuccess'),
        });
      } else {
        setBrowserHealthError(resolveStructuredErrorDisplay(data, t, 'gateway.browserSelfHealFailed'));
      }
    } catch (err) {
      setBrowserHealthError({
        message: t('gateway.browserSelfHealFailed'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setBrowserTaskInfo({
        status: 'idle',
        phase: null,
        rawDetail: null,
        updatedAt: new Date().toISOString(),
      });
      setIsSelfHealingBrowser(false);
    }
  };

  const handleAddHost = async () => {
    if (!newHost.trim()) return;
    const updated = [...allowedHosts, newHost.trim()];
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: JSON.stringify({ allowedHosts: updated }),
      });
      if (res.ok) {
        setAllowedHosts(updated);
        setNewHost('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateHost = async () => {
    if (!editHostValue.trim() || !editingHost) return;
    const updated = allowedHosts.map(h => h === editingHost ? editHostValue.trim() : h);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: JSON.stringify({ allowedHosts: updated }),
      });
      if (res.ok) {
        setAllowedHosts(updated);
        setEditingHost(null);
        setEditHostValue('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const startEditHost = (host: string) => {
    setEditingHost(host);
    setEditHostValue(host);
  };

  const handleRemoveHost = (hostToRemove: string) => {
    setDeleteTarget({ type: 'host', value: hostToRemove });
    setDeleteModalMessage(t('settings.gateway.removeHostConfirm', { host: hostToRemove }));
    setIsDeleteModalOpen(true);
  };

  const handleTest = async () => {
    setIsLoading(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gatewayUrl: url, token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setGatewayErrorModalOpen(false);
        setGatewayErrorMessage('');
        setGatewayErrorDetail('');
        setTestResult({ success: true, message: data.message || '' });
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.gateway.testFailed');
        setTestResult({ success: false, message: display.message });
        openSettingsErrorModal(display.message, display.detail);
      }
    } catch (err) {
      const detail = err instanceof Error && err.message.trim() ? err.message.trim() : '';
      const message = t('settings.gateway.testFailed');
      setTestResult({ success: false, message });
      openSettingsErrorModal(message, detail);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveGeneral = async () => {
    setIsLoading(true);
    setGeneralError(false);
    const nextHistoryPageRounds = commitHistoryPageRounds();
    if (!aiName.trim()) {
      setAiNameError('required');
      setIsLoading(false);
      return;
    }
    if (getVisualLength(aiName) > 20) {
      setAiNameError('tooLong');
      setIsLoading(false);
      return;
    }
    setAiNameError('');
    const nextPreviewTimeoutSeconds = parsePreviewTimeoutSecondsInput(previewTimeoutSecondsInput);
    if (nextPreviewTimeoutSeconds === null) {
      setPreviewTimeoutError(true);
      setIsLoading(false);
      return;
    }
    setPreviewTimeoutError(false);

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: JSON.stringify({
          aiName,
          loginEnabled,
          loginPassword,
          historyPageRounds: nextHistoryPageRounds,
          previewConversionTimeoutSeconds: nextPreviewTimeoutSeconds,
        }),
      });
      if (res.ok) {
        setPreviewTimeoutSecondsInput(String(nextPreviewTimeoutSeconds));
        setGeneralSaved(true);
        setTimeout(() => setGeneralSaved(false), 2000);
      } else throw new Error(t('settings.general.saveError'));
    } catch (err) {
      setGeneralError(true);
      setTimeout(() => setGeneralError(false), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLanguageChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextLanguage = normalizeLanguage(event.target.value) as SupportedLanguage;

    if (normalizeLanguage(i18n.resolvedLanguage || i18n.language) === nextLanguage) {
      return;
    }

    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: buildUpdateRequestHeaders(true),
        body: JSON.stringify({ language: nextLanguage }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(
          (typeof data?.error === 'string' && data.error.trim()) ||
          (typeof data?.message === 'string' && data.message.trim()) ||
          'Failed to persist preferred language'
        );
      }

      await applyLanguagePreference(nextLanguage);
    } catch (error) {
      console.error('Failed to update language preference:', error);
      setGeneralError(true);
      setTimeout(() => setGeneralError(false), 3000);
    }
  };

  const commitHistoryPageRounds = () => {
    const nextValue = persistChatHistoryPageRounds(historyPageRoundsInput);
    setHistoryPageRoundsInput(String(nextValue));
    return nextValue;
  };

  const handleHistoryPageRoundsChange = (event: ChangeEvent<HTMLInputElement>) => {
    const digitsOnly = event.target.value.replace(/[^\d]/g, '');
    setHistoryPageRoundsInput(digitsOnly);
  };

  const handleAddCommand = async () => {
    if (!newCommand || !newDescription) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: newCommand, description: newDescription }),
      });
      if (res.ok) {
        setNewCommand('');
        setNewDescription('');
        fetchCommands();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateCommand = async () => {
    if (!editingId || !newCommand || !newDescription) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/commands/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: newCommand, description: newDescription }),
      });
      if (res.ok) {
        setEditingId(null);
        setNewCommand('');
        setNewDescription('');
        fetchCommands();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteCommand = (id: number) => {
    setDeleteTarget({ type: 'command', id });
    setDeleteModalMessage(t('settings.commands.deleteConfirm'));
    setIsDeleteModalOpen(true);
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'host') {
        const updated = allowedHosts.filter(h => h !== deleteTarget.value);
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowedHosts: updated }),
        });
        if (res.ok) setAllowedHosts(updated);
      } else if (deleteTarget.type === 'command') {
        const res = await fetch(`/api/commands/${deleteTarget.id}`, { method: 'DELETE' });
        if (res.ok) fetchCommands();
      } else if (deleteTarget.type === 'model') {
        const res = await fetch('/api/models/manage', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: deleteTarget.id }),
        });
        if (res.ok) {
          setModelActionError(EMPTY_INLINE_ERROR);
          fetchModels();
          fetchImageGenerationModelConfig();
          fetchGlobalFallbacks();
  
        } else {
          const data = await res.json().catch(() => ({}));
          setModelActionError(resolveStructuredErrorDisplay(data, t, 'settings.models.deleteModelFailed'));
        }
      } else if (deleteTarget.type === 'endpoint') {
        const res = await fetch('/api/endpoints/manage', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: deleteTarget.name }),
        });
        if (res.ok) {
          setModelActionError(EMPTY_INLINE_ERROR);
          fetchModels();
          fetchImageGenerationModelConfig();
          fetchGlobalFallbacks();
          fetchEndpoints();
  
        } else {
          const data = await res.json().catch(() => ({}));
          setModelActionError(resolveStructuredErrorDisplay(data, t, 'settings.models.deleteEndpointFailed'));
        }
      }
    } catch (err) {
      console.error(err);
      if (deleteTarget.type === 'model') {
        setModelActionError({
          message: t('settings.models.deleteModelFailed'),
          detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
        });
      } else if (deleteTarget.type === 'endpoint') {
        setModelActionError({
          message: t('settings.models.deleteEndpointFailed'),
          detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
        });
      }
    } finally {
      setIsDeleteModalOpen(false);
      setDeleteTarget(null);
    }
  };

  const startEdit = (cmd: { id: number; command: string; description: string }) => {
    setEditingId(cmd.id);
    setNewCommand(cmd.command);
    setNewDescription(cmd.description);
  };

  const handleTestModel = async (e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    if (!newModelEndpoint.trim() || !newModelName.trim()) {
      setAddModelError(t('settings.models.endpointModelRequiredForTest'));
      setAddModelErrorDetail('');
      setTimeout(() => setAddModelError(''), 3000);
      return false;
    }
    setAddModelTestStatus('testing');
    const shouldUseImageGenerationTest = modelSupportsImageGeneration({ input: newModelInput });
    setAddModelTestMessage(shouldUseImageGenerationTest ? t('settings.models.imageGenerationLightChecking') : t('settings.models.testingConnectivity'));
    try {
      const res = await fetch(shouldUseImageGenerationTest ? '/api/models/test-image-generation' : '/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: newModelEndpoint.trim(),
          modelName: newModelName.trim()
        })
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        setAddModelTestStatus('success');
        const latency = data.latency !== undefined ? `${data.latency}ms` : t('settings.models.unknownLatency');
        setAddModelTestMessage(shouldUseImageGenerationTest
          ? t('settings.models.imageGenerationLightCheckGoodWithLatency', { latency })
          : t('settings.models.connectivityGood', { latency }));
        setTestModelMessage(typeof data.warning === 'string' && data.warning.trim() ? data.warning.trim() : '');
        return true;
      } else {
        const display = resolveStructuredErrorDisplay(data, t, shouldUseImageGenerationTest ? 'settings.models.imageGenerationLightCheckFailed' : 'settings.models.connectivityFailed');
        setAddModelTestStatus('error');
        setAddModelTestMessage(display.message);
        setTestModelMessage(display.detail || display.message);
        return false;
      }
    } catch (err: any) {
      const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
      const message = t('settings.models.testNetworkError');
      setAddModelTestStatus('error');
      setAddModelTestMessage(message);
      setTestModelMessage(detail || message);
      return false;
    }
  };

  const handleAddModel = async () => {
    if (!newModelEndpoint.trim() || !newModelName.trim()) {
      setAddModelError(t('settings.models.endpointModelRequired'));
      setAddModelErrorDetail('');
      setTimeout(() => setAddModelError(''), 3000);
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/models/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: newModelEndpoint.trim(),
          modelName: newModelName.trim(),
          alias: newModelAlias.trim() || undefined,
          input: newModelInput.length > 0 ? newModelInput : undefined,
        }),
      });
      
      if (res.ok) {
        setNewModelEndpoint('');
        setNewModelName('');
        setNewModelAlias('');
        setNewModelInput(['text']);
        setAddModelError('');
        setAddModelErrorDetail('');
        setIsAddModelModalOpen(false);
        fetchModels();
      } else {
        const data = await res.json().catch(() => ({}));
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.saveModelFailed');
        setAddModelError(display.message);
        setAddModelErrorDetail(display.detail);
      }
    } catch (err) {
      console.error(err);
      setAddModelError(t('settings.models.addModelNetworkError'));
      setAddModelErrorDetail(err instanceof Error && err.message.trim() ? err.message.trim() : '');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteModel = (id: string, isPrimary: boolean) => {
    setDeleteTarget({ type: 'model', id });
    setDeleteModalMessage(t('settings.models.deleteModelConfirm', {
      id,
      defaultWarning: isPrimary ? t('settings.models.defaultModelWarning') : '',
    }));
    setIsDeleteModalOpen(true);
  };

  const handleSaveDefaultModelSelection = async (id: string) => {
    const nextId = id.trim();
    if (!nextId) {
      setDefaultModelError({
        message: t('settings.models.defaultModelNoSelection'),
        detail: '',
      });
      return;
    }

    const previousId = defaultModelId;
    setDefaultModelId(nextId);
    setDefaultModelError(EMPTY_INLINE_ERROR);
    setIsSavingDefaultModel(true);

    try {
      const res = await fetch('/api/models/manage/default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: nextId }),
      });

      if (res.ok) {
        await fetchModels();
        return;
      }

      const data = await res.json().catch(() => ({}));
      setDefaultModelId(previousId);
      setDefaultModelError(resolveStructuredErrorDisplay(data, t, 'settings.models.setDefaultModelFailed'));
    } catch (err) {
      setDefaultModelId(previousId);
      setDefaultModelError({
        message: t('settings.models.setDefaultModelNetworkError'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsSavingDefaultModel(false);
    }
  };

  const handleSetDefaultModel = async (id: string) => {
    setIsLoading(true);
    try {
      await handleSaveDefaultModelSelection(id);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const startEditModel = (model: { id: string; alias?: string; input: string[] }) => {
    setEditingModelId(model.id);
    setEditingAlias(model.alias || '');
    setEditingInput(model.input || []);
    setTimeout(() => editAliasInputRef.current?.focus(), 50);
  };

  const handleDeleteEndpoint = (endpoint: string, count: number) => {
    setDeleteTarget({ type: 'endpoint', name: endpoint });
    setDeleteModalMessage(t('settings.models.deleteEndpointConfirm', { endpoint, count }));
    setIsDeleteModalOpen(true);
  };

  const cancelEditModel = () => {
    setEditingModelId(null);
    setEditingAlias('');
  };

  const handleSaveModelAlias = async () => {
    if (!editingModelId) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/models/manage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingModelId, alias: editingAlias, input: editingInput }),
      });
      if (res.ok) {
        setModelActionError(EMPTY_INLINE_ERROR);
        setEditingModelId(null);
        setEditingAlias('');
        setEditingInput([]);
        fetchModels();
        fetchImageGenerationModelConfig();

      } else {
        const data = await res.json().catch(() => ({}));
        setModelActionError(resolveStructuredErrorDisplay(data, t, 'settings.models.editAliasFailed'));
      }
    } catch (err) {
      console.error(err);
      setModelActionError({
        message: t('settings.models.editAliasNetworkError'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const openAddEndpointModal = () => {
    setEditingEndpoint(null);
    setNewEndpointData({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });
    setEndpointTestStatus('idle');
    setEndpointTestMessage('');
    setEndpointModalError(EMPTY_INLINE_ERROR);
    setIsEndpointModalOpen(true);
  };

  const openEditEndpointModal = (ep: EndpointConfig) => {
    setEditingEndpoint(ep);
    setNewEndpointData({ ...ep });
    setEndpointTestStatus('idle');
    setEndpointTestMessage('');
    setEndpointModalError(EMPTY_INLINE_ERROR);
    setIsEndpointModalOpen(true);
  };

  const handleSaveEndpoint = async () => {
    if (!newEndpointData.id.trim() || !newEndpointData.baseUrl.trim() || !newEndpointData.api) {
      setEndpointModalError({ message: t('settings.models.endpointConfigRequired'), detail: '' });
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch('/api/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEndpointData),
      });
      if (res.ok) {
        setEndpointModalError(EMPTY_INLINE_ERROR);
        setIsEndpointModalOpen(false);
        fetchEndpoints();

      } else {
        const data = await res.json().catch(() => ({}));
        setEndpointModalError(resolveStructuredErrorDisplay(data, t, 'settings.models.saveEndpointFailed'));
      }
    } catch (err) {
      console.error(err);
      setEndpointModalError({
        message: t('settings.models.saveEndpointNetworkError'),
        detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestEndpoint = async () => {
    if (!newEndpointData.baseUrl.trim() || !newEndpointData.api) {
      setEndpointTestStatus('error');
      setEndpointTestMessage(t('settings.models.fillBaseUrlApiType'));
      return;
    }
    
    setEndpointTestStatus('testing');
    setEndpointTestMessage(t('settings.models.testing'));
    
    try {
      const res = await fetch('/api/endpoints/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: newEndpointData.baseUrl,
          apiKey: newEndpointData.apiKey,
          api: newEndpointData.api
        })
      });
      const data = await res.json();
      if (data.success) {
        setEndpointTestStatus('success');
        setEndpointTestMessage(t('settings.models.endpointConnectionSuccess'));
        setTimeout(() => setEndpointTestStatus('idle'), 3000);
      } else {
        const display = resolveStructuredErrorDisplay(data, t, 'settings.models.endpointConnectionFailed');
        setEndpointTestStatus('error');
        setEndpointTestMessage(display.message);
        if (display.detail) {
          openSettingsErrorModal(display.message, display.detail);
        }
      }
    } catch (err: any) {
      const detail = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : '';
      setEndpointTestStatus('error');
      setEndpointTestMessage(t('settings.models.networkConnectionError'));
      if (detail) {
        openSettingsErrorModal(t('settings.models.networkConnectionError'), detail);
      }
    }
  };

  // Get distinct endpoints from current models, merged with actual endpoints objects
  const knownEndpoints = Array.from(new Set([
    ...endpoints.map(ep => ep.id),
    ...models.map(m => m.id.split('/')[0]).filter(Boolean)
  ])).sort((a, b) => a.localeCompare(b));
  const currentPrimaryModelId = models.find((model) => model.primary)?.id || '';
  const sortedModels = sortModelsByDisplayName(models);
  const imageGenerationModels = sortModelsByDisplayName(models.filter(modelSupportsImageGeneration));
  const hasImageGenerationModels = imageGenerationModels.length > 0;
  const newModelUsesImageGeneration = modelSupportsImageGeneration({ input: newModelInput });

  const currentLanguage = normalizeLanguage(i18n.resolvedLanguage || i18n.language);
  const openClawCurrentVersion = detectedOpenClawVersion
    || appVersionInfo?.openclawVersion
    || openClawLatestVersionInfo?.currentVersion
    || '';
  const isAppUpdateFlowActive = isCheckingLatestVersion
    || ['checking', 'updating', 'stopping', 'restarting'].includes(updateStatusInfo?.status || '');
  const isOpenClawUpdateFlowActive = isCheckingOpenClawLatestVersion
    || isStartingOpenClawUpdate
    || ['checking', 'updating', 'stopping'].includes(openClawUpdateStatusInfo?.status || '');
  const isAppUpdateBlockedByOpenClaw = !isAppUpdateFlowActive && isOpenClawUpdateFlowActive;
  const isOpenClawUpdateBlockedByApp = !isOpenClawUpdateFlowActive && isAppUpdateFlowActive;
  const openClawEffectiveLatestVersion = openClawLatestVersionInfo?.latestVersion || openClawUpdateStatusInfo?.latestVersion || null;
  const effectiveLatestVersion = latestVersionInfo?.latestVersion || updateStatusInfo?.latestVersion || null;
  const updatePhaseVisual = updateStatusInfo?.phase && UPDATE_PHASE_VISUALS[updateStatusInfo.phase]
    ? UPDATE_PHASE_VISUALS[updateStatusInfo.phase]
    : { progress: 8, labelKey: 'settings.about.updateProgressPreparing' };
  const openClawPhaseVisual = openClawUpdateStatusInfo?.phase && OPENCLAW_UPDATE_PHASE_VISUALS[openClawUpdateStatusInfo.phase]
    ? OPENCLAW_UPDATE_PHASE_VISUALS[openClawUpdateStatusInfo.phase]
    : { progress: 8, labelKey: 'settings.openclawUpdate.progressChecking' };
  const updateFailureDetail = joinDistinctLines([
    updateStatusInfo?.rawDetail,
    updateStatusInfo?.message,
  ]);
  const updateRestartSteps = UPDATE_RESTART_STEP_IDS.map((id) => {
    const matched = (updateStatusInfo?.restartSteps || updateRestartStepSnapshot || []).find((step) => step.id === id) || null;
    return matched || {
      id,
      status: 'pending' as UpdateRestartStepStatus,
      detail: null,
      updatedAt: null,
    };
  });
  const updateRestartStepItems = updateRestartSteps.map((step) => ({
    ...step,
    label: step.id === 'restart_openclaw'
      ? t('settings.about.restartStepRestartOpenClaw')
      : step.id === 'restart_project'
        ? t('settings.about.restartStepRestartProject')
        : t('settings.about.restartStepWarmupBrowser'),
    statusLabel: step.status === 'completed'
      ? t('settings.about.restartStepStatusCompleted')
      : step.status === 'skipped'
        ? t('settings.about.restartStepStatusSkipped')
        : step.status === 'failed'
          ? t('settings.about.restartStepStatusFailed')
          : step.status === 'running'
            ? t('settings.about.restartStepStatusRunning')
            : t('settings.about.restartStepStatusPending'),
    // 跳过时把「为什么跳过」翻成人话，原始 reason 是给日志看的
    skipReason: step.status === 'skipped'
      ? t(`settings.about.restartSkipReason.${step.detail || 'unknown'}`, { defaultValue: step.detail || '' })
      : '',
  }));
  const openClawUpdateFailureDetail = joinDistinctLines([
    openClawUpdateStatusInfo?.rawDetail,
    openClawUpdateStatusInfo?.message,
  ]);
  const openClawUpdateLatestLog = openClawUpdateStatusInfo?.logs?.length
    ? openClawUpdateStatusInfo.logs[openClawUpdateStatusInfo.logs.length - 1]
    : '';
  const openClawUpdateActiveDetail = ['checking', 'updating', 'stopping'].includes(openClawUpdateStatusInfo?.status || '')
    ? joinDistinctLines([
      openClawUpdateLatestLog,
      openClawUpdateStatusInfo?.message,
    ])
    : '';
  const updateCheckDetail = joinDistinctLines([
    latestVersionError.detail,
    latestVersionError.message,
  ]);
  const openClawCheckDetail = joinDistinctLines([
    openClawLatestVersionError.detail,
    openClawLatestVersionError.message,
  ]);
  const applyMutualExclusionToVisual = <T extends {
    clickable: boolean;
    muted?: boolean;
  }>(visual: T, blocked: boolean): T => (
    blocked
      ? {
        ...visual,
        clickable: false,
        muted: true,
      }
      : {
        ...visual,
        muted: false,
      }
  );
  const updateProgressVisual = applyMutualExclusionToVisual((() => {
    const baseProgress = updatePhaseVisual.progress;
    const clickableIdle = !isCheckingLatestVersion;

    if (updateStatusInfo?.status === 'checking') {
      return {
        progress: Math.max(baseProgress, 12),
        label: t('settings.about.updateProgressChecking'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'updating') {
      return {
        progress: Math.max(baseProgress, 10),
        label: `${t(updatePhaseVisual.labelKey)}${t('settings.about.updateProgressClickToStopSuffix')}`,
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'stopping') {
      return {
        progress: Math.max(baseProgress, 15),
        label: t('settings.about.updateProgressStopping'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'update_succeeded') {
      return {
        progress: 100,
        label: t('settings.about.updateSucceededButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (updateStatusInfo?.status === 'update_failed') {
      return {
        progress: Math.max(baseProgress, 12),
        label: t('settings.about.updateFailedButton'),
        detail: updateFailureDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    if (updateStatusInfo?.status === 'restarting') {
      return {
        progress: Math.max(baseProgress, 99),
        label: t(updatePhaseVisual.labelKey),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (updateStatusInfo?.status === 'restart_failed') {
      return {
        progress: 100,
        label: t('settings.about.restartFailedButton'),
        detail: updateFailureDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    if (updateStatusInfo?.status === 'has_update' || latestVersionInfo?.status === 'update_available') {
      return {
        progress: 0,
        label: t('settings.about.checkUpdateAvailableButton', {
          version: effectiveLatestVersion || t('settings.about.unavailable'),
        }),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'activity' as const,
      };
    }

    if (isCheckingLatestVersion) {
      return {
        progress: 12,
        label: t('settings.about.updateProgressChecking'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (latestVersionInfo?.status === 'up_to_date') {
      return {
        progress: 100,
        label: t('settings.about.checkUpToDateButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: clickableIdle,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (latestVersionInfo?.status === 'no_release') {
      return {
        progress: 0,
        label: t('settings.about.checkNoReleaseButton'),
        detail: '',
        tone: 'neutral' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: clickableIdle,
        showSpinner: false,
        icon: 'activity' as const,
      };
    }

    if (latestVersionError.message) {
      return {
        progress: 0,
        label: t('settings.about.checkRetryButton'),
        detail: updateCheckDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: clickableIdle,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    return {
      progress: 0,
      label: t('settings.about.checkNewVersion'),
      detail: '',
      tone: 'neutral' as UpdateProgressTone,
      layout: 'compact' as UpdateProgressLayout,
      clickable: clickableIdle,
      showSpinner: false,
      icon: 'activity' as const,
    };
  })(), isAppUpdateBlockedByOpenClaw);
  const openClawUpdateProgressVisual = applyMutualExclusionToVisual((() => {
    if (isStartingOpenClawUpdate) {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 18),
        label: t(openClawPhaseVisual.labelKey),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'checking') {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 18),
        label: openClawUpdateStatusInfo.canCancel
          ? `${t(openClawPhaseVisual.labelKey)}${t('settings.openclawUpdate.progressClickToStopSuffix')}`
          : t(openClawPhaseVisual.labelKey),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: openClawUpdateStatusInfo.canCancel,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'updating') {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 18),
        label: openClawUpdateStatusInfo.canCancel
          ? `${t(openClawPhaseVisual.labelKey)}${t('settings.openclawUpdate.progressClickToStopSuffix')}`
          : t(openClawPhaseVisual.labelKey),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: openClawUpdateStatusInfo.canCancel,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'stopping') {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 24),
        label: t('settings.openclawUpdate.progressStopping'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'update_succeeded') {
      return {
        progress: 100,
        label: t('settings.openclawUpdate.updateSucceededButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (openClawUpdateStatusInfo?.status === 'update_failed') {
      return {
        progress: Math.max(openClawPhaseVisual.progress, 12),
        label: t('settings.openclawUpdate.updateFailedButton'),
        detail: openClawUpdateFailureDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    if (isCheckingOpenClawLatestVersion) {
      return {
        progress: 12,
        label: t('settings.openclawUpdate.progressChecking'),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: false,
        showSpinner: true,
        icon: 'activity' as const,
      };
    }

    if (openClawLatestVersionInfo?.status === 'update_available') {
      return {
        progress: 0,
        label: t('settings.openclawUpdate.checkUpdateAvailableButton', {
          version: openClawEffectiveLatestVersion || t('settings.about.unavailable'),
        }),
        detail: '',
        tone: 'brand' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'activity' as const,
      };
    }

    if (openClawLatestVersionInfo?.status === 'up_to_date') {
      return {
        progress: 100,
        label: t('settings.openclawUpdate.checkUpToDateButton'),
        detail: '',
        tone: 'success' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'success' as const,
      };
    }

    if (openClawLatestVersionError.message) {
      return {
        progress: 0,
        label: t('settings.openclawUpdate.checkRetryButton'),
        detail: openClawCheckDetail,
        tone: 'error' as UpdateProgressTone,
        layout: 'expanded' as UpdateProgressLayout,
        clickable: true,
        showSpinner: false,
        icon: 'error' as const,
      };
    }

    return {
      progress: 0,
      label: t('settings.openclawUpdate.checkNewVersion'),
      detail: '',
      tone: 'neutral' as UpdateProgressTone,
      layout: 'compact' as UpdateProgressLayout,
      clickable: true,
      showSpinner: false,
      icon: 'activity' as const,
    };
  })(), isOpenClawUpdateBlockedByApp);
  const updateProgressTitle = updateProgressVisual.detail || updateFailureDetail || updateCheckDetail || undefined;
  const updateProgressWidthClass = updateProgressVisual.layout === 'expanded'
    ? 'w-full sm:w-[24rem]'
    : 'w-full sm:w-auto';
  const updateProgressButtonWidthClass = updateProgressVisual.layout === 'expanded'
    ? 'w-full sm:min-w-[24rem]'
    : 'w-full sm:w-auto';
  const updateCancelUnsafeDetail = joinDistinctLines([
    updateStatusInfo?.rawDetail,
    updateStatusInfo?.message,
  ]);
  const openClawUpdateCancelUnsafeDetail = joinDistinctLines([
    openClawUpdateStatusInfo?.rawDetail,
    openClawUpdateStatusInfo?.message,
  ]);
  const updateCancelModalTitle = updateStatusInfo?.canCancel
    ? t('settings.about.updateCancelConfirmTitle')
    : t('settings.about.updateCancelUnavailableTitle');
  const updateCancelModalMessage = updateStatusInfo?.canCancel
    ? t('settings.about.updateCancelConfirmMessage')
    : t('settings.about.updateCancelUnavailableMessage');
  const openClawUpdateCancelModalTitle = openClawUpdateStatusInfo?.canCancel
    ? t('settings.openclawUpdate.updateCancelConfirmTitle')
    : t('settings.openclawUpdate.updateCancelUnavailableTitle');
  const openClawUpdateCancelModalMessage = openClawUpdateStatusInfo?.canCancel
    ? t('settings.openclawUpdate.updateCancelConfirmMessage')
    : t('settings.openclawUpdate.updateCancelUnavailableMessage');
  const browserHeadedModeConfirmingEnable = browserHeadedModePendingEnabled === true;
  const browserHeadedModeModalTitle = browserHeadedModeModalStage === 'confirm'
    ? browserHeadedModeConfirmingEnable
      ? t('settings.gateway.browserHeadedModeConfirmEnableTitle')
      : t('settings.gateway.browserHeadedModeConfirmDisableTitle')
    : browserHeadedModeModalStage === 'restarting'
      ? t('settings.gateway.browserHeadedModeRestartingTitle')
      : browserHeadedModeModalStage === 'success'
        ? t('settings.gateway.browserHeadedModeRestartSuccessTitle')
        : browserHeadedModeModalStage === 'failure'
          ? t('settings.gateway.browserHeadedModeRestartFailedTitle')
          : '';
  const browserHeadedModeModalMessage = browserHeadedModeModalStage === 'confirm'
    ? browserHeadedModeConfirmingEnable
      ? t('settings.gateway.browserHeadedModeConfirmEnableMessage')
      : t('settings.gateway.browserHeadedModeConfirmDisableMessage')
    : browserHeadedModeModalStage === 'restarting'
      ? t('settings.gateway.browserHeadedModeRestartingMessage')
      : browserHeadedModeModalStage === 'success'
        ? browserHeadedModeConfirmingEnable
          ? t('settings.gateway.browserHeadedModeRestartSuccessEnableMessage')
          : t('settings.gateway.browserHeadedModeRestartSuccessDisableMessage')
        : browserHeadedModeModalStage === 'failure'
          ? browserHeadedModeConfirmingEnable
            ? t('settings.gateway.browserHeadedModeRestartFailedEnableMessage')
            : t('settings.gateway.browserHeadedModeRestartFailedDisableMessage')
          : '';
  const gatewayRestartModalTitle = gatewayRestartModalStage === 'confirm'
    ? t('settings.gateway.restartGatewayConfirmTitle')
    : gatewayRestartModalStage === 'restarting'
      ? t('settings.gateway.restartGatewayRestartingTitle')
      : gatewayRestartModalStage === 'success'
        ? t('settings.gateway.restartGatewayRestartSuccessTitle')
        : gatewayRestartModalStage === 'failure'
          ? t('settings.gateway.restartGatewayRestartFailedTitle')
          : '';
  const gatewayRestartModalMessage = gatewayRestartModalStage === 'confirm'
    ? t('settings.gateway.restartGatewayConfirmMessage')
    : gatewayRestartModalStage === 'restarting'
      ? t('settings.gateway.restartGatewayRestartingMessage')
      : gatewayRestartModalStage === 'success'
        ? t('settings.gateway.restartGatewayRestartSuccessMessage')
        : gatewayRestartModalStage === 'failure'
          ? t('settings.gateway.restartGatewayRestartFailedMessage')
          : '';
  const canRestartGateway = !isRestarting
    && gatewayRestartModalStage === null
    && browserHeadedModeModalStage !== 'restarting'
    && updateRestartModalStage !== 'restarting';
  const canSaveGateway = !isLoading && !!url.trim();
  const updateRestartModalTitle = updateRestartModalStage === 'confirm'
    ? t('settings.about.restartServiceConfirmTitle')
    : updateRestartModalStage === 'restarting'
      ? t('settings.about.restartServiceRestartingTitle')
      : updateRestartModalStage === 'success'
        ? t('settings.about.restartServiceRestartSuccessTitle')
        : updateRestartModalStage === 'failure'
          ? t('settings.about.restartServiceRestartFailedTitle')
          : '';
  const updateRestartModalMessage = updateRestartModalStage === 'confirm'
    ? t('settings.about.restartServiceConfirmMessage')
    : updateRestartModalStage === 'restarting'
      ? t('settings.about.restartServiceRestartingMessage')
      : updateRestartModalStage === 'success'
        ? t('settings.about.restartServiceRestartSuccessMessage')
        : updateRestartModalStage === 'failure'
          ? t('settings.about.restartServiceRestartFailedMessage')
          : '';
  const resolveProgressToneClasses = (tone: UpdateProgressTone) => (
    tone === 'success'
      ? {
        container: 'border-emerald-200 bg-emerald-50',
        hover: 'hover:bg-emerald-100',
        text: 'text-emerald-700',
        icon: 'text-emerald-600',
        fill: 'bg-emerald-200/90',
        detail: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      }
      : tone === 'error'
        ? {
          container: 'border-red-200 bg-red-50',
          hover: 'hover:bg-red-100',
          text: 'text-red-700',
          icon: 'text-red-600',
          fill: 'bg-red-200/90',
          detail: 'border-red-200 bg-red-50 text-red-700',
        }
        : {
          container: 'border-blue-200 bg-blue-50',
          hover: 'hover:bg-blue-100',
          text: 'text-[#2563eb]',
          icon: 'text-[#2563eb]',
          fill: 'bg-blue-200/90',
          detail: 'border-blue-200 bg-blue-50 text-[#2563eb]',
        }
  );
  const updateProgressToneClasses = resolveProgressToneClasses(updateProgressVisual.tone);
  const openClawUpdateProgressToneClasses = resolveProgressToneClasses(openClawUpdateProgressVisual.tone);
  const openClawUpdateProgressTitle = openClawUpdateProgressVisual.detail || openClawUpdateFailureDetail || openClawUpdateActiveDetail || openClawCheckDetail || undefined;
  const openClawUpdateProgressWidthClass = openClawUpdateProgressVisual.layout === 'expanded'
    ? 'w-full sm:w-[24rem]'
    : 'w-full sm:w-auto';
  const openClawUpdateProgressButtonWidthClass = openClawUpdateProgressVisual.layout === 'expanded'
    ? 'w-full sm:min-w-[24rem]'
    : 'w-full sm:w-auto';
  const secondaryActionButtonClass = 'inline-flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold leading-5 text-[#2563eb] text-center transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60';
  const renderProgressActionButton = (
    visual: {
      progress: number;
      label: string;
      detail: string;
      clickable: boolean;
      muted?: boolean;
      showSpinner: boolean;
      icon: 'activity' | 'success' | 'error';
    },
    toneClasses: {
      container: string;
      hover: string;
      text: string;
      icon: string;
      fill: string;
      detail: string;
    },
    onClick: () => void,
    widthClass: string,
    buttonWidthClass: string,
    title?: string,
  ) => (
    <div className={widthClass}>
      <button
        type="button"
        onClick={onClick}
        disabled={!visual.clickable}
        title={title}
        className={`relative overflow-hidden rounded-xl border text-left transition-colors ${buttonWidthClass} ${toneClasses.container} ${visual.clickable ? toneClasses.hover : 'cursor-default'} ${visual.muted ? 'opacity-60 saturate-50' : !visual.clickable ? 'opacity-90' : ''}`}
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-l-xl transition-[width] duration-500 ease-out ${toneClasses.fill}`}
          style={{ width: `${Math.min(Math.max(visual.progress, 0), 100)}%` }}
        />
        <div className="relative z-10 flex items-center justify-center gap-2 px-4 py-2.5 text-center">
          {visual.showSpinner
            ? <Loader2 className={`h-4 w-4 shrink-0 animate-spin ${toneClasses.icon}`} />
            : visual.icon === 'success'
              ? <Check className={`h-4 w-4 shrink-0 ${toneClasses.icon}`} />
              : visual.icon === 'error'
                ? <X className={`h-4 w-4 shrink-0 ${toneClasses.icon}`} />
                : <Activity className={`h-4 w-4 shrink-0 ${toneClasses.icon}`} />}
          <span className={`truncate whitespace-nowrap text-sm font-semibold leading-5 ${toneClasses.text}`}>
            {visual.label}
          </span>
        </div>
      </button>
      {visual.detail ? (
        <div className={`mt-2 whitespace-pre-wrap rounded-xl border px-4 py-3 text-sm ${toneClasses.detail}`}>
          {visual.detail}
        </div>
      ) : null}
    </div>
  );
  const browserProgressToneClasses = {
    container: 'border-blue-200 bg-blue-50',
    text: 'text-[#2563eb]',
    icon: 'text-[#2563eb]',
    fill: 'bg-blue-200/90',
  };
  const activeBrowserTaskInfo = browserTaskInfo && ['checking', 'repairing'].includes(browserTaskInfo.status)
    ? browserTaskInfo
    : null;
  const activeBrowserTaskPhaseVisual = activeBrowserTaskInfo
    ? (activeBrowserTaskInfo.status === 'repairing'
      ? (BROWSER_REPAIR_PHASE_VISUALS[activeBrowserTaskInfo.phase || 'inspect-current'] || BROWSER_REPAIR_PHASE_VISUALS['inspect-current'])
      : (BROWSER_CHECK_PHASE_VISUALS[activeBrowserTaskInfo.phase || 'read-config'] || BROWSER_CHECK_PHASE_VISUALS['read-config']))
    : null;
  const activeBrowserTaskLabel = activeBrowserTaskPhaseVisual
    ? t(activeBrowserTaskPhaseVisual.labelKey)
    : '';
  const canSelfHealBrowser = browserHealth?.healthy === false
    && !isCheckingBrowserHealth
    && !isSelfHealingBrowser
    && !isLoading
    && !activeBrowserTaskInfo;
  const browserHealthNotCheckedText = t('settings.gateway.browserHealthStates.notChecked');
  const browserHealthValueFallback = browserHealth ? t('common.unknown') : browserHealthNotCheckedText;
  const browserHealthConfig = browserHealth?.config ?? null;
  const browserHealthRuntime = browserHealth?.runtime ?? null;
  const browserHealthFacts = [
    {
      label: t('settings.gateway.browserHealthPermissionsLabel'),
      value: browserHealth?.maxPermissionsEnabled === null || !browserHealth
        ? browserHealthValueFallback
        : browserHealth.maxPermissionsEnabled
          ? t('settings.gateway.browserHealthStates.permissionsEnabled')
          : t('settings.gateway.browserHealthStates.permissionsDisabled'),
    },
    {
      label: t('settings.gateway.browserHealthEnabledLabel'),
      value: browserHealthConfig?.enabled === null || browserHealthConfig?.enabled === undefined || !browserHealth
        ? browserHealthValueFallback
        : browserHealthConfig.enabled
          ? t('settings.gateway.browserHealthStates.enabled')
          : t('settings.gateway.browserHealthStates.disabled'),
    },
    {
      label: t('settings.gateway.browserHealthRunningLabel'),
      value: browserHealthRuntime?.running === null || browserHealthRuntime?.running === undefined || !browserHealth
        ? browserHealthValueFallback
        : browserHealthRuntime.running
          ? t('settings.gateway.browserHealthStates.running')
          : t('settings.gateway.browserHealthStates.stopped'),
    },
    {
      label: t('settings.gateway.browserHealthTransportLabel'),
      value: browserHealthRuntime?.transport || browserHealthValueFallback,
    },
    {
      label: t('settings.gateway.browserHealthModeLabel'),
      value: browserHealthRuntime?.headless === null || browserHealthRuntime?.headless === undefined || !browserHealth
        ? browserHealthValueFallback
        : browserHealthRuntime.headless
          ? t('settings.gateway.browserHealthStates.headless')
          : t('settings.gateway.browserHealthStates.windowed'),
    },
    {
      label: t('settings.gateway.browserHealthBrowserLabel'),
      value: browserHealthRuntime?.detectedBrowser || browserHealthRuntime?.chosenBrowser || browserHealthValueFallback,
    },
    {
      label: t('settings.gateway.browserHealthProfileLabel'),
      value: browserHealthRuntime?.profile || browserHealthConfig?.profile || browserHealth?.profile || browserHealthValueFallback,
    },
  ];
  const browserHealthDetail = activeBrowserTaskInfo?.rawDetail
    || (activeBrowserTaskInfo ? activeBrowserTaskLabel : '')
    || browserHealth?.validationDetail
    || browserHealth?.rawDetail
    || browserHealthRuntime?.detectError
    || browserHealth?.detectError
    || browserHealthError.detail
    || browserHealthError.message
    || '';
  const browserHealthDetailText = browserHealthDetail
    || (browserHealthError.message
      ? t('settings.gateway.browserHealthButtonNeedsAttention')
      : browserHealth
        ? browserHealth.healthy
          ? t('settings.gateway.browserHealthButtonHealthy')
          : t('settings.gateway.browserHealthButtonNeedsAttention')
        : browserHealthNotCheckedText);
  const renderBrowserTaskActionButton = (
    mode: 'checking' | 'repairing',
    onClick: () => void,
    defaultLabel: string,
    defaultIcon: 'activity' | 'wrench',
  ) => {
    const isActive = activeBrowserTaskInfo?.status === mode && activeBrowserTaskPhaseVisual;
    if (!isActive || !activeBrowserTaskPhaseVisual) {
      const disabled = mode === 'repairing'
        ? !canSelfHealBrowser
        : isCheckingBrowserHealth || isSelfHealingBrowser || isLoading || !!activeBrowserTaskInfo;
      return (
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={`${secondaryActionButtonClass} flex-1 min-w-0 ${disabled && mode === 'repairing' ? 'border-gray-200 bg-gray-100 text-gray-400 hover:bg-gray-100' : ''}`}
        >
          {defaultIcon === 'wrench'
            ? <Wrench className="hidden sm:block w-4 h-4 shrink-0" />
            : <Activity className="hidden sm:block w-4 h-4 shrink-0" />}
          <span className="min-w-0 text-center leading-snug">{defaultLabel}</span>
        </button>
      );
    }

    return (
      <button
        type="button"
        disabled
        className={`relative overflow-hidden rounded-xl border text-left transition-colors flex-1 min-w-0 ${browserProgressToneClasses.container} cursor-default opacity-90`}
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-l-xl transition-[width] duration-500 ease-out ${browserProgressToneClasses.fill}`}
          style={{ width: `${Math.min(Math.max(activeBrowserTaskPhaseVisual.progress, 0), 100)}%` }}
        />
        <div className="relative z-10 flex items-center justify-center gap-2 px-4 py-2.5 text-center">
          <Loader2 className={`h-4 w-4 shrink-0 animate-spin ${browserProgressToneClasses.icon}`} />
          <span className={`truncate whitespace-nowrap text-sm font-semibold leading-5 ${browserProgressToneClasses.text}`}>
            {t(activeBrowserTaskPhaseVisual.labelKey)}
          </span>
        </div>
      </button>
    );
  };
  const hostTakeoverMode = hostTakeoverStatus?.mode || 'disabled';
  const hostTakeoverToneClass = hostTakeoverMode === 'ready'
    ? 'border-green-200 bg-green-50 text-green-700'
    : hostTakeoverMode === 'broken'
      ? 'border-red-200 bg-red-50 text-red-700'
      : hostTakeoverMode === 'needs_install'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-gray-200 bg-gray-50 text-gray-600';
  const hostTakeoverPathVisible = !!hostTakeoverStatus?.hostRootPath && (maxPermissions || hostTakeoverMode !== 'disabled');
  const hostTakeoverManualInstallVisible = !!hostTakeoverStatus?.manualInstallCommand
    && hostTakeoverMode !== 'ready'
    && hostTakeoverMode !== 'disabled'
    && hostTakeoverStatus?.autoInstallSupported === false;
  const latestDevicePairing = devicePairingStatus?.latestPending ?? null;
  const devicePairingPairedCount = devicePairingStatus?.pairedCount ?? null;
  const devicePairingMode = !hasLoadedMaxPermissionsState
    ? 'loading'
    : latestDevicePairing
      ? 'pending'
      : devicePairingPairedCount === null
        ? 'unavailable'
        : devicePairingPairedCount > 0
          ? 'paired'
          : 'idle';
  const devicePairingToneClass = devicePairingMode === 'pending'
    ? 'border-amber-200 bg-amber-50 text-amber-700'
    : devicePairingMode === 'paired'
      ? 'border-green-200 bg-green-50 text-green-700'
      : devicePairingMode === 'unavailable'
        ? 'border-red-200 bg-red-50 text-red-700'
        : 'border-gray-200 bg-gray-50 text-gray-600';
  const latestDevicePairingRoleText = latestDevicePairing
    ? (latestDevicePairing.role
      || latestDevicePairing.roles.join(', ')
      || t('common.unknown'))
    : '';
  const latestDevicePairingScopeText = latestDevicePairing?.scopes.join(', ') || '';
  const headerTitle = settingsTab === 'gateway'
    ? t('settings.gateway.headerTitle')
    : settingsTab === 'general'
      ? t('settings.general.headerTitle')
      : settingsTab === 'presets'
        ? t('settings.presets.headerTitle')
      : settingsTab === 'commands'
        ? t('settings.commands.headerTitle')
        : settingsTab === 'models'
          ? t('settings.models.headerTitle')
          : t('settings.about.headerTitle');

  return (
    <div className="flex flex-col h-full bg-gray-50/50">
      <header className="h-14 flex items-center px-4 sm:px-8 border-b border-gray-200 bg-white sticky top-0 z-10 gap-3">
        <button 
          className="md:hidden text-gray-500 hover:text-gray-900 focus:outline-none pr-1"
          onClick={onMenuClick}
        >
          <Menu className="w-6 h-6" />
        </button>
        <h2 className="text-xl font-bold text-gray-900">{headerTitle}</h2>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:p-8">
        <div className="max-w-2xl mx-auto space-y-6 sm:space-y-8">

          {/* Gateway Settings Tab */}
          {settingsTab === 'gateway' && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex min-w-0 items-baseline gap-3">
                    <h3 className="text-lg font-semibold text-gray-900">
                      {t('settings.gateway.connectionTitle')}
                    </h3>
                    {openClawCurrentVersion && (
                      <span className="text-sm font-normal text-gray-500">
                        {t('settings.gateway.versionInline', { version: openClawCurrentVersion })}
                      </span>
                    )}
                  </div>
                  <div className="flex min-w-0 justify-end">
                    <button
                      type="button"
                      onClick={() => { void detectGatewayConfig(); }}
                      disabled={isDetectingAll || isLoading}
                      className={`${secondaryActionButtonClass} shrink-0`}
                    >
                      {isDetectingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                      {t('settings.gateway.autoDetect')}
                    </button>
                  </div>
                </div>
                <p className="text-sm text-gray-500 mb-6 mt-1">{t('settings.gateway.description')}</p>
                {detectError ? (
                  <p className="mb-4 text-sm text-red-600">{detectError}</p>
                ) : null}
                
                <div className="space-y-5 sm:space-y-6 bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      {t('settings.gateway.gatewayUrlLabel')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="ws://127.0.0.1:18789"
                      className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.gateway.tokenLabel')}</label>
                    <input
                      type="text"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder={hasToken ? t('settings.gateway.secretConfigured') : ''}
                      className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                    />
                    {hasToken && <p className="text-xs text-gray-400 mt-1.5">{t('settings.gateway.secretKeepHint')}</p>}
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.gateway.passwordLabel')}</label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        placeholder={hasPassword ? t('settings.gateway.secretConfigured') : ''}
                        onChange={(e) => setPassword(e.target.value)}
                        className="block w-full px-4 py-2.5 pr-12 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* 外接 Agent 凭据 */}
                <div className="mt-8">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.runtimeAuth.title')}</h3>
                  <p className="text-sm text-gray-500 mb-4">{t('settings.runtimeAuth.description')}</p>

                  <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-1">
                    {runtimeAuthLoading && runtimeAuth.length === 0 && (
                      <div className="text-xs text-gray-400">{t('settings.runtimeAuth.loading')}</div>
                    )}
                    {runtimeAuth.filter((row) => row.state !== 'notRequired').map((row) => (
                      <div key={row.runtimeId} className="py-3 border-b border-gray-50 last:border-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                            row.state === 'configured' ? 'bg-emerald-500'
                              : row.state === 'unreadable' ? 'bg-red-400' : 'bg-gray-300'
                          }`} />
                          <span className="text-sm font-semibold text-gray-900">
                            {t(`sidebar.agentRuntime.${row.runtimeId}`, { defaultValue: row.runtimeId })}
                          </span>
                          {row.envKey && <code className="text-[11px] text-gray-400">{row.envKey}</code>}
                        </div>

                        <div className="text-xs text-gray-500 mt-1">
                          {row.state === 'configured' ? t('settings.runtimeAuth.stateConfigured')
                            : row.state === 'unreadable' ? t('settings.runtimeAuth.stateUnreadable')
                              : row.webConfigurable ? t('settings.runtimeAuth.stateUnknown')
                                : t('settings.runtimeAuth.stateHostOnly')}
                        </div>

                        {row.webConfigurable && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                              type="password"
                              autoComplete="off"
                              value={keyDraft[row.runtimeId] ?? ''}
                              onChange={(e) => setKeyDraft((prev) => ({ ...prev, [row.runtimeId]: e.target.value }))}
                              placeholder={row.state === 'configured'
                                ? t('settings.runtimeAuth.placeholderReplace')
                                : t('settings.runtimeAuth.placeholderNew')}
                              className="flex-1 min-w-[200px] px-3 py-1.5 text-xs rounded-lg border border-gray-200 focus:border-indigo-400 focus:outline-none"
                            />
                            <button
                              onClick={() => submitRuntimeKey(row.runtimeId, keyDraft[row.runtimeId] ?? '')}
                              disabled={keySaving === row.runtimeId || !(keyDraft[row.runtimeId] ?? '').trim()}
                              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              {keySaving === row.runtimeId ? t('settings.runtimeAuth.saving') : t('settings.runtimeAuth.save')}
                            </button>
                            {row.state === 'configured' && (
                              <button
                                onClick={() => submitRuntimeKey(row.runtimeId, null)}
                                disabled={keySaving === row.runtimeId}
                                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition-colors"
                              >
                                {t('settings.runtimeAuth.clear')}
                              </button>
                            )}
                          </div>
                        )}
                        {keyError[row.runtimeId] && (
                          <div className="text-xs text-red-500 mt-1.5">{keyError[row.runtimeId]}</div>
                        )}
                      </div>
                    ))}
                    <p className="text-xs text-gray-400 pt-3 leading-relaxed">{t('settings.runtimeAuth.hint')}</p>
                  </div>
                </div>

                {/* Max Permissions Toggle */}
                <div className="mt-8">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.gateway.permissionsTitle')}</h3>
                  <p className="text-sm text-gray-500 mb-4">{t('settings.gateway.permissionsDescription')}</p>

                  <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 pr-4">
                        <div className="text-sm font-semibold text-gray-900">{t('settings.gateway.maxPermissionsLabel')}</div>
                        <p className="text-xs text-gray-400 mt-1">
                          {t('settings.gateway.maxPermissionsHint')}
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={maxPermissions}
                        disabled={isTogglingPermissions}
                        onClick={handleToggleMaxPermissions}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed ${ maxPermissions ? 'bg-blue-600' : 'bg-gray-200' }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${ maxPermissions ? 'translate-x-6' : 'translate-x-1' }`}
                        />
                      </button>
                    </div>
                    {gatewayRestartNoticeSource === 'permissions' && (
                      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                        {t('settings.gateway.restartRequiredNotice')}
                      </div>
                    )}

                    <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${hostTakeoverToneClass}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-gray-900">{t('settings.gateway.hostTakeoverStatusLabel')}</span>
                        <span className="rounded-full border border-current/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide">
                          {t(`settings.gateway.hostTakeoverModes.${hostTakeoverMode}`)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-current">
                        {t(`settings.gateway.hostTakeoverDescriptions.${hostTakeoverMode}`)}
                      </p>
                      {hostTakeoverStatus?.currentUser && (
                        <p className="mt-3 text-xs text-gray-600">
                          <span className="font-semibold text-gray-700">{t('settings.gateway.hostTakeoverCurrentUserLabel')}:</span>{' '}
                          <span className="font-mono">{hostTakeoverStatus.currentUser}</span>
                        </p>
                      )}
                      {hostTakeoverPathVisible && (
                        <div className="mt-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            {t('settings.gateway.hostTakeoverEntryPointLabel')}
                          </div>
                          <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 font-mono text-xs text-gray-700 break-all">
                            {hostTakeoverStatus?.hostRootPath}
                          </div>
                        </div>
                      )}
                      {hostTakeoverStatus?.rawDetail && (
                        <div className="mt-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            {t('settings.gateway.hostTakeoverDetailLabel')}
                          </div>
                          <div className="mt-1 rounded-xl border border-current/10 bg-white/70 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
                            {hostTakeoverStatus.rawDetail}
                          </div>
                        </div>
                      )}
                      {hostTakeoverManualInstallVisible && (
                        <div className="mt-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            {t('settings.gateway.hostTakeoverManualInstallLabel')}
                          </div>
                          <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 font-mono text-xs text-gray-700 break-all whitespace-pre-wrap">
                            {hostTakeoverStatus?.manualInstallCommand}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${devicePairingToneClass}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-gray-900">{t('settings.gateway.devicePairingStatusLabel')}</span>
                        <span className="rounded-full border border-current/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide">
                          {t(`settings.gateway.devicePairingModes.${devicePairingMode}`)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-current">
                        {devicePairingMode === 'loading'
                          ? t('settings.gateway.devicePairingDescriptions.loading')
                          : devicePairingMode === 'pending'
                          ? t('settings.gateway.devicePairingDescriptions.pending', { count: devicePairingStatus?.pending.length || 0 })
                          : devicePairingMode === 'paired'
                            ? t('settings.gateway.devicePairingDescriptions.paired', { count: devicePairingStatus?.pairedCount || 0 })
                            : devicePairingMode === 'unavailable'
                              ? t('settings.gateway.devicePairingDescriptions.unavailable')
                              : t('settings.gateway.devicePairingDescriptions.idle')}
                      </p>
                      {latestDevicePairing && (
                        <>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                                {t('settings.gateway.devicePairingRequestLabel')}
                              </div>
                              <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 font-mono text-xs text-gray-700 break-all">
                                {latestDevicePairing.requestId}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                                {t('settings.gateway.devicePairingDeviceLabel')}
                              </div>
                              <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-xs text-gray-700 break-all">
                                {latestDevicePairing.displayName || latestDevicePairing.deviceId || t('common.unknown')}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                                {t('settings.gateway.devicePairingRoleLabel')}
                              </div>
                              <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-xs text-gray-700 break-all">
                                {latestDevicePairingRoleText}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                                {t('settings.gateway.devicePairingScopeLabel')}
                              </div>
                              <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-xs text-gray-700 break-all whitespace-pre-wrap">
                                {latestDevicePairingScopeText || t('common.unknown')}
                              </div>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              onClick={handleApproveLatestDevicePairing}
                              disabled={isApprovingDevicePairing || isTogglingPermissions || isSubmittingPermissionsPassword}
                              className={secondaryActionButtonClass}
                            >
                              {isApprovingDevicePairing
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : <Link2 className="w-4 h-4" />}
                              {isApprovingDevicePairing
                                ? t('settings.gateway.devicePairingApprovingLatest')
                                : t('settings.gateway.devicePairingApproveLatest')}
                            </button>
                            {latestDevicePairing.remoteIp && (
                              <span className="text-xs text-gray-600">
                                {t('settings.gateway.devicePairingIpLabel')}: {latestDevicePairing.remoteIp}
                              </span>
                            )}
                          </div>
                        </>
                      )}
                      {devicePairingStatus?.rawDetail && (
                        <div className="mt-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            {t('settings.gateway.devicePairingDetailLabel')}
                          </div>
                          <div className="mt-1 rounded-xl border border-current/10 bg-white/70 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
                            {devicePairingStatus.rawDetail}
                          </div>
                        </div>
                      )}
                    </div>

                    {permissionsNotice && (
                      <div className={`mt-4 rounded-xl border px-3 py-2 text-sm ${permissionsNotice.tone === 'success' ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                        {permissionsNotice.message}
                      </div>
                    )}

                    {permissionsError.message && (
                      <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-3 py-3 text-sm text-red-600 flex items-start gap-2">
                        <X className="w-4 h-4 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div>{permissionsError.message}</div>
                          {permissionsError.detail && (
                            <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                              {permissionsError.detail}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-8">
                  <div className="mb-1 flex items-center justify-between gap-4">
                    <h3 className="text-lg font-semibold text-gray-900">{t('settings.gateway.browserHealthTitle')}</h3>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-sm font-medium text-gray-600 whitespace-nowrap">
                        {t('settings.gateway.browserHeadedModeLabel')}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={browserHeadedModeEnabled === true}
                        aria-label={t('settings.gateway.browserHeadedModeLabel')}
                        disabled={isLoadingBrowserHeadedMode || isTogglingBrowserHeadedMode || isLoading || browserHeadedModeModalStage !== null || gatewayRestartModalStage === 'restarting' || updateRestartModalStage === 'restarting'}
                        onClick={handleToggleBrowserHeadedMode}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60 ${browserHeadedModeEnabled ? 'bg-blue-600' : 'bg-gray-200'}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${browserHeadedModeEnabled ? 'translate-x-6' : 'translate-x-1'}`}
                        />
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-gray-500 mb-4">{t('settings.gateway.browserHealthDescription')}</p>

                  <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
                    <div className="space-y-3">
                      <div className="flex gap-2 flex-nowrap">
                        {renderBrowserTaskActionButton(
                          'checking',
                          handleCheckBrowserHealth,
                          t('settings.gateway.checkBrowserHealth'),
                          'activity',
                        )}
                        {renderBrowserTaskActionButton(
                          'repairing',
                          handleSelfHealBrowser,
                          t('settings.gateway.selfHealBrowser'),
                          'wrench',
                        )}
                      </div>

                      <p className="text-sm text-gray-500 whitespace-pre-wrap break-all">
                        <span className="font-medium text-gray-600">{t('settings.gateway.browserHealthDetailLabel')}:</span>{' '}
                        <span>{browserHealthDetailText}</span>
                      </p>
                    </div>

                    {browserHealthNotice && (
                      <div className={`p-3 rounded-xl border text-sm ${browserHealthNotice.tone === 'success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                        {browserHealthNotice.message}
                      </div>
                    )}

                    {gatewayRestartNoticeSource === 'browser' && (
                      <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-700">
                        {t('settings.gateway.restartRequiredNotice')}
                      </div>
                    )}

                    {browserHealthError.message && (
                      <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                        <X className="w-4 h-4 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div>{browserHealthError.message}</div>
                          {browserHealthError.detail && (
                            <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                              {browserHealthError.detail}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {browserHealthFacts.map((item) => (
                        <div key={item.label} className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">{item.label}</div>
                          <div className="mt-1 text-sm text-gray-700 break-all">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Domain Management Section */}
                <div className="mt-8">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.gateway.domainManagementTitle')}</h3>
                  <p className="text-sm text-gray-500 mb-4">{t('settings.gateway.domainManagementDescription')}</p>
                  
                  <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
                    <div className="flex flex-row gap-3">
                      <input
                        type="text"
                        value={newHost}
                        onChange={(e) => setNewHost(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddHost()}
                        placeholder={t('settings.gateway.hostPlaceholder')}
                        className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
                      />
                      <button
                        onClick={handleAddHost}
                        disabled={!newHost.trim()}
                        className="px-6 py-2.5 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center gap-2"
                      >
                        <Plus className="w-4 h-4" />
                        <span className="hidden sm:inline">{t('common.add')}</span>
                      </button>
                    </div>

                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                       {allowedHosts.map(host => (
                         <div key={host} className="flex w-full items-center justify-between gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100 group">
                           {editingHost === host ? (
                             <>
                               <input
                                 type="text"
                                 value={editHostValue}
                                 onChange={(e) => setEditHostValue(e.target.value)}
                                 onKeyDown={(e) => e.key === 'Enter' && handleUpdateHost()}
                                 autoFocus
                                 className="min-w-0 flex-1 w-full text-sm font-mono text-gray-700 bg-transparent outline-none border-none p-0"
                               />
                               <div className="flex items-center gap-1 shrink-0">
                                 <button
                                   onClick={handleUpdateHost}
                                   disabled={!editHostValue.trim()}
                                   className="p-1 px-2 text-green-600 hover:bg-green-50 rounded-lg transition-all disabled:opacity-50"
                                   title={t('common.save')}
                                 >
                                   <Check className="w-4 h-4" />
                                 </button>
                                 <button
                                   onClick={() => { setEditingHost(null); setEditHostValue(''); }}
                                   className="p-1 px-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                   title={t('common.cancel')}
                                 >
                                   <X className="w-4 h-4" />
                                 </button>
                               </div>
                             </>
                           ) : (
                             <>
                               <span className="min-w-0 flex-1 text-sm font-mono text-gray-700 break-all">{host}</span>
                               <div className="flex items-center gap-1 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 transition-all">
                                 <button
                                   onClick={() => startEditHost(host)}
                                   className="p-1 px-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-all"
                                   title={t('common.edit')}
                                 >
                                   <Edit2 className="w-4 h-4" />
                                 </button>
                                 <button
                                   onClick={() => handleRemoveHost(host)}
                                   className="p-1 px-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                   title={t('common.delete')}
                                 >
                                   <Trash2 className="w-4 h-4" />
                                 </button>
                               </div>
                             </>
                           )}
                         </div>
                       ))}
                       {allowedHosts.length === 0 && (
                         <div className="text-center py-6 text-gray-400 text-sm italic">
                           {t('settings.gateway.noHosts')}
                         </div>
                       )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-row items-center justify-between pt-4 gap-2 sm:gap-0">
                  <button
                    onClick={handleTest}
                    disabled={isLoading}
                    className="inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 border border-gray-200 text-sm font-medium rounded-xl text-gray-700 bg-white hover:bg-gray-50 transition-all disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {testResult?.success ? <Check className="w-4 h-4 text-green-600" /> : testResult && !testResult.success ? <X className="w-4 h-4 text-red-500" /> : null}
                    <span className={testResult?.success ? 'text-green-600 font-semibold' : testResult && !testResult.success ? 'text-red-500 font-semibold' : ''}>
                      {isLoading ? '' : testResult?.success ? t('settings.gateway.connectionSuccess') : testResult && !testResult.success ? (testResult.message || t('settings.gateway.connectionFailed')) : <><span className="sm:hidden">{t('common.test')}</span><span className="hidden sm:inline">{t('settings.gateway.testConnection')}</span></>}
                    </span>
                  </button>

                <div className="flex gap-2 sm:gap-3 items-center">
                  <button
                    onClick={handleRestartGateway}
                    disabled={!canRestartGateway}
                    className={`inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 text-sm font-medium rounded-xl transition-all ${ canRestartGateway ? 'text-orange-600 bg-orange-50 hover:bg-orange-100 border border-orange-200' : 'text-gray-400 bg-gray-100 border border-gray-200 cursor-not-allowed' }`}
                  >
                    {isRestarting ? <Loader2 className="w-4 h-4 animate-spin sm:block hidden" /> : <Loader2 className="w-4 h-4 sm:block hidden" />}
                    {restartSuccess ? t('settings.gateway.restarted') : <><span className="sm:hidden">{t('common.restart')}</span><span className="hidden sm:inline">{t('settings.gateway.restartGateway')}</span></>}
                  </button>

                  <div className="h-6 w-px bg-gray-200 hidden sm:block"></div>
                  {gatewayError && (
                    <span className="text-sm font-semibold text-red-500 animate-in fade-in zoom-in-95 duration-200 flex items-center gap-1">
                      <X className="w-4 h-4" /> {t('settings.gateway.saveError')}
                    </span>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={!canSaveGateway}
                    className={`inline-flex items-center gap-2 px-5 sm:px-8 py-2.5 text-sm font-medium rounded-xl text-white transition-all ${ !canSaveGateway ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700' }`}
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : gatewaySaved ? <><Check className="w-4 h-4" /> {t('settings.gateway.saved')}</> : <><span className="sm:hidden">{t('common.save')}</span><span className="hidden sm:inline">{t('settings.gateway.save')}</span></>}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* General Settings Tab */}
          {settingsTab === 'general' && (
            <>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.general.title')}</h3>
                <p className="text-sm text-gray-500 mb-6">{t('settings.general.description')}</p>

                <div className="space-y-6 bg-white p-6 rounded-2xl border border-gray-200">
                  {/* AI Name */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-2">
                      {t('settings.general.aiNameLabel')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={aiName}
                      onChange={(e) => {
                        setAiName(e.target.value);
                        if (aiNameError) setAiNameError('');
                      }}
                      placeholder={t('settings.general.aiNamePlaceholder')}
                      className={`block w-full px-4 py-2.5 rounded-xl border ${aiNameError ? 'border-red-500' : 'border-gray-200'} bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 ${aiNameError ? 'focus:ring-red-500/20' : 'focus:ring-blue-500/20'} transition-all text-sm`}
                    />
                    {aiNameError ? (
                      <p className="text-xs text-red-500 mt-1.5 font-medium">
                        {aiNameError === 'required' ? t('settings.general.aiNameRequired') : t('settings.general.aiNameTooLong')}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.aiNameHint')}</p>
                    )}
                  </div>

                  {/* Language */}
                  <div className="border-t border-gray-100 pt-6">
                    <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.languageLabel')}</label>
                    <div className="relative">
                      <select
                        value={currentLanguage}
                        onChange={handleLanguageChange}
                        className="block w-full appearance-none px-4 pr-14 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      >
                        <option value="zh-CN">{t('settings.general.languageOptions.zh-CN')}</option>
                        <option value="zh-TW">{t('settings.general.languageOptions.zh-TW')}</option>
                        <option value="en">{t('settings.general.languageOptions.en')}</option>
                      </select>
                      <span className="pointer-events-none absolute inset-y-0 right-5 flex items-center text-gray-500">
                        <ChevronDown className="w-4 h-4" />
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.languageHint')}</p>
                  </div>

                  <div className="border-t border-gray-100 pt-6">
                    <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.historyPageRoundsLabel')}</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={historyPageRoundsInput}
                      onChange={handleHistoryPageRoundsChange}
                      onBlur={commitHistoryPageRounds}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitHistoryPageRounds();
                          (event.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      placeholder={t('settings.general.historyPageRoundsPlaceholder')}
                      className="block w-full max-w-[220px] px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                    />
                    <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.historyPageRoundsHint')}</p>
                  </div>

                  <div className="border-t border-gray-100 pt-6">
                    <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.previewTimeoutLabel')}</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={previewTimeoutSecondsInput}
                      onChange={(event) => {
                        setPreviewTimeoutSecondsInput(event.target.value);
                        if (previewTimeoutError) {
                          setPreviewTimeoutError(false);
                        }
                      }}
                      onBlur={() => {
                        const parsed = parsePreviewTimeoutSecondsInput(previewTimeoutSecondsInput);
                        if (parsed !== null) {
                          setPreviewTimeoutSecondsInput(String(parsed));
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          const parsed = parsePreviewTimeoutSecondsInput(previewTimeoutSecondsInput);
                          if (parsed !== null) {
                            setPreviewTimeoutSecondsInput(String(parsed));
                          }
                          (event.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      placeholder={t('settings.general.previewTimeoutPlaceholder')}
                      className={`block w-full max-w-[220px] px-4 py-2.5 rounded-xl border ${previewTimeoutError ? 'border-red-500' : 'border-gray-200'} bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 ${previewTimeoutError ? 'focus:ring-red-500/20' : 'focus:ring-blue-500/20'} transition-all text-sm`}
                    />
                    {previewTimeoutError ? (
                      <p className="text-xs text-red-500 mt-1.5 font-medium">
                        {t('settings.general.previewTimeoutInvalid', {
                          min: PREVIEW_TIMEOUT_MIN_SECONDS,
                          max: PREVIEW_TIMEOUT_MAX_SECONDS,
                        })}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-400 mt-1.5">
                        {t('settings.general.previewTimeoutHint', {
                          min: PREVIEW_TIMEOUT_MIN_SECONDS,
                          max: PREVIEW_TIMEOUT_MAX_SECONDS,
                        })}
                      </p>
                    )}
                  </div>

                  {/* Login Password Toggle */}
                  <div className="border-t border-gray-100 pt-6">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <label className="block text-sm font-semibold text-gray-900">{t('settings.general.loginProtectionLabel')}</label>
                        <p className="text-xs text-gray-400 mt-0.5">{t('settings.general.loginProtectionHint')}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setLoginEnabled(!loginEnabled)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${ loginEnabled ? 'bg-blue-600' : 'bg-gray-300' }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${ loginEnabled ? 'translate-x-6' : 'translate-x-1' }`}
                        />
                      </button>
                    </div>

                    {loginEnabled && (
                      <div className="mt-3 animate-in slide-in-from-top-2 duration-200">
                        <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.loginPasswordLabel')}</label>
                        <div className="relative">
                          <input
                            type={showLoginPassword ? "text" : "password"}
                            value={loginPassword}
                            onChange={(e) => setLoginPassword(e.target.value)}
                            placeholder={hasLoginPassword ? t('settings.gateway.secretConfigured') : t('settings.general.loginPasswordPlaceholder')}
                            className="block w-full px-4 py-2.5 pr-12 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => setShowLoginPassword(!showLoginPassword)}
                            className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                          >
                            {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <p className="text-xs text-gray-400 mt-1.5">
                          {hasLoginPassword ? t('settings.gateway.secretKeepHint') : t('settings.general.loginPasswordHint')}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-center sm:justify-end pt-4">
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  {generalError && (
                    <span className="text-sm font-semibold text-red-500 animate-in fade-in zoom-in-95 duration-200 flex items-center gap-1">
                      <X className="w-4 h-4" /> {t('settings.general.saveError')}
                    </span>
                  )}
                  <button
                    onClick={handleSaveGeneral}
                    disabled={isLoading}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 transition-all disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : generalSaved ? <><Check className="w-4 h-4" /> {t('settings.general.saved')}</> : t('settings.general.save')}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Preset Library Tab */}
          {settingsTab === 'presets' && (
            <PresetLibrary onAgentsChanged={onAgentsChanged} />
          )}

          {/* Quick Commands Management Tab */}
          {settingsTab === 'commands' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.commands.title')}</h3>
                <p className="text-sm text-gray-500 mb-6">{t('settings.commands.description')}</p>

                {/* Add/Edit Form */}
                <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 mb-6">
                  <div className="flex flex-col sm:flex-row gap-4 items-end">
                    <div className="flex-1 w-full">
                      <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.commands.commandLabel')}</label>
                      <input
                        type="text"
                        value={newCommand}
                        onChange={(e) => setNewCommand(e.target.value)}
                        placeholder="/models"
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
                      />
                    </div>
                    <div className="flex-[2] w-full">
                      <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.commands.descriptionLabel')}</label>
                      <input
                        type="text"
                        value={newDescription}
                        onChange={(e) => setNewDescription(e.target.value)}
                        placeholder={t('settings.commands.descriptionPlaceholder')}
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      />
                    </div>
                    <div className="flex w-full sm:w-auto gap-2">
                      <button
                        onClick={editingId ? handleUpdateCommand : handleAddCommand}
                        disabled={isLoading || !newCommand || !newDescription}
                        className="h-[42px] px-6 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 flex-1 sm:flex-none flex items-center justify-center gap-2"
                      >
                        {editingId ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                        {editingId ? t('settings.commands.save') : t('settings.commands.addNew')}
                      </button>
                      {editingId && (
                        <button
                          onClick={() => { setEditingId(null); setNewCommand(''); setNewDescription(''); }}
                          className="h-[42px] px-4 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50 transition-all font-bold text-sm flex-1 sm:flex-none"
                        >
                          {t('common.cancel')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Commands List */}
                <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[500px]">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest w-1/3">{t('settings.commands.tableCommand')}</th>
                        <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">{t('settings.commands.tableDescription')}</th>
                        <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right w-24">{t('settings.commands.tableActions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {commands.map((cmd) => (
                        <tr key={cmd.id} className="hover:bg-gray-50/50 transition-colors">
                          <td className="px-6 py-4 text-sm font-mono font-bold text-blue-600">{cmd.command}</td>
                          <td className="px-6 py-4 text-sm text-gray-600">{cmd.description}</td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button 
                                onClick={() => startEdit(cmd)}
                                className="p-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-all"
                                title={t('common.edit')}
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button 
                                onClick={() => handleDeleteCommand(cmd.id)}
                                className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                title={t('common.delete')}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {commands.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-6 py-12 text-center text-gray-400 text-sm italic">
                            {t('settings.commands.empty')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Model Management Tab */}
          {settingsTab === 'models' && (
            <div className="space-y-6">
              {/* Header */}
              <div className="flex justify-between items-start sm:items-center">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.models.title')}</h3>
                  <p className="text-sm text-gray-500">{t('settings.models.description')}</p>
                </div>
                <button
                  onClick={openAddEndpointModal}
                  className="h-[40px] px-5 rounded-xl bg-blue-600 text-white font-medium text-sm hover:bg-blue-700 transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  {t('settings.models.addEndpoint')}
                </button>
              </div>

              {modelActionError.message && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                  <X className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div>{modelActionError.message}</div>
                    {modelActionError.detail && (
                      <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {modelActionError.detail}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {modelError && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-center gap-2">
                  <X className="w-4 h-4 shrink-0" />
                  {modelError}
                </div>
              )}

              {/* Unified Endpoint + Model List */}
              <div className="space-y-3">
                {knownEndpoints.length === 0 ? (
                  <div className="bg-white rounded-2xl border border-gray-200 px-4 py-12 text-center text-gray-400 text-sm">
                    {t('settings.models.emptyEndpoints')}
                  </div>
                ) : (
                  knownEndpoints.map(epName => {
                    const epModels = models.filter(m => m.id.startsWith(`${epName}/`)).sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
                    const epConfig = endpoints.find(e => e.id === epName) || { id: epName, baseUrl: '', apiKey: '', api: 'openai-completions' };
                    const displayApi = epConfig.api === 'openai-completions' ? 'OpenAI' : 
                                       epConfig.api === 'anthropic-messages' ? 'Anthropic' :
                                       epConfig.api === 'google-genai' ? 'Gemini' : 
                                       epConfig.api === 'ollama' ? 'Ollama' : epConfig.api;
                    const isExpanded = expandedEndpoints.has(epName);

                    return (
                      <div key={epName} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                        {/* Endpoint Header Row */}
                        <div
                          className="flex items-center gap-3 px-4 py-4 cursor-pointer hover:bg-gray-50/80 transition-colors select-none group"
                          onClick={() => toggleEndpointExpanded(epName)}
                        >
                          <ChevronDown className={`w-6 h-6 text-gray-400 transition-transform duration-200 shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2.5 mb-0.5">
                              <span className="font-semibold text-gray-900 text-base">{epName}</span>
                              <span className="px-2 py-0.5 rounded-md bg-gray-100/80 border border-gray-200 text-gray-500 text-xs font-mono">
                                {displayApi}
                              </span>
                              <span className="hidden sm:inline text-xs text-gray-400">{t('settings.models.modelCount', { count: epModels.length })}</span>
                            </div>
                            <div className="text-sm text-gray-400 truncate">{epConfig.baseUrl || '-'}</div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => {
                                setNewModelEndpoint(epName);
                                setNewModelName('');
                                setNewModelAlias('');
                                setAddModelTestStatus('idle');
                                setTestModelMessage('');
                                setDiscoveredModels([]);
                                setModelSearchQuery('');
                                setIndividualTestStatus({});
                                setShowOnlyConnected(false);
                                setModelError('');
                                setAddModelError('');
                                setAddModelErrorDetail('');
                                setIsAddModelModalOpen(true);
                              }}
                              className="flex items-center gap-1 px-2 py-1.5 text-sm text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-all"
                              title={t('settings.models.addModel')}
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span className="hidden sm:inline">{t('settings.models.addModel')}</span>
                            </button>
                            <button
                              onClick={() => openEditEndpointModal(epConfig)}
                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                              title={t('settings.models.editEndpoint')}
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteEndpoint(epName, epModels.length)}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                              title={t('settings.models.deleteEntireEndpoint')}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        {/* Expanded Models Section */}
                        {isExpanded && (
                          <div className="border-t border-gray-100">
                            {epModels.length === 0 ? (
                              <div className="px-6 py-6 text-center text-gray-400 text-sm">
                                {t('settings.models.noModelsPrefix')}
                                <button
                                  onClick={() => {
                                    setNewModelEndpoint(epName);
                                    setNewModelName('');
                                    setNewModelAlias('');
                                    setAddModelTestStatus('idle');
                                    setTestModelMessage('');
                                    setDiscoveredModels([]);
                                    setModelSearchQuery('');
                                    setIndividualTestStatus({});
                                    setShowOnlyConnected(false);
                                    setModelError('');
                                    setAddModelError('');
                                    setAddModelErrorDetail('');
                                    setIsAddModelModalOpen(true);
                                  }}
                                  className="text-blue-600 hover:text-blue-700 font-medium hover:underline"
                                >
                                  {t('settings.models.clickToAdd')}
                                </button>
                              </div>
                            ) : (
                              <table className="w-full text-left border-collapse">
                                <thead>
                                  <tr className="bg-gray-50/80 border-b border-gray-100">
                                    <th className="px-6 py-2.5 font-medium text-gray-500 whitespace-nowrap text-xs">{t('settings.models.tableModelId')}</th>
                                    <th className="px-4 py-2.5 font-medium text-gray-500 whitespace-nowrap text-xs">{t('settings.models.tableAlias')}</th>
                                    <th className="px-4 py-2.5 font-medium text-gray-500 whitespace-nowrap w-20 text-xs">{t('settings.models.tableStatus')}</th>
                                    <th className="px-4 py-2.5 font-medium text-gray-500 whitespace-nowrap text-right w-28 text-xs">{t('settings.models.tableActions')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {epModels.map((model, idx) => {
                                    const modelName = model.id.substring(epName.length + 1);
                                    return (
                                      <Fragment key={model.id}>
                                      <tr className={`transition-colors text-sm ${editingModelId === model.id ? 'bg-blue-50/30' : 'group'}`}>
                                        <td className="px-6 py-3 text-gray-700">
                                          <div className="text-[13px]">{modelName}</div>
                                        </td>
                                        <td className="px-4 py-3 text-gray-600 text-[13px]">
                                          {editingModelId === model.id ? (
                                            <input
                                              ref={editAliasInputRef}
                                              type="text"
                                              value={editingAlias}
                                              onChange={(e) => setEditingAlias(e.target.value)}
                                              onKeyDown={(e) => {
                                                if (e.key === 'Enter') handleSaveModelAlias();
                                                if (e.key === 'Escape') cancelEditModel();
                                              }}
                                              placeholder={t('settings.models.aliasPlaceholder')}
                                              className="w-full px-2 py-1 text-[13px] border border-blue-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                                            />
                                          ) : (
                                            model.alias || <span className="text-gray-300">-</span>
                                          )}
                                        </td>
                                        <td className="px-4 py-3">
                                          <div className="flex items-center gap-2">
                                            {(() => {
                                              const testData = existingModelTestStatus[model.id];
                                              if (testData?.status === 'testing') return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
                                              if (testData?.status === 'success') return <Check className="w-4 h-4 text-green-500" />;
                                              if (testData?.status === 'error') return <span title={testData.detail || testData.message}><X className="w-4 h-4 text-red-500" /></span>;
                                              return null;
                                            })()}
                                            {model.primary ? (
                                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 whitespace-nowrap">
                                                {t('settings.models.defaultTag')}
                                              </span>
                                            ) : null}
                                          </div>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                          {editingModelId === model.id ? (
                                            <div className="flex items-center justify-end gap-1">
                                              <button
                                                onClick={handleSaveModelAlias}
                                                disabled={isLoading}
                                                className="p-1.5 text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors"
                                                title={t('common.save')}
                                              >
                                                <Check className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                onClick={cancelEditModel}
                                                className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                                title={t('common.cancel')}
                                              >
                                                <X className="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          ) : (
                                            <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                              <button
                                                onClick={() => startEditModel(model)}
                                                className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                                title={t('settings.models.editAlias')}
                                              >
                                                <Edit2 className="w-4 h-4" />
                                              </button>
                                              {!model.primary && (
                                                <button
                                                  onClick={() => handleSetDefaultModel(model.id)}
                                                  className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                                  title={t('settings.models.setDefault')}
                                                >
                                                  <Check className="w-4 h-4" />
                                                </button>
                                              )}
                                              <button
                                                onClick={() => {
                                                  handleTestExistingSingleModel(model.id, epName, modelName);
                                                }}
                                                disabled={existingModelTestStatus[model.id]?.status === 'testing'}
                                                className={`p-1.5 rounded-lg transition-colors ${ existingModelTestStatus[model.id]?.status === 'testing' ? 'text-gray-300 cursor-not-allowed' : 'text-gray-400 hover:text-purple-600 hover:bg-purple-50' }`}
                                                title={modelSupportsImageGeneration(model) ? t('settings.models.testImageGenerationLight') : t('settings.models.testAvailability')}
                                              >
                                                <Activity className="w-4 h-4" />
                                              </button>
                                              <button
                                                onClick={() => handleDeleteModel(model.id, model.primary)}
                                                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                                title={t('common.delete')}
                                              >
                                                <Trash2 className="w-4 h-4" />
                                              </button>
                                            </div>
                                          )}
                                        </td>
                                      </tr>
                                      {/* Capabilities row */}
                                      {editingModelId === model.id ? (
                                        <tr className="bg-blue-50/30">
                                          <td colSpan={3} className="px-6 pt-0 pb-3">
                                            <div className="flex flex-nowrap gap-1">
                                              {CAPABILITIES.map(cap => {
                                                const active = editingInput.includes(cap.id);
                                                return (
                                                  <button
                                                    key={cap.id}
                                                    type="button"
                                                    onClick={() => setEditingInput(prev =>
                                                      prev.includes(cap.id) ? prev.filter(i => i !== cap.id) : [...prev, cap.id]
                                                    )}
                                                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium border transition-all ${ active ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-gray-400 bg-gray-50 border-gray-200' }`}
                                                  >
                                                    <cap.Icon className="w-2.5 h-2.5" />
                                                    {cap.label}
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          </td>
                                          <td></td>
                                        </tr>
                                      ) : (
                                        (model.input || []).filter(i => i !== 'text').length > 0 && (
                                          <tr>
                                            <td colSpan={3} className="px-6 pt-0 pb-3">
                                              <div className="flex flex-nowrap gap-1">
                                                {CAPABILITIES.filter(c => (model.input || []).includes(c.id)).map(cap => (
                                                  <span key={cap.id} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium border text-blue-600 bg-blue-50 border-blue-200">
                                                    <cap.Icon className="w-2.5 h-2.5" />
                                                    {cap.label}
                                                  </span>
                                                ))}
                                              </div>
                                            </td>
                                            <td></td>
                                          </tr>
                                        )
                                      )}
                                      {idx < epModels.length - 1 && (
                                        <tr><td colSpan={4} className="p-0"><div className="mx-5 border-b border-gray-200"></div></td></tr>
                                      )}
                                      </Fragment>
                                    );
                                  })}
                                </tbody>
                              </table>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <div className="space-y-4 pt-2">
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {t('settings.models.defaultModelTitle')}
                  </h3>
                  <p className="text-sm text-gray-500 leading-relaxed">
                    {t('settings.models.defaultModelDescription')}
                  </p>
                </div>

                {defaultModelError.message ? (
                  <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                    <div>{defaultModelError.message}</div>
                    {defaultModelError.detail ? (
                      <div className="mt-2 rounded-lg border border-red-100 bg-white/80 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {defaultModelError.detail}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
                  <ModelSinglePicker
                    availableModels={sortedModels}
                    selectedModelId={defaultModelId}
                    onSelectedModelIdChange={(id) => {
                      void handleSaveDefaultModelSelection(id);
                    }}
                    placeholder={t('settings.models.defaultModelPlaceholder')}
                    emptyText={t('settings.models.defaultModelEmpty')}
                    allModelsTabLabel={t('sidebar.allModels')}
                    defaultBadgeLabel={t('settings.models.defaultTag')}
                    visionBadgeLabel={t('sidebar.visionModel')}
                    imageGenerationBadgeLabel={t('settings.models.imageGenerationBadge')}
                    disabled={isSavingDefaultModel || models.length === 0}
                  />
                </div>
              </div>

              <div className="space-y-4 pt-2">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-1">
                      {t('settings.models.globalFallbackTitle')}
                    </h3>
                    <p className="text-sm text-gray-500 leading-relaxed">
                      {t('settings.models.globalFallbackDescription')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={globalFallbackMode !== 'disabled'}
                    aria-label={t('settings.models.globalFallbackTitle')}
                    onClick={() => setGlobalFallbackMode((prev) => prev === 'disabled' ? 'custom' : 'disabled')}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${globalFallbackMode !== 'disabled' ? 'bg-blue-600' : 'bg-gray-200'}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${globalFallbackMode !== 'disabled' ? 'translate-x-6' : 'translate-x-1'}`}
                    />
                  </button>
                </div>

                {globalFallbackError.message ? (
                  <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                    <div>{globalFallbackError.message}</div>
                    {globalFallbackError.detail ? (
                      <div className="mt-2 rounded-lg border border-red-100 bg-white/80 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {globalFallbackError.detail}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {globalFallbackMode !== 'disabled' ? (
                  <ModelFallbackEditor
                    availableModels={[...models].sort((a, b) => {
                      const labelA = a.alias || a.id;
                      const labelB = b.alias || b.id;
                      return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
                    })}
                    mode={globalFallbackMode}
                    onModeChange={(mode) => setGlobalFallbackMode(mode)}
                    selectedModelIds={globalFallbacks}
                    onSelectedModelIdsChange={(ids) => {
                      setGlobalFallbacks(ids);
                      if (ids.length === 0) {
                        setGlobalFallbackMode('disabled');
                      } else if (globalFallbackMode !== 'custom') {
                        setGlobalFallbackMode('custom');
                      }
                    }}
                    excludedModelIds={currentPrimaryModelId ? [currentPrimaryModelId] : []}
                    title=""
                    description=""
                    customLabel={t('settings.models.fallbackModeCustom')}
                    customHint=""
                    disabledLabel={t('settings.models.fallbackModeDisabled')}
                    disabledHint=""
                    hideModeSelector
                    searchPlaceholder={t('settings.models.fallbackSearchPlaceholder')}
                    selectedTitle={t('settings.models.fallbackSelectedTitle')}
                    availableTitle={t('settings.models.fallbackAvailableTitle')}
                    emptySelectedText={t('settings.models.fallbackSelectedEmpty')}
                    emptyAvailableText={t('settings.models.fallbackAvailableEmpty')}
                    defaultBadgeLabel={t('settings.models.defaultTag')}
                    allModelsTabLabel={t('sidebar.allModels')}
                    visionBadgeLabel={t('sidebar.visionModel')}
                    imageGenerationBadgeLabel={t('settings.models.imageGenerationBadge')}
                    selectionUiVariant="model-picker"
                    className="min-w-0"
                  />
                ) : null}
              </div>

              <div className="space-y-4 pt-2">
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {t('settings.models.imageGenerationTitle')}
                  </h3>
                  <p className="text-sm text-gray-500 leading-relaxed">
                    {t('settings.models.imageGenerationDescription')}
                  </p>
                </div>

                {imageGenerationModelError.message ? (
                  <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                    <div>{imageGenerationModelError.message}</div>
                    {imageGenerationModelError.detail ? (
                      <div className="mt-2 rounded-lg border border-red-100 bg-white/80 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {imageGenerationModelError.detail}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="min-w-0 space-y-4 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
                  <ModelSinglePicker
                    availableModels={imageGenerationModels}
                    selectedModelId={imageGenerationModelId}
                    onSelectedModelIdChange={(id) => {
                      const nextFallbacks = imageGenerationFallbacks.filter((fallbackId) => fallbackId !== id);
                      setImageGenerationModelId(id);
                      setImageGenerationFallbacks(nextFallbacks);
                      if (nextFallbacks.length === 0) {
                        setImageGenerationFallbackMode('disabled');
                      }
                      void handleSaveImageGenerationModelConfig(id, nextFallbacks);
                    }}
                    placeholder={t('settings.models.imageGenerationPlaceholder')}
                    emptyText={t('settings.models.imageGenerationEmpty')}
                    allModelsTabLabel={t('sidebar.allModels')}
                    defaultBadgeLabel={t('settings.models.defaultTag')}
                    visionBadgeLabel={t('sidebar.visionModel')}
                    imageGenerationBadgeLabel={t('settings.models.imageGenerationBadge')}
                    disabled={isSavingImageGenerationModel || !hasImageGenerationModels}
                  />

                  {!imageGenerationModelId ? (
                    <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-500">
                      {hasImageGenerationModels
                        ? t('settings.models.imageGenerationOpenClawDefaultHint')
                        : t('settings.models.imageGenerationNoSupportedHint')}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="space-y-4 pt-2">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-1">
                      {t('settings.models.imageGenerationFallbackTitle')}
                    </h3>
                    <p className="text-sm text-gray-500 leading-relaxed">
                      {t('settings.models.imageGenerationFallbackDescription')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(imageGenerationModelId) && imageGenerationFallbackMode !== 'disabled'}
                    aria-label={t('settings.models.imageGenerationFallbackTitle')}
                    disabled={!imageGenerationModelId || isSavingImageGenerationModel}
                    onClick={() => {
                      if (!imageGenerationModelId) return;
                      if (imageGenerationFallbackMode === 'disabled') {
                        setImageGenerationFallbackMode('custom');
                        return;
                      }
                      setImageGenerationFallbackMode('disabled');
                      setImageGenerationFallbacks([]);
                      void handleSaveImageGenerationModelConfig(imageGenerationModelId, []);
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60 ${imageGenerationModelId && imageGenerationFallbackMode !== 'disabled' ? 'bg-blue-600' : 'bg-gray-200'}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${imageGenerationModelId && imageGenerationFallbackMode !== 'disabled' ? 'translate-x-6' : 'translate-x-1'}`}
                    />
                  </button>
                </div>

                {imageGenerationModelId ? (
                  imageGenerationFallbackMode !== 'disabled' ? (
                    <ModelFallbackEditor
                      availableModels={imageGenerationModels}
                      mode={imageGenerationFallbackMode}
                      onModeChange={(mode) => setImageGenerationFallbackMode(mode)}
                      selectedModelIds={imageGenerationFallbacks}
                      onSelectedModelIdsChange={(ids) => {
                        const nextIds = ids.filter((id) => id !== imageGenerationModelId);
                        setImageGenerationFallbacks(nextIds);
                        setImageGenerationFallbackMode(nextIds.length > 0 ? 'custom' : 'disabled');
                        void handleSaveImageGenerationModelConfig(imageGenerationModelId, nextIds);
                      }}
                      excludedModelIds={[imageGenerationModelId]}
                      title=""
                      description=""
                      customLabel={t('settings.models.fallbackModeCustom')}
                      customHint=""
                      disabledLabel={t('settings.models.fallbackModeDisabled')}
                      disabledHint=""
                      hideModeSelector
                      searchPlaceholder={t('settings.models.imageGenerationFallbackSearchPlaceholder')}
                      selectedTitle={t('settings.models.fallbackSelectedTitle')}
                      availableTitle={t('settings.models.fallbackAvailableTitle')}
                      emptySelectedText={t('settings.models.fallbackSelectedEmpty')}
                      emptyAvailableText={t('settings.models.fallbackAvailableEmpty')}
                      defaultBadgeLabel={t('settings.models.defaultTag')}
                      allModelsTabLabel={t('sidebar.allModels')}
                      visionBadgeLabel={t('sidebar.visionModel')}
                      imageGenerationBadgeLabel={t('settings.models.imageGenerationBadge')}
                      selectionUiVariant="model-picker"
                      className="min-w-0"
                    />
                  ) : null
                ) : (
                  <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-500">
                    {hasImageGenerationModels
                      ? t('settings.models.imageGenerationFallbackNeedsPrimary')
                      : t('settings.models.imageGenerationNoSupportedHint')}
                  </div>
                )}
              </div>
            </div>
          )}

            {/* About System Tab */}

            {settingsTab === 'about' && (
              <div className="space-y-6">
                <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-6 w-full">
                  <div className="flex w-full flex-col gap-6">
                  <div className="flex w-full flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-baseline gap-3">
                      <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight">{t('settings.openclawUpdate.title')}</div>
                      <span className="text-[0.8rem] font-medium text-gray-500 leading-none">
                        {isLoadingAppVersion
                          ? t('settings.about.loadingVersion')
                          : openClawCurrentVersion || t('settings.about.unavailable')}
                      </span>
                    </div>
                    <div className="flex min-w-0 justify-end">
                      {renderProgressActionButton(
                        openClawUpdateProgressVisual,
                        openClawUpdateProgressToneClasses,
                        handleOpenClawLatestVersionAction,
                        openClawUpdateProgressWidthClass,
                        openClawUpdateProgressButtonWidthClass,
                        openClawUpdateProgressTitle,
                      )}
                    </div>
                  </div>

                  <div className="w-full border-t border-gray-200" />
                  
                  {/* Header */}
                  <div className="flex w-full flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="w-full text-left sm:w-auto">
                      <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight mb-1">ClawOPT</div>
                      <div className="flex items-baseline gap-2 whitespace-nowrap leading-none">
                        <div className="text-[0.9rem] font-medium text-gray-400 leading-tight">应用版本</div>
                        <div className="text-[0.8rem] font-medium text-gray-400 leading-none">
                          {isLoadingAppVersion
                            ? t('settings.about.loadingVersion')
                            : appVersionInfo?.version || t('settings.about.unavailable')}
                        </div>
                      </div>
                    </div>
                    <div className="flex min-w-0 justify-end">
                      {renderProgressActionButton(
                        updateProgressVisual,
                        updateProgressToneClasses,
                        handleLatestVersionAction,
                        updateProgressWidthClass,
                        updateProgressButtonWidthClass,
                        updateProgressTitle,
                      )}
                    </div>
                  </div>

                  <div className="w-full border-t border-gray-200" />

                  {appVersionError.message && (
                    <div className="w-full rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                      <div className="font-semibold">{appVersionError.message}</div>
                      {appVersionError.detail ? <div className="mt-1 whitespace-pre-wrap text-red-600">{appVersionError.detail}</div> : null}
                    </div>
                  )}

                  {/* Project Info */}
                  <div className="w-full text-center text-xl font-medium leading-8 text-gray-700">
                    {t('settings.about.projectName')}
                  </div>
                  <div className="w-full text-center text-[13px] sm:text-[15px] text-gray-500 px-4">
                    {t('settings.about.projectTagline')}
                  </div>

                  </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {maxPermissionsConfirmPendingEnabled !== null && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
                {isTogglingPermissions
                  ? <Loader2 className="h-6 w-6 animate-spin text-amber-600" />
                  : <Zap className="h-6 w-6 text-amber-600" />}
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">
                {t(maxPermissionsConfirmPendingEnabled
                  ? 'settings.gateway.maxPermissionsRestartConfirmTitle'
                  : 'settings.gateway.maxPermissionsDisableRestartConfirmTitle')}
              </h3>
              <p className="text-sm text-gray-500 whitespace-pre-wrap">
                {t(maxPermissionsConfirmPendingEnabled
                  ? 'settings.gateway.maxPermissionsRestartConfirmMessage'
                  : 'settings.gateway.maxPermissionsDisableRestartConfirmMessage')}
              </p>
            </div>
            <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
              <button
                type="button"
                onClick={closeMaxPermissionsConfirmModal}
                disabled={isTogglingPermissions}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmMaxPermissionsToggle()}
                disabled={isTogglingPermissions}
                className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isTogglingPermissions
                  ? t('settings.gateway.hostTakeoverPasswordSubmitting')
                  : t(maxPermissionsConfirmPendingEnabled
                    ? 'settings.gateway.maxPermissionsRestartConfirmAction'
                    : 'settings.gateway.maxPermissionsDisableRestartConfirmAction')}
              </button>
            </div>
          </div>
        </div>
      )}

      {permissionsPasswordModalOpen && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
                {isSubmittingPermissionsPassword
                  ? <Loader2 className="h-6 w-6 animate-spin text-amber-600" />
                  : <Zap className="h-6 w-6 text-amber-600" />}
              </div>
              <h3 className="mb-2 text-center text-lg font-bold text-gray-900">
                {t('settings.gateway.hostTakeoverPasswordModalTitle')}
              </h3>
              <p className="text-center text-sm text-gray-500 whitespace-pre-wrap">
                {t('settings.gateway.hostTakeoverPasswordModalMessage')}
              </p>

              <div className="mt-5 space-y-4">
                <div>
                  <div className="mb-2 text-sm font-semibold text-gray-900">
                    {t('settings.gateway.hostTakeoverCurrentUserLabel')}
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 font-mono text-sm text-gray-700 break-all">
                    {permissionsPasswordUser || hostTakeoverStatus?.currentUser || '-'}
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-gray-900">
                    {t('settings.gateway.hostTakeoverPasswordLabel')}
                  </label>
                  <input
                    type="password"
                    value={permissionsPassword}
                    onChange={(event) => setPermissionsPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !isSubmittingPermissionsPassword) {
                        event.preventDefault();
                        void handleSubmitPermissionsPassword();
                      }
                    }}
                    placeholder={t('settings.gateway.hostTakeoverPasswordPlaceholder')}
                    disabled={isSubmittingPermissionsPassword}
                    className="block w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
                  />
                </div>

                {permissionsPasswordError.message && (
                  <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-3 text-sm text-red-600">
                    <div>{permissionsPasswordError.message}</div>
                    {permissionsPasswordError.detail && (
                      <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {permissionsPasswordError.detail}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
              <button
                type="button"
                onClick={closePermissionsPasswordModal}
                disabled={isSubmittingPermissionsPassword}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitPermissionsPassword()}
                disabled={isSubmittingPermissionsPassword}
                className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmittingPermissionsPassword
                  ? t('settings.gateway.hostTakeoverPasswordSubmitting')
                  : t('settings.gateway.hostTakeoverPasswordSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {browserHeadedModeModalStage && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
                browserHeadedModeModalStage === 'confirm'
                  ? 'bg-amber-100'
                  : browserHeadedModeModalStage === 'success'
                    ? 'bg-emerald-100'
                    : browserHeadedModeModalStage === 'failure'
                      ? 'bg-red-100'
                      : 'bg-blue-100'
              }`}>
                {browserHeadedModeModalStage === 'confirm' ? (
                  <Activity className="h-6 w-6 text-amber-600" />
                ) : browserHeadedModeModalStage === 'success' ? (
                  <Check className="h-6 w-6 text-emerald-600" />
                ) : browserHeadedModeModalStage === 'failure' ? (
                  <X className="h-6 w-6 text-red-600" />
                ) : (
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                )}
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{browserHeadedModeModalTitle}</h3>
              <p className="text-sm text-gray-500 whitespace-pre-wrap">{browserHeadedModeModalMessage}</p>
              {browserHeadedModeModalDetail && browserHeadedModeModalStage === 'failure' ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{browserHeadedModeModalDetail}</p>
                </div>
              ) : null}
            </div>
            {browserHeadedModeModalStage === 'confirm' ? (
              <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeBrowserHeadedModeModal}
                  className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmBrowserHeadedModeToggle()}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {browserHeadedModeConfirmingEnable
                    ? t('settings.gateway.browserHeadedModeConfirmEnableAction')
                    : t('settings.gateway.browserHeadedModeConfirmDisableAction')}
                </button>
              </div>
            ) : browserHeadedModeModalStage === 'success' || browserHeadedModeModalStage === 'failure' ? (
              <div className="border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeBrowserHeadedModeModal}
                  className="w-full rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('common.gotIt')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {gatewayRestartModalStage && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
                gatewayRestartModalStage === 'confirm'
                  ? 'bg-amber-100'
                  : gatewayRestartModalStage === 'success'
                    ? 'bg-emerald-100'
                    : gatewayRestartModalStage === 'failure'
                      ? 'bg-red-100'
                      : 'bg-blue-100'
              }`}>
                {gatewayRestartModalStage === 'confirm' ? (
                  <Activity className="h-6 w-6 text-amber-600" />
                ) : gatewayRestartModalStage === 'success' ? (
                  <Check className="h-6 w-6 text-emerald-600" />
                ) : gatewayRestartModalStage === 'failure' ? (
                  <X className="h-6 w-6 text-red-600" />
                ) : (
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                )}
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{gatewayRestartModalTitle}</h3>
              <p className="text-sm text-gray-500 whitespace-pre-wrap">{gatewayRestartModalMessage}</p>
              {gatewayRestartModalDetail && gatewayRestartModalStage === 'failure' ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{gatewayRestartModalDetail}</p>
                </div>
              ) : null}
            </div>
            {gatewayRestartModalStage === 'confirm' ? (
              <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeGatewayRestartModal}
                  className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmRestartGateway()}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('settings.gateway.restartGatewayConfirmAction')}
                </button>
              </div>
            ) : gatewayRestartModalStage === 'success' || gatewayRestartModalStage === 'failure' ? (
              <div className="border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeGatewayRestartModal}
                  className="w-full rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('common.gotIt')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {updateRestartModalStage && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
                updateRestartModalStage === 'confirm'
                  ? 'bg-amber-100'
                  : updateRestartModalStage === 'success'
                    ? 'bg-emerald-100'
                    : updateRestartModalStage === 'failure'
                      ? 'bg-red-100'
                      : 'bg-blue-100'
              }`}>
                {updateRestartModalStage === 'confirm' ? (
                  <Activity className="h-6 w-6 text-amber-600" />
                ) : updateRestartModalStage === 'success' ? (
                  <Check className="h-6 w-6 text-emerald-600" />
                ) : updateRestartModalStage === 'failure' ? (
                  <X className="h-6 w-6 text-red-600" />
                ) : (
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                )}
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{updateRestartModalTitle}</h3>
              <p className="text-sm text-gray-500 whitespace-pre-wrap">{updateRestartModalMessage}</p>
              {updateRestartModalStage !== 'confirm' ? (
                <div className="mt-4 space-y-2 text-left">
                  {updateRestartStepItems.map((step) => (
                    <div
                      key={step.id}
                      className={`rounded-xl border px-4 py-3 ${
                        step.status === 'completed'
                          ? 'border-emerald-200 bg-emerald-50'
                          : step.status === 'skipped'
                            ? 'border-gray-200 bg-gray-50'
                            : step.status === 'failed'
                              ? 'border-red-200 bg-red-50'
                              : step.status === 'running'
                                ? 'border-blue-200 bg-blue-50'
                                : 'border-gray-200 bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`flex h-7 w-7 items-center justify-center rounded-full ${
                          step.status === 'completed'
                            ? 'bg-emerald-100 text-emerald-600'
                            : step.status === 'skipped'
                              ? 'bg-gray-200 text-gray-500'
                              : step.status === 'failed'
                                ? 'bg-red-100 text-red-600'
                                : step.status === 'running'
                                  ? 'bg-blue-100 text-blue-600'
                                  : 'bg-gray-200 text-gray-500'
                        }`}>
                          {step.status === 'completed' ? (
                            <Check className="h-4 w-4" />
                          ) : step.status === 'failed' ? (
                            <X className="h-4 w-4" />
                          ) : step.status === 'running' ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Activity className="h-4 w-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-semibold text-gray-900">{step.label}</p>
                            <span className={`shrink-0 text-xs font-medium ${
                              step.status === 'completed'
                                ? 'text-emerald-700'
                                : step.status === 'failed'
                                  ? 'text-red-700'
                                  : step.status === 'running'
                                    ? 'text-blue-700'
                                    : 'text-gray-500'
                            }`}>
                              {step.statusLabel}
                            </span>
                          </div>
                          {step.status === 'skipped' && step.skipReason ? (
                            <p className="mt-1 whitespace-pre-wrap text-xs text-gray-500">{step.skipReason}</p>
                          ) : step.detail ? (
                            <p className="mt-1 whitespace-pre-wrap break-all text-xs text-gray-500">{step.detail}</p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {updateRestartModalDetail && updateRestartModalStage === 'failure' ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{updateRestartModalDetail}</p>
                </div>
              ) : null}
            </div>
            {updateRestartModalStage === 'confirm' ? (
              <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeUpdateRestartModal}
                  className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmRestartUpdatedService()}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('settings.about.restartServiceConfirmAction')}
                </button>
              </div>
            ) : updateRestartModalStage === 'success' || updateRestartModalStage === 'failure' ? (
              <div className="border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeUpdateRestartModal}
                  className="w-full rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('common.gotIt')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {isOpenClawUpdateCancelModalOpen && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
            onClick={() => {
              if (!isCancellingOpenClawUpdate) {
                setIsOpenClawUpdateCancelModalOpen(false);
              }
            }}
          />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${openClawUpdateStatusInfo?.canCancel ? 'bg-amber-100' : 'bg-blue-100'}`}>
                <Activity className={`h-6 w-6 ${openClawUpdateStatusInfo?.canCancel ? 'text-amber-600' : 'text-blue-600'}`} />
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{openClawUpdateCancelModalTitle}</h3>
              <p className="text-sm text-gray-500">{openClawUpdateCancelModalMessage}</p>
              {!openClawUpdateStatusInfo?.canCancel && openClawUpdateCancelUnsafeDetail ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{openClawUpdateCancelUnsafeDetail}</p>
                </div>
              ) : null}
            </div>
            <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
              <button
                type="button"
                onClick={() => setIsOpenClawUpdateCancelModalOpen(false)}
                disabled={isCancellingOpenClawUpdate}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {openClawUpdateStatusInfo?.canCancel ? t('settings.openclawUpdate.updateCancelKeepRunning') : t('common.gotIt')}
              </button>
              {openClawUpdateStatusInfo?.canCancel ? (
                <button
                  type="button"
                  onClick={() => void handleConfirmCancelOpenClawUpdate()}
                  disabled={isCancellingOpenClawUpdate}
                  className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isCancellingOpenClawUpdate ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('settings.openclawUpdate.updateStoppingButton')}
                    </span>
                  ) : (
                    t('settings.openclawUpdate.updateCancelConfirmAction')
                  )}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {isUpdateCancelModalOpen && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
            onClick={() => {
              if (!isCancellingUpdate) {
                setIsUpdateCancelModalOpen(false);
              }
            }}
          />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${updateStatusInfo?.canCancel ? 'bg-amber-100' : 'bg-blue-100'}`}>
                <Activity className={`h-6 w-6 ${updateStatusInfo?.canCancel ? 'text-amber-600' : 'text-blue-600'}`} />
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{updateCancelModalTitle}</h3>
              <p className="text-sm text-gray-500">{updateCancelModalMessage}</p>
              {!updateStatusInfo?.canCancel && updateCancelUnsafeDetail ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{updateCancelUnsafeDetail}</p>
                </div>
              ) : null}
            </div>
            <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
              <button
                type="button"
                onClick={() => setIsUpdateCancelModalOpen(false)}
                disabled={isCancellingUpdate}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {updateStatusInfo?.canCancel ? t('settings.about.updateCancelKeepRunning') : t('common.gotIt')}
              </button>
              {updateStatusInfo?.canCancel ? (
                <button
                  type="button"
                  onClick={() => void handleConfirmCancelUpdate()}
                  disabled={isCancellingUpdate}
                  className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isCancellingUpdate ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('settings.about.updateStoppingButton')}
                    </span>
                  ) : (
                    t('settings.about.updateCancelConfirmAction')
                  )}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Shared Delete Confirmation Modal */}
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsDeleteModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{t('common.confirmDelete')}</h3>
              <p className="text-sm text-gray-500">{deleteModalMessage}</p>
            </div>
            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setIsDeleteModalOpen(false)}
                className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={executeDelete}
                className="flex-1 px-4 py-2.5 text-white bg-red-600 hover:bg-red-700 rounded-xl font-semibold transition-all"
              >
                {t('common.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Endpoint Add/Edit Modal */}
      {isEndpointModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsEndpointModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-5 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-lg font-bold text-gray-900">
                {editingEndpoint ? t('settings.models.endpointModalEditTitle') : t('settings.models.endpointModalCreateTitle')}
              </h3>
              <button
                onClick={() => setIsEndpointModalOpen(false)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                title={t('common.close')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {endpointModalError.message && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                  <X className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div>{endpointModalError.message}</div>
                    {endpointModalError.detail && (
                      <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {endpointModalError.detail}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {modelError && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-center gap-2">
                  <X className="w-4 h-4 shrink-0" />
                  {modelError}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1.5">
                  {t('settings.models.endpointNameLabel')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newEndpointData.id}
                  onChange={(e) => setNewEndpointData({ ...newEndpointData, id: e.target.value })}
                  disabled={!!editingEndpoint}
                  placeholder={t('settings.models.endpointNamePlaceholder')}
                  className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>

	              <div>
	                <label className="block text-sm font-medium text-gray-900 mb-1.5">
	                  {t('settings.models.apiTypeLabel')} <span className="text-red-500">*</span>
	                </label>
	                <div className="relative">
	                  <select
	                    value={newEndpointData.api}
	                    onChange={(e) => setNewEndpointData({ ...newEndpointData, api: e.target.value })}
	                    className="block w-full appearance-none px-4 pr-14 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
	                  >
	                    <option value="openai-completions">{t('settings.models.openaiCompatibleLabel')}</option>
	                    <option value="anthropic-messages">Anthropic (Messages)</option>
	                    <option value="google-genai">Google Gemini (GenAI)</option>
	                    <option value="cohere-chat">Cohere Chat</option>
	                    <option value="mistral-chat">Mistral Chat</option>
	                    <option value="ollama">Ollama</option>
	                  </select>
	                  <span className="pointer-events-none absolute inset-y-0 right-5 flex items-center text-gray-500">
	                    <ChevronDown className="w-4 h-4" />
	                  </span>
	                </div>
	                <p className="text-xs text-gray-500 mt-1.5 ml-1">{t('settings.models.apiTypeHint')}</p>
	              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1.5">
                  {t('settings.models.baseUrlLabel')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newEndpointData.baseUrl}
                  onChange={(e) => setNewEndpointData({ ...newEndpointData, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1.5">
                  {t('settings.models.apiKeyLabel')}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={newEndpointData.apiKey}
                    onChange={(e) => setNewEndpointData({ ...newEndpointData, apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="block w-full px-4 py-2.5 pr-12 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setIsEndpointModalOpen(false)}
                className="flex-[0.5] px-3 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all text-sm whitespace-nowrap"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleTestEndpoint}
                disabled={endpointTestStatus === 'testing' || !newEndpointData.baseUrl || !newEndpointData.api}
                className={`flex-[1.5] px-3 py-2.5 rounded-xl font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 text-sm overflow-hidden ${ endpointTestStatus === 'testing' ? 'bg-blue-50 text-blue-600 border border-blue-200' : endpointTestStatus === 'success' ? 'bg-green-50 text-green-600 border border-green-200' : endpointTestStatus === 'error' ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-white text-gray-700 border border-gray-200 hover:text-purple-700 hover:border-purple-200 hover:bg-purple-50' }`}
                title={endpointTestStatus !== 'idle' ? endpointTestMessage : t('settings.models.pretestEndpoint')}
              >
                {endpointTestStatus === 'testing' ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> :
                 endpointTestStatus === 'success' ? <Check className="w-4 h-4 shrink-0" /> :
                 endpointTestStatus === 'error' ? <X className="w-4 h-4 shrink-0" /> :
                 <Activity className="w-4 h-4 shrink-0" />}
                <span className="truncate">
                  {endpointTestStatus === 'idle' ? t('common.test') : endpointTestMessage}
                </span>
              </button>
              <button
                type="button"
                onClick={handleSaveEndpoint}
                disabled={isLoading}
                className="flex-[0.8] px-3 py-2.5 text-white bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 text-sm whitespace-nowrap"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t('settings.models.saveEndpoint')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* End of content */}

      {isAddModelModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsAddModelModalOpen(false)}></div>
          <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl min-h-[400px] max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200 flex flex-col">
            <div className="px-6 py-5 border-b border-gray-100 flex justify-between items-start bg-gray-50/50 rounded-t-2xl">
              <div>
                <h3 className="text-lg font-bold text-gray-900 mt-1">{t('settings.models.addModelTitle')}</h3>
                <div className="text-xs text-gray-500 mt-1">
                  {t('settings.models.addModelIntro')}
                  <div className="text-red-500 font-bold mt-1 space-y-0.5 leading-relaxed">
                    <p>{t('settings.models.addModelNoteAutoFetch')}</p>
                    <p>{t('settings.models.addModelNoteTestConsumesToken')}</p>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setIsAddModelModalOpen(false)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                title={t('common.close')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 space-y-5 flex-1 overflow-visible flex flex-col">
              {addModelError && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                  <X className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div>{addModelError}</div>
                    {addModelErrorDetail && (
                      <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {addModelErrorDetail}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 z-[210]">
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-900 mb-1.5">
                    {t('settings.models.endpointLabel')} <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={isEndpointDropdownOpen ? endpointSearchQuery : newModelEndpoint}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEndpointSearchQuery(val);
                        if (!isEndpointDropdownOpen) setIsEndpointDropdownOpen(true);
                      }}
                      onFocus={() => {
                        setEndpointSearchQuery('');
                        setIsEndpointDropdownOpen(true);
                      }}
                      placeholder={newModelEndpoint ? newModelEndpoint : t('settings.models.endpointPlaceholder')}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all text-sm font-mono text-gray-900 pr-8"
                    />
                    {newModelEndpoint && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNewModelEndpoint('');
                          setEndpointSearchQuery('');
                          setIsEndpointDropdownOpen(false);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-all"
                        title={t('common.clear')}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {isEndpointDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-[10]" onClick={() => {
                        setIsEndpointDropdownOpen(false);
                        if (endpointSearchQuery && !newModelEndpoint) {
                          setNewModelEndpoint(endpointSearchQuery.trim());
                          handleDiscoverModels(endpointSearchQuery.trim());
                        }
                      }} />
                      <div className="absolute z-[20] top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl max-h-[160px] overflow-y-auto">
                        {knownEndpoints
                          .filter(ep => {
                            if (!endpointSearchQuery) return true;
                            return ep.toLowerCase().includes(endpointSearchQuery.toLowerCase());
                          })
                          .map((ep, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                setNewModelEndpoint(ep);
                                setHasFetched(false);
                                setEndpointSearchQuery('');
                                setIsEndpointDropdownOpen(false);
                              }}
                              className={`w-full text-left px-4 py-2 text-sm hover:bg-blue-50 transition-colors flex items-center gap-2 ${ newModelEndpoint === ep ? 'bg-blue-50 text-blue-600' : 'text-gray-700' }`}
                            >
                              <span className="font-mono text-xs max-w-[200px] truncate">{ep}</span>
                            </button>
                          ))
                        }
                        {endpointSearchQuery && !knownEndpoints.some(ep => ep.toLowerCase() === endpointSearchQuery.toLowerCase()) && (
                          <button
                            type="button"
                            onClick={() => {
                              const val = endpointSearchQuery.trim();
                              setNewModelEndpoint(val);
                              setHasFetched(false);
                              setEndpointSearchQuery('');
                              setIsEndpointDropdownOpen(false);
                            }}
                            className="w-full text-left px-4 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors border-t border-gray-100 bg-gray-50 flex items-center justify-between"
                          >
                            <span>{t('settings.models.useNewEndpoint')} <strong className="font-mono">{endpointSearchQuery}</strong></span>
                            <Plus className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-900 mb-1.5">{t('settings.models.aliasOptionalLabel')}</label>
                  <input
                    type="text"
                    value={newModelAlias}
                    onChange={(e) => setNewModelAlias(e.target.value)}
                    placeholder={t('settings.models.aliasExamplePlaceholder')}
                    className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                  />
                </div>
              </div>

              <div className="flex-1 flex flex-col relative z-10" ref={dropdownRef}>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-gray-900">
                    {t('settings.models.modelIdLabel')} <span className="text-red-500">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (isDiscovering) {
                        cancelDiscovery();
                      } else if (hasFetched && discoveredModels.length > 0) {
                        setHasFetched(false);
                      } else {
                        handleDiscoverModels(newModelEndpoint.trim());
                      }
                    }}
                    disabled={!newModelEndpoint.trim()}
                    title={isDiscovering ? t('settings.models.fetchingModelsTitle') : ""}
                    className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all border flex items-center gap-1.5 ${ !newModelEndpoint.trim() ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : isDiscovering ? 'bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50' }`}
                  >
                    {isDiscovering && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {isDiscovering 
                      ? t('settings.models.autoFetching')
                      : (hasFetched && discoveredModels.length > 0) 
                        ? t('settings.models.manualInput')
                        : t('settings.models.autoFetch')
                    }
                  </button>
                </div>
                <div 
                  className="relative cursor-pointer block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus-within:bg-white focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-500/20 transition-all text-sm min-h-[46px] flex items-center gap-2 flex-wrap"
                  onClick={() => {
                    if (hasFetched && discoveredModels.length > 0) {
                      setIsModelDropdownOpen(true);
                    }
                  }}
                >
                  <input
                    type="text"
                    value={newModelName}
                    onChange={(e) => {
                      setNewModelName(e.target.value);
                      setModelSearchQuery(e.target.value);
                      // Auto-detect capabilities when user types a model name
                      if (e.target.value.trim()) {
                        setNewModelInput(guessCapabilities(e.target.value.trim()));
                      }
                    }}
                    placeholder={!hasFetched ? t('settings.models.modelPlaceholderNoFetch') : (discoveredModels.length > 0 ? t('settings.models.modelPlaceholderFetched', { count: discoveredModels.length }) : t('settings.models.modelPlaceholderEmpty'))}
                    className="bg-transparent border-none outline-none w-full text-sm placeholder-gray-400 py-1"
                    onFocus={() => {
                      if (hasFetched && discoveredModels.length > 0) {
                        setIsModelDropdownOpen(true);
                      }
                    }}
                  />
                  {newModelName && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setNewModelName('');
                        setModelSearchQuery('');
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-all"
                      title={t('common.clear')}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {isModelDropdownOpen && (hasFetched && discoveredModels.length > 0) && (
                  <>
                  <div className="fixed inset-0 z-[40]" onClick={(e) => { e.stopPropagation(); setIsModelDropdownOpen(false); }} />
                  <div 
                    className="absolute z-50 left-0 right-0 top-[80px] bg-white border border-gray-200 rounded-xl flex flex-col overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200"
                    style={{ maxHeight: modelDropdownMaxHeight ? `${modelDropdownMaxHeight}px` : '350px' }}
                  >
                    {(() => {
                      const visibleDiscoveredModels = discoveredModels.filter(m => {
                        if (showOnlyConnected && individualTestStatus[m]?.status !== 'success') return false;
                        return m.toLowerCase().includes(modelSearchQuery.toLowerCase());
                      }).sort((a, b) => a.localeCompare(b));
                      const isAnyTesting = Object.values(individualTestStatus).some(t => t.status === 'testing');
                      const hasAnyTests = Object.keys(individualTestStatus).length > 0;

                      return (
                        <>
                          <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 bg-gray-50/95 backdrop-blur">
                            <span className="text-sm text-gray-700 font-semibold flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 rounded-full bg-green-500"></span>
                              {t('settings.models.modelListTitle', { count: visibleDiscoveredModels.length })}
                            </span>
                            
                            <div className="flex items-center gap-3">
                              <div className="flex items-center bg-gray-200/50 p-0.5 rounded-lg border border-gray-200/50">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setShowOnlyConnected(false); }}
                                  disabled={isAnyTesting}
                                  className={`text-sm px-3 py-1.5 rounded-md font-medium transition-all border ${ !showOnlyConnected ? 'bg-white text-gray-800 border-gray-200' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-200/50' } ${isAnyTesting ? 'opacity-50 cursor-not-allowed' : ''}`}
                                >
                                  {t('settings.models.filterAll')}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setShowOnlyConnected(true); }}
                                  disabled={isAnyTesting || !hasAnyTests}
                                  className={`text-sm px-3 py-1.5 rounded-md font-medium transition-all border ${ showOnlyConnected ? 'bg-white text-green-700 border-green-200' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-200/50' } ${(isAnyTesting || !hasAnyTests) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  title={!hasAnyTests ? t('settings.models.noConnectivityTestsYet') : ""}
                                >
                                  {t('settings.models.filterValid')}
                                </button>
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                if (isAnyTesting) {
                                  cancelTestAll();
                                } else {
                                  handleTestAllFiltered();
                                }
                              }}
                              disabled={!isAnyTesting && visibleDiscoveredModels.length === 0}
                              title={isAnyTesting ? t('settings.models.fetchingModelsTitle') : ""}
                              className={`text-sm flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all border ${ !isAnyTesting && visibleDiscoveredModels.length === 0 ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : isAnyTesting ? 'text-red-600 bg-red-50 hover:bg-red-100 border-red-200' : 'text-indigo-700 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 border-indigo-200' }`}
                            >
                              {isAnyTesting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                              {isAnyTesting
                                  ? t('settings.models.testingCount', { count: Object.values(individualTestStatus).filter(t => t.status === 'testing').length })
                                  : t('settings.models.testModels')
                                }
                              </button>
                            </div>
                          </div>
                          
                          <div className="overflow-y-auto flex-1 p-1.5 space-y-0.5 min-h-[100px]" onClick={() => setIsModelDropdownOpen(false)}>
                            {visibleDiscoveredModels.length === 0 && (
                              <div className="py-8 text-center text-gray-400 text-sm">
                                {showOnlyConnected ? t('settings.models.noValidModelsFound') : t('settings.models.noMatchingModels', { query: modelSearchQuery })}
                              </div>
                            )}
                            {visibleDiscoveredModels.map(m => {
                              const isExisting = existingModelIds.has(`${newModelEndpoint.trim()}/${m}`);
                              const testData = individualTestStatus[m];
                              const isSelected = newModelName === m;

                              return (
                                <div 
                                  key={m}
                                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all ${ isExisting ? 'opacity-60 bg-gray-50/50 cursor-not-allowed' : isSelected ? 'bg-blue-50/80 border-blue-100 font-medium cursor-pointer ' : 'hover:bg-gray-100 cursor-pointer border-transparent' } border`}
                                  onClick={(e) => {
                                    if (isExisting) return;
                                    e.preventDefault();
                                    if (isSelected) {
                                      setNewModelName('');
                                    } else {
                                      setNewModelName(m);
                                      setIsModelDropdownOpen(false);
                                      // Auto-detect capabilities when a model is selected from dropdown
                                      setNewModelInput(guessCapabilities(m));
                                    }
                                  }}
                                >
                                  <div className="flex items-center gap-3 overflow-hidden flex-1">
                                    <span className={`truncate ${isSelected ? 'text-blue-900' : 'text-gray-700'}`} title={m}>{m}</span>
                                    {isExisting && <span className="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full ml-1 shrink-0 font-medium">{t('settings.models.alreadyInUse')}</span>}
                                  </div>

                                  {!isExisting && (
                                    <div className="flex items-center gap-2 shrink-0 ml-3" onClick={e => e.stopPropagation()}>
                                      {testData?.status === 'testing' && <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />}
                                      {testData?.status === 'success' && <span title={t('settings.models.valid')}><Check className="w-3.5 h-3.5 text-green-500" /></span>}
                                      {testData?.status === 'error' && <span title={testData.detail || testData.message}><X className="w-3.5 h-3.5 text-red-500" /></span>}
                                      
                                      <button 
                                        onClick={(e) => handleTestSingleModel(m, e)}
                                        className="text-xs text-gray-500 hover:text-indigo-600 px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 transition-colors"
                                        title={t('settings.models.testSingleModel')}
                                      >
                                        {t('common.test')}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  </>
                )}
              </div>

              {/* Model Capabilities Section */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <label className="block text-sm font-medium text-gray-900">{t('settings.models.capabilitiesLabel')}</label>
                  <span className="text-xs text-gray-400">{t('settings.models.capabilitiesHint')}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {CAPABILITIES.map(cap => {
                    const active = newModelInput.includes(cap.id);
                    return (
                      <button
                        key={cap.id}
                        type="button"
                        onClick={() => setNewModelInput(prev =>
                          prev.includes(cap.id) ? prev.filter(i => i !== cap.id) : [...prev, cap.id]
                        )}
                        className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${ active ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-gray-400 bg-gray-50 border-gray-200 hover:bg-gray-100' }`}
                      >
                        <cap.Icon className="w-3.5 h-3.5" />
                        {cap.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100 rounded-b-2xl">
              <button
                type="button"
                onClick={() => setIsAddModelModalOpen(false)}
                className="flex-[0.5] px-3 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all text-sm whitespace-nowrap"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleTestModel}
                disabled={addModelTestStatus === 'testing' || !newModelEndpoint.trim() || !newModelName.trim()}
                className={`flex-[1.5] px-3 py-2.5 rounded-xl font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 text-sm overflow-hidden ${ addModelTestStatus === 'testing' ? 'bg-blue-50 text-blue-600 border border-blue-200' : addModelTestStatus === 'success' ? 'bg-green-50 text-green-600 border border-green-200' : addModelTestStatus === 'error' ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-indigo-50 text-indigo-700 border border-indigo-200 hover:text-indigo-800 hover:bg-indigo-100' }`}
                title={addModelTestStatus !== 'idle' ? addModelTestMessage : (newModelUsesImageGeneration ? t('settings.models.testImageGenerationLight') : t('settings.models.testThisModel'))}
              >
                {addModelTestStatus === 'testing' ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> :
                 addModelTestStatus === 'success' ? <Check className="w-4 h-4 shrink-0" /> :
                 addModelTestStatus === 'error' ? <X className="w-4 h-4 shrink-0" /> :
                 <Activity className="w-4 h-4 shrink-0" />}
                <span className="truncate">
                  {addModelTestStatus === 'idle' ? t('common.test') : addModelTestMessage}
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleAddModel()}
                disabled={isLoading || addModelTestStatus === 'testing' || !newModelEndpoint.trim() || !newModelName.trim()}
                className="flex-[0.8] px-3 py-2.5 text-white bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition-all disabled:opacity-50 flex items-center justify-center gap-2 text-sm whitespace-nowrap"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {t('settings.models.add')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showForceAddModal && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <h3 className="text-xl font-bold text-gray-900 mb-2">{t('settings.models.forceAddTitle')}</h3>
              <p className="text-sm text-gray-700 mb-6 bg-red-50 p-3 rounded-lg border border-red-100">{testModelMessage}</p>
              <p className="text-sm text-gray-600 mb-6">{t('settings.models.forceAddDescription')}</p>
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => setShowForceAddModal(false)}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors cursor-pointer"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    setShowForceAddModal(false);
                    handleAddModel();
                  }}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition-colors cursor-pointer"
                >
                  {t('settings.models.forceAdd')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Gateway Error Modal */}
      {gatewayErrorModalOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" onClick={() => setGatewayErrorModalOpen(false)}></div>
          <div className="bg-white rounded-[32px] border border-gray-200 w-full max-w-[420px] max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-8 text-center">
	              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-3xl bg-red-50 mb-6 border border-red-100"><X className="h-8 w-8 text-red-500" /></div>
	              <h3 className="text-xl font-black text-gray-900 mb-2 tracking-tight">{t('settings.gateway.configErrorTitle')}</h3>
	              <p className="text-sm text-gray-500 leading-relaxed px-2">{gatewayErrorMessage}</p>
                {gatewayErrorDetail && (
                  <div className="mt-4 text-left bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">{t('settings.gateway.errorDetailLabel')}</p>
                    <p className="text-xs text-gray-500 whitespace-pre-wrap break-all font-mono">{gatewayErrorDetail}</p>
                  </div>
                )}
	            </div>
            <div className="p-5 bg-gray-50/80 border-t border-gray-100">
              <button type="button" onClick={() => setGatewayErrorModalOpen(false)} className="w-full px-4 py-3 text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-2xl font-bold text-sm transition-all">{t('common.gotIt')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
