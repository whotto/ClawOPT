/**
 * 运行时管理器的对外形状（spec 04 §2.13–§2.14）。适配器按这里的签名编码。
 */

/** 原生文件：`path` 以 `~/` 开头；`homeEnv` 设了且环境里有值时，`~/<homeDir>` 换成那个目录（CODEX_HOME 之类）。 */
export interface NativeFileSpec {
  path: string;
  language: 'markdown' | 'json' | 'toml' | 'yaml' | 'dotenv' | 'text';
}

export type NativeMcpFormat = 'claude-json' | 'pi-json' | 'opencode-json' | 'codex-toml' | 'grok-toml' | 'dsh-yaml' | 'hermes-yaml';

export interface NativeMcpSpec extends NativeFileSpec {
  format: NativeMcpFormat;
}

export interface SkillsRootSpec {
  path: string;
  /** 多个运行时共用的目录（`~/.agents/skills`）：这些页面里一律只读。 */
  shared: boolean;
}

export interface RuntimeNativeFiles {
  /** `~/<homeDir>` 的覆盖环境变量（CODEX_HOME / GROK_HOME / DSH_HOME / HERMES_HOME）。 */
  homeEnv?: { variable: string; homeDir: string };
  preference?: NativeFileSpec;
  config?: NativeFileSpec;
  mcp?: NativeMcpSpec;
  /** 认证文件：**只报在不在，永远不读内容、不给编辑**。 */
  auth?: NativeFileSpec[];
  skills?: SkillsRootSpec[];
}

export interface RuntimeDescriptor {
  id: string;
  name: string;
  command: string;
  npmPackage?: string;
  pipPackage?: string;
  /** pip 安装时带的 extras（hermes-agent 的 ACP 依赖在 `[acp]` 里，不带就起不来 `hermes acp`）。更新检查仍按包名查。 */
  pipExtras?: string[];
  installKind: 'npm' | 'pip' | 'manual';
  versionArgs: string[];
  officialRegistry?: boolean;
  // ---- 以下为可选扩展（不影响适配器按上面的字段登记） ----
  /** `remote`：不是本机 CLI（如远程 OpenClaw 成员），管理器不探测、不安装。 */
  kind?: 'cli' | 'remote';
  vendor?: string;
  /** 更新检查是否把预发布版当成可升级目标（DSH 目前只发预发布）。 */
  prereleaseAware?: boolean;
  /** pip 运行时的 Python 版本约束（uv venv --python 的写法）。 */
  pythonRequirement?: string;
  nativeFiles?: RuntimeNativeFiles;
}

export type RuntimeMessageCode =
  | 'runtime.notInstalled'
  | 'runtime.updating'
  | 'runtime.unknown'
  | 'runtime.operationInProgress'
  | 'runtime.nodeEnvironmentMissing'
  | 'runtime.pythonMissing'
  | 'runtime.installFailed'
  | 'runtime.installedButNotFound'
  | 'runtime.uninstallFailed'
  | 'runtime.notManagedByClawopt'
  | 'runtime.manualInstallOnly'
  | 'runtime.updateCheckFailed'
  | 'runtime.busy'
  | 'runtime.hostInsufficientMemory'
  | 'runtime.remoteNotManaged';

export class RuntimeManagerError extends Error {
  constructor(readonly messageCode: RuntimeMessageCode, readonly status: number, message: string, readonly detail?: string) {
    super(message);
    this.name = 'RuntimeManagerError';
  }
}

export type UpdateState = 'unknown' | 'checking' | 'current' | 'available' | 'waiting' | 'updating' | 'failed';

export interface RuntimeUpdateStatus {
  state: UpdateState;
  currentVersion: string | null;
  latestVersion: string | null;
  checkedAt: string | null;
  /** 已脱敏。 */
  error: string | null;
}

export interface RuntimeStatus {
  id: string;
  name: string;
  vendor: string | null;
  kind: 'cli' | 'remote';
  installKind: RuntimeDescriptor['installKind'];
  installed: boolean;
  version: string | null;
  /** 可执行文件路径（家目录换成 ~）。 */
  path: string | null;
  /** 所有候选（`which -a`）。 */
  candidates: string[];
  /** 安装来源：npm 全局 / ClawOPT 管理的 venv / 其他（Homebrew cask 之类，ClawOPT 不代管升级卸载）。 */
  source: 'npm-global' | 'managed-venv' | 'external' | null;
  /** ClawOPT 能不能替它升级、卸载。 */
  managed: boolean;
  probeError: string | null;
  probedAt: string;
  update: RuntimeUpdateStatus;
  autoUpdate: boolean;
  locked: boolean;
  preparing: number;
}

export interface RuntimeManager {
  resolveExecutable(id: string): Promise<{ path: string } | { missing: true; messageCode: 'runtime.notInstalled' }>;
  /** 白名单环境 + 扩充过的 PATH + extra。**不继承**白名单外的任何变量（修正参考实现的泄露）。 */
  childEnv(extra: Record<string, string>): NodeJS.ProcessEnv;
  /** 准备计数：升级锁住时抛 `runtime.updating`；返回的函数结束这次准备。 */
  beginRun(id: string): () => void;
  register(descriptor: RuntimeDescriptor): void;
}
