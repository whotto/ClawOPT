/**
 * ACP（Agent Client Protocol，JSON-RPC 2.0 over stdio）一轮的通用驱动：DSH 与 Hermes Agent 共用。
 *
 * 一个进程一轮：initialize → session/new | session/resume → （配置）→ session/prompt → session/close（对方声明支持时）→ 关 stdin。
 *
 * 规矩：
 * - **续话失败不偷偷新建**：session/resume 报错就判 runtime.resumeFailed，下一轮由表面决定开新会话；
 *   Hermes 还会「找不到就新建一个」而不报错——结果里的会话来历（`_meta.hermes.sessionProvenance.acpSessionId`）对不上也算失败；
 * - resume 期间对方会把历史当 `session/update` 重放一遍：在 resume 应答到达之前的更新一律不当本轮输出；
 * - 只收自己会话的 `session/update`；
 * - `session/request_permission`：按运行时声明，要么自动选「允许一次」（DSH，已用 danger-full-access 关掉审批），
 *   要么翻译成审批请求交给协调器（Hermes）；
 * - 中止：`session/cancel` 通知 + 挂着的权限请求回 cancelled，之后骨架停进程组。
 */
import type { ApprovalDecision } from '../../contract';
import type { ManagedMcpServer } from '../../mcp/types';
import type { FinishInput, TurnDriver, TurnDriverContext, TurnVerdict } from './cli-adapter';
import { looksLikeAuthMissing, looksLikeSessionMissing, type RuntimeMessageCode } from './errors';
import { JsonRpcPeer } from './jsonrpc';
import { flattenContent, stringifyArgs } from './turn';

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_REQUEST_TIMEOUT_MS = 60_000;
export const ACP_CLOSE_TIMEOUT_MS = 10_000;
/** 关了 stdin 之后多久还没退出就停进程组。 */
export const ACP_EXIT_GRACE_MS = 3_000;
export const ACP_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
export const ACP_SESSION_NEW_RETRIES = 3;
export const ACP_SESSION_NEW_RETRY_DELAY_MS = 1000;

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: 'http'; name: string; url: string; headers: Array<{ name: string; value: string }> };

export function acpMcpServers(servers: readonly ManagedMcpServer[]): AcpMcpServer[] {
  return servers.map((server) => server.transport === 'http'
    ? { type: 'http' as const, name: server.name, url: server.url ?? '', headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }
    : { name: server.name, command: server.command ?? '', args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) });
}

export interface AcpDriverOptions {
  label: string;
  /** 本轮 prompt 的内容块（指令前言、图片等由运行时决定）。 */
  promptBlocks(ctx: TurnDriverContext): unknown[];
  /** session/new 或 resume 之后的配置（DSH 选模型与推理强度，Hermes 设模型）。失败只记日志。 */
  configure?(peer: JsonRpcPeer, sessionId: string, result: any, ctx: TurnDriverContext): Promise<void>;
  /** resume 的结果是否真的续上了（Hermes 会悄悄新建）。 */
  resumeConfirmed?(requestedId: string, result: any): boolean;
  permissions: 'auto-allow' | 'interactive';
  /** 这类 session/new 错误是「插件还没加载完」的瞬时状态，隔一秒重试（最多 3 次）。 */
  retrySessionNew?: RegExp;
  /** 最终文本本身就是错误（Hermes 把 401 当成正文吐出来）。返回 null 表示正常。 */
  textError?(text: string): { code: RuntimeMessageCode; detail: string } | null;
  /** 把 ACP 的整轮 usage 翻成用量行。 */
  usageFromResult?(result: any, sessionId: string, ctx: TurnDriverContext): Parameters<TurnDriverContext['emitter']['usage']>[0] | null;
}

interface PendingPermission {
  resolve(result: unknown): void;
  options: Array<{ optionId: string; kind: string; name?: string }>;
}

/** ClawOPT 的审批选择 → ACP 选项 id。 */
export function acpOptionFor(decision: ApprovalDecision, options: PendingPermission['options']): string | null {
  const byKind = (kind: string) => options.find((option) => option.kind === kind)?.optionId ?? null;
  switch (decision) {
    case 'once':
      return byKind('allow_once');
    case 'session':
      return options.find((option) => option.optionId === 'allow_session')?.optionId ?? null;
    case 'always':
      return options.find((option) => option.kind === 'allow_always' && option.optionId !== 'allow_session')?.optionId ?? null;
    case 'deny':
      return byKind('reject_once') ?? byKind('reject_always');
  }
}

export function acpChoicesFor(options: PendingPermission['options']): Array<'once' | 'session' | 'always' | 'deny'> {
  const choices: Array<'once' | 'session' | 'always' | 'deny'> = [];
  for (const decision of ['once', 'session', 'always', 'deny'] as const) {
    if (acpOptionFor(decision, options)) choices.push(decision);
  }
  return choices;
}

export function createAcpDriver(ctx: TurnDriverContext, options: AcpDriverOptions): TurnDriver {
  const { emitter, io } = ctx;
  let sessionId: string | null = null;
  let acceptingUpdates = false;
  let stopReason: string | null = null;
  let failure: { code: RuntimeMessageCode; detail: string } | null = null;
  let lastMessageId: string | null = null;
  let permissionSeq = 0;
  let exitTimer: NodeJS.Timeout | undefined;
  const toolTitles = new Map<string, { name: string; args: unknown }>();
  const pendingPermissions = new Map<string, PendingPermission>();

  const classify = (message: string, fallback: RuntimeMessageCode): RuntimeMessageCode => {
    // 装了运行时但缺 ACP 依赖（hermes-agent 不带 [acp] extra 装的，集成 P2 真机实测）：按「没装好」报，界面引导去重装。
    if (/ACP dependencies not installed|No module named ['"]?(?:acp|agent_client_protocol)/i.test(message)) return 'runtime.notInstalled';
    return looksLikeAuthMissing(message) || /MISSING_CREDENTIAL|no api key|No LLM provider configured/i.test(message) ? 'runtime.notLoggedIn' : fallback;
  };

  const handleUpdate = (params: any) => {
    if (!acceptingUpdates || !params || params.sessionId !== sessionId) return;
    const update = params.update ?? {};
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = typeof update.content?.text === 'string' ? update.content.text : flattenContent(update.content);
        if (!text) return;
        const messageId = typeof update.messageId === 'string' ? update.messageId : null;
        if (messageId && lastMessageId && messageId !== lastMessageId && emitter.text) emitter.boundary();
        if (messageId) lastMessageId = messageId;
        emitter.textDelta(text);
        return;
      }
      case 'agent_thought_chunk': {
        const text = typeof update.content?.text === 'string' ? update.content.text : flattenContent(update.content);
        if (text) emitter.reasoningDelta(text);
        return;
      }
      case 'tool_call': {
        const callId = String(update.toolCallId ?? '');
        if (!callId) return;
        const name = String(update.title ?? update.kind ?? 'tool');
        toolTitles.set(callId, { name, args: update.rawInput ?? {} });
        emitter.toolStarted({ callId, name, args: update.rawInput ?? {} });
        if (update.status === 'completed' || update.status === 'failed') handleToolDone(callId, update);
        return;
      }
      case 'tool_call_update':
        if (update.status === 'completed' || update.status === 'failed') handleToolDone(String(update.toolCallId ?? ''), update);
        return;
      case 'plan':
        // 条目带上 ACP 原生的 status（pending / in_progress / completed），单聊计划卡要显示进度。
        emitter.plan({ entries: Array.isArray(update.entries) ? update.entries.map((entry: any) => ({ content: String(entry?.content ?? ''), status: typeof entry?.status === 'string' ? entry.status : 'pending' })) : [] });
        return;
      case 'session_info_update': {
        // 运行时起的会话标题（Hermes 按第一句话起、同名加「#2」）。只转成提议，收不收由表面按标题优先级定。
        const title = typeof update.title === 'string' ? update.title.replace(/\s+/g, ' ').trim() : '';
        if (title) ctx.emitControl({ type: 'session.title', title });
        return;
      }
      default:
        return; // usage_update（上下文占用，不计费）、available_commands_update、user_message_chunk
    }
  };

  const handleToolDone = (callId: string, update: any) => {
    if (!callId) return;
    const known = toolTitles.get(callId) ?? { name: String(update.title ?? 'tool'), args: update.rawInput ?? {} };
    emitter.toolCallDone({ callId, name: known.name, args: known.args });
    const output = flattenContent(update.content) || (update.rawOutput !== undefined ? stringifyArgs(update.rawOutput) : '');
    emitter.toolOutput({ callId, output, failed: update.status === 'failed' });
  };

  const handlePermission = (params: any): Promise<unknown> | unknown => {
    const opts: PendingPermission['options'] = Array.isArray(params?.options) ? params.options : [];
    if (options.permissions === 'auto-allow') {
      const optionId = acpOptionFor('once', opts);
      return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    const approvalId = `acp:${ctx.runId}:${permissionSeq++}`;
    const toolCall = params?.toolCall ?? {};
    const command = typeof toolCall.rawInput?.command === 'string' ? toolCall.rawInput.command : undefined;
    return new Promise((resolve) => {
      pendingPermissions.set(approvalId, { resolve, options: opts });
      ctx.emitControl({
        type: 'approval.requested',
        request: {
          approvalId,
          agentId: ctx.agentId,
          title: String(toolCall.title ?? `${options.label} permission`),
          description: typeof toolCall.rawInput?.description === 'string' ? toolCall.rawInput.description : undefined,
          command,
          choices: acpChoicesFor(opts),
          timeoutMs: ACP_PERMISSION_TIMEOUT_MS,
        },
      });
    });
  };

  const peer = new JsonRpcPeer({
    write: (line) => io.write(line),
    defaultTimeoutMs: ACP_REQUEST_TIMEOUT_MS,
    numericIds: true,
    onNotification: (method, params) => {
      if (method === 'session/update') handleUpdate(params);
    },
    onRequest: (method, params) => {
      if (method === 'session/request_permission') return handlePermission(params);
      return undefined; // fs/*、terminal/*：没声明这些能力，回 -32601
    },
  });

  const finishProtocol = () => {
    peer.close();
    io.endStdin();
    exitTimer = setTimeout(() => { void io.terminate(); }, ACP_EXIT_GRACE_MS);
    exitTimer.unref?.();
  };

  const run = async () => {
    const init = await peer.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'clawopt', version: '1' },
    });
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      failure = { code: 'runtime.protocolError', detail: `unsupported ACP protocol version ${init?.protocolVersion}` };
      return;
    }
    const blocks = options.promptBlocks(ctx);
    if (blocks.some((block: any) => block?.type === 'image') && init?.agentCapabilities?.promptCapabilities?.image !== true) {
      failure = { code: 'runtime.capabilityUnsupported', detail: `${options.label} does not accept images` };
      return;
    }
    // MCP 经 session/new|resume 的 mcpServers 注入（DSH 与 Hermes 都不需要写配置文件）。
    const servers = acpMcpServers(ctx.mcpServers);
    const cwd = ctx.prepared.cwd ?? ctx.request.workspace;
    let sessionResult: any;
    const resumeId = ctx.resume.resumeNativeId;
    if (resumeId) {
      try {
        sessionResult = await peer.request('session/resume', { sessionId: resumeId, cwd, mcpServers: servers });
      } catch (error) {
        const message = (error as Error).message;
        failure = { code: looksLikeSessionMissing(message) || /not resumable/i.test(message) ? 'runtime.resumeFailed' : classify(message, 'runtime.resumeFailed'), detail: message };
        return;
      }
      if (options.resumeConfirmed && !options.resumeConfirmed(resumeId, sessionResult)) {
        failure = { code: 'runtime.resumeFailed', detail: `${options.label} did not resume session ${resumeId}` };
        return;
      }
      sessionId = resumeId;
    } else {
      for (let attempt = 0; ; attempt += 1) {
        try {
          sessionResult = await peer.request('session/new', { cwd, mcpServers: servers });
          break;
        } catch (error) {
          const message = String((error as any).rpcError?.data?.details ?? (error as Error).message);
          if (options.retrySessionNew?.test(message) && attempt < ACP_SESSION_NEW_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, ACP_SESSION_NEW_RETRY_DELAY_MS));
            continue;
          }
          failure = { code: classify(message, 'runtime.protocolError'), detail: message };
          return;
        }
      }
      if (typeof sessionResult?.sessionId !== 'string' || !sessionResult.sessionId) {
        failure = { code: 'runtime.protocolError', detail: 'session/new returned no sessionId' };
        return;
      }
      sessionId = sessionResult.sessionId;
    }
    emitter.session(sessionId);
    if (options.configure) {
      try {
        await options.configure(peer, sessionId!, sessionResult, ctx);
      } catch (error) {
        ctx.log.warn(`[${options.label}] ACP 配置失败，按默认继续`, { detail: (error as Error).message });
      }
    }
    acceptingUpdates = true;
    emitter.ensureCreated();
    let result: any;
    try {
      result = await peer.request('session/prompt', { sessionId, prompt: blocks }, 0);
    } catch (error) {
      const rpc = (error as any).rpcError;
      const message = String(rpc?.data?.details ?? (error as Error).message);
      failure = { code: classify(message, 'runtime.apiError'), detail: message };
      return;
    }
    stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn';
    const usage = options.usageFromResult?.(result, sessionId!, ctx);
    if (usage) emitter.usage(usage);
    if (init?.agentCapabilities?.sessionCapabilities?.close !== undefined) {
      try {
        await peer.request('session/close', { sessionId }, ACP_CLOSE_TIMEOUT_MS);
      } catch {
        // 刷盘失败不改变这一轮的结局
      }
    }
  };

  return {
    start() {
      void run().catch((error) => {
        if (!failure) failure = { code: 'runtime.protocolError', detail: (error as Error)?.message ?? String(error) };
      }).finally(finishProtocol);
    },
    onLine(line) {
      peer.handleLine(line);
    },
    requestCancel() {
      if (sessionId) peer.notify('session/cancel', { sessionId });
      for (const [id, pending] of pendingPermissions) {
        pending.resolve({ outcome: { outcome: 'cancelled' } });
        pendingPermissions.delete(id);
      }
    },
    resolveApproval(approvalId, decision) {
      const pending = pendingPermissions.get(approvalId);
      if (!pending) return false;
      const optionId = acpOptionFor(decision, pending.options) ?? acpOptionFor('deny', pending.options);
      pendingPermissions.delete(approvalId);
      pending.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
      return true;
    },
    finish({ exit, stderrTail }: FinishInput): TurnVerdict {
      if (exitTimer) clearTimeout(exitTimer);
      peer.close();
      for (const pending of pendingPermissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
      pendingPermissions.clear();
      if (failure) return { kind: 'failed', messageCode: failure.code, detail: failure.detail };
      if (stopReason) {
        const textError = options.textError?.(emitter.text);
        if (textError) return { kind: 'failed', messageCode: textError.code, detail: textError.detail };
        if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
          return { kind: 'completed', stopReason: stopReason === 'max_tokens' ? 'length' : stopReason };
        }
        return { kind: 'failed', messageCode: stopReason === 'cancelled' ? 'runtime.sessionClosed' : 'runtime.apiError', detail: `${options.label} stopped: ${stopReason}`, stopReason };
      }
      const detail = stderrTail || `${options.label} exited with code ${exit.code ?? exit.signal} before the turn finished`;
      return { kind: 'failed', messageCode: classify(detail, exit.code === 0 ? 'runtime.sessionClosed' : 'runtime.exitNonZero'), detail };
    },
  };
}
