/**
 * OpenCode `run --format json` → 规范事件。
 *
 * 每行 `{type, timestamp, sessionID, part}`（1.18.31 实录，fixtures/real-*.jsonl）：
 *   step_start · text（part.text，**整段**，time.end 设了才发）· reasoning（整段）·
 *   tool_use（part.tool / callID / state{status, input, output, error}，只在 completed / error 时发）·
 *   step_finish（part.tokens{input, output, reasoning, cache{read, write}}、part.cost、part.reason）·
 *   error（error{name, data{message}}）
 * 没有显式的结束事件：会话空闲后进程退出，以 close 为准。
 */
import type { FinishInput, TurnDriver, TurnDriverContext, TurnVerdict } from '../_shared/cli-adapter';
import { looksLikeAuthMissing, looksLikeSessionMissing } from '../_shared/errors';
import { num } from '../_shared/turn';

export function createOpenCodeDriver(ctx: TurnDriverContext): TurnDriver {
  const { emitter } = ctx;
  let sessionId: string | null = ctx.resume.resumeNativeId;
  let error: string | null = null;
  let sawStep = false;
  const seenParts = new Set<string>();
  let textParts = 0;

  const handle = (event: any) => {
    const session = typeof event.sessionID === 'string' ? event.sessionID : typeof event.session_id === 'string' ? event.session_id : null;
    if (session) {
      sessionId = session;
      emitter.session(session);
    }
    const part = event.part ?? {};
    const partId = typeof part.id === 'string' ? part.id : null;
    if (partId && event.type !== 'tool_use') {
      if (seenParts.has(`${event.type}:${partId}`)) return;
      seenParts.add(`${event.type}:${partId}`);
    }
    switch (event.type) {
      case 'step_start':
        sawStep = true;
        emitter.ensureCreated();
        return;
      case 'text':
        if (typeof part.text === 'string' && part.text) {
          if (textParts > 0) emitter.boundary();
          textParts += 1;
          emitter.textChunk(part.text);
        }
        return;
      case 'reasoning':
        if (typeof part.text === 'string') emitter.reasoningDelta(part.text);
        return;
      case 'tool_use': {
        const callId = String(part.callID ?? part.id ?? '');
        if (!callId) return;
        const state = part.state ?? {};
        const name = String(part.tool ?? 'tool');
        emitter.toolCallDone({ callId, name, args: state.input ?? {} });
        const failed = state.status === 'error';
        emitter.toolOutput({ callId, output: String(failed ? (state.error ?? state.output ?? '') : (state.output ?? '')), failed });
        return;
      }
      case 'step_finish': {
        sawStep = true;
        const tokens = part.tokens;
        if (!tokens) return;
        emitter.usage({
          callId: `opencode:${sessionId ?? 'session'}:${partId ?? `${ctx.runId}:${event.timestamp ?? ''}`}`,
          scope: 'model_call',
          model: emitter.model,
          inputTokens: num(tokens.input),
          outputTokens: num(tokens.output),
          cacheReadTokens: num(tokens.cache?.read),
          cacheWriteTokens: num(tokens.cache?.write),
          reasoningTokens: num(tokens.reasoning),
          apiCalls: 1,
          costUsd: typeof part.cost === 'number' && part.cost > 0 ? part.cost : undefined,
        });
        return;
      }
      case 'error': {
        const err = event.error ?? {};
        error = String(err.data?.message ?? err.message ?? err.name ?? 'error');
        return;
      }
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
      const detail = error ?? stderrTail;
      if (looksLikeSessionMissing(stderrTail) || looksLikeSessionMissing(error ?? '')) {
        return { kind: 'failed', messageCode: 'runtime.resumeFailed', detail: detail || 'session not found' };
      }
      if (error) {
        return { kind: 'failed', messageCode: looksLikeAuthMissing(`${error}\n${stderrTail}`) ? 'runtime.notLoggedIn' : 'runtime.apiError', detail: stderrTail ? `${error}\n${stderrTail}` : error };
      }
      if (exit.code === 0) {
        if (!sawStep && !emitter.text) return { kind: 'failed', messageCode: 'runtime.noOutput', detail: 'opencode exited without output' };
        return { kind: 'completed' };
      }
      return { kind: 'failed', messageCode: looksLikeAuthMissing(stderrTail) ? 'runtime.notLoggedIn' : 'runtime.exitNonZero', detail: stderrTail || `opencode exited with code ${exit.code ?? exit.signal}` };
    },
  };
}
