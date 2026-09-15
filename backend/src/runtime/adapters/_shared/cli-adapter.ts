/**
 * 编码类外部运行时的通用适配器骨架。
 *
 * 每个运行时只提供一份 `RuntimeDefinition`：描述符、能力、仲裁表、怎么准备启动（文件 + 参数 + 环境，纯数据）、
 * 怎么把原生输出翻译成规范事件（`TurnDriver`）。这里把它们接成 `AgentRuntimeAdapter`：
 *
 * 准备段：更新锁 → 定位可执行文件 → 模式与凭据检查 → 运行时 home 与续话判定 → 注册代理目标（scoped）
 *        → 解析托管 MCP → 生成文件并落盘 → 组装子进程环境（白名单）
 * 运行段：执行器起进程 → 逐行交给驱动 → 代理 tee 原样转发（仲裁在协调器）
 * 收尾：**只在 `close` 之后**判终态、发 completed/failed、写续话状态、撤销代理目标、清临时文件。
 *
 * 中止：协调器触发 signal → 驱动先做协议层取消（Pi `abort`、ACP `session/cancel`）→ 进程组 SIGINT，
 * 1.5 秒后 SIGKILL → 等 `close` 才确认已停（synced）。
 *
 * 这里**不写**会话行、排队、陈旧判断、落库、用量去重——那些在协调器里。
 */
import os from 'os';
import path from 'path';
import { randomUUID as nodeRandomUUID } from 'crypto';
import type {
  AdapterRunContext,
  AdapterRunHandle,
  AdapterRunOutcome,
  AgentRuntimeAdapter,
  ApprovalDecision,
  CanonicalEvent,
  InterruptReason,
  ProxyMode,
  RuntimeCapabilities,
  SourceOfTruthTable,
} from '../../contract';
import type { ManagedMcpServer } from '../../mcp/types';
import type { RegisteredProxyTarget } from '../../proxy/types';
import type { RuntimeDescriptor } from '../../manager/types';
import { buildChildEnv } from './env';
import {
  OAUTH_ONLY_PROVIDERS,
  RuntimeAdapterError,
  detectGatewayErrorText,
  type RuntimeMessageCode,
} from './errors';
import { composeInstructions } from './managed-prompt';
import type { ProcessExit, RunningProcess } from './process';
import { createNodeRuntimeFs, materializeFiles, type PlannedFile, type RuntimeFs } from './runtime-fs';
import { sanitizeRuntimeText, tailLines } from './sanitize';
import {
  decideResume,
  fingerprintsCompatible,
  fingerprintFor,
  readSessionState,
  writeSessionState,
  type LaunchFingerprint,
  type NativeSessionIdPolicy,
  type ResumeDecision,
} from './session-state';
import { TurnEmitter } from './turn';
import type { CodingAgentAdapterDeps, CodingAgentRunRequest, SessionCommand } from './types';

/** 空闲（没有任何输出）多久算这一轮死了。参考实现的 runner 空闲回收也是 30 分钟。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface PrepareContext {
  runtimeId: string;
  runId: string;
  request: CodingAgentRunRequest;
  mode: ProxyMode;
  command: SessionCommand;
  homeDir: string;
  workspace: string;
  executablePath: string;
  resume: ResumeDecision;
  fingerprint: LaunchFingerprint;
  /** 这一轮的指令（群聊系统提示替换基础提示，追加指令在后）。 */
  instructions: string;
  mcpServers: ManagedMcpServer[];
  proxyTarget: RegisteredProxyTarget | null;
  /** 用户真实 home（读全局配置用，只读）。 */
  userHome: string;
  fs: RuntimeFs;
  processEnv: NodeJS.ProcessEnv;
  randomUUID: () => string;
  now: () => number;
}

export interface PreparedLaunch {
  files: PlannedFile[];
  args: string[];
  launchEnv: Record<string, string>;
  stdin: 'ignore' | 'pipe';
  /** 写完立刻关 stdin（prompt 走 stdin 的运行时）。RPC 类运行时由驱动自己写。 */
  stdinData?: string;
  cwd?: string;
  /** 收尾时删除（Grok 的一次性 prompt 文件）。 */
  cleanupPaths?: string[];
}

export interface ProcessIo {
  write(data: string): boolean;
  endStdin(): void;
  /** 让进程组停下（驱动在协议层确认本轮结束后调用，例如 Pi 的 agent_settled）。 */
  terminate(): Promise<ProcessExit>;
}

export interface TurnDriverContext {
  runId: string;
  agentId: string;
  request: CodingAgentRunRequest;
  mode: ProxyMode;
  command: SessionCommand;
  prepared: PreparedLaunch;
  resume: ResumeDecision;
  /** 通过了运行前探测的 MCP 服务（ACP 类运行时经 session/new 注入）。 */
  mcpServers: ManagedMcpServer[];
  emitter: TurnEmitter;
  /** 审批、澄清这类控制事件。 */
  emitControl(event: CanonicalEvent): void;
  io: ProcessIo;
  log: CodingAgentAdapterDeps['logger'];
}

export type TurnVerdict =
  | { kind: 'completed'; stopReason?: string; outputText?: string }
  | { kind: 'failed'; messageCode: RuntimeMessageCode; detail: string; stopReason?: string };

export interface FinishInput {
  exit: ProcessExit;
  stderrTail: string;
  /** 这一轮是被中止的（驱动可据此不把 SIGINT 退出当成错误）。 */
  cancelled: boolean;
}

export interface TurnDriver {
  /** 进程起来之后（RPC 类运行时在这里发请求）。 */
  start?(): void;
  onLine(line: string): void;
  onStderr?(chunk: string): void;
  /** 协议层取消；之后骨架会停掉进程组。 */
  requestCancel?(): void;
  /** `close` 之后判终态。**只在这里**决定成败。 */
  finish(input: FinishInput): TurnVerdict;
  resolveApproval?(approvalId: string, decision: ApprovalDecision): boolean;
  resolveClarify?(clarifyId: string, response: string): boolean;
}

export interface RuntimeDefinition {
  descriptor: RuntimeDescriptor;
  capabilities: Readonly<RuntimeCapabilities>;
  sourceOfTruth: Readonly<SourceOfTruthTable>;
  nativeSessionIds: NativeSessionIdPolicy;
  /** global 模式放行的凭据环境变量（按名字）。 */
  globalCredentialEnv: readonly RegExp[];
  supportsCommand(kind: SessionCommand['kind'], mode: ProxyMode): boolean;
  /** 退出码 0 但终文是网关错误时判失败（Claude 原生结果有自己的错误位，不走这条）。 */
  detectGatewayErrorText: boolean;
  prepare(ctx: PrepareContext): PreparedLaunch | Promise<PreparedLaunch>;
  createDriver(ctx: TurnDriverContext): TurnDriver;
  idleTimeoutMs?: number;
}

export interface CodingAgentRuntimeAdapter extends AgentRuntimeAdapter<CodingAgentRunRequest> {
  readonly descriptor: RuntimeDescriptor;
}

function failedOutcome(code: RuntimeMessageCode, detail: string, stopReason?: string): AdapterRunOutcome {
  return { kind: 'failed', error: detail, code, stopReason };
}

export function createCodingAgentAdapter(definition: RuntimeDefinition, deps: CodingAgentAdapterDeps): CodingAgentRuntimeAdapter {
  const runtimeFs = deps.fs ?? createNodeRuntimeFs();
  const userHome = deps.homeDir ?? os.homedir();
  const processEnv = deps.processEnv ?? process.env;
  const makeUUID = deps.randomUUID ?? nodeRandomUUID;
  const now = deps.now ?? Date.now;
  const runtimeId = definition.descriptor.id;

  return {
    id: runtimeId,
    descriptor: definition.descriptor,
    capabilities: definition.capabilities,
    sourceOfTruth: definition.sourceOfTruth,
    start(context: AdapterRunContext<CodingAgentRunRequest>): AdapterRunHandle {
      // scoped 且表面没直接给上游时，准备段按成员 / 会话配置解析一次（见 resolveScopedProvider），之后整轮用同一份。
      let request = context.request;
      const mode: ProxyMode = context.proxyMode ?? request.mode ?? 'global';
      const command: SessionCommand = request.command ?? { kind: 'turn' };
      const emitter = new TurnEmitter(context.runId, (event) => onAdapterEvent(event.event));
      let phase: 'preparing' | 'running' | 'finished' = 'preparing';
      let interruptReason: InterruptReason | null = null;
      let cancelled = false;
      let child: RunningProcess | null = null;
      let driver: TurnDriver | null = null;
      let nativeRunId: string | undefined;
      let confirmedNativeId: string | null = null;
      let homeDir = '';
      let fingerprint: LaunchFingerprint | null = null;
      let decision: ResumeDecision | null = null;

      const persistState = (nativeSessionId: string, confirmed: boolean) => {
        if (!homeDir || !fingerprint) return;
        try {
          writeSessionState(runtimeFs, homeDir, {
            version: 1,
            sessionId: request.sessionId,
            nativeSessionId,
            confirmed,
            fingerprint,
            updatedAt: new Date(now()).toISOString(),
          });
        } catch (error) {
          deps.logger.warn(`[${runtimeId}] 写续话状态失败`, { detail: sanitizeRuntimeText(String((error as Error)?.message ?? error)) });
        }
      };

      function onAdapterEvent(event: CanonicalEvent): void {
        if (event.type === 'runtime.native_session') {
          // 输出里确认过的原生 id：立刻记下，首轮中途崩了下一轮也能续。
          if (event.nativeSessionId !== confirmedNativeId) {
            confirmedNativeId = event.nativeSessionId;
            nativeRunId = event.nativeSessionId;
            persistState(event.nativeSessionId, true);
          }
        }
        context.emit({ channel: 'native', event });
      }

      const stopChild = () => {
        if (!child) return;
        try { driver?.requestCancel?.(); } catch { /* 协议层取消失败不妨碍杀进程 */ }
        void child.terminate();
      };
      const onAbort = () => {
        cancelled = true;
        stopChild();
      };
      context.signal.addEventListener('abort', onAbort, { once: true });

      const run = async (): Promise<AdapterRunOutcome> => {
        let release: (() => void) | null = null;
        let proxyTarget: RegisteredProxyTarget | null = null;
        let unsubscribeProxy: (() => void) | null = null;
        let prepared: PreparedLaunch | null = null;
        const abortedInPreparing = (): AdapterRunOutcome => ({ kind: 'aborted', reason: interruptReason ?? 'user_stop', synced: true, phase: 'preparing' });

        try {
          try {
            release = deps.manager.beginRun(runtimeId);
          } catch (error) {
            const code = (error as any)?.messageCode === 'runtime.updating' ? 'runtime.updating' : 'runtime.launchFailed';
            return failedOutcome(code, sanitizeRuntimeText(String((error as Error)?.message ?? error)));
          }
          if (!definition.supportsCommand(command.kind, mode)) {
            return failedOutcome('runtime.commandUnsupported', `${definition.descriptor.name} does not support ${command.kind} in ${mode} mode`);
          }
          if (!definition.capabilities.proxyMode.includes(mode)) {
            return failedOutcome('runtime.modeUnsupported', `${definition.descriptor.name} does not support ${mode} mode`);
          }
          if (mode === 'scoped') {
            if (!request.provider && deps.resolveScopedProvider) {
              const resolved = deps.resolveScopedProvider(request.runtimeConfig, runtimeId);
              if (resolved) request = { ...request, provider: resolved };
            }
            const provider = request.provider;
            if (provider && OAUTH_ONLY_PROVIDERS.has(provider.provider)) {
              return failedOutcome('runtime.oauthProviderScopedUnsupported', `provider ${provider.provider} requires global mode`);
            }
            if (!provider?.model) return failedOutcome('runtime.modelRequired', 'scoped mode requires a model');
            if (!provider.baseUrl || !provider.apiKey) {
              return failedOutcome('runtime.providerCredentialsMissing', `provider ${provider.provider} is missing base URL or API key`);
            }
          }

          const executable = await deps.manager.resolveExecutable(runtimeId);
          if ('missing' in executable) {
            return failedOutcome('runtime.notInstalled', `${definition.descriptor.name} (${definition.descriptor.command}) is not installed or not on PATH`);
          }
          if (context.signal.aborted) return abortedInPreparing();

          // 运行时目录由平台发（带归属标记）：删会话 / 删成员 / 删群时回收，定期清扫孤儿与久未使用的。
          homeDir = deps.homes.ensureHome(runtimeId, request.owner);
          runtimeFs.mkdirp(homeDir);
          fingerprint = fingerprintFor(runtimeId, request, mode);
          const ownState = readSessionState(runtimeFs, homeDir);
          let forkSource: { nativeSessionId: string } | null = null;
          if (request.forkFrom && definition.capabilities.nativeFork && !(ownState?.confirmed && ownState.nativeSessionId)) {
            // 分叉来源必须是父归属里 CLI 确认过、坐标兼容的原生会话；没有就明说失败——
            // 悄悄开个新会话，界面上带着拷来的历史而运行时什么都不记得，是假分叉。
            const parent = readSessionState(runtimeFs, deps.homes.ensureHome(runtimeId, request.forkFrom));
            if (!parent?.confirmed || !parent.nativeSessionId || !fingerprintsCompatible(parent.fingerprint, fingerprint)) {
              return failedOutcome('runtime.forkSourceUnavailable', `${definition.descriptor.name}: the parent conversation has no resumable native session to fork from`);
            }
            forkSource = { nativeSessionId: parent.nativeSessionId };
          }
          decision = decideResume({
            policy: definition.nativeSessionIds,
            state: ownState,
            request,
            fingerprint,
            randomUUID: makeUUID,
            forkSource,
          });
          if (decision.resumeNativeId) nativeRunId = decision.resumeNativeId;
          if (decision.createNativeId) {
            nativeRunId = decision.createNativeId;
            // 预生成的 id 在首轮之前就记下（未确认）：首轮崩在半路，下一轮沿用同一个 id 再建。
            persistState(decision.createNativeId, false);
          }

          if (mode === 'scoped' && request.provider) {
            const provider = request.provider;
            proxyTarget = deps.proxy.register({
              provider: provider.provider,
              model: provider.model,
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              apiMode: provider.apiMode,
              reasoningEffort: provider.reasoningEffort ?? request.reasoningEffort,
              runtime: runtimeId,
              runId: context.runId,
              sessionId: context.sessionKey,
            });
            unsubscribeProxy = deps.proxy.onCanonicalEvent(context.runId, (event) => {
              context.emit({ channel: 'proxy', event });
            });
          }

          // scoped 的运行副本 = 用户在这个运行时全局 MCP 文件里启用的服务（global 模式 CLI 自己读，不重复注入）+ 托管服务；
          // 注入器逐个探测，坏的只从这一次的副本里剔除。
          let userServers = request.userMcpServers;
          if (!userServers && mode === 'scoped' && deps.userMcpServers) {
            try {
              userServers = deps.userMcpServers(runtimeId);
            } catch (error) {
              deps.logger.warn(`[${runtimeId}] 读用户 MCP 配置失败，本轮不合并用户服务`, { detail: sanitizeRuntimeText(String((error as Error)?.message ?? error)) });
            }
          }
          const mcp = await deps.mcp.resolveForRun({ runtime: runtimeId, userServers: userServers ?? [] });
          for (const excluded of mcp.excluded) {
            deps.logger.warn(`[${runtimeId}] MCP 服务未通过运行前探测，本轮不注入`, { name: excluded.name, reason: excluded.reason });
          }
          if (context.signal.aborted) return abortedInPreparing();

          prepared = await definition.prepare({
            runtimeId,
            runId: context.runId,
            request,
            mode,
            command,
            homeDir,
            workspace: request.workspace,
            executablePath: executable.path,
            resume: decision,
            fingerprint,
            instructions: composeInstructions(request),
            mcpServers: mcp.servers,
            proxyTarget,
            userHome,
            fs: runtimeFs,
            processEnv,
            randomUUID: makeUUID,
            now,
          });
          materializeFiles(prepared.files, runtimeFs);
          if (context.signal.aborted) return abortedInPreparing();

          const env = buildChildEnv({
            mode,
            manager: deps.manager,
            launchEnv: prepared.launchEnv,
            processEnv,
            globalCredentialEnv: definition.globalCredentialEnv,
          });

          let idleTimer: NodeJS.Timeout | undefined;
          let idleExpired = false;
          const idleMs = definition.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
          const touch = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              idleExpired = true;
              stopChild();
            }, idleMs);
            idleTimer.unref?.();
          };

          const launchedPrepared = prepared;
          child = deps.executor(
            { command: executable.path, args: prepared.args, cwd: prepared.cwd ?? request.workspace, env, stdin: prepared.stdin },
            {
              onStdoutLine: (line) => {
                touch();
                driver?.onLine(line);
              },
              onStderr: (chunk) => {
                touch();
                driver?.onStderr?.(chunk);
              },
            },
          );
          const io: ProcessIo = {
            write: (data) => child!.write(data),
            endStdin: () => child!.endStdin(),
            terminate: () => child!.terminate(),
          };
          driver = definition.createDriver({
            runId: context.runId,
            agentId: context.agentId,
            request,
            mode,
            command,
            prepared: launchedPrepared,
            resume: decision,
            mcpServers: mcp.servers,
            emitter,
            emitControl: (event) => onAdapterEvent(event),
            io,
            log: deps.logger,
          });
          phase = 'running';
          touch();
          if (prepared.stdin === 'pipe' && prepared.stdinData !== undefined) {
            io.write(prepared.stdinData);
            io.endStdin();
          }
          driver.start?.();
          if (context.signal.aborted) onAbort();

          const exit = await child.closed;
          if (idleTimer) clearTimeout(idleTimer);
          const stderrTail = tailLines(child.stderrTail());

          if (exit.spawnError) {
            const missing = exit.spawnError.code === 'ENOENT';
            const code: RuntimeMessageCode = missing ? 'runtime.notInstalled' : 'runtime.launchFailed';
            emitter.failed(exit.spawnError.message, code);
            return failedOutcome(code, exit.spawnError.message);
          }

          if (cancelled && !idleExpired) {
            // 驱动仍然有机会把已经到手的正文收个尾（例如 Pi 的 aborted 消息），但终态是中止。
            driver.finish({ exit, stderrTail, cancelled: true });
            return { kind: 'aborted', reason: interruptReason ?? 'user_stop', synced: true, phase: 'running' };
          }

          let verdict = driver.finish({ exit, stderrTail, cancelled: false });
          if (idleExpired) {
            verdict = { kind: 'failed', messageCode: 'runtime.sessionClosed', detail: `no output for ${Math.round(idleMs / 1000)} s`, stopReason: 'idle_timeout' };
          }
          if (verdict.kind === 'completed' && definition.detectGatewayErrorText) {
            const gatewayError = detectGatewayErrorText(verdict.outputText ?? emitter.text);
            if (gatewayError) verdict = { kind: 'failed', messageCode: 'runtime.apiError', detail: gatewayError };
          }

          if (verdict.kind === 'completed') {
            emitter.completed(verdict.stopReason, verdict.outputText);
            return { kind: 'completed', outputText: verdict.outputText ?? emitter.text, stopReason: verdict.stopReason };
          }
          emitter.failed(verdict.detail, verdict.messageCode);
          return failedOutcome(verdict.messageCode, verdict.detail, verdict.stopReason);
        } catch (error) {
          const code = error instanceof RuntimeAdapterError ? error.messageCode : 'runtime.launchFailed';
          const detail = sanitizeRuntimeText(String((error as Error)?.message ?? error), { homeDir: userHome });
          if (phase === 'running') emitter.failed(detail, code);
          if (child) await child.terminate();
          return failedOutcome(code, detail);
        } finally {
          context.signal.removeEventListener('abort', onAbort);
          unsubscribeProxy?.();
          proxyTarget?.revoke();
          for (const file of prepared?.cleanupPaths ?? []) runtimeFs.removeFile(file);
          release?.();
          phase = 'finished';
        }
      };

      const done = run().catch((error): AdapterRunOutcome => failedOutcome('runtime.launchFailed', sanitizeRuntimeText(String(error?.message ?? error))));

      const handle: AdapterRunHandle = {
        done,
        status: () => ({ phase, nativeRunId }),
        interrupt: async (reason) => {
          interruptReason = reason;
          if (!cancelled) onAbort();
          await done;
          return { synced: true };
        },
      };
      if (definition.capabilities.approvals) {
        handle.resolveApproval = (approvalId, decisionValue) => driver?.resolveApproval?.(approvalId, decisionValue) ?? false;
      }
      if (definition.capabilities.clarify) {
        handle.resolveClarify = (clarifyId, response) => driver?.resolveClarify?.(clarifyId, response) ?? false;
      }
      return handle;
    },
  };
}

/** 各运行时拼路径用。 */
export function homePath(homeDir: string, ...segments: string[]): string {
  return path.join(homeDir, ...segments);
}
