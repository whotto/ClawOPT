/**
 * Claude Code stream-json → 规范事件。
 *
 * 行类型（本机 2.1.272 实录，fixture 在 test/runtime/adapters/claude-code/fixtures）：
 * - `system/hook_started`、`system/hook_response`、`system/status`、`system/thinking_tokens`、`rate_limit_event`：
 *   随本机 hook 配置而变，一律忽略——hook_response 的 stdout/stderr 是本机执行细节，**不能**当正文；
 * - `system/init`：模型、CLI 版本（版本漂移探针）；
 * - `stream_event`：Anthropic 流事件原样包一层（message_start / content_block_start|delta|stop / message_delta / message_stop）；
 * - `assistant`：整条消息（带 partial 时，同一 message id 会按块重复出现）；tool_use 块在这里拿到完整 input；
 *   `isApiErrorMessage: true` 是 API 错误；
 * - `user`：tool_result 块；
 * - `system/compact_boundary`：压缩完成；
 * - `result`：整轮结果、用量（`usage` 合计 + `modelUsage` 按模型）、成本。
 *
 * 终态**只在 close 之后**判：`exit` 先于 stdout 排空，最后一条 isApiErrorMessage 可能还没读到。
 */
import type { TurnDriver, TurnDriverContext, TurnVerdict, FinishInput } from '../_shared/cli-adapter';
import { looksLikeAuthMissing, looksLikeSessionMissing } from '../_shared/errors';
import { flattenContent, num } from '../_shared/turn';
import type { UsageReport } from '../../contract';

interface ClaudeResult {
  isError: boolean;
  subtype: string;
  text: string | undefined;
  raw: any;
}

interface OpenTool {
  id: string;
  name: string;
  args: string;
}

export function createClaudeCodeDriver(ctx: TurnDriverContext): TurnDriver {
  const { emitter } = ctx;
  let result: ClaudeResult | null = null;
  let apiError: string | null = null;
  let sessionId: string | null = null;
  const streamedTextMessages = new Set<string>();
  const openTools = new Map<number, OpenTool>();
  let currentMessageId: string | null = null;
  let sawAnyLine = false;

  const handle = (event: any) => {
    if (typeof event.session_id === 'string' && event.session_id) {
      sessionId = event.session_id;
      emitter.session(event.session_id);
    }

    switch (event.type) {
      case 'system': {
        if (event.subtype === 'init') {
          emitter.init(typeof event.model === 'string' ? event.model : undefined, typeof event.claude_code_version === 'string' ? event.claude_code_version : undefined);
        } else if (event.subtype === 'compact_boundary') {
          const meta = event.compact_metadata ?? {};
          const pre = num(meta.pre_tokens);
          const post = num(meta.post_tokens);
          emitter.plan({ kind: 'compact_boundary', trigger: meta.trigger ?? 'manual', preTokens: pre || undefined, postTokens: post || undefined });
        }
        return;
      }
      case 'stream_event':
        handleStreamEvent(event.event ?? {});
        return;
      case 'assistant': {
        const message = event.message ?? {};
        const messageId = typeof message.id === 'string' ? message.id : null;
        const blocks: any[] = Array.isArray(message.content) ? message.content : [];
        if (event.isApiErrorMessage === true || message.isApiErrorMessage === true) {
          apiError = flattenContent(blocks) || 'API error';
          return;
        }
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            // 没开 partial 的老 CLI / 这条消息没有流式增量：整块补上。
            if (!messageId || !streamedTextMessages.has(messageId)) emitter.textChunk(block.text);
          } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
            emitter.toolCallDone({ callId: block.id, name: String(block.name ?? 'tool'), args: block.input ?? {} });
          }
        }
        return;
      }
      case 'user': {
        const blocks: any[] = Array.isArray(event.message?.content) ? event.message.content : [];
        for (const block of blocks) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          emitter.toolOutput({ callId: block.tool_use_id, output: flattenContent(block.content), failed: block.is_error === true });
        }
        return;
      }
      case 'result':
        result = {
          isError: event.is_error === true,
          subtype: typeof event.subtype === 'string' ? event.subtype : 'unknown',
          text: typeof event.result === 'string' ? event.result : undefined,
          raw: event,
        };
        for (const usage of usageRows(event)) emitter.usage(usage);
        return;
      default:
        return;
    }
  };

  const handleStreamEvent = (streamEvent: any) => {
    switch (streamEvent.type) {
      case 'message_start': {
        const id = streamEvent.message?.id;
        if (typeof id === 'string') {
          currentMessageId = id;
          emitter.adoptResponseId(id);
        }
        emitter.ensureCreated(typeof streamEvent.message?.model === 'string' ? streamEvent.message.model : undefined);
        return;
      }
      case 'content_block_start': {
        const block = streamEvent.content_block ?? {};
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          openTools.set(Number(streamEvent.index), { id: block.id, name: String(block.name ?? 'tool'), args: '' });
          emitter.toolStarted({ callId: block.id, name: String(block.name ?? 'tool'), args: {} });
        }
        return;
      }
      case 'content_block_delta': {
        const delta = streamEvent.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (currentMessageId) streamedTextMessages.add(currentMessageId);
          emitter.textDelta(delta.text);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          emitter.reasoningDelta(delta.thinking);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const tool = openTools.get(Number(streamEvent.index));
          if (tool) {
            tool.args += delta.partial_json;
            emitter.toolArgumentsDelta(tool.id, delta.partial_json);
          }
        }
        return;
      }
      case 'content_block_stop': {
        const tool = openTools.get(Number(streamEvent.index));
        if (tool) {
          openTools.delete(Number(streamEvent.index));
          let args: unknown = tool.args || '{}';
          try { args = JSON.parse(tool.args || '{}'); } catch { /* 保留原串 */ }
          emitter.toolCallDone({ callId: tool.id, name: tool.name, args });
        }
        return;
      }
      default:
        return;
    }
  };

  /**
   * 整轮用量。多模型（一次调用里既有 opus 又有 haiku）时按模型拆行，否则一行。
   * callId 以 CLI 的会话 id 与 result 的 uuid 为底——同一次结果重放得到同一个 id。
   */
  const usageRows = (event: any): UsageReport[] => {
    const usage = event.usage;
    if (!usage || typeof usage !== 'object') return [];
    const session = typeof event.session_id === 'string' ? event.session_id : sessionId ?? 'unknown-session';
    const resultId = typeof event.uuid === 'string' ? event.uuid : ctx.runId;
    const base = `claude-code:${session}:${resultId}`;
    const modelUsage = event.modelUsage && typeof event.modelUsage === 'object' ? event.modelUsage as Record<string, any> : {};
    const models = Object.keys(modelUsage);
    if (models.length > 1) {
      return models.map((model) => {
        const row = modelUsage[model] ?? {};
        return {
          callId: `${base}:${model}`,
          scope: 'run' as const,
          model,
          inputTokens: num(row.inputTokens),
          outputTokens: num(row.outputTokens),
          cacheReadTokens: num(row.cacheReadInputTokens),
          cacheWriteTokens: num(row.cacheCreationInputTokens),
          reasoningTokens: num(row.thinkingTokens),
          apiCalls: 1,
          costUsd: typeof row.costUSD === 'number' ? row.costUSD : undefined,
        };
      });
    }
    return [{
      callId: base,
      scope: 'run',
      model: models[0] ?? emitter.model,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      reasoningTokens: num(usage.output_tokens_details?.thinking_tokens),
      apiCalls: Math.max(1, num(event.num_turns)),
      costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
    }];
  };

  return {
    onLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return; // 非 JSON 行（启动噪声）不打断本轮
      }
      if (!event || typeof event !== 'object') return;
      sawAnyLine = true;
      handle(event);
    },
    finish({ exit, stderrTail }: FinishInput): TurnVerdict {
      if (apiError) {
        return { kind: 'failed', messageCode: looksLikeAuthMissing(apiError) ? 'runtime.notLoggedIn' : 'runtime.apiError', detail: apiError };
      }
      if (result) {
        // is_error 优先于 subtype：实测 subtype 仍是 success 而 is_error 为真是可能的。
        if (result.isError || result.subtype !== 'success') {
          const detail = result.text || result.subtype;
          const code = looksLikeSessionMissing(detail) ? 'runtime.resumeFailed'
            : looksLikeAuthMissing(detail) ? 'runtime.notLoggedIn'
            : 'runtime.apiError';
          return { kind: 'failed', messageCode: code, detail, stopReason: result.subtype };
        }
        return { kind: 'completed', outputText: emitter.text || result.text || '', stopReason: result.raw?.stop_reason ?? undefined };
      }
      if (exit.code === 0) {
        if (!sawAnyLine && !emitter.text) return { kind: 'failed', messageCode: 'runtime.noOutput', detail: 'claude exited without output' };
        return { kind: 'completed' };
      }
      const detail = stderrTail || `claude exited with code ${exit.code ?? exit.signal}`;
      const code = looksLikeSessionMissing(detail) ? 'runtime.resumeFailed'
        : looksLikeAuthMissing(detail) ? 'runtime.notLoggedIn'
        : 'runtime.exitNonZero';
      return { kind: 'failed', messageCode: code, detail };
    },
  };
}
