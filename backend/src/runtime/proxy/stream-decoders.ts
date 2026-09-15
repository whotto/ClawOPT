/**
 * 上游响应 → 中立事件。三种格式，各有流式（SSE）与 JSON 两种解码。
 *
 * 解码器不抛：认不出的帧跳过。上游偶尔插入 `ping`、注释行、未知事件类型，
 * 抛错会让整轮在别人的服务商上炸掉。
 */
import { randomUUID } from 'crypto';

import type { SseEvent } from './sse';
import { parseJsonSafe } from './sse';
import { CumulativeOrDelta, type FinishReason, type NeutralEvent, type NeutralUsage } from './stream-neutral';

export interface StreamDecoder {
  push(event: SseEvent): NeutralEvent[];
  /** 流结束（`[DONE]`、`message_stop`、EOF 都会走到这里）；重复调用无副作用。 */
  end(): NeutralEvent[];
  readonly finished: boolean;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------- Chat Completions ----------------

export function chatUsage(usage: any): Partial<NeutralUsage> | null {
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: num(usage.prompt_tokens) ?? 0,
    outputTokens: num(usage.completion_tokens) ?? 0,
    cacheReadTokens: num(usage.prompt_tokens_details?.cached_tokens) ?? num(usage.prompt_cache_hit_tokens) ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: num(usage.completion_tokens_details?.reasoning_tokens) ?? 0,
  };
}

function chatFinish(reason: unknown, sawTool: boolean): FinishReason {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return sawTool ? 'tool_calls' : 'stop';
}

/** Chat SSE 的思维字段有好几种写法；`reasoning_details` 是分段数组。 */
function chatReasoningChunk(delta: any): string {
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof delta?.[key] === 'string' && delta[key]) return delta[key];
  }
  if (Array.isArray(delta?.reasoning_details)) {
    return delta.reasoning_details
      .map((detail: any) => (typeof detail?.text === 'string' ? detail.text : typeof detail?.summary === 'string' ? detail.summary : ''))
      .join('');
  }
  return '';
}

export class ChatStreamDecoder implements StreamDecoder {
  finished = false;
  private started = false;
  private readonly tools = new Map<number, { key: string }>();
  private openToolIndex: number | null = null;
  private finishReason: unknown = null;
  private usage: Partial<NeutralUsage> | null = null;
  private readonly reasoning = new CumulativeOrDelta();

  push(event: SseEvent): NeutralEvent[] {
    if (this.finished) return [];
    const data = event.data.trim();
    if (data === '[DONE]') return this.end();
    const chunk = parseJsonSafe(data);
    if (!chunk || typeof chunk !== 'object') return [];
    const out: NeutralEvent[] = [];
    if (chunk.error) {
      out.push({ kind: 'error', message: String(chunk.error?.message ?? 'Provider stream error'), code: chunk.error?.code ? String(chunk.error.code) : undefined });
      this.finished = true;
      return out;
    }
    if (!this.started) {
      this.started = true;
      out.push({ kind: 'start', id: typeof chunk.id === 'string' ? chunk.id : undefined, model: typeof chunk.model === 'string' ? chunk.model : undefined });
    }
    const usage = chatUsage(chunk.usage);
    if (usage) this.usage = usage;
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const delta = choice?.delta ?? choice?.message ?? {};
      const reasoning = this.reasoning.next(chatReasoningChunk(delta));
      if (reasoning) out.push({ kind: 'reasoning', delta: reasoning });
      if (typeof delta.content === 'string' && delta.content) {
        this.closeTool(out);
        out.push({ kind: 'text', delta: delta.content });
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index = typeof call?.index === 'number' ? call.index : this.tools.size;
        if (!this.tools.has(index)) {
          this.closeTool(out);
          const key = `chat_tool_${index}`;
          this.tools.set(index, { key });
          this.openToolIndex = index;
          out.push({ kind: 'tool_start', key, id: String(call?.id || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`), name: String(call?.function?.name ?? '') });
        }
        const args = call?.function?.arguments;
        if (typeof args === 'string' && args) out.push({ kind: 'tool_args', key: this.tools.get(index)!.key, delta: args });
      }
      if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    }
    return out;
  }

  private closeTool(out: NeutralEvent[]): void {
    if (this.openToolIndex === null) return;
    out.push({ kind: 'tool_end', key: this.tools.get(this.openToolIndex)!.key });
    this.openToolIndex = null;
  }

  end(): NeutralEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const out: NeutralEvent[] = [];
    if (!this.started) out.push({ kind: 'start' });
    this.closeTool(out);
    if (this.usage) out.push({ kind: 'usage', usage: this.usage });
    out.push({ kind: 'finish', reason: chatFinish(this.finishReason, this.tools.size > 0) });
    return out;
  }
}

export function neutralFromChatJson(json: any): NeutralEvent[] {
  const out: NeutralEvent[] = [{ kind: 'start', id: json?.id, model: json?.model }];
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  const message = choice?.message ?? {};
  const reasoning = chatReasoningChunk(message);
  if (reasoning) out.push({ kind: 'reasoning', delta: reasoning });
  if (typeof message.content === 'string' && message.content) out.push({ kind: 'text', delta: message.content });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  calls.forEach((call: any, index: number) => {
    const key = `chat_tool_${index}`;
    out.push({ kind: 'tool_start', key, id: String(call?.id || `call_${index}`), name: String(call?.function?.name ?? '') });
    out.push({ kind: 'tool_args', key, delta: String(call?.function?.arguments ?? '{}') });
    out.push({ kind: 'tool_end', key });
  });
  const usage = chatUsage(json?.usage);
  if (usage) out.push({ kind: 'usage', usage });
  out.push({ kind: 'finish', reason: chatFinish(choice?.finish_reason, calls.length > 0) });
  return out;
}

// ---------------- Anthropic Messages ----------------

function anthropicUsage(usage: any): Partial<NeutralUsage> | null {
  if (!usage || typeof usage !== 'object') return null;
  const patch: Partial<NeutralUsage> = {};
  if (num(usage.input_tokens) !== undefined) patch.inputTokens = usage.input_tokens;
  if (num(usage.output_tokens) !== undefined) patch.outputTokens = usage.output_tokens;
  if (num(usage.cache_read_input_tokens) !== undefined) patch.cacheReadTokens = usage.cache_read_input_tokens;
  if (num(usage.cache_creation_input_tokens) !== undefined) patch.cacheWriteTokens = usage.cache_creation_input_tokens;
  return patch;
}

function anthropicFinish(reason: unknown): FinishReason {
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'refusal') return 'content_filter';
  return 'stop';
}

export class AnthropicStreamDecoder implements StreamDecoder {
  finished = false;
  private started = false;
  private readonly toolBlocks = new Set<number>();
  private stopReason: unknown = null;

  push(event: SseEvent): NeutralEvent[] {
    if (this.finished) return [];
    const payload = parseJsonSafe(event.data);
    const type = payload?.type ?? event.event;
    const out: NeutralEvent[] = [];
    switch (type) {
      case 'message_start': {
        this.started = true;
        out.push({ kind: 'start', id: payload?.message?.id, model: payload?.message?.model });
        const usage = anthropicUsage(payload?.message?.usage);
        if (usage) out.push({ kind: 'usage', usage });
        break;
      }
      case 'content_block_start': {
        const block = payload?.content_block;
        if (block?.type === 'tool_use') {
          const index = Number(payload.index);
          this.toolBlocks.add(index);
          out.push({ kind: 'tool_start', key: `anthropic_block_${index}`, id: String(block.id ?? ''), name: String(block.name ?? '') });
          if (block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0) {
            out.push({ kind: 'tool_args', key: `anthropic_block_${index}`, delta: JSON.stringify(block.input) });
          }
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          out.push({ kind: 'text', delta: block.text });
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          out.push({ kind: 'reasoning', delta: block.thinking });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = payload?.delta;
        if (delta?.type === 'text_delta') out.push({ kind: 'text', delta: String(delta.text ?? '') });
        else if (delta?.type === 'thinking_delta') out.push({ kind: 'reasoning', delta: String(delta.thinking ?? '') });
        else if (delta?.type === 'signature_delta') out.push({ kind: 'reasoning_signature', signature: String(delta.signature ?? '') });
        else if (delta?.type === 'input_json_delta') out.push({ kind: 'tool_args', key: `anthropic_block_${Number(payload.index)}`, delta: String(delta.partial_json ?? '') });
        break;
      }
      case 'content_block_stop': {
        const index = Number(payload?.index);
        if (this.toolBlocks.has(index)) out.push({ kind: 'tool_end', key: `anthropic_block_${index}` });
        break;
      }
      case 'message_delta': {
        if (payload?.delta?.stop_reason) this.stopReason = payload.delta.stop_reason;
        const usage = anthropicUsage(payload?.usage);
        if (usage) out.push({ kind: 'usage', usage });
        break;
      }
      case 'message_stop':
        return [...out, ...this.end()];
      case 'error':
        this.finished = true;
        out.push({ kind: 'error', message: String(payload?.error?.message ?? 'Provider stream error'), code: payload?.error?.type });
        break;
      default:
        break;
    }
    return out;
  }

  end(): NeutralEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [...(this.started ? [] : [{ kind: 'start' } as NeutralEvent]), { kind: 'finish', reason: anthropicFinish(this.stopReason) }];
  }
}

export function neutralFromAnthropicJson(json: any): NeutralEvent[] {
  const out: NeutralEvent[] = [{ kind: 'start', id: json?.id, model: json?.model }];
  (Array.isArray(json?.content) ? json.content : []).forEach((block: any, index: number) => {
    if (block?.type === 'text') out.push({ kind: 'text', delta: String(block.text ?? '') });
    else if (block?.type === 'thinking') {
      out.push({ kind: 'reasoning', delta: String(block.thinking ?? '') });
      if (typeof block.signature === 'string') out.push({ kind: 'reasoning_signature', signature: block.signature });
    } else if (block?.type === 'tool_use') {
      const key = `anthropic_block_${index}`;
      out.push({ kind: 'tool_start', key, id: String(block.id ?? ''), name: String(block.name ?? '') });
      out.push({ kind: 'tool_args', key, delta: JSON.stringify(block.input ?? {}) });
      out.push({ kind: 'tool_end', key });
    }
  });
  const usage = anthropicUsage(json?.usage);
  if (usage) out.push({ kind: 'usage', usage });
  out.push({ kind: 'finish', reason: anthropicFinish(json?.stop_reason) });
  return out;
}

// ---------------- OpenAI Responses ----------------

export function responsesUsage(usage: any): Partial<NeutralUsage> | null {
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: num(usage.input_tokens) ?? 0,
    outputTokens: num(usage.output_tokens) ?? 0,
    cacheReadTokens: num(usage.input_tokens_details?.cached_tokens) ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: num(usage.output_tokens_details?.reasoning_tokens) ?? 0,
  };
}

function toolItemName(item: any): string {
  return String(item?.name ?? (item?.type === 'tool_search_call' ? 'tool_search' : ''));
}

export class ResponsesStreamDecoder implements StreamDecoder {
  finished = false;
  private started = false;
  private readonly toolItems = new Map<string, { args: boolean }>();

  push(event: SseEvent): NeutralEvent[] {
    if (this.finished) return [];
    const data = event.data.trim();
    if (data === '[DONE]') return this.end();
    const payload = parseJsonSafe(data);
    const type = payload?.type ?? event.event;
    const out: NeutralEvent[] = [];
    switch (type) {
      case 'response.created':
        this.started = true;
        out.push({ kind: 'start', id: payload?.response?.id, model: payload?.response?.model });
        break;
      case 'response.output_text.delta':
        out.push({ kind: 'text', delta: String(payload?.delta ?? '') });
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        out.push({ kind: 'reasoning', delta: String(payload?.delta ?? '') });
        break;
      case 'response.output_item.added': {
        const item = payload?.item;
        if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
          const key = String(item.id ?? `item_${payload?.output_index}`);
          this.toolItems.set(key, { args: false });
          out.push({ kind: 'tool_start', key, id: String(item.call_id ?? item.id ?? ''), name: toolItemName(item) });
        }
        break;
      }
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta': {
        const key = String(payload?.item_id ?? '');
        const tool = this.toolItems.get(key);
        if (tool) {
          tool.args = true;
          out.push({ kind: 'tool_args', key, delta: String(payload?.delta ?? '') });
        }
        break;
      }
      case 'response.output_item.done': {
        const item = payload?.item;
        const key = String(item?.id ?? '');
        const tool = this.toolItems.get(key);
        if (tool) {
          if (!tool.args) {
            const args = item.type === 'custom_tool_call' ? String(item.input ?? '') : String(item.arguments ?? '');
            if (args) out.push({ kind: 'tool_args', key, delta: args });
          }
          out.push({ kind: 'tool_end', key });
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const usage = responsesUsage(payload?.response?.usage);
        if (usage) out.push({ kind: 'usage', usage });
        this.finished = true;
        const reason: FinishReason = type === 'response.incomplete' ? 'length' : this.toolItems.size > 0 ? 'tool_calls' : 'stop';
        if (!this.started) out.unshift({ kind: 'start', id: payload?.response?.id, model: payload?.response?.model });
        out.push({ kind: 'finish', reason });
        break;
      }
      case 'response.failed':
        this.finished = true;
        out.push({ kind: 'error', message: String(payload?.response?.error?.message ?? 'Provider response failed'), code: payload?.response?.error?.code });
        break;
      case 'error':
        this.finished = true;
        out.push({ kind: 'error', message: String(payload?.message ?? payload?.error?.message ?? 'Provider stream error'), code: payload?.code ?? payload?.error?.code });
        break;
      default:
        break;
    }
    return out;
  }

  end(): NeutralEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [...(this.started ? [] : [{ kind: 'start' } as NeutralEvent]), { kind: 'finish', reason: this.toolItems.size > 0 ? 'tool_calls' : 'stop' }];
  }
}

export function neutralFromResponsesJson(json: any): NeutralEvent[] {
  const out: NeutralEvent[] = [{ kind: 'start', id: json?.id, model: json?.model }];
  let sawTool = false;
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (typeof part?.text === 'string') out.push({ kind: 'text', delta: part.text });
      }
    } else if (item?.type === 'reasoning') {
      const text = (Array.isArray(item.summary) ? item.summary : []).map((s: any) => s?.text ?? '').join('\n');
      if (text) out.push({ kind: 'reasoning', delta: text });
    } else if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      sawTool = true;
      const key = String(item.id ?? item.call_id);
      out.push({ kind: 'tool_start', key, id: String(item.call_id ?? item.id ?? ''), name: toolItemName(item) });
      out.push({ kind: 'tool_args', key, delta: item.type === 'custom_tool_call' ? String(item.input ?? '') : String(item.arguments ?? '') });
      out.push({ kind: 'tool_end', key });
    }
  }
  const usage = responsesUsage(json?.usage);
  if (usage) out.push({ kind: 'usage', usage });
  if (json?.status === 'failed' || json?.error) {
    out.push({ kind: 'error', message: String(json?.error?.message ?? 'Provider response failed'), code: json?.error?.code });
  } else {
    out.push({ kind: 'finish', reason: json?.status === 'incomplete' ? 'length' : sawTool ? 'tool_calls' : 'stop' });
  }
  return out;
}
