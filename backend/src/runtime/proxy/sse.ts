/**
 * SSE 增量解析与写出。
 *
 * 上游分块与事件边界毫无关系：一个 `data:` 行会在任意字节处被切开，UTF-8 多字节字符也会被切开。
 * 所以解析器按字节缓冲、只在完整的空行边界上出事件，解码交给 TextDecoder 的流模式。
 * NDJSON（部分本地服务商）按行解析，每行当成一个 `data`。
 */

export interface SseEvent {
  event: string | null;
  data: string;
}

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';
  private eventName: string | null = null;
  private dataLines: string[] = [];

  constructor(private readonly mode: 'sse' | 'ndjson' = 'sse') {}

  push(chunk: Uint8Array | string): SseEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    let index = this.buffer.search(/\r\n|\n|\r/);
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      const newlineLength = this.buffer.startsWith('\r\n', index) ? 2 : 1;
      // 一个 \r 恰好落在分块末尾时，下一块可能以 \n 开头：留到下一块再判断。
      if (!final && this.buffer[index] === '\r' && index + 1 === this.buffer.length) break;
      this.buffer = this.buffer.slice(index + newlineLength);
      this.handleLine(line, events);
      index = this.buffer.search(/\r\n|\n|\r/);
    }
    if (final) {
      if (this.buffer) this.handleLine(this.buffer, events);
      this.buffer = '';
      this.flush(events);
    }
    return events;
  }

  private handleLine(line: string, events: SseEvent[]): void {
    if (this.mode === 'ndjson') {
      if (line.trim()) events.push({ event: null, data: line });
      return;
    }
    if (line === '') {
      this.flush(events);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
  }

  private flush(events: SseEvent[]): void {
    if (this.dataLines.length === 0 && this.eventName === null) return;
    events.push({ event: this.eventName, data: this.dataLines.join('\n') });
    this.eventName = null;
    this.dataLines = [];
  }
}

export function formatSseEvent(event: string | null, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const lines = payload.split('\n').map((line) => `data: ${line}`).join('\n');
  return `${event ? `event: ${event}\n` : ''}${lines}\n\n`;
}

export function parseJsonSafe(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isEventStreamContentType(contentType: string | null | undefined): 'sse' | 'ndjson' | null {
  const value = String(contentType ?? '').toLowerCase();
  if (value.includes('text/event-stream')) return 'sse';
  if (value.includes('application/x-ndjson') || value.includes('application/jsonl')) return 'ndjson';
  return null;
}
