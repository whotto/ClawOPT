/**
 * 代理流的 tee：中立事件 → 契约的规范事件（channel = proxy）。
 *
 * 一次上游调用对应一个 `CanonicalTee`。协调器按适配器的事实来源表决定收哪些：
 * Codex 收代理的文本增量求快、Claude Code 只收代理的用量，工具生命周期一律只信 CLI。
 * 用量的 callId 以上游响应 id 为底（没有就用本目标上的调用序号），同一次调用只报一次。
 */
import type { CanonicalEvent, UsageReport } from '../contract';
import { emptyNeutralUsage, mergeUsage, type NeutralEvent, type NeutralUsage } from './stream-neutral';
import type { ProxyTarget } from './types';

export class CanonicalTee {
  private responseId: string;
  private model: string | undefined;
  private messageOpened = false;
  private text = '';
  private readonly usage: NeutralUsage = emptyNeutralUsage();
  private sawUsage = false;
  private readonly tools = new Map<string, { id: string; name: string; args: string }>();
  private done = false;

  constructor(
    private readonly target: Pick<ProxyTarget, 'runtime' | 'sessionId' | 'provider' | 'model'>,
    private readonly callSequence: number,
    private readonly emit: (event: CanonicalEvent) => void,
  ) {
    this.responseId = `proxy_${target.sessionId}_${callSequence}`;
  }

  private get messageItemId(): string {
    return `msg_${this.responseId}`;
  }

  push(event: NeutralEvent): void {
    if (this.done) return;
    switch (event.kind) {
      case 'start':
        if (event.id) this.responseId = event.id;
        this.model = event.model;
        this.emit({ type: 'response.created', response_id: this.responseId, model: event.model ?? this.target.model });
        break;
      case 'text':
        if (!event.delta) break;
        if (!this.messageOpened) {
          this.messageOpened = true;
          this.emit({ type: 'response.output_item.added', item: { type: 'message', id: this.messageItemId, role: 'assistant' } });
        }
        this.text += event.delta;
        this.emit({ type: 'response.output_text.delta', item_id: this.messageItemId, delta: event.delta });
        break;
      case 'reasoning':
        if (event.delta) this.emit({ type: 'response.reasoning.delta', item_id: `rs_${this.responseId}`, delta: event.delta });
        break;
      case 'tool_start': {
        const tool = { id: event.id || event.key, name: event.name, args: '' };
        this.tools.set(event.key, tool);
        this.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: tool.id, call_id: tool.id, name: tool.name, arguments: '' } });
        break;
      }
      case 'tool_args': {
        const tool = this.tools.get(event.key);
        if (!tool || !event.delta) break;
        tool.args += event.delta;
        this.emit({ type: 'response.function_call_arguments.delta', item_id: tool.id, call_id: tool.id, delta: event.delta });
        break;
      }
      case 'tool_end': {
        const tool = this.tools.get(event.key);
        if (tool) this.emit({ type: 'response.output_item.done', item: { type: 'function_call', id: tool.id, call_id: tool.id, name: tool.name, arguments: tool.args || '{}' } });
        break;
      }
      case 'usage':
        this.sawUsage = true;
        mergeUsage(this.usage, event.usage);
        break;
      case 'finish':
        this.done = true;
        this.reportUsage();
        if (this.messageOpened) {
          this.emit({ type: 'response.output_text.done', item_id: this.messageItemId, text: this.text });
          this.emit({ type: 'response.output_item.done', item: { type: 'message', id: this.messageItemId, role: 'assistant', text: this.text } });
        }
        this.emit({ type: 'response.completed', response_id: this.responseId, output_text: this.text, stop_reason: event.reason });
        break;
      case 'error':
        this.done = true;
        this.reportUsage();
        this.emit({ type: 'response.failed', response_id: this.responseId, error: { message: event.message, code: event.code } });
        break;
      default:
        break;
    }
  }

  private reportUsage(): void {
    if (!this.sawUsage) return;
    const usage: UsageReport = {
      callId: `${this.target.runtime}:proxy:${this.target.sessionId}:${this.responseId}`,
      scope: 'model_call',
      model: this.model ?? this.target.model,
      provider: this.target.provider,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens,
      reasoningTokens: this.usage.reasoningTokens,
      apiCalls: 1,
    };
    this.emit({ type: 'usage.reported', usage });
  }
}
