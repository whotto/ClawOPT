/**
 * 一轮的规范事件合成器：各运行时的解析器把原生输出喂进来，这里产出 Responses 形状的事件。
 *
 * 只做「形状」上的事：懒开消息 item、工具调用去重（同一 call id 只开一次）、
 * 累计快照转增量（`dedupeAppendedText`）、终态事件。**不做**仲裁、落库、陈旧判断——那些在协调器里。
 */
import {
  dedupeAppendedText,
  type AdapterEvent,
  type CanonicalEvent,
  type RuntimeChannel,
  type SessionCommandResult,
  type UsageReport,
} from '../../contract';

/** 工具输出落库前的上限：头 24 KiB + 尾 7 KiB（与代理的请求体瘦身同一个量级）。 */
export const TOOL_OUTPUT_LIMIT = 32 * 1024;

export function truncateToolOutput(output: string): string {
  if (output.length <= TOOL_OUTPUT_LIMIT) return output;
  const head = output.slice(0, 24 * 1024);
  const tail = output.slice(-7 * 1024);
  return `${head}\n…[truncated ${output.length - head.length - tail.length} chars]…\n${tail}`;
}

export function stringifyArgs(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content?.text === 'string') return part.content.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  if (typeof (content as any)?.text === 'string') return (content as any).text;
  return stringifyArgs(content);
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class TurnEmitter {
  private responseId: string;
  private created = false;
  private openMessageId: string | null = null;
  private messageSeq = 0;
  private messageText = '';
  private toolBoundary = false;
  private readonly startedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();
  private readonly toolOutputs = new Set<string>();
  private terminal: 'completed' | 'failed' | null = null;
  private nativeSession: string | null = null;
  /** 本轮全部正文（跨消息 item，工具边界之间以空行分隔）。 */
  text = '';
  reasoningText = '';
  model: string | undefined;

  constructor(
    private readonly runId: string,
    private readonly sink: (event: AdapterEvent) => void,
    private readonly channel: RuntimeChannel = 'native',
  ) {
    this.responseId = `resp_${runId}`;
  }

  get terminalState(): 'completed' | 'failed' | null {
    return this.terminal;
  }

  get nativeSessionId(): string | null {
    return this.nativeSession;
  }

  private emit(event: CanonicalEvent): void {
    this.sink({ channel: this.channel, event });
  }

  ensureCreated(model?: string): void {
    if (model) this.model = model;
    if (this.created) return;
    this.created = true;
    this.emit({ type: 'response.created', response_id: this.responseId, model: this.model });
  }

  /** 运行时自报的 response / 消息 id（例如 Claude 的 message_start）；只在还没发出 created 前采用。 */
  adoptResponseId(id: string): void {
    if (!this.created && id) this.responseId = id;
  }

  init(model?: string, runtimeVersion?: string): void {
    if (model) this.model = model;
    this.emit({ type: 'runtime.init', model, runtimeVersion });
  }

  session(nativeSessionId: string | undefined | null): void {
    if (!nativeSessionId || nativeSessionId === this.nativeSession) return;
    this.nativeSession = nativeSessionId;
    this.emit({ type: 'runtime.native_session', nativeSessionId });
  }

  private openMessage(): string {
    this.ensureCreated();
    if (this.openMessageId) return this.openMessageId;
    this.openMessageId = `msg_${this.responseId}_${this.messageSeq++}`;
    this.messageText = '';
    this.emit({ type: 'response.output_item.added', item: { type: 'message', id: this.openMessageId, role: 'assistant' } });
    return this.openMessageId;
  }

  private closeMessage(): void {
    if (!this.openMessageId) return;
    const id = this.openMessageId;
    this.emit({ type: 'response.output_text.done', item_id: id, text: this.messageText });
    this.emit({ type: 'response.output_item.done', item: { type: 'message', id, role: 'assistant', text: this.messageText } });
    this.openMessageId = null;
  }

  /** 真增量。 */
  textDelta(delta: string): void {
    if (!delta || this.terminal) return;
    const id = this.openMessage();
    let chunk = delta;
    if (this.toolBoundary && this.text && this.messageText === '') {
      const separator = this.text.endsWith('\n\n') ? '' : this.text.endsWith('\n') ? '\n' : '\n\n';
      chunk = separator + delta;
    }
    this.toolBoundary = false;
    this.messageText += delta;
    this.text += chunk;
    this.emit({ type: 'response.output_text.delta', item_id: id, delta: chunk });
  }

  /**
   * 可能是累计快照、也可能是增量的一块（OpenCode 的 text part、Pi 的 message_end 终文、Codex 的整条消息）。
   * 对**当前消息**去重后只发多出来的部分。
   */
  textChunk(chunk: string): void {
    if (!chunk || this.terminal) return;
    const suffix = this.messageText ? dedupeAppendedText(this.messageText, chunk) : chunk;
    if (suffix) this.textDelta(suffix);
  }

  /** 整条消息的终文：已经流过的就只补缺的后缀；分叉时不重复拼接。 */
  reconcileMessageText(finalText: string): void {
    if (!finalText || this.terminal) return;
    if (!this.messageText) {
      this.textDelta(finalText);
      return;
    }
    if (finalText === this.messageText || this.messageText.endsWith(finalText)) return;
    if (finalText.startsWith(this.messageText)) this.textDelta(finalText.slice(this.messageText.length));
  }

  reasoningDelta(delta: string): void {
    if (!delta || this.terminal) return;
    this.ensureCreated();
    this.reasoningText += delta;
    this.emit({ type: 'response.reasoning.delta', item_id: `rs_${this.responseId}`, delta });
  }

  /** 工具边界：之后的正文另开一个消息 item。 */
  boundary(): void {
    this.closeMessage();
    this.toolBoundary = true;
  }

  toolStarted(input: { callId: string; name: string; args?: unknown }): void {
    if (!input.callId || this.startedTools.has(input.callId) || this.terminal) return;
    this.ensureCreated();
    this.boundary();
    this.startedTools.add(input.callId);
    this.emit({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: input.callId, call_id: input.callId, name: input.name || 'tool', arguments: stringifyArgs(input.args) },
    });
  }

  toolArgumentsDelta(callId: string, delta: string): void {
    if (!delta || !this.startedTools.has(callId) || this.finishedTools.has(callId)) return;
    this.emit({ type: 'response.function_call_arguments.delta', item_id: callId, call_id: callId, delta });
  }

  toolCallDone(input: { callId: string; name: string; args?: unknown }): void {
    if (!input.callId || this.finishedTools.has(input.callId) || this.terminal) return;
    if (!this.startedTools.has(input.callId)) this.toolStarted(input);
    this.finishedTools.add(input.callId);
    this.emit({
      type: 'response.output_item.done',
      item: { type: 'function_call', id: input.callId, call_id: input.callId, name: input.name || 'tool', arguments: stringifyArgs(input.args) },
    });
  }

  toolOutput(input: { callId: string; output: string; failed?: boolean; name?: string; args?: unknown }): void {
    if (!input.callId || this.toolOutputs.has(input.callId) || this.terminal) return;
    this.toolOutputs.add(input.callId);
    this.boundary();
    this.emit({
      type: 'response.output_item.done',
      item: {
        type: 'function_call_output',
        id: `out_${input.callId}`,
        call_id: input.callId,
        output: truncateToolOutput(input.output),
        status: input.failed ? 'failed' : 'completed',
        ...(input.name ? { name: input.name } : {}),
        ...(input.args !== undefined ? { arguments: stringifyArgs(input.args) } : {}),
      },
    });
  }

  /** 会话命令结果 / 运行中途的压缩完成（契约事件 `session.command`，不走计划、不进正文）。 */
  commandResult(result: SessionCommandResult): void {
    this.ensureCreated();
    this.emit({ type: 'session.command', result });
  }

  plan(plan: unknown): void {
    this.emit({ type: 'plan.updated', plan });
  }

  usage(usage: UsageReport): void {
    this.emit({ type: 'usage.reported', usage });
  }

  completed(stopReason?: string, outputText?: string): void {
    if (this.terminal) return;
    this.ensureCreated();
    this.closeMessage();
    this.terminal = 'completed';
    this.emit({ type: 'response.completed', response_id: this.responseId, output_text: outputText ?? this.text, stop_reason: stopReason });
  }

  failed(message: string, code?: string): void {
    if (this.terminal) return;
    this.ensureCreated();
    this.closeMessage();
    this.terminal = 'failed';
    this.emit({ type: 'response.failed', response_id: this.responseId, error: { message, code } });
  }
}
