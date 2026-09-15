// 设置页共用的类型。只放类型与空值常量，不放逻辑。
import type { SettingsTab } from '../../../app/routeState';

export type TestStatus = {
  status: 'testing' | 'success' | 'error';
  message?: string;
  detail?: string;
};

export type InlineErrorState = {
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

export type BrowserHealthSnapshot = {
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

export type BrowserHealthNotice = {
  tone: 'success' | 'warning';
  message: string;
};

export type GatewayRestartNoticeSource = 'permissions' | 'browser' | null;

export type BrowserHeadedModeConfig = {
  headless: boolean;
  headedModeEnabled: boolean;
};

export type RestartFlowModalStage = 'confirm' | 'restarting' | 'success' | 'failure' | null;
export type BrowserHeadedModeModalStage = RestartFlowModalStage;

type BrowserTaskStatus = 'idle' | 'checking' | 'repairing';

export type BrowserTaskInfo = {
  status: BrowserTaskStatus;
  phase: string | null;
  rawDetail: string | null;
  updatedAt: string | null;
};

export type GatewayRestartTrigger =
  | 'gateway'
  | 'browser-headed-mode';

type GatewayRestartTaskStatus =
  | 'idle'
  | 'restarting'
  | 'failed';

export type GatewayRestartTaskInfo = {
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

export type HostTakeoverStatus = {
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

export type DevicePairingStatus = {
  pending: DevicePairingPendingRequest[];
  latestPending: DevicePairingPendingRequest | null;
  pairedCount: number | null;
  rawDetail: string | null;
};

export type AppVersionInfo = {
  appName: string;
  version: string;
  releaseTag: string;
  commit: string | null;
  buildTime: string | null;
  repositoryUrl: string | null;
  openclawVersion: string | null;
};

export type LatestVersionInfo = {
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

export type OpenClawLatestVersionInfo = {
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

export type UpdateStatusInfo = {
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

export type OpenClawUpdateStatusInfo = {
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

export const EMPTY_INLINE_ERROR: InlineErrorState = { message: '', detail: '' };

export type UpdateProgressTone = 'neutral' | 'brand' | 'success' | 'error';

export type UpdatePhaseVisual = {
  progress: number;
  labelKey: string;
};

export type UpdateRestartStepId =
  | 'restart_openclaw'
  | 'restart_project'
  | 'warmup_browser';

export type UpdateRestartStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  // 这一步被跳过了，且这是正常结果——例如浏览器插件用户根本没启用。
  // 跳过不是失败：一个没开的可选能力不该让整条升级流程报红。
  | 'skipped'
  | 'failed';

export type UpdateRestartStep = {
  id: UpdateRestartStepId;
  status: UpdateRestartStepStatus;
  detail: string | null;
  updatedAt: string | null;
};

export type PersistedUpdateRestartModalState = {
  stage: 'restarting';
  detail: string;
  stepSnapshot: UpdateRestartStep[] | null;
  startedAtMs: number | null;
};

export type BrowserTaskPhaseVisual = {
  progress: number;
  labelKey: string;
};

export type UpdateProgressLayout = 'compact' | 'expanded';

export type DeleteTarget = { type: 'host'; value: string } | { type: 'command'; id: number } | { type: 'model'; id: string } | { type: 'endpoint'; name: string };

/**
 * 服务商（端点）。`apiKey` 只在表单里用来**输入新值**——后端从不回传它，列表里只有 `hasApiKey`；
 * `revision` 是后端对完整条目（含 key）求的版本号，保存时带回去做乐观锁。
 */
export type EndpointConfig = {
  id: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  hasApiKey?: boolean;
  revision?: string;
  contextLengths?: Record<string, number>;
};

export type SettingsProps = {
  isConnected: boolean;
  settingsTab: SettingsTab;
  onMenuClick: () => void;
  onModelsChanged?: () => void;
  onAgentsChanged?: () => void;
};
