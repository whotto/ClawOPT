/**
 * OpenAI Responses 请求 ↔ 中间表示，以及 Responses 路由的请求体瘦身。
 */
import { sanitizeFunctionName, stringifyJson, type IrMessage, type IrPart, type IrRequest, type IrTool } from './request-ir';

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function contentParts(content: unknown): IrPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: IrPart[] = [];
  for (const part of content as any[]) {
    if (!part || typeof part !== 'object') continue;
    if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string') {
        const data = parseDataUrl(url);
        parts.push(data ? { type: 'image', mediaType: data.mediaType, data: data.data } : { type: 'image', mediaType: 'image/*', url });
      }
    } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
      parts.push({ type: 'text', text: part.refusal });
    }
  }
  return parts;
}

function functionOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return contentText(output);
  return stringifyJson(output, '');
}

/** 把 Responses 的工具定义展平成普通函数，并记下还原信息。 */
function flattenTools(rawTools: unknown): IrTool[] {
  const tools: IrTool[] = [];
  const used = new Set<string>();
  const unique = (name: string) => {
    let candidate = sanitizeFunctionName(name);
    let n = 2;
    while (used.has(candidate)) candidate = sanitizeFunctionName(`${name}_${n++}`);
    used.add(candidate);
    return candidate;
  };

  for (const tool of Array.isArray(rawTools) ? rawTools : []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' && typeof tool.name === 'string') {
      tools.push({
        name: unique(tool.name),
        description: tool.description,
        parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
        origin: { kind: 'function' },
      });
    } else if (tool.type === 'namespace' && typeof tool.name === 'string') {
      const inner = Array.isArray(tool.tools) ? tool.tools : [];
      if (inner.length > 0) {
        for (const child of inner) {
          if (!child || typeof child.name !== 'string') continue;
          tools.push({
            name: unique(`${tool.name}__${child.name}`),
            description: child.description ?? tool.description,
            parameters: child.parameters && typeof child.parameters === 'object' ? child.parameters : { type: 'object', properties: {} },
            origin: { kind: 'namespace', namespace: tool.name, name: child.name },
          });
        }
      } else {
        // 没列出成员的命名空间（典型是 `mcp__*`）：一个分发函数，参数里说要调哪个工具。
        tools.push({
          name: unique(tool.name),
          description: `${tool.description ?? `Tools in namespace ${tool.name}`}. Call with {"tool": "<tool name>", "arguments": {...}}.`,
          parameters: {
            type: 'object',
            properties: { tool: { type: 'string' }, arguments: { type: 'object' } },
            required: ['tool'],
          },
          origin: { kind: 'dispatcher', namespace: tool.name },
        });
      }
    } else if (tool.type === 'tool_search') {
      tools.push({
        name: unique('tool_search'),
        description: tool.description ?? 'Search for additional tools by keyword.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        origin: { kind: 'tool_search' },
      });
    } else if (tool.type === 'custom' && typeof tool.name === 'string') {
      // 自定义（语法约束）工具，如 Codex 的 apply_patch：别家上游只能收一个字符串参数。
      tools.push({
        name: unique(tool.name),
        description: tool.description,
        parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
        origin: { kind: 'custom', name: tool.name },
      });
    }
  }
  return tools;
}

export function parseResponsesRequest(body: any): IrRequest {
  const system: string[] = [];
  if (typeof body?.instructions === 'string' && body.instructions) system.push(body.instructions);

  const tools = flattenTools(body?.tools);
  const flatNameOf = (name: string, namespace?: string): string => {
    const match = tools.find((tool) => {
      const origin = tool.origin;
      if (namespace) {
        return (origin.kind === 'namespace' && origin.namespace === namespace && origin.name === name)
          || (origin.kind === 'dispatcher' && origin.namespace === namespace);
      }
      return (origin.kind === 'custom' && origin.name === name) || (origin.kind === 'function' && tool.name === sanitizeFunctionName(name));
    });
    return match?.name ?? sanitizeFunctionName(namespace ? `${namespace}__${name}` : name);
  };

  const messages: IrMessage[] = [];
  const pushPart = (role: 'user' | 'assistant', part: IrPart) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else messages.push({ role, parts: [part] });
  };

  const input = typeof body?.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body?.input) ? body.input : [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type ?? (item.role ? 'message' : undefined);
    if (type === 'message') {
      if (item.role === 'system' || item.role === 'developer') {
        const text = contentText(item.content);
        if (text) system.push(text);
        continue;
      }
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      for (const part of contentParts(item.content)) pushPart(role, part);
    } else if (type === 'function_call') {
      const namespace = typeof item.namespace === 'string' ? item.namespace : undefined;
      const flat = flatNameOf(String(item.name ?? 'tool'), namespace);
      const origin = tools.find((tool) => tool.name === flat)?.origin;
      const args = origin?.kind === 'dispatcher'
        ? JSON.stringify({ tool: item.name, arguments: safeJson(item.arguments) })
        : String(item.arguments ?? '{}');
      pushPart('assistant', { type: 'tool_call', id: String(item.call_id ?? item.id ?? ''), name: flat, arguments: args });
    } else if (type === 'custom_tool_call') {
      pushPart('assistant', {
        type: 'tool_call',
        id: String(item.call_id ?? item.id ?? ''),
        name: flatNameOf(String(item.name ?? 'tool')),
        arguments: JSON.stringify({ input: String(item.input ?? '') }),
      });
    } else if (type === 'tool_search_call') {
      pushPart('assistant', {
        type: 'tool_call',
        id: String(item.call_id ?? item.id ?? ''),
        name: flatNameOf('tool_search'),
        arguments: stringifyJson(item.arguments ?? { query: item.query ?? '' }),
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_search_output') {
      pushPart('user', { type: 'tool_result', callId: String(item.call_id ?? ''), content: functionOutputText(item.output ?? item.tools ?? '') });
    } else if (type === 'reasoning') {
      const text = [
        ...(Array.isArray(item.summary) ? item.summary.map((s: any) => s?.text ?? '') : []),
        ...(Array.isArray(item.content) ? item.content.map((c: any) => c?.text ?? '') : []),
      ].filter(Boolean).join('\n');
      if (text) pushPart('assistant', { type: 'reasoning', text });
    }
  }

  let toolChoice: IrRequest['toolChoice'];
  const choice = body?.tool_choice;
  if (choice === 'auto' || choice === 'none' || choice === 'required') toolChoice = choice;
  else if (choice && typeof choice === 'object' && typeof choice.name === 'string') toolChoice = { name: flatNameOf(choice.name) };

  return {
    model: String(body?.model ?? ''),
    system,
    messages,
    tools,
    toolChoice,
    maxTokens: typeof body?.max_output_tokens === 'number' ? body.max_output_tokens : undefined,
    temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body?.top_p === 'number' ? body.top_p : undefined,
    stream: body?.stream === true,
    reasoningEffort: typeof body?.reasoning?.effort === 'string' ? body.reasoning.effort : undefined,
    parallelToolCalls: typeof body?.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : undefined,
  };
}

function safeJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 中间表示 → Responses 请求体（Anthropic 客户端打 Responses 上游时用）。 */
export function emitResponsesRequest(ir: IrRequest, options: { model: string; stream: boolean; reasoningEffort?: string }): Record<string, unknown> {
  const input: any[] = [];
  for (const message of ir.messages) {
    const content: any[] = [];
    const flush = () => {
      if (content.length === 0) return;
      input.push({ type: 'message', role: message.role, content: content.splice(0) });
    };
    for (const part of message.parts) {
      if (part.type === 'text') {
        content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
      } else if (part.type === 'image' && message.role === 'user') {
        const url = part.data ? `data:${part.mediaType};base64,${part.data}` : part.url;
        if (url) content.push({ type: 'input_image', image_url: url });
      } else if (part.type === 'tool_call') {
        flush();
        input.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: part.arguments });
      } else if (part.type === 'tool_result') {
        flush();
        input.push({ type: 'function_call_output', call_id: part.callId, output: part.content });
      }
      // reasoning：不带 encrypted_content 的 reasoning item 官方上游会拒，干脆不发。
    }
    flush();
  }

  const body: Record<string, unknown> = { model: options.model, input, stream: options.stream, store: false };
  if (ir.system.length > 0) body.instructions = ir.system.join('\n\n');
  if (ir.tools.length > 0) {
    body.tools = ir.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
  }
  if (ir.toolChoice === 'auto' || ir.toolChoice === 'none' || ir.toolChoice === 'required') body.tool_choice = ir.toolChoice;
  else if (typeof ir.toolChoice === 'object') body.tool_choice = { type: 'function', name: ir.toolChoice.name };
  if (ir.maxTokens !== undefined) body.max_output_tokens = ir.maxTokens;
  if (ir.temperature !== undefined) body.temperature = ir.temperature;
  if (ir.topP !== undefined) body.top_p = ir.topP;
  const effort = options.reasoningEffort ?? ir.reasoningEffort;
  if (effort && effort !== 'none') body.reasoning = { effort };
  if (ir.parallelToolCalls !== undefined) body.parallel_tool_calls = ir.parallelToolCalls;
  return body;
}

// ---- 请求体瘦身（Codex 每次都重发整段历史，服务商有请求体上限） ----

export const FUNCTION_OUTPUT_LIMIT_BYTES = 32 * 1024;
export const FUNCTION_OUTPUT_HEAD_BYTES = 24 * 1024;
export const FUNCTION_OUTPUT_TAIL_BYTES = 7 * 1024;

/** 在 UTF-8 字符边界上截取：不把一个多字节字符切成两半。 */
function utf8Head(buffer: Buffer, bytes: number): string {
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf-8');
}

function utf8Tail(buffer: Buffer, bytes: number): string {
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf-8');
}

export function truncateToolOutput(text: string): string {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= FUNCTION_OUTPUT_LIMIT_BYTES) return text;
  const head = utf8Head(buffer, FUNCTION_OUTPUT_HEAD_BYTES);
  const tail = utf8Tail(buffer, FUNCTION_OUTPUT_TAIL_BYTES);
  const omitted = buffer.length - Buffer.byteLength(head) - Buffer.byteLength(tail);
  return `${head}\n\n[... ${omitted} bytes of tool output omitted by ClawOPT proxy ...]\n\n${tail}`;
}

/**
 * Responses 路由的请求瘦身，直通上游也做：
 * - 最新一条用户消息**之前**的内联 `data:image/*` 换成带字节数的文字标记；
 * - 超过 32 KiB 的 `function_call_output` 截成约 24 KiB 头 + 7 KiB 尾。
 */
export function applyResponsesRequestHygiene(body: any): any {
  if (!Array.isArray(body?.input)) return body;
  const items: any[] = body.input;
  let latestUser = -1;
  items.forEach((item, index) => {
    if (item && (item.type === 'message' || (!item.type && item.role)) && item.role === 'user') latestUser = index;
  });

  const input = items.map((item, index) => {
    if (!item || typeof item !== 'object') return item;
    if (index < latestUser && Array.isArray(item.content)) {
      let changed = false;
      const content = item.content.map((part: any) => {
        const url = typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url;
        if (part?.type === 'input_image' && typeof url === 'string' && url.startsWith('data:image/')) {
          changed = true;
          const bytes = Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);
          return { type: 'input_text', text: `[earlier image omitted by ClawOPT proxy: ${bytes} bytes]` };
        }
        return part;
      });
      if (changed) item = { ...item, content };
    }
    if (item.type === 'function_call_output') {
      if (typeof item.output === 'string') {
        const output = truncateToolOutput(item.output);
        if (output !== item.output) item = { ...item, output };
      } else if (Array.isArray(item.output)) {
        let changed = false;
        const output = item.output.map((part: any) => {
          if (typeof part?.text !== 'string') return part;
          const text = truncateToolOutput(part.text);
          if (text === part.text) return part;
          changed = true;
          return { ...part, text };
        });
        if (changed) item = { ...item, output };
      }
    }
    return item;
  });
  return { ...body, input };
}

/** Grok 当 harness 时：system 角色改 developer，去掉 max_output_tokens。 */
export function applyGrokResponsesRewrite(body: any): any {
  const next = { ...body };
  delete next.max_output_tokens;
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item: any) => (item?.role === 'system' ? { ...item, role: 'developer' } : item));
  }
  return next;
}
