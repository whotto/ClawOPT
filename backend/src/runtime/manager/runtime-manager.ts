/**
 * 运行时管理器（spec 04 §2.13–§2.14）：发现、版本探测、安装 / 升级 / 卸载、更新检查、自动升级、升级锁。
 *
 * ## 升级安全（参考实现吃过的亏都在这里只写一次）
 *
 * - 每个运行时一个**准备计数**：适配器 `beginRun(id)` 到运行真正交出去为止；计数 > 0 或协调器里有这个运行时
 *   的活跃运行，就算忙；
 * - **升级锁**：锁住期间 `beginRun` 直接抛 `runtime.updating`；上锁前同步复查一次忙闲；
 * - **活动版本号**：每次 beginRun 递增；自动升级要求连续空闲 60 秒且版本号没变，才同步复查、上锁、安装；
 * - 同一运行时的安装 / 升级 / 卸载并发 → 409 `runtime.operationInProgress`。
 *
 * ## 不碰系统
 *
 * - npm 装全局（运行 ClawOPT 的那个 node 的 npm，官方源要求的运行时加 `--registry`），版本不钉；
 * - pip 运行时装进 `<数据目录>/runtime/venvs/<id>`（有 uv 用 uv，否则 `python3 -m venv`），**永远不用系统 pip**；
 * - 不是 npm 全局、也不是我们 venv 里的安装（如 Homebrew cask 装的 codex）只探测不代管：升级卸载一律拒绝并说明。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readPrivateText, writePrivateText } from '../platform-store';
import { BUILTIN_RUNTIME_DESCRIPTORS } from './descriptors';
import { probeHostCapabilities, RUNTIME_INSTALL_MIN_FREE_MB, type HostCapabilities } from './host-capabilities';
import { compareVersions, firstSemver, PathAugmenter, pickAllowlistedEnv, pickInstallerEnv, whichAll } from './path-env';
import { defaultProcessRunner, sanitizeProcessOutput, type ProcessResult, type ProcessRunner } from './process-runner';
import { RuntimeHomes, type RuntimeHomeOwner } from './runtime-homes';
import {
  RuntimeManagerError,
  type RuntimeDescriptor,
  type RuntimeManager,
  type RuntimeStatus,
  type RuntimeUpdateStatus,
} from './types';

export const VERSION_PROBE_TIMEOUT_MS = 8000;
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;
export const AUTO_UPDATE_TICK_MS = 60_000;
export const AUTO_UPDATE_IDLE_MS = 60_000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const HOMES_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NPM_OFFICIAL_REGISTRY = 'https://registry.npmjs.org';

export type RuntimeOperation = 'install' | 'update' | 'uninstall' | 'check';

export interface RuntimeOperationRecord {
  op: RuntimeOperation;
  ok: boolean;
  messageCode: string | null;
  /** 给人看的命令行（不含任何变量值）。 */
  command: string | null;
  /** 已脱敏的输出尾部。 */
  output: string;
  finishedAt: string;
}

export interface RuntimeManagerOptions {
  /** `<数据目录>/runtime`。 */
  dataDir: string;
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** 协调器里这个运行时是否有活跃运行（自动升级的忙闲判据之一）。 */
  isRuntimeBusy?: (id: string) => boolean;
  /** 卸载后停掉这个运行时的全部运行。 */
  stopRuntimeRuns?: (id: string) => Promise<void> | void;
  fetchJson?: (url: string, timeoutMs: number) => Promise<any>;
  log?: (message: string) => void;
  hostProbe?: () => Promise<HostCapabilities>;
  /** 见 PathAugmenterOptions.includeHostBins。 */
  includeHostBins?: boolean;
}

interface RuntimeState {
  preparing: number;
  locked: boolean;
  activityRevision: number;
  idleSince: { revision: number; at: number } | null;
  operation: RuntimeOperation | null;
  update: RuntimeUpdateStatus;
  lastCheckAt: number;
  lastOperation: RuntimeOperationRecord | null;
  cachedStatus: RuntimeStatus | null;
}

async function defaultFetchJson(url: string, timeoutMs: number): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function outputTail(result: ProcessResult | null, home: string, lines = 20): string {
  if (!result) return '';
  const text = sanitizeProcessOutput(`${result.stdout}\n${result.stderr}`, { home });
  return text.split('\n').filter((line) => line.trim()).slice(-lines).join('\n');
}

export class LocalRuntimeManager implements RuntimeManager {
  private readonly descriptorsById = new Map<string, RuntimeDescriptor>();
  private readonly states = new Map<string, RuntimeState>();
  private readonly runner: ProcessRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly fetchJson: (url: string, timeoutMs: number) => Promise<any>;
  private readonly pathAugmenter: PathAugmenter;
  private readonly policyFile: string;
  private augmentedPathSnapshot: string | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private tickInFlight: Promise<void> | null = null;
  private lastHomesSweepAt = 0;
  private host: HostCapabilities | null = null;
  readonly homes: RuntimeHomes;
  /** 定期清扫时判断归属还在不在（bootstrap 注入：查会话表与群成员表）。 */
  homeOwnerExists: ((owner: RuntimeHomeOwner) => boolean) | null = null;

  constructor(private readonly options: RuntimeManagerOptions) {
    this.runner = options.runner ?? defaultProcessRunner;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.log(message));
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.policyFile = path.join(options.dataDir, 'update-policy.json');
    this.homes = new RuntimeHomes(options.dataDir, this.now);
    this.pathAugmenter = new PathAugmenter({
      runner: this.runner,
      env: this.env,
      platform: this.platform,
      includeHostBins: options.includeHostBins,
      extraBinDirs: () => [...this.descriptorsById.values()]
        .filter((d) => d.installKind === 'pip')
        .map((d) => this.venvBinDir(d.id)),
    });
    for (const descriptor of BUILTIN_RUNTIME_DESCRIPTORS) this.register(descriptor);
  }

  private get home(): string {
    return this.env.HOME ?? os.homedir();
  }

  // ---------------- 登记 ----------------

  register(descriptor: RuntimeDescriptor): void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(descriptor.id)) throw new Error(`invalid runtime id: ${descriptor.id}`);
    const previous = this.descriptorsById.get(descriptor.id);
    // 适配器自登记时可能只给最基本的字段：内置描述符里的原生文件表等扩展字段保留。
    this.descriptorsById.set(descriptor.id, previous ? { ...previous, ...descriptor, nativeFiles: descriptor.nativeFiles ?? previous.nativeFiles } : descriptor);
    this.state(descriptor.id);
  }

  descriptors(): RuntimeDescriptor[] {
    return [...this.descriptorsById.values()];
  }

  descriptor(id: string): RuntimeDescriptor {
    const descriptor = this.descriptorsById.get(id);
    if (!descriptor) throw new RuntimeManagerError('runtime.unknown', 404, `Unknown runtime: ${id}`);
    return descriptor;
  }

  private state(id: string): RuntimeState {
    let state = this.states.get(id);
    if (!state) {
      state = {
        preparing: 0,
        locked: false,
        activityRevision: 0,
        idleSince: null,
        operation: null,
        update: { state: 'unknown', currentVersion: null, latestVersion: null, checkedAt: null, error: null },
        lastCheckAt: 0,
        lastOperation: null,
        cachedStatus: null,
      };
      this.states.set(id, state);
    }
    return state;
  }

  // ---------------- 环境与发现 ----------------

  /** 预热 PATH 缓存（`childEnv` 是同步的，要用上扩充版就得先算好）。 */
  async warmup(): Promise<string> {
    this.augmentedPathSnapshot = await this.pathAugmenter.augmentedPath();
    return this.augmentedPathSnapshot;
  }

  async augmentedPath(): Promise<string> {
    return this.warmup();
  }

  /** 还没预热时的同步兜底：不起子进程，只拼 node 目录、常见 bin 与原 PATH。 */
  private syncFallbackPath(): string {
    const entries = [
      ...(this.env.PATH ?? '').split(path.delimiter),
      ...this.descriptors().filter((d) => d.installKind === 'pip').map((d) => this.venvBinDir(d.id)),
      path.dirname(process.execPath),
      path.join(this.home, '.npm-global', 'bin'),
      path.join(this.home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    return [...new Set(entries.filter((entry) => entry && path.isAbsolute(entry)))].join(path.delimiter);
  }

  childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env = pickAllowlistedEnv(this.env);
    env.PATH = this.augmentedPathSnapshot ?? this.syncFallbackPath();
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string') env[key] = value;
    }
    return env;
  }

  private installerEnv(): NodeJS.ProcessEnv {
    return { ...this.childEnv({}), ...pickInstallerEnv(this.env) };
  }

  async resolveExecutable(id: string): Promise<{ path: string } | { missing: true; messageCode: 'runtime.notInstalled' }> {
    const descriptor = this.descriptor(id);
    const [first] = whichAll(descriptor.command, await this.augmentedPath(), this.platform);
    return first ? { path: first } : { missing: true, messageCode: 'runtime.notInstalled' };
  }

  // ---------------- 准备计数与升级锁 ----------------

  beginRun(id: string): () => void {
    const state = this.state(id);
    if (state.locked) throw new RuntimeManagerError('runtime.updating', 409, 'Runtime is updating; retry after it completes');
    state.preparing += 1;
    // 空闲计时靠活动版本号失效（调度那一拍看到版本号变了就重新计时），这里不直接清计时器——两套判据只留一套。
    state.activityRevision += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.preparing = Math.max(0, state.preparing - 1);
      state.activityRevision += 1;
    };
  }

  isBusy(id: string): boolean {
    const state = this.state(id);
    return state.preparing > 0 || state.operation !== null || Boolean(this.options.isRuntimeBusy?.(id));
  }

  private lockForUpdate(id: string): () => void {
    const state = this.state(id);
    if (state.locked) throw new RuntimeManagerError('runtime.operationInProgress', 409, 'Runtime update already in progress');
    if (state.preparing > 0 || this.options.isRuntimeBusy?.(id)) {
      throw new RuntimeManagerError('runtime.busy', 409, 'Runtime is preparing or running a task; update postponed');
    }
    state.locked = true;
    return () => { state.locked = false; };
  }

  private beginOperation(id: string, op: RuntimeOperation): () => void {
    const state = this.state(id);
    if (state.operation) throw new RuntimeManagerError('runtime.operationInProgress', 409, `Another ${state.operation} is running for ${id}`);
    state.operation = op;
    return () => { state.operation = null; };
  }

  // ---------------- 状态 ----------------

  private venvDir(id: string): string {
    return path.join(this.options.dataDir, 'venvs', id);
  }

  private venvBinDir(id: string): string {
    return path.join(this.venvDir(id), this.platform === 'win32' ? 'Scripts' : 'bin');
  }

  private classifySource(descriptor: RuntimeDescriptor, executable: string): { source: RuntimeStatus['source']; npmPrefix: string | null } {
    let real = executable;
    try {
      real = fs.realpathSync(executable);
    } catch {
      // 断链：按原路径判
    }
    if (real.startsWith(`${this.venvDir(descriptor.id)}${path.sep}`)) return { source: 'managed-venv', npmPrefix: null };
    if (descriptor.npmPackage) {
      const marker = `${path.sep}lib${path.sep}node_modules${path.sep}${descriptor.npmPackage.split('/').join(path.sep)}${path.sep}`;
      const index = real.indexOf(marker);
      if (index > 0) return { source: 'npm-global', npmPrefix: real.slice(0, index) };
      const winMarker = `${path.sep}node_modules${path.sep}${descriptor.npmPackage.split('/').join(path.sep)}${path.sep}`;
      if (this.platform === 'win32' && real.includes(winMarker)) return { source: 'npm-global', npmPrefix: real.slice(0, real.indexOf(winMarker)) };
    }
    return { source: 'external', npmPrefix: null };
  }

  private displayPath(value: string | null): string | null {
    if (!value) return value;
    return this.home && value.startsWith(this.home) ? `~${value.slice(this.home.length)}` : value;
  }

  private autoUpdatePolicies(): Record<string, { autoUpdate: boolean }> {
    try {
      const parsed = JSON.parse(readPrivateText(this.policyFile) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  setAutoUpdate(id: string, autoUpdate: boolean): void {
    this.descriptor(id);
    const policies = this.autoUpdatePolicies();
    policies[id] = { autoUpdate };
    writePrivateText(this.policyFile, `${JSON.stringify(policies, null, 2)}\n`);
  }

  cachedStatus(id: string): RuntimeStatus | null {
    return this.state(id).cachedStatus;
  }

  lastOperation(id: string): RuntimeOperationRecord | null {
    return this.state(id).lastOperation;
  }

  async status(id: string): Promise<RuntimeStatus> {
    const descriptor = this.descriptor(id);
    const state = this.state(id);
    const base = {
      id,
      name: descriptor.name,
      vendor: descriptor.vendor ?? null,
      kind: descriptor.kind ?? 'cli',
      installKind: descriptor.installKind,
      probedAt: new Date(this.now()).toISOString(),
      update: { ...state.update },
      autoUpdate: this.autoUpdatePolicies()[id]?.autoUpdate === true,
      locked: state.locked,
      preparing: state.preparing,
    } as const;
    if (descriptor.kind === 'remote') {
      const status: RuntimeStatus = { ...base, installed: true, version: null, path: null, candidates: [], source: null, managed: false, probeError: null };
      state.cachedStatus = status;
      return status;
    }
    const searchPath = await this.augmentedPath();
    const candidates = whichAll(descriptor.command, searchPath, this.platform);
    if (candidates.length === 0) {
      const status: RuntimeStatus = { ...base, installed: false, version: null, path: null, candidates: [], source: null, managed: false, probeError: null };
      state.cachedStatus = status;
      return status;
    }
    const executable = candidates[0];
    const result = await this.runner(executable, descriptor.versionArgs, { env: this.childEnv({}), timeoutMs: VERSION_PROBE_TIMEOUT_MS, maxOutputBytes: 256 * 1024 }).catch(() => null);
    const combined = result ? `${result.stdout}\n${result.stderr}` : '';
    const version = result && result.code === 0 ? firstSemver(combined) : null;
    const { source } = this.classifySource(descriptor, executable);
    const status: RuntimeStatus = {
      ...base,
      installed: true,
      version,
      path: this.displayPath(executable),
      candidates: candidates.map((candidate) => this.displayPath(candidate)!),
      source,
      managed: source === 'npm-global' || source === 'managed-venv',
      probeError: result && result.code === 0 && version ? null : sanitizeProcessOutput(result?.spawnError ?? (result?.timedOut ? 'version probe timed out' : combined), { home: this.home, maxLines: 4 }) || 'version probe failed',
    };
    if (version) state.update.currentVersion = version;
    state.cachedStatus = status;
    return status;
  }

  async statusAll(): Promise<RuntimeStatus[]> {
    return Promise.all(this.descriptors().map((descriptor) => this.status(descriptor.id)));
  }

  // ---------------- 主机能力 ----------------

  async hostCapabilities(refresh = false): Promise<HostCapabilities> {
    if (this.host && !refresh) return this.host;
    this.host = await (this.options.hostProbe?.() ?? probeHostCapabilities({ runner: this.runner, searchPath: await this.augmentedPath(), env: this.childEnv({}) }));
    return this.host;
  }

  // ---------------- 安装 / 升级 / 卸载 ----------------

  private record(id: string, record: Omit<RuntimeOperationRecord, 'finishedAt'>): RuntimeOperationRecord {
    const full = { ...record, finishedAt: new Date(this.now()).toISOString() };
    this.state(id).lastOperation = full;
    return full;
  }

  private async npmCommand(): Promise<string> {
    const sibling = path.join(path.dirname(process.execPath), this.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (whichAll(sibling, '', this.platform).length > 0) return sibling;
    const [found] = whichAll('npm', await this.augmentedPath(), this.platform);
    if (!found) throw new RuntimeManagerError('runtime.nodeEnvironmentMissing', 422, 'Node/npm environment was not detected');
    return found;
  }

  private async assertHostAllowsInstall(descriptor: RuntimeDescriptor): Promise<void> {
    const host = await this.hostCapabilities(true);
    if (host.memory.freeMb < RUNTIME_INSTALL_MIN_FREE_MB) {
      throw new RuntimeManagerError('runtime.hostInsufficientMemory', 422, `Only ${host.memory.freeMb} MB memory available`);
    }
    if (descriptor.installKind === 'pip' && !host.tools.uv && !host.tools.python3) {
      throw new RuntimeManagerError('runtime.pythonMissing', 422, 'Neither uv nor python3 was found');
    }
  }

  /** 安装；已装且可代管时等同升级。 */
  async install(id: string, options: { mode?: 'install' | 'update'; automatic?: boolean } = {}): Promise<{ status: RuntimeStatus; operation: RuntimeOperationRecord }> {
    const descriptor = this.descriptor(id);
    const op: RuntimeOperation = options.mode ?? 'install';
    if (descriptor.kind === 'remote') throw new RuntimeManagerError('runtime.remoteNotManaged', 422, 'Remote runtimes are not installed locally');
    if (descriptor.installKind === 'manual') throw new RuntimeManagerError('runtime.manualInstallOnly', 422, 'This runtime must be installed manually');
    const endOperation = this.beginOperation(id, op);
    let unlock: (() => void) | null = null;
    const state = this.state(id);
    try {
      const before = await this.status(id);
      if (before.installed && !before.managed) {
        throw new RuntimeManagerError('runtime.notManagedByClawopt', 409, `Installed outside ClawOPT (${before.path ?? 'unknown path'}); update it with the tool that installed it`);
      }
      await this.assertHostAllowsInstall(descriptor);
      if (before.installed) unlock = this.lockForUpdate(id);
      state.update = { ...state.update, state: 'updating', error: null };

      const result = descriptor.installKind === 'npm' ? await this.npmInstall(descriptor) : await this.pipInstall(descriptor);
      this.pathAugmenter.invalidate();
      await this.warmup();
      if (result.code !== 0) {
        const output = outputTail(result.process, this.home);
        state.update = { ...state.update, state: 'failed', error: output.split('\n').slice(-4).join('\n') || 'install failed' };
        const operation = this.record(id, { op, ok: false, messageCode: result.spawnMissing ? 'runtime.nodeEnvironmentMissing' : 'runtime.installFailed', command: result.display, output });
        throw Object.assign(new RuntimeManagerError(operation.messageCode as any, 500, 'Install failed', output), { operation });
      }
      const after = await this.status(id);
      if (!after.installed) {
        const operation = this.record(id, { op, ok: false, messageCode: 'runtime.installedButNotFound', command: result.display, output: outputTail(result.process, this.home) });
        state.update = { ...state.update, state: 'unknown' };
        throw Object.assign(new RuntimeManagerError('runtime.installedButNotFound', 500, 'Install completed but the command was not found', operation.output), { operation });
      }
      // 装完再查一次最新版；查失败只说「不知道」，不说「已是最新」。
      state.update = { state: 'unknown', currentVersion: after.version, latestVersion: null, checkedAt: null, error: null };
      await this.checkUpdateInternal(descriptor).catch(() => undefined);
      const operation = this.record(id, { op, ok: true, messageCode: null, command: result.display, output: outputTail(result.process, this.home, 8) });
      if (options.automatic) this.log(`[RuntimeManager] auto-updated ${id} to ${after.version ?? 'unknown'}`);
      return { status: await this.status(id), operation };
    } finally {
      unlock?.();
      endOperation();
    }
  }

  private async npmInstall(descriptor: RuntimeDescriptor): Promise<{ code: number | null; process: ProcessResult | null; display: string; spawnMissing: boolean }> {
    const npm = await this.npmCommand();
    const args = ['install', '-g', `${descriptor.npmPackage}@latest`];
    if (descriptor.officialRegistry) args.push(`--registry=${NPM_OFFICIAL_REGISTRY}`);
    const env = this.installerEnv();
    env.PATH = [path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter);
    const result = await this.runner(npm, args, { env, timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 10 * 1024 * 1024 });
    return { code: result.timedOut ? null : result.code, process: result, display: `npm ${args.join(' ')}`, spawnMissing: result.spawnError === 'ENOENT' };
  }

  private async pipInstall(descriptor: RuntimeDescriptor): Promise<{ code: number | null; process: ProcessResult | null; display: string; spawnMissing: boolean }> {
    const searchPath = await this.augmentedPath();
    const env = this.installerEnv();
    const venv = this.venvDir(descriptor.id);
    const python = path.join(this.venvBinDir(descriptor.id), this.platform === 'win32' ? 'python.exe' : 'python');
    fs.mkdirSync(path.dirname(venv), { recursive: true, mode: 0o700 });
    const [uv] = whichAll('uv', searchPath, this.platform);
    const steps: Array<{ command: string; args: string[]; display: string }> = [];
    const venvExists = whichAll(python, '', this.platform).length > 0;
    if (uv) {
      if (!venvExists) steps.push({ command: uv, args: ['venv', '--python', descriptor.pythonRequirement ?? '>=3.10', venv], display: `uv venv --python "${descriptor.pythonRequirement ?? '>=3.10'}" <data>/runtime/venvs/${descriptor.id}` });
      steps.push({ command: uv, args: ['pip', 'install', '--python', python, '--upgrade', descriptor.pipPackage!], display: `uv pip install --python <venv>/bin/python --upgrade ${descriptor.pipPackage}` });
    } else {
      const [python3] = whichAll('python3', searchPath, this.platform);
      if (!python3) throw new RuntimeManagerError('runtime.pythonMissing', 422, 'Neither uv nor python3 was found');
      if (!venvExists) steps.push({ command: python3, args: ['-m', 'venv', venv], display: `python3 -m venv <data>/runtime/venvs/${descriptor.id}` });
      steps.push({ command: python, args: ['-m', 'pip', 'install', '--upgrade', descriptor.pipPackage!], display: `<venv>/bin/python -m pip install --upgrade ${descriptor.pipPackage}` });
    }
    let last: ProcessResult | null = null;
    for (const step of steps) {
      last = await this.runner(step.command, step.args, { env, timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 10 * 1024 * 1024 });
      if (last.code !== 0 || last.timedOut) return { code: last.timedOut ? null : last.code, process: last, display: step.display, spawnMissing: false };
    }
    return { code: 0, process: last, display: steps.map((s) => s.display).join(' && '), spawnMissing: false };
  }

  async uninstall(id: string): Promise<{ status: RuntimeStatus; operation: RuntimeOperationRecord }> {
    const descriptor = this.descriptor(id);
    if (descriptor.kind === 'remote') throw new RuntimeManagerError('runtime.remoteNotManaged', 422, 'Remote runtimes are not installed locally');
    const endOperation = this.beginOperation(id, 'uninstall');
    let unlock: (() => void) | null = null;
    try {
      const before = await this.status(id);
      if (!before.installed) {
        const operation = this.record(id, { op: 'uninstall', ok: true, messageCode: null, command: null, output: '' });
        return { status: before, operation };
      }
      if (!before.managed) {
        throw new RuntimeManagerError('runtime.notManagedByClawopt', 409, `Installed outside ClawOPT (${before.path ?? 'unknown path'}); uninstall it with the tool that installed it`);
      }
      unlock = this.lockForUpdate(id);
      await this.options.stopRuntimeRuns?.(id);
      let display = '';
      let last: ProcessResult | null = null;
      if (descriptor.installKind === 'pip') {
        fs.rmSync(this.venvDir(id), { recursive: true, force: true });
        display = `rm -rf <data>/runtime/venvs/${id}`;
      } else {
        const npm = await this.npmCommand();
        const prefixes = new Set<string>();
        for (const candidate of whichAll(descriptor.command, await this.augmentedPath(), this.platform)) {
          const { source, npmPrefix } = this.classifySource(descriptor, candidate);
          if (source === 'npm-global' && npmPrefix) prefixes.add(npmPrefix);
        }
        const env = this.installerEnv();
        env.PATH = [path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter);
        for (const prefix of prefixes) {
          const args = ['uninstall', '-g', '--prefix', prefix, descriptor.npmPackage!];
          display = `npm uninstall -g --prefix ${this.displayPath(prefix)} ${descriptor.npmPackage}`;
          last = await this.runner(npm, args, { env, timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 10 * 1024 * 1024 });
          if (last.code !== 0) {
            const operation = this.record(id, { op: 'uninstall', ok: false, messageCode: 'runtime.uninstallFailed', command: display, output: outputTail(last, this.home) });
            throw Object.assign(new RuntimeManagerError('runtime.uninstallFailed', 500, 'Uninstall failed', operation.output), { operation });
          }
        }
      }
      this.pathAugmenter.invalidate();
      await this.warmup();
      const state = this.state(id);
      state.update = { state: 'unknown', currentVersion: null, latestVersion: null, checkedAt: null, error: null };
      const operation = this.record(id, { op: 'uninstall', ok: true, messageCode: null, command: display, output: outputTail(last, this.home, 8) });
      return { status: await this.status(id), operation };
    } finally {
      unlock?.();
      endOperation();
    }
  }

  // ---------------- 更新检查与自动升级 ----------------

  private async latestVersion(descriptor: RuntimeDescriptor): Promise<string> {
    if (descriptor.installKind === 'pip' && descriptor.pipPackage) {
      const json = await this.fetchJson(`https://pypi.org/pypi/${encodeURIComponent(descriptor.pipPackage)}/json`, UPDATE_CHECK_TIMEOUT_MS);
      const version = typeof json?.info?.version === 'string' ? json.info.version : null;
      if (!version) throw new Error('PyPI response has no version');
      return version;
    }
    const npm = await this.npmCommand();
    const args = ['view', descriptor.npmPackage!, 'version'];
    if (descriptor.officialRegistry) args.push(`--registry=${NPM_OFFICIAL_REGISTRY}`);
    const env = this.installerEnv();
    env.PATH = [path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter);
    const result = await this.runner(npm, args, { env, timeoutMs: UPDATE_CHECK_TIMEOUT_MS, maxOutputBytes: 256 * 1024 });
    const version = result.code === 0 ? firstSemver(result.stdout) : null;
    if (!version) throw new Error(outputTail(result, this.home, 4) || 'npm view failed');
    return version;
  }

  private async checkUpdateInternal(descriptor: RuntimeDescriptor): Promise<RuntimeUpdateStatus> {
    const state = this.state(descriptor.id);
    const current = state.update.currentVersion ?? (await this.status(descriptor.id)).version;
    state.update = { ...state.update, state: 'checking' };
    try {
      const latest = await this.latestVersion(descriptor);
      const latestIsPrerelease = latest.includes('-');
      let next: RuntimeUpdateStatus['state'];
      if (!current) next = 'unknown';
      else if (latestIsPrerelease && !descriptor.prereleaseAware) next = 'current';
      else next = compareVersions(latest, current) > 0 ? 'available' : 'current';
      state.update = { state: next, currentVersion: current, latestVersion: latest, checkedAt: new Date(this.now()).toISOString(), error: null };
    } catch (error) {
      // 查失败永远不报「已是最新」。
      state.update = {
        state: 'failed',
        currentVersion: current,
        latestVersion: state.update.latestVersion,
        checkedAt: new Date(this.now()).toISOString(),
        error: sanitizeProcessOutput((error as Error)?.message ?? 'update check failed', { home: this.home, maxLines: 4 }),
      };
    }
    state.lastCheckAt = this.now();
    return { ...state.update };
  }

  async checkUpdate(id: string): Promise<RuntimeUpdateStatus> {
    const descriptor = this.descriptor(id);
    if (descriptor.kind === 'remote' || descriptor.installKind === 'manual') return { ...this.state(id).update };
    return this.checkUpdateInternal(descriptor);
  }

  updateStatuses(): Record<string, RuntimeUpdateStatus & { autoUpdate: boolean }> {
    const policies = this.autoUpdatePolicies();
    const out: Record<string, RuntimeUpdateStatus & { autoUpdate: boolean }> = {};
    for (const descriptor of this.descriptors()) {
      out[descriptor.id] = { ...this.state(descriptor.id).update, autoUpdate: policies[descriptor.id]?.autoUpdate === true };
    }
    return out;
  }

  /** 自动升级调度的一拍（单飞）。也负责定期清扫运行时目录。 */
  tick(): Promise<void> {
    if (!this.tickInFlight) {
      this.tickInFlight = this.runTick().catch((error) => {
        this.log(`[RuntimeManager] tick failed: ${(error as Error)?.name ?? 'Error'}`);
      }).finally(() => { this.tickInFlight = null; });
    }
    return this.tickInFlight;
  }

  private async runTick(): Promise<void> {
    if (this.homeOwnerExists && this.now() - this.lastHomesSweepAt > HOMES_SWEEP_INTERVAL_MS) {
      this.lastHomesSweepAt = this.now();
      const removed = this.homes.sweep(this.homeOwnerExists);
      if (removed.length > 0) this.log(`[RuntimeManager] removed ${removed.length} runtime home(s)`);
    }
    const policies = this.autoUpdatePolicies();
    for (const descriptor of this.descriptors()) {
      if (policies[descriptor.id]?.autoUpdate !== true || descriptor.kind === 'remote' || descriptor.installKind === 'manual') continue;
      const state = this.state(descriptor.id);
      const cached = state.cachedStatus ?? await this.status(descriptor.id);
      if (!cached.installed || !cached.managed) continue;
      if (this.now() - state.lastCheckAt > UPDATE_CHECK_INTERVAL_MS && state.operation === null) {
        await this.checkUpdateInternal(descriptor);
      }
      if (state.update.state !== 'available' && state.update.state !== 'waiting') continue;
      if (this.isBusy(descriptor.id)) {
        state.update = { ...state.update, state: 'waiting' };
        state.idleSince = null;
        continue;
      }
      if (!state.idleSince || state.idleSince.revision !== state.activityRevision) {
        state.idleSince = { revision: state.activityRevision, at: this.now() };
        state.update = { ...state.update, state: 'waiting' };
        continue;
      }
      if (this.now() - state.idleSince.at < AUTO_UPDATE_IDLE_MS) continue;
      // 上锁前同步复查：策略可能刚被关掉、可能刚有运行开始。
      if (this.autoUpdatePolicies()[descriptor.id]?.autoUpdate !== true || this.isBusy(descriptor.id) || state.idleSince.revision !== state.activityRevision) continue;
      try {
        await this.install(descriptor.id, { mode: 'update', automatic: true });
      } catch (error) {
        this.log(`[RuntimeManager] auto-update of ${descriptor.id} failed: ${(error as RuntimeManagerError)?.messageCode ?? 'Error'}`);
      }
      state.idleSince = null;
    }
  }

  start(): void {
    if (this.tickTimer) return;
    void this.warmup().catch(() => undefined);
    this.tickTimer = setInterval(() => { void this.tick(); }, AUTO_UPDATE_TICK_MS);
    this.tickTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
}

export function createRuntimeManager(options: RuntimeManagerOptions): LocalRuntimeManager {
  return new LocalRuntimeManager(options);
}
