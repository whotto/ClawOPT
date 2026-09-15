/**
 * Anthropic Messages 请求 ↔ 中间表示。
 */
import { stringifyJson, type IrMessage, type IrPart, type IrRequest, type IrTool } from './request-ir';

function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => (typeof block === 'string' ? block : block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

function partsOfBlocks(content: unknown): IrPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: IrPart[] = [];
  for (const block of content as any[]) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
        break;
      case 'image': {
        const source = block.source ?? {};
        if (source.type === 'base64') parts.push({ type: 'image', mediaType: String(source.media_type || 'image/png'), data: String(source.data || '') });
        else if (source.type === 'url') parts.push({ type: 'image', mediaType: 'image/*', url: String(source.url || '') });
        break;
      }
      case 'document':
        parts.push({ type: 'text', text: '[document omitted by proxy]' });
        break;
      case 'tool_use':
        parts.push({ type: 'tool_call', id: String(block.id ?? ''), name: String(block.name ?? 'tool'), arguments: stringifyJson(block.input) });
        break;
      case 'tool_result':
        parts.push({
          type: 'tool_result',
          callId: String(block.tool_use_id ?? ''),
          content: textOfBlocks(block.content),
          isError: block.is_error === true,
        });
        break;
      case 'thinking':
        parts.push({ type: 'reasoning', text: String(block.thinking ?? ''), signature: typeof block.signature === 'string' ? block.signature : undefined });
        break;
      case 'redacted_thinking':
        parts.push({ type: 'reasoning', text: '', redacted: String(block.data ?? '') });
        break;
      default:
        break;
    }
  }
  return parts;
}

export function parseAnthropicRequest(body: any): IrRequest {
  const system: string[] = [];
  if (typeof body?.system === 'string' && body.system) system.push(body.system);
  else if (Array.isArray(body?.system)) {
    const text = textOfBlocks(body.system);
    if (text) system.push(text);
  }

  const messages: IrMessage[] = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, parts: partsOfBlocks(message?.content) });
  }

  const tools: IrTool[] = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    if (!tool || typeof tool.name !== 'string') continue;
    // 服务端工具（web_search_20250305 这类带 type 的）别家上游没有，不转。
    if (typeof tool.type === 'string' && tool.type !== 'custom') continue;
    tools.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      parameters: tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : { type: 'object', properties: {} },
      origin: { kind: 'function' },
    });
  }

  let toolChoice: IrRequest['toolChoice'];
  const choice = body?.tool_choice;
  if (choice?.type === 'auto') toolChoice = 'auto';
  else if (choice?.type === 'any') toolChoice = 'required';
  else if (choice?.type === 'none') toolChoice = 'none';
  else if (choice?.type === 'tool' && typeof choice.name === 'string') toolChoice = { name: choice.name };

  return {
    model: String(body?.model ?? ''),
    system,
    messages,
    tools,
    toolChoice,
    maxTokens: typeof body?.max_tokens === 'number' ? body.max_tokens : undefined,
    temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body?.top_p === 'number' ? body.top_p : undefined,
    stop: Array.isArray(body?.stop_sequences) ? body.stop_sequences.filter((s: unknown) => typeof s === 'string') : undefined,
    stream: body?.stream === true,
    parallelToolCalls: choice?.disable_parallel_tool_use === true ? false : undefined,
  };
}

function parseArguments(raw: string): unknown {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' ? value : { value };
  } catch {
    return { raw };
  }
}

/** 中间表示 → Anthropic Messages 请求体（Responses 客户端打 Anthropic 上游时用）。 */
export function emitAnthropicRequest(ir: IrRequest, options: { model: string; stream: boolean; defaultMaxTokens?: number }): Record<string, unknown> {
  const out: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    // Anthropic 要求 user / assistant 交替：同角色的相邻消息合并。
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const message of ir.messages) {
    const blocks: any[] = [];
    for (const part of message.parts) {
      switch (part.type) {
        case 'text':
          if (part.text) blocks.push({ type: 'text', text: part.text });
          break;
        case 'image':
          if (part.data) blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } });
          else if (part.url) blocks.push({ type: 'image', source: { type: 'url', url: part.url } });
          break;
        case 'tool_call':
          blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: parseArguments(part.arguments) });
          break;
        case 'tool_result':
          blocks.push({ type: 'tool_result', tool_use_id: part.callId, content: part.content, ...(part.isError ? { is_error: true } : {}) });
          break;
        case 'reasoning':
          // 只有带签名的原生思维块能回放；别家的思维文本交给 Anthropic 会被当成伪造的签名拒掉。
          if (message.role === 'assistant' && part.signature) blocks.push({ type: 'thinking', thinking: part.text, signature: part.signature });
          else if (message.role === 'assistant' && part.redacted) blocks.push({ type: 'redacted_thinking', data: part.redacted });
          break;
      }
    }
    push(message.role, blocks);
  }
  if (out.length === 0 || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });

  const body: Record<string, unknown> = {
    model: options.model,
    messages: out,
    max_tokens: ir.maxTokens ?? options.defaultMaxTokens ?? 32000,
    stream: options.stream,
  };
  if (ir.system.length > 0) body.system = ir.system.join('\n\n');
  if (ir.tools.length > 0) {
    body.tools = ir.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  }
  if (ir.toolChoice === 'required') body.tool_choice = { type: 'any' };
  else if (ir.toolChoice === 'none') body.tool_choice = { type: 'none' };
  else if (typeof ir.toolChoice === 'object') body.tool_choice = { type: 'tool', name: ir.toolChoice.name };
  if (ir.temperature !== undefined) body.temperature = ir.temperature;
  if (ir.topP !== undefined) body.top_p = ir.topP;
  if (ir.stop?.length) body.stop_sequences = ir.stop;
  return body;
}

const ENCRYPTED_THINKING_MESSAGE = /encrypted[_ ]content[^.]*(?:could not|cannot|failed to)[^.]*(?:decrypt|verif)/i;

/** 上游是不是在说「历史里的加密思维块解不开」。只认错误码或这条消息，其它 400 一律不重试。 */
export function isEncryptedThinkingError(payload: unknown): boolean {
  const error = (payload as any)?.error ?? payload;
  const code = String(error?.code ?? error?.type ?? '');
  if (code === 'invalid_encrypted_content') return true;
  const message = String(error?.message ?? '');
  return ENCRYPTED_THINKING_MESSAGE.test(message) || message.includes('invalid_encrypted_content');
}

/**
 * 剥掉历史里的 `thinking` / `redacted_thinking` 块。剥空的消息丢掉，相邻同角色合并；
 * 但**永远不留下零条消息**（那样的请求上游直接 400）。
 */
export function stripThinkingBlocks(body: any): any {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const kept: any[] = [];
  for (const message of messages) {
    if (!Array.isArray(message?.content)) {
      kept.push(message);
      continue;
    }
    const content = message.content.filter((block: any) => block?.type !== 'thinking' && block?.type !== 'redacted_thinking');
    if (content.length === 0) continue;
    const last = kept[kept.length - 1];
    if (last && last.role === message.role && Array.isArray(last.content)) last.content = [...last.content, ...content];
    else kept.push({ ...message, content });
  }
  if (kept.length === 0 && messages.length > 0) kept.push({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  return { ...body, messages: kept };
}
