/**
 * Pi RPC → 规范事件，以及审批 / 澄清的真映射。
 *
 * 事件（0.85.1 实录，fixtures/real-*.rpc.jsonl）：
 *   response {id, command, success, error?, data?} · agent_start · turn_start · message_start ·
 *   message_update {assistantMessageEvent: text_start|text_delta|text_end|thinking_delta|toolcall_*} ·
 *   message_end {message: {role, content, stopReason, errorMessage?, usage, model, provider, timestamp}} ·
 *   tool_execution_start {toolCallId, toolName, args} · tool_execution_update · tool_execution_end {toolCallId, result, isError} ·
 *   turn_end · agent_end {willRetry?} · auto_retry_start · auto_retry_end {success, finalError?} · agent_settled ·
 *   extension_ui_request {id, method, title, message, options, placeholder, prefill, timeout}
 *
 * 映射：
 * - `confirm` → 审批（选项 once / deny）；`select` → 带选项的澄清；`input` / `editor` → 自由文本澄清；
 *   其余对话类方法立刻回 `cancelled`；notify / setStatus / setWidget / setTitle / set_editor_text 忽略。
 * - `agent_settled` 才是本轮结束：自动重试挂着时不算；之后停掉进程，`close` 之后骨架判终态。
 * - `message_end` 在 `turn_end` / `agent_end` 里还会重复出现：用量按消息时间戳 + 模型去重。
 */
import type { ApprovalDecision } from '../../contract';
import type { FinishInput, TurnDriver, TurnDriverContext, TurnVerdict } from '../_shared/cli-adapter';
import { looksLikeAuthMissing, looksLikeSessionMissing } from '../_shared/errors';
import { flattenContent, num } from '../_shared/turn';
import { piThinkingLevel } from './launch';

export const PI_CLARIFY_MAX_CHARS = 20_000;
/** Pi 没给 timeout 时，注册表的排队超时（到点按拒绝 / 以说明作答）。 */
export const PI_DEFAULT_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

type PendingUi =
  | { kind: 'approval'; piId: string }
  | { kind: 'clarify'; piId: string; method: 'select' | 'input' | 'editor'; options: string[] | null };

const IGNORED_UI_METHODS = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);

export function createPiDriver(ctx: TurnDriverContext): TurnDriver {
  const { emitter, io, command } = ctx;
  const nativeId = ctx.resume.resumeNativeId ?? ctx.resume.createNativeId ?? ctx.request.sessionId;
  let seq = 0;
  const promptRequestId = `clawopt_prompt_${ctx.runId}`;
  let pendingError: { code: 'runtime.apiError' | 'runtime.notLoggedIn' | 'runtime.protocolError' | 'runtime.resumeFailed'; detail: string } | null = null;
  let retryPending = false;
  let settled = false;
  let commandResult: { ok: boolean; data?: unknown; error?: string } | null = null;
  let lengthStop = false;
  const usageSeen = new Set<string>();
  const pendingUi = new Map<string, PendingUi>();

  const send = (message: Record<string, unknown>) => io.write(`${JSON.stringify(message)}\n`);
  const stop = () => {
    io.endStdin();
    void io.terminate();
  };

  const handleUiRequest = (event: any) => {
    const piId = String(event.id ?? '');
    const method = String(event.method ?? '');
    if (!piId || IGNORED_UI_METHODS.has(method)) return;
    const timeoutMs = typeof event.timeout === 'number' && event.timeout > 0 ? event.timeout : PI_DEFAULT_INTERACTION_TIMEOUT_MS;
    const title = String(event.title ?? event.message ?? '');
    if (method === 'confirm') {
      const approvalId = `pi:${ctx.runId}:${piId}`;
      pendingUi.set(approvalId, { kind: 'approval', piId });
      ctx.emitControl({
        type: 'approval.requested',
        request: { approvalId, agentId: ctx.agentId, title, description: typeof event.message === 'string' ? event.message : undefined, choices: ['once', 'deny'], timeoutMs },
      });
      return;
    }
    if (method === 'select' || method === 'input' || method === 'editor') {
      const clarifyId = `pi:${ctx.runId}:${piId}`;
      const options = method === 'select' && Array.isArray(event.options) ? event.options.map(String) : null;
      pendingUi.set(clarifyId, { kind: 'clarify', piId, method, options });
      const question = [title, method === 'editor' && typeof event.prefill === 'string' ? event.prefill.slice(0, PI_CLARIFY_MAX_CHARS) : '']
        .filter(Boolean).join('\n\n');
      ctx.emitControl({ type: 'clarify.requested', request: { clarifyId, agentId: ctx.agentId, question, choices: options, timeoutMs } });
      return;
    }
    // 认不出的对话类方法：立刻取消，不让 Pi 一直阻塞。
    send({ type: 'extension_ui_response', id: piId, cancelled: true });
  };

  const handleMessageEnd = (message: any) => {
    if (message?.role !== 'assistant') return;
    const text = Array.isArray(message.content)
      ? message.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('')
      : typeof message.content === 'string' ? message.content : '';
    if (text) emitter.reconcileMessageText(text);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      const detail = String(message.errorMessage ?? message.stopReason);
      pendingError = { code: looksLikeAuthMissing(detail) ? 'runtime.notLoggedIn' : 'runtime.apiError', detail };
    } else if (message.stopReason) {
      pendingError = null;
      lengthStop = message.stopReason === 'length';
    }
    const usage = message.usage;
    const total = num(usage?.input) + num(usage?.output) + num(usage?.cacheRead) + num(usage?.cacheWrite);
    if (!usage || total === 0) return; // 占位 / 出错消息的零用量不记
    const key = `${message.timestamp ?? ''}:${message.model ?? ''}:${message.responseId ?? ''}`;
    if (usageSeen.has(key)) return;
    usageSeen.add(key);
    emitter.usage({
      callId: `pi:${nativeId}:${message.timestamp ?? ctx.runId}:${message.model ?? 'model'}`,
      scope: 'model_call',
      model: typeof message.model === 'string' ? message.model : undefined,
      provider: typeof message.provider === 'string' ? message.provider : undefined,
      inputTokens: num(usage.input),
      outputTokens: num(usage.output),
      cacheReadTokens: num(usage.cacheRead),
      cacheWriteTokens: num(usage.cacheWrite),
      reasoningTokens: num(usage.reasoning),
      apiCalls: 1,
      costUsd: typeof usage.cost?.total === 'number' ? usage.cost.total : undefined,
    });
  };

  const handle = (event: any) => {
    switch (event.type) {
      case 'response': {
        if (event.id === promptRequestId || event.command === 'prompt') {
          if (event.success === false) {
            const detail = String(event.error ?? 'prompt rejected');
            pendingError = { code: looksLikeSessionMissing(detail) ? 'runtime.resumeFailed' : looksLikeAuthMissing(detail) ? 'runtime.notLoggedIn' : 'runtime.apiError', detail };
            settled = true;
            stop();
          } else {
            // 按确切 id 建 / 用会话成功：原生 id 确认。
            emitter.session(nativeId);
          }
          return;
        }
        if (command.kind !== 'turn' && typeof event.id === 'string' && event.id.startsWith('clawopt_cmd_')) {
          commandResult = event.success === false ? { ok: false, error: String(event.error ?? 'command failed') } : { ok: true, data: event.data };
          if (event.success !== false) emitter.session(nativeId);
          stop();
        }
        return;
      }
      case 'agent_start':
      case 'turn_start':
        emitter.ensureCreated();
        return;
      case 'message_update': {
        const update = event.assistantMessageEvent ?? {};
        if (update.type === 'text_delta' && typeof update.delta === 'string') emitter.textDelta(update.delta);
        else if (update.type === 'thinking_delta' && typeof update.delta === 'string') emitter.reasoningDelta(update.delta);
        return;
      }
      case 'message_end':
        handleMessageEnd(event.message);
        return;
      case 'tool_execution_start':
        emitter.toolCallDone({ callId: String(event.toolCallId), name: String(event.toolName ?? 'tool'), args: event.args ?? {} });
        return;
      case 'tool_execution_end':
        emitter.toolOutput({ callId: String(event.toolCallId), output: flattenContent(event.result?.content ?? event.result), failed: event.isError === true });
        return;
      case 'agent_end':
        retryPending = event.willRetry === true;
        return;
      case 'auto_retry_start':
        retryPending = true;
        return;
      case 'auto_retry_end':
        retryPending = false;
        if (event.success === false) {
          const detail = String(event.finalError ?? 'retry failed');
          pendingError = { code: looksLikeAuthMissing(detail) ? 'runtime.notLoggedIn' : 'runtime.apiError', detail };
        }
        return;
      case 'agent_settled':
        if (retryPending || command.kind !== 'turn') return;
        settled = true;
        stop();
        return;
      case 'extension_ui_request':
        handleUiRequest(event);
        return;
      default:
        return;
    }
  };

  const respond = (id: string, payload: Record<string, unknown>) => {
    const entry = pendingUi.get(id);
    if (!entry) return false;
    pendingUi.delete(id);
    send({ type: 'extension_ui_response', id: entry.piId, ...payload });
    return true;
  };

  return {
    start() {
      if (command.kind === 'turn') {
        const level = piThinkingLevel(ctx.request.provider?.reasoningEffort ?? ctx.request.reasoningEffort);
        if (level) send({ id: `clawopt_think_${ctx.runId}`, type: 'set_thinking_level', level });
        const images = (ctx.request.images ?? []).filter((image) => image.data).map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
        send({ id: promptRequestId, type: 'prompt', message: ctx.request.prompt, ...(images.length ? { images } : {}) });
        return;
      }
      const id = `clawopt_cmd_${seq++}`;
      if (command.kind === 'compact') send({ id, type: 'compact', ...(command.instructions ? { customInstructions: command.instructions } : {}) });
      else if (command.kind === 'status') send({ id, type: 'get_state' });
      else send({ id, type: 'get_session_stats' });
    },
    onLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try { event = JSON.parse(trimmed); } catch { return; }
      if (event && typeof event === 'object') handle(event);
    },
    requestCancel() {
      send({ type: 'abort' });
      for (const id of [...pendingUi.keys()]) respond(id, { cancelled: true });
    },
    resolveApproval(approvalId: string, decision: ApprovalDecision) {
      const entry = pendingUi.get(approvalId);
      if (!entry || entry.kind !== 'approval') return false;
      if (decision === 'once') return respond(approvalId, { confirmed: true });
      if (decision === 'deny') return respond(approvalId, { confirmed: false });
      return false; // 只提供了 once / deny
    },
    resolveClarify(clarifyId: string, response: string) {
      const entry = pendingUi.get(clarifyId);
      if (!entry || entry.kind !== 'clarify') return false;
      const value = response.slice(0, PI_CLARIFY_MAX_CHARS);
      if (entry.method === 'select') {
        if (!value || !entry.options?.includes(value)) return respond(clarifyId, { cancelled: true });
      }
      return respond(clarifyId, { value });
    },
    finish({ exit, stderrTail }: FinishInput): TurnVerdict {
      for (const id of [...pendingUi.keys()]) respond(id, { cancelled: true });
      if (command.kind !== 'turn') {
        if (commandResult?.ok) {
          if (command.kind === 'compact') {
            const data: any = commandResult.data ?? {};
            emitter.plan({ kind: 'compact_boundary', trigger: 'manual', preTokens: num(data.tokensBefore) || undefined, postTokens: num(data.estimatedTokensAfter) || undefined });
            return { kind: 'completed', stopReason: 'compacted', outputText: typeof data.summary === 'string' ? data.summary : '' };
          }
          return { kind: 'completed', stopReason: `session_command:${command.kind}`, outputText: JSON.stringify(commandResult.data ?? {}) };
        }
        const detail = commandResult?.error ?? (stderrTail || `pi exited with code ${exit.code ?? exit.signal}`);
        return { kind: 'failed', messageCode: commandResult ? 'runtime.apiError' : 'runtime.exitNonZero', detail };
      }
      if (pendingError) return { kind: 'failed', messageCode: pendingError.code, detail: pendingError.detail };
      if (settled) return { kind: 'completed', stopReason: lengthStop ? 'length' : undefined };
      // 没等到 agent_settled 进程就关了：Pi 中途退出。
      const detail = stderrTail || `pi exited with code ${exit.code ?? exit.signal} before the turn settled`;
      return { kind: 'failed', messageCode: looksLikeAuthMissing(detail) ? 'runtime.notLoggedIn' : 'runtime.sessionClosed', detail };
    },
  };
}
