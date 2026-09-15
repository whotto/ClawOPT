/**
 * 响应的中立事件：三种上游格式（Chat / Responses / Anthropic，流式或 JSON）先解码成它，
 * 再编码成客户端格式（Anthropic SSE/JSON 或 Responses SSE/JSON），tee 也吃同一串事件。
 */

export interface NeutralUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

export type NeutralEvent =
  | { kind: 'start'; id?: string; model?: string }
  | { kind: 'text'; delta: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: 'reasoning_signature'; signature: string }
  /** `key` 区分并行调用（Chat 的 index、Responses 的 item id、Anthropic 的块序号）。 */
  | { kind: 'tool_start'; key: string; id: string; name: string }
  | { kind: 'tool_args'; key: string; delta: string }
  | { kind: 'tool_end'; key: string }
  | { kind: 'usage'; usage: Partial<NeutralUsage> }
  | { kind: 'finish'; reason: FinishReason }
  | { kind: 'error'; message: string; code?: string };

export function emptyNeutralUsage(): NeutralUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

export function mergeUsage(into: NeutralUsage, patch: Partial<NeutralUsage>): NeutralUsage {
  for (const key of Object.keys(patch) as Array<keyof NeutralUsage>) {
    const value = patch[key];
    if (typeof value === 'number' && Number.isFinite(value)) into[key] = value;
  }
  return into;
}

export type NeutralBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature?: string }
  | { type: 'tool'; key: string; id: string; name: string; arguments: string };

export interface NeutralResponse {
  id: string;
  model: string;
  blocks: NeutralBlock[];
  finish: FinishReason;
  usage: NeutralUsage | null;
  error: { message: string; code?: string } | null;
}

/** 把一串中立事件收拢成完整响应（JSON 响应的编码与非流式 tee 用）。 */
export class NeutralAccumulator {
  readonly response: NeutralResponse;
  private readonly tools = new Map<string, Extract<NeutralBlock, { type: 'tool' }>>();

  constructor(fallback: { id: string; model: string }) {
    this.response = { id: fallback.id, model: fallback.model, blocks: [], finish: 'stop', usage: null, error: null };
  }

  push(event: NeutralEvent): void {
    const blocks = this.response.blocks;
    const last = blocks[blocks.length - 1];
    switch (event.kind) {
      case 'start':
        if (event.id) this.response.id = event.id;
        if (event.model) this.response.model = event.model;
        break;
      case 'text':
        if (last?.type === 'text') last.text += event.delta;
        else blocks.push({ type: 'text', text: event.delta });
        break;
      case 'reasoning':
        if (last?.type === 'reasoning') last.text += event.delta;
        else blocks.push({ type: 'reasoning', text: event.delta });
        break;
      case 'reasoning_signature':
        if (last?.type === 'reasoning') last.signature = (last.signature ?? '') + event.signature;
        break;
      case 'tool_start': {
        const block = { type: 'tool' as const, key: event.key, id: event.id, name: event.name, arguments: '' };
        this.tools.set(event.key, block);
        blocks.push(block);
        break;
      }
      case 'tool_args': {
        const block = this.tools.get(event.key);
        if (block) block.arguments += event.delta;
        break;
      }
      case 'usage':
        this.response.usage = mergeUsage(this.response.usage ?? emptyNeutralUsage(), event.usage);
        break;
      case 'finish':
        this.response.finish = event.reason;
        break;
      case 'error':
        this.response.error = { message: event.message, code: event.code };
        break;
      default:
        break;
    }
  }

  get hasToolCalls(): boolean {
    return this.tools.size > 0;
  }
}

/**
 * 累计快照与增量混用的上游（部分 Chat 服务商的 reasoning 字段是累计的）：
 * 新块以已累计文本开头 → 只取后缀；否则当增量。
 */
export class CumulativeOrDelta {
  private accumulated = '';

  next(chunk: string): string {
    if (!chunk) return '';
    // 短于 16 字符的累计文本不做判定：短块重复（如连续两个「好」）更可能是真增量。
    const judgeable = this.accumulated.length >= 16;
    if (judgeable && chunk.length > this.accumulated.length && chunk.startsWith(this.accumulated)) {
      const suffix = chunk.slice(this.accumulated.length);
      this.accumulated = chunk;
      return suffix;
    }
    if (judgeable && chunk === this.accumulated) return '';
    this.accumulated += chunk;
    return chunk;
  }
}
