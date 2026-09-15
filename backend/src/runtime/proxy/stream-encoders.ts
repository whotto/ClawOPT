/**
 * 中立事件 → 客户端格式（Anthropic Messages SSE/JSON，或 OpenAI Responses SSE/JSON）。
 */
import { randomUUID } from 'crypto';

import type { IrToolOrigin, ToolNameMap } from './request-ir';
import { formatSseEvent } from './sse';
import { emptyNeutralUsage, mergeUsage, type FinishReason, type NeutralEvent, type NeutralResponse, type NeutralUsage } from './stream-neutral';

function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function anthropicStopReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  return 'end_turn';
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// ---------------- Anthropic ----------------

type OpenBlock = { index: number; type: 'text' | 'thinking' | 'tool_use'; key?: string };

export class AnthropicStreamEncoder {
  private started = false;
  private finished = false;
  private nextIndex = 0;
  private open: OpenBlock | null = null;
  private readonly usage: NeutralUsage = emptyNeutralUsage();
  private messageId = shortId('msg');

  constructor(private readonly clientModel: string) {}

  get isStarted(): boolean {
    return this.started;
  }

  private ensureStarted(out: string[], id?: string): void {
    if (this.started) return;
    this.started = true;
    if (id) this.messageId = id.startsWith('msg') ? id : `msg_${id.replace(/[^A-Za-z0-9_]/g, '')}`;
    out.push(formatSseEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.clientModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.usage.inputTokens, output_tokens: 0 },
      },
    }));
  }

  private closeOpen(out: string[]): void {
    if (!this.open) return;
    out.push(formatSseEvent('content_block_stop', { type: 'content_block_stop', index: this.open.index }));
    this.open = null;
  }

  private openBlock(out: string[], type: OpenBlock['type'], contentBlock: Record<string, unknown>, key?: string): OpenBlock {
    this.closeOpen(out);
    const block: OpenBlock = { index: this.nextIndex++, type, key };
    this.open = block;
    out.push(formatSseEvent('content_block_start', { type: 'content_block_start', index: block.index, content_block: contentBlock }));
    return block;
  }

  push(event: NeutralEvent): string {
    if (this.finished) return '';
    const out: string[] = [];
    switch (event.kind) {
      case 'start':
        this.ensureStarted(out, event.id);
        break;
      case 'usage':
        mergeUsage(this.usage, event.usage);
        break;
      case 'text': {
        if (!event.delta) break;
        this.ensureStarted(out);
        const block = this.open?.type === 'text' ? this.open : this.openBlock(out, 'text', { type: 'text', text: '' });
        out.push(formatSseEvent('content_block_delta', { type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text: event.delta } }));
        break;
      }
      case 'reasoning': {
        if (!event.delta) break;
        this.ensureStarted(out);
        const block = this.open?.type === 'thinking' ? this.open : this.openBlock(out, 'thinking', { type: 'thinking', thinking: '', signature: '' });
        out.push(formatSseEvent('content_block_delta', { type: 'content_block_delta', index: block.index, delta: { type: 'thinking_delta', thinking: event.delta } }));
        break;
      }
      case 'reasoning_signature':
        if (this.open?.type === 'thinking' && event.signature) {
          out.push(formatSseEvent('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'signature_delta', signature: event.signature } }));
        }
        break;
      case 'tool_start': {
        this.ensureStarted(out);
        const id = event.id || shortId('toolu');
        this.openBlock(out, 'tool_use', { type: 'tool_use', id, name: event.name, input: {} }, event.key);
        break;
      }
      case 'tool_args':
        if (this.open?.type === 'tool_use' && this.open.key === event.key && event.delta) {
          out.push(formatSseEvent('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'input_json_delta', partial_json: event.delta } }));
        }
        break;
      case 'tool_end':
        if (this.open?.type === 'tool_use' && this.open.key === event.key) this.closeOpen(out);
        break;
      case 'finish':
        this.ensureStarted(out);
        this.closeOpen(out);
        out.push(formatSseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: anthropicStopReason(event.reason), stop_sequence: null },
          usage: {
            input_tokens: this.usage.inputTokens,
            output_tokens: this.usage.outputTokens,
            cache_read_input_tokens: this.usage.cacheReadTokens,
            cache_creation_input_tokens: this.usage.cacheWriteTokens,
          },
        }));
        out.push(formatSseEvent('message_stop', { type: 'message_stop' }));
        this.finished = true;
        break;
      case 'error':
        this.closeOpen(out);
        out.push(formatSseEvent('error', { type: 'error', error: { type: 'api_error', message: event.message } }));
        this.finished = true;
        break;
    }
    return out.join('');
  }

  /** 上游流没给终态就断了：补一个错误帧，别让 CLI 一直等。 */
  finalize(): string {
    if (this.finished) return '';
    return this.push({ kind: 'error', message: 'Upstream stream ended before completion' });
  }
}

export function anthropicJsonFromNeutral(response: NeutralResponse, clientModel: string): Record<string, unknown> {
  const content: any[] = [];
  for (const block of response.blocks) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text, signature: block.signature ?? '' });
    else content.push({ type: 'tool_use', id: block.id || shortId('toolu'), name: block.name, input: parseObject(block.arguments) });
  }
  const usage = response.usage ?? emptyNeutralUsage();
  return {
    id: response.id.startsWith('msg') ? response.id : shortId('msg'),
    type: 'message',
    role: 'assistant',
    model: clientModel,
    content,
    stop_reason: anthropicStopReason(response.finish),
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
    },
  };
}

// ---------------- Responses ----------------

export type ResponsesUsagePolicy = 'include' | 'zero_fill' | 'strip';

export function responsesUsageObject(usage: NeutralUsage | null): Record<string, unknown> {
  const u = usage ?? emptyNeutralUsage();
  return {
    input_tokens: u.inputTokens,
    input_tokens_details: { cached_tokens: u.cacheReadTokens },
    output_tokens: u.outputTokens,
    output_tokens_details: { reasoning_tokens: u.reasoningTokens },
    total_tokens: u.inputTokens + u.outputTokens,
  };
}

/** 上游函数调用 → 客户端认得的输出项（按请求时记下的还原表把命名空间、自定义工具还原回去）。 */
export function clientToolItem(origin: IrToolOrigin | undefined, base: { id: string; callId: string; name: string; arguments: string; status: string }): Record<string, unknown> {
  if (origin?.kind === 'namespace') {
    return { id: base.id, type: 'function_call', status: base.status, call_id: base.callId, name: origin.name, namespace: origin.namespace, arguments: base.arguments };
  }
  if (origin?.kind === 'dispatcher') {
    const args = parseObject(base.arguments);
    const tool = typeof args.tool === 'string' ? args.tool : base.name;
    return {
      id: base.id,
      type: 'function_call',
      status: base.status,
      call_id: base.callId,
      name: tool,
      namespace: origin.namespace,
      arguments: JSON.stringify(args.arguments && typeof args.arguments === 'object' ? args.arguments : {}),
    };
  }
  if (origin?.kind === 'custom') {
    const args = parseObject(base.arguments);
    return { id: base.id, type: 'custom_tool_call', status: base.status, call_id: base.callId, name: origin.name, input: typeof args.input === 'string' ? args.input : base.arguments };
  }
  if (origin?.kind === 'tool_search') {
    // Codex 的 ResponseItem::ToolSearchCall：`execution: client` 表示由客户端执行搜索，参数是对象而不是字符串。
    // 还原成普通 function_call 时 Codex 不认识 `tool_search` 这个函数，直接回 "aborted"（集成 P2 真机实测）。
    return { id: base.id, type: 'tool_search_call', status: base.status, call_id: base.callId, execution: 'client', arguments: parseObject(base.arguments) };
  }
  return { id: base.id, type: 'function_call', status: base.status, call_id: base.callId, name: base.name, arguments: base.arguments };
}

type OpenItem =
  | { kind: 'message'; index: number; id: string; text: string }
  | { kind: 'reasoning'; index: number; id: string; text: string }
  | { kind: 'tool'; index: number; id: string; key: string; callId: string; name: string; args: string; buffered: boolean };

export class ResponsesStreamEncoder {
  private started = false;
  private finished = false;
  private sequence = 0;
  private open: OpenItem | null = null;
  private readonly output: Record<string, unknown>[] = [];
  private readonly usage: NeutralUsage = emptyNeutralUsage();
  private sawUsage = false;
  private responseId = shortId('resp');
  private readonly createdAt = Math.floor(Date.now() / 1000);

  constructor(private readonly options: { model: string; toolNames: ToolNameMap; usagePolicy: ResponsesUsagePolicy }) {}

  get isStarted(): boolean {
    return this.started;
  }

  private emit(out: string[], type: string, data: Record<string, unknown>): void {
    out.push(formatSseEvent(type, { type, sequence_number: this.sequence++, ...data }));
  }

  private responseObject(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: this.responseId, object: 'response', created_at: this.createdAt, status, model: this.options.model, output: [...this.output], ...extra };
  }

  private ensureStarted(out: string[], id?: string): void {
    if (this.started) return;
    this.started = true;
    if (id) this.responseId = id.startsWith('resp') ? id : `resp_${id.replace(/[^A-Za-z0-9_]/g, '')}`;
    this.emit(out, 'response.created', { response: this.responseObject('in_progress') });
    this.emit(out, 'response.in_progress', { response: this.responseObject('in_progress') });
  }

  private closeOpen(out: string[]): void {
    const item = this.open;
    if (!item) return;
    this.open = null;
    if (item.kind === 'message') {
      const part = { type: 'output_text', text: item.text, annotations: [] };
      this.emit(out, 'response.output_text.done', { item_id: item.id, output_index: item.index, content_index: 0, text: item.text });
      this.emit(out, 'response.content_part.done', { item_id: item.id, output_index: item.index, content_index: 0, part });
      const done = { id: item.id, type: 'message', status: 'completed', role: 'assistant', content: [part] };
      this.output.push(done);
      this.emit(out, 'response.output_item.done', { output_index: item.index, item: done });
    } else if (item.kind === 'reasoning') {
      const part = { type: 'summary_text', text: item.text };
      this.emit(out, 'response.reasoning_summary_text.done', { item_id: item.id, output_index: item.index, summary_index: 0, text: item.text });
      this.emit(out, 'response.reasoning_summary_part.done', { item_id: item.id, output_index: item.index, summary_index: 0, part });
      const done = { id: item.id, type: 'reasoning', summary: [part] };
      this.output.push(done);
      this.emit(out, 'response.output_item.done', { output_index: item.index, item: done });
    } else {
      const origin = this.options.toolNames.get(item.name);
      const done = clientToolItem(origin, { id: item.id, callId: item.callId, name: item.name, arguments: item.args || '{}', status: 'completed' });
      if (item.buffered) {
        this.emit(out, 'response.output_item.added', { output_index: item.index, item: { ...done, status: 'in_progress' } });
      } else {
        this.emit(out, 'response.function_call_arguments.done', { item_id: item.id, output_index: item.index, arguments: item.args || '{}' });
      }
      this.output.push(done);
      this.emit(out, 'response.output_item.done', { output_index: item.index, item: done });
    }
  }

  private nextOutputIndex(): number {
    return this.output.length;
  }

  push(event: NeutralEvent): string {
    if (this.finished) return '';
    const out: string[] = [];
    switch (event.kind) {
      case 'start':
        this.ensureStarted(out, event.id);
        break;
      case 'usage':
        this.sawUsage = true;
        mergeUsage(this.usage, event.usage);
        break;
      case 'text': {
        if (!event.delta) break;
        this.ensureStarted(out);
        if (this.open?.kind !== 'message') {
          this.closeOpen(out);
          const item: OpenItem = { kind: 'message', index: this.nextOutputIndex(), id: shortId('msg'), text: '' };
          this.open = item;
          this.emit(out, 'response.output_item.added', { output_index: item.index, item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
          this.emit(out, 'response.content_part.added', { item_id: item.id, output_index: item.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        const item = this.open as Extract<OpenItem, { kind: 'message' }>;
        item.text += event.delta;
        this.emit(out, 'response.output_text.delta', { item_id: item.id, output_index: item.index, content_index: 0, delta: event.delta });
        break;
      }
      case 'reasoning': {
        if (!event.delta) break;
        this.ensureStarted(out);
        if (this.open?.kind !== 'reasoning') {
          this.closeOpen(out);
          const item: OpenItem = { kind: 'reasoning', index: this.nextOutputIndex(), id: shortId('rs'), text: '' };
          this.open = item;
          this.emit(out, 'response.output_item.added', { output_index: item.index, item: { id: item.id, type: 'reasoning', summary: [] } });
          this.emit(out, 'response.reasoning_summary_part.added', { item_id: item.id, output_index: item.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
        }
        const item = this.open as Extract<OpenItem, { kind: 'reasoning' }>;
        item.text += event.delta;
        this.emit(out, 'response.reasoning_summary_text.delta', { item_id: item.id, output_index: item.index, summary_index: 0, delta: event.delta });
        break;
      }
      case 'tool_start': {
        this.ensureStarted(out);
        this.closeOpen(out);
        const origin = this.options.toolNames.get(event.name);
        // 需要还原的工具（命名空间、分发、自定义）要看到完整参数才知道最终形状：攒到结束再一次发出。
        const buffered = !!origin && origin.kind !== 'function';
        const item: OpenItem = { kind: 'tool', index: this.nextOutputIndex(), id: shortId('fc'), key: event.key, callId: event.id || shortId('call'), name: event.name, args: '', buffered };
        this.open = item;
        if (!buffered) {
          this.emit(out, 'response.output_item.added', {
            output_index: item.index,
            item: clientToolItem(origin, { id: item.id, callId: item.callId, name: item.name, arguments: '', status: 'in_progress' }),
          });
        }
        break;
      }
      case 'tool_args': {
        const item = this.open;
        if (item?.kind !== 'tool' || item.key !== event.key || !event.delta) break;
        item.args += event.delta;
        if (!item.buffered) this.emit(out, 'response.function_call_arguments.delta', { item_id: item.id, output_index: item.index, delta: event.delta });
        break;
      }
      case 'tool_end':
        if (this.open?.kind === 'tool' && this.open.key === event.key) this.closeOpen(out);
        break;
      case 'finish': {
        this.ensureStarted(out);
        this.closeOpen(out);
        const extra: Record<string, unknown> = {};
        const policy = this.options.usagePolicy;
        if (policy === 'zero_fill' || (policy === 'include' && this.sawUsage)) extra.usage = responsesUsageObject(this.usage);
        if (event.reason === 'length') {
          this.emit(out, 'response.incomplete', { response: this.responseObject('incomplete', { ...extra, incomplete_details: { reason: 'max_output_tokens' } }) });
        } else {
          this.emit(out, 'response.completed', { response: this.responseObject('completed', extra) });
        }
        this.finished = true;
        break;
      }
      case 'error':
        this.ensureStarted(out);
        this.closeOpen(out);
        this.emit(out, 'response.failed', { response: this.responseObject('failed', { error: { code: event.code ?? 'provider_error', message: event.message } }) });
        this.finished = true;
        break;
    }
    return out.join('');
  }

  finalize(): string {
    if (this.finished) return '';
    return this.push({ kind: 'error', message: 'Upstream stream ended before completion', code: 'upstream_incomplete' });
  }
}

export function responsesJsonFromNeutral(response: NeutralResponse, options: { model: string; toolNames: ToolNameMap; usagePolicy: ResponsesUsagePolicy }): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  for (const block of response.blocks) {
    if (block.type === 'text') {
      output.push({ id: shortId('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }] });
    } else if (block.type === 'reasoning') {
      output.push({ id: shortId('rs'), type: 'reasoning', summary: [{ type: 'summary_text', text: block.text }] });
    } else {
      output.push(clientToolItem(options.toolNames.get(block.name), { id: shortId('fc'), callId: block.id || shortId('call'), name: block.name, arguments: block.arguments || '{}', status: 'completed' }));
    }
  }
  const body: Record<string, unknown> = {
    id: response.id.startsWith('resp') ? response.id : shortId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: response.error ? 'failed' : response.finish === 'length' ? 'incomplete' : 'completed',
    model: options.model,
    output,
  };
  if (response.error) body.error = { code: response.error.code ?? 'provider_error', message: response.error.message };
  if (options.usagePolicy === 'zero_fill' || (options.usagePolicy === 'include' && response.usage)) body.usage = responsesUsageObject(response.usage);
  return body;
}
