/**
 * Grok streaming-json → 规范事件。
 *
 * 事件（1.0.30 对本地假上游实录，fixtures/real-mock-*.jsonl）：
 *   available_commands（忽略）· text {data} · thought {data} ·
 *   tool_call {toolCallId, title, toolName, rawInput, status} ·
 *   tool_call_update {toolCallId, status: null|in_progress|completed|failed, content, rawOutput} ·
 *   plan {entries} · usage {usage} · end {sessionId, stopReason, requestId, usage, num_turns, modelUsage} ·
 *   error {message} · auto_compact_started|completed|failed · max_turns_reached
 *
 * 工具结果只在终态状态（completed / failed）时出；end 是最后一行。没有 end 就关了：退出码 0 算完成，否则失败。
 */
import type { UsageReport } from '../../contract';
import type { FinishInput, TurnDriver, TurnDriverContext, TurnVerdict } from '../_shared/cli-adapter';
import { looksLikeAuthMissing, looksLikeSessionMissing } from '../_shared/errors';
import { flattenContent, num } from '../_shared/turn';

function usageFields(usage: any) {
  return {
    inputTokens: num(usage?.input_tokens ?? usage?.inputTokens),
    outputTokens: num(usage?.output_tokens ?? usage?.outputTokens),
    cacheReadTokens: num(usage?.cache_read_input_tokens ?? usage?.cacheReadInputTokens),
    cacheWriteTokens: num(usage?.cache_creation_input_tokens ?? usage?.cacheCreationInputTokens),
    reasoningTokens: num(usage?.reasoning_tokens ?? usage?.reasoningTokens ?? usage?.thinkingTokens),
  };
}

export function createGrokDriver(ctx: TurnDriverContext): TurnDriver {
  const { emitter } = ctx;
  let ended: any = null;
  let error: string | null = null;
  let sessionId: string | null = null;
  const toolNames = new Map<string, { name: string; args: unknown }>();
  const usageEvents: any[] = [];

  const emitUsage = () => {
    const session = sessionId ?? ctx.resume.resumeNativeId ?? ctx.resume.createNativeId ?? 'session';
    const requestId = typeof ended?.requestId === 'string' ? ended.requestId : ctx.runId;
    const base = `grok:${session}:${requestId}`;
    const modelUsage = ended?.modelUsage && typeof ended.modelUsage === 'object' ? ended.modelUsage as Record<string, any> : {};
    const models = Object.keys(modelUsage);
    const rows: UsageReport[] = [];
    if (models.length > 0) {
      const aggregate = usageFields(ended?.usage);
      for (const model of models) {
        const fields = usageFields(modelUsage[model]);
        // 单模型漏了推理 token 时从整轮合计补。
        if (models.length === 1 && !fields.reasoningTokens) fields.reasoningTokens = aggregate.reasoningTokens;
        rows.push({ callId: models.length === 1 ? base : `${base}:${model}`, scope: 'run', model, ...fields, apiCalls: Math.max(1, num(modelUsage[model]?.modelCalls)) });
      }
    } else if (ended?.usage) {
      rows.push({ callId: base, scope: 'run', model: emitter.model, ...usageFields(ended.usage), apiCalls: Math.max(1, num(ended.num_turns)) });
    } else if (usageEvents.length > 0) {
      // 崩在 end 之前：把逐次的 usage 加起来。
      const sum = usageEvents.map(usageFields).reduce((a, b) => ({
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
      }));
      rows.push({ callId: base, scope: 'run', model: emitter.model, ...sum, apiCalls: usageEvents.length });
    }
    for (const row of rows) emitter.usage(row);
  };

  const handle = (event: any) => {
    switch (event.type) {
      case 'text':
        if (typeof event.data === 'string') emitter.textDelta(event.data);
        return;
      case 'thought':
        if (typeof event.data === 'string') emitter.reasoningDelta(event.data);
        return;
      case 'tool_call': {
        const callId = String(event.toolCallId ?? '');
        if (!callId) return;
        const name = String(event.toolName ?? event.title ?? 'tool');
        toolNames.set(callId, { name, args: event.rawInput ?? {} });
        emitter.toolStarted({ callId, name, args: event.rawInput ?? {} });
        return;
      }
      case 'tool_call_update': {
        const callId = String(event.toolCallId ?? '');
        if (event.status !== 'completed' && event.status !== 'failed') return;
        const known = toolNames.get(callId) ?? { name: 'tool', args: {} };
        emitter.toolCallDone({ callId, name: known.name, args: known.args });
        const output = flattenContent(event.content) || flattenContent(event.rawOutput?.output_for_prompt ?? '');
        emitter.toolOutput({ callId, output, failed: event.status === 'failed' });
        return;
      }
      case 'plan': {
        const entries = Array.isArray(event.entries) ? event.entries : [];
        emitter.plan({ entries: entries.map((entry: any) => String(entry?.content ?? entry?.title ?? '')) });
        return;
      }
      case 'usage':
        usageEvents.push(event.usage ?? event.data?.usage ?? {});
        return;
      case 'end':
        ended = event;
        if (typeof event.sessionId === 'string') {
          sessionId = event.sessionId;
          emitter.session(event.sessionId);
        }
        emitUsage();
        return;
      case 'error':
        error = String(event.message ?? event.data?.message ?? 'error');
        return;
      default:
        return; // available_commands / auto_compact_* / max_turns_reached：只是状态
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
      if (error) {
        if (!ended && usageEvents.length > 0) emitUsage();
        const code = looksLikeAuthMissing(error) || /not signed in/i.test(error) ? 'runtime.notLoggedIn'
          : looksLikeSessionMissing(error) ? 'runtime.resumeFailed'
          : 'runtime.apiError';
        return { kind: 'failed', messageCode: code, detail: error };
      }
      if (ended) {
        const stop = String(ended.stopReason ?? '');
        if (stop && !['end_turn', 'max_tokens', 'stop', 'max_turns'].includes(stop)) {
          return { kind: 'failed', messageCode: 'runtime.apiError', detail: `grok stopped: ${stop}`, stopReason: stop };
        }
        return { kind: 'completed', stopReason: stop || undefined };
      }
      if (exit.code === 0) {
        if (usageEvents.length > 0) emitUsage();
        return { kind: 'completed' };
      }
      const detail = stderrTail || `grok exited with code ${exit.code ?? exit.signal}`;
      return { kind: 'failed', messageCode: /not signed in/i.test(detail) || looksLikeAuthMissing(detail) ? 'runtime.notLoggedIn' : 'runtime.exitNonZero', detail };
    },
  };
}
