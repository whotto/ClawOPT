/**
 * Codex JSONL（exec 方言）→ 规范事件；压缩走 app-server JSON-RPC。
 *
 * exec 方言（0.153.4 实录，fixtures/real-*.jsonl）：
 *   thread.started {thread_id} · turn.started · item.started {item} · item.completed {item} ·
 *   turn.completed {usage} · turn.failed {error} · error {message}
 * item 类型：agent_message {text} · reasoning {text} · command_execution {command, aggregated_output, exit_code, status} ·
 *   mcp_tool_call {server, tool, arguments, result|error} · web_search {query} · file_change {changes}
 *
 * 三条规矩：
 * 1. `error` 是**临时**的（流重试时也会发），先记着，退出码说了算——退出码 0 就当没发生；
 * 2. `mcp_tool_call` 名为 `exec_command` 的是 `command_execution` 的回声，丢掉，否则一次命令两张卡；
 * 3. scoped 下代理增量先到、CLI 的整条 agent_message 后到：两路都照发，由协调器按轮次与段比对去重
 *    （事实来源表 `text: ['proxy', 'native']`，见 coordinator/turn-text-arbiter.ts）。驱动里不再自己折叠。
 */
import type { FinishInput, TurnDriver, TurnDriverContext, TurnVerdict } from '../_shared/cli-adapter';
import { looksLikeAuthMissing, looksLikeSessionMissing } from '../_shared/errors';
import { JsonRpcPeer } from '../_shared/jsonrpc';
import { flattenContent, num } from '../_shared/turn';

const SESSION_KEYS = ['thread_id', 'threadId', 'session_id', 'sessionId', 'conversation_id', 'conversationId'];
const NESTED_KEYS = ['thread', 'session', 'conversation', 'params', 'msg', 'message'];

export function findCodexSessionId(value: any, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 3) return null;
  for (const key of SESSION_KEYS) if (typeof value[key] === 'string' && value[key]) return value[key];
  for (const key of NESTED_KEYS) {
    const found = findCodexSessionId(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

interface ToolView {
  name: string;
  args: Record<string, unknown>;
  output: string;
  failed: boolean;
}

/** 把 Codex 的工具类 item 规范成 名字 / 参数 / 输出。认不出的 item 返回 null。 */
export function codexToolView(item: any): ToolView | null {
  const output = typeof item.aggregated_output === 'string' ? item.aggregated_output
    : typeof item.output === 'string' ? item.output
    : item.result !== undefined ? flattenContent(item.result?.content ?? item.result)
    : typeof item.error?.message === 'string' ? item.error.message : '';
  const failed = item.status === 'failed' || item.status === 'declined' || Boolean(item.error);
  switch (item.type) {
    case 'command_execution':
      return { name: 'Command', args: { command: item.command }, output, failed: failed || (typeof item.exit_code === 'number' && item.exit_code !== 0) };
    case 'mcp_tool_call':
      return { name: String(item.tool ?? 'mcp'), args: { server: item.server, tool: item.tool, arguments: item.arguments }, output, failed };
    case 'web_search':
      return { name: 'Web Search', args: { query: item.query ?? item.action?.query }, output, failed };
    case 'file_change':
    case 'patch_apply':
      return { name: 'File Change', args: { changes: item.changes ?? item.path, action: item.action }, output, failed };
    default:
      return null;
  }
}

export function createCodexDriver(ctx: TurnDriverContext): TurnDriver {
  return ctx.command.kind === 'compact' ? createCompactionDriver(ctx) : createExecDriver(ctx);
}

function createExecDriver(ctx: TurnDriverContext): TurnDriver {
  const { emitter } = ctx;
  let threadId: string | null = ctx.resume.resumeNativeId;
  let turnFailed: string | null = null;
  let lastError: string | null = null;
  let sawTurnCompleted = false;
  let usageSeq = 0;
  let agentMessages = 0;
  let lastWasTool = false;

  const emitAgentMessage = (text: string) => {
    if (!text) return;
    if (agentMessages > 0 && !lastWasTool) emitter.boundary();
    agentMessages += 1;
    emitter.textDelta(text);
    lastWasTool = false;
  };

  const handle = (event: any) => {
    const session = findCodexSessionId(event);
    if (session) {
      threadId = session;
      emitter.session(session);
    }
    const type = typeof event.type === 'string' ? event.type : typeof event.method === 'string' ? event.method : '';
    switch (type) {
      case 'thread.started':
      case 'turn.started':
        emitter.ensureCreated();
        return;
      case 'item.started': {
        const item = event.item ?? {};
        const view = codexToolView(item);
        if (!view || (item.type === 'mcp_tool_call' && item.tool === 'exec_command')) return;
        emitter.toolStarted({ callId: String(item.id), name: view.name, args: view.args });
        return;
      }
      case 'item.completed': {
        const item = event.item ?? {};
        if (item.type === 'agent_message' || item.type === 'assistant_message') {
          emitAgentMessage(typeof item.text === 'string' ? item.text : flattenContent(item.content));
          return;
        }
        if (item.type === 'reasoning') {
          emitter.reasoningDelta(typeof item.text === 'string' ? item.text : flattenContent(item.summary ?? item.content));
          return;
        }
        const view = codexToolView(item);
        if (!view || (item.type === 'mcp_tool_call' && item.tool === 'exec_command')) return;
        const callId = String(item.id);
        emitter.toolCallDone({ callId, name: view.name, args: view.args });
        emitter.toolOutput({ callId, output: view.output, failed: view.failed });
        lastWasTool = true;
        return;
      }
      case 'turn.completed': {
        sawTurnCompleted = true;
        const usage = event.usage ?? {};
        const cached = num(usage.cached_input_tokens);
        emitter.usage({
          callId: `codex:${threadId ?? 'thread'}:${ctx.runId}:${usageSeq++}`,
          scope: 'run',
          model: emitter.model,
          inputTokens: Math.max(0, num(usage.input_tokens) - cached),
          outputTokens: num(usage.output_tokens),
          cacheReadTokens: cached,
          cacheWriteTokens: num(usage.cache_write_input_tokens),
          reasoningTokens: num(usage.reasoning_output_tokens),
          apiCalls: 1,
        });
        return;
      }
      case 'turn.failed':
        turnFailed = String(event.error?.message ?? event.message ?? 'turn failed');
        return;
      case 'error':
        // 临时：流重试也会发。退出码决定它算不算数。
        lastError = String(event.message ?? event.error?.message ?? 'error');
        return;
      default:
        return;
    }
  };

  return {
    onLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try { event = JSON.parse(trimmed); } catch { return; }
      if (event && typeof event === 'object') handle(event);
    },
    finish({ exit, stderrTail }: FinishInput): TurnVerdict {
      if (exit.code === 0) {
        if (turnFailed) return { kind: 'failed', messageCode: looksLikeAuthMissing(turnFailed) ? 'runtime.notLoggedIn' : 'runtime.apiError', detail: turnFailed };
        if (!sawTurnCompleted && !emitter.text) return { kind: 'failed', messageCode: 'runtime.noOutput', detail: 'codex exited without a turn' };
        return { kind: 'completed' };
      }
      const detail = turnFailed ?? lastError ?? (stderrTail || `codex exited with code ${exit.code ?? exit.signal}`);
      const code = looksLikeSessionMissing(detail) ? 'runtime.resumeFailed'
        : looksLikeAuthMissing(detail) ? 'runtime.notLoggedIn'
        : (turnFailed || lastError) ? 'runtime.apiError'
        : 'runtime.exitNonZero';
      return { kind: 'failed', messageCode: code, detail };
    },
  };
}

export const CODEX_COMPACT_READY_TIMEOUT_MS = 30_000;
export const CODEX_COMPACT_TIMEOUT_MS = 5 * 60_000;

/** `codex app-server` 压缩：initialize → initialized → thread/resume → thread/compact/start → 等 thread/compacted。 */
function createCompactionDriver(ctx: TurnDriverContext): TurnDriver {
  const { emitter, io } = ctx;
  const threadId = ctx.resume.resumeNativeId;
  let compacted = false;
  let error: { code: 'runtime.resumeFailed' | 'runtime.protocolError' | 'runtime.commandUnsupported'; detail: string } | null = null;
  let accepted = false;
  let tokensBefore: number | undefined;
  let tokensAfter: number | undefined;
  let compactTimer: NodeJS.Timeout | undefined;

  const finishProtocol = () => {
    if (compactTimer) clearTimeout(compactTimer);
    peer.close();
    io.endStdin();
    void io.terminate();
  };

  const peer = new JsonRpcPeer({
    write: (line) => io.write(line),
    numericIds: true,
    defaultTimeoutMs: CODEX_COMPACT_READY_TIMEOUT_MS,
    onNotification: (method, params) => {
      if (method === 'thread/tokenUsage/updated' && (!params?.threadId || params.threadId === threadId)) {
        const total = num(params?.tokenUsage?.last?.totalTokens ?? params?.tokenUsage?.total?.totalTokens);
        if (!accepted) tokensBefore = total || tokensBefore;
        else tokensAfter = total || tokensAfter;
      }
      if ((method === 'thread/compacted' || (accepted && method === 'turn/completed')) && (!params?.threadId || params.threadId === threadId)) {
        compacted = true;
        finishProtocol();
      }
    },
    // app-server 可能反问审批：压缩流程里不该出现，一律拒绝。
    onRequest: () => ({ decision: 'denied' }),
  });

  return {
    start() {
      if (!threadId) {
        error = { code: 'runtime.resumeFailed', detail: 'no confirmed Codex thread to compact' };
        finishProtocol();
        return;
      }
      void (async () => {
        try {
          await peer.request('initialize', { clientInfo: { name: 'clawopt', title: 'ClawOPT', version: '1' } });
          peer.notify('initialized');
          await peer.request('thread/resume', { threadId });
          // 发出压缩请求那一刻起的用量更新都算「压缩后」：通知可能先于请求的应答到达。
          accepted = true;
          await peer.request('thread/compact/start', { threadId });
          compactTimer = setTimeout(() => {
            error = { code: 'runtime.protocolError', detail: 'compaction timed out' };
            finishProtocol();
          }, CODEX_COMPACT_TIMEOUT_MS);
          compactTimer.unref?.();
        } catch (err) {
          if (compacted) return;
          const message = (err as Error)?.message ?? String(err);
          error = { code: looksLikeSessionMissing(message) ? 'runtime.resumeFailed' : 'runtime.protocolError', detail: message };
          finishProtocol();
        }
      })();
    },
    onLine(line) {
      peer.handleLine(line);
    },
    finish({ exit, stderrTail }: FinishInput): TurnVerdict {
      peer.close();
      if (compacted) {
        emitter.commandResult({ command: 'compact', ok: true, compaction: { trigger: 'manual', preTokens: tokensBefore, postTokens: tokensAfter } });
        return { kind: 'completed', stopReason: 'compacted', outputText: '' };
      }
      if (error) return { kind: 'failed', messageCode: error.code, detail: error.detail };
      return { kind: 'failed', messageCode: 'runtime.exitNonZero', detail: stderrTail || `codex app-server exited with code ${exit.code ?? exit.signal} before compaction completed` };
    },
  };
}
