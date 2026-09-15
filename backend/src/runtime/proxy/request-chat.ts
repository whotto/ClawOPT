/**
 * 中间表示 → OpenAI Chat Completions 请求体。
 */
import type { IrRequest } from './request-ir';

export interface ChatEmitOptions {
  model: string;
  stream: boolean;
  reasoningEffort?: string;
  /** DeepSeek / Kimi / Moonshot / MiMo：助手轮次带回 `reasoning_content`。 */
  preserveReasoningContent: boolean;
  /** Grok：system → developer，去掉输出上限。 */
  systemAsDeveloper: boolean;
}

export function emitChatRequest(ir: IrRequest, options: ChatEmitOptions): Record<string, unknown> {
  const messages: any[] = [];
  const systemRole = options.systemAsDeveloper ? 'developer' : 'system';
  if (ir.system.length > 0) messages.push({ role: systemRole, content: ir.system.join('\n\n') });

  for (const message of ir.messages) {
    if (message.role === 'assistant') {
      const text = message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
      const reasoning = message.parts.filter((p) => p.type === 'reasoning').map((p) => (p as { text: string }).text).filter(Boolean).join('\n');
      const toolCalls = message.parts
        .filter((p): p is Extract<typeof p, { type: 'tool_call' }> => p.type === 'tool_call')
        .map((p) => ({ id: p.id, type: 'function', function: { name: p.name, arguments: p.arguments || '{}' } }));
      if (!text && toolCalls.length === 0 && !reasoning) continue;
      const out: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      if (options.preserveReasoningContent && reasoning) out.reasoning_content = reasoning;
      messages.push(out);
      continue;
    }

    // 用户侧：工具结果先各自成一条 tool 消息（必须紧跟在对应的 assistant tool_calls 之后），再放用户正文。
    const content: any[] = [];
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: part.callId, content: part.content });
      } else if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        const url = part.data ? `data:${part.mediaType};base64,${part.data}` : part.url;
        if (url) content.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (content.length === 0) continue;
    const onlyText = content.every((c) => c.type === 'text');
    messages.push({ role: 'user', content: onlyText ? content.map((c) => c.text).join('\n') : content });
  }

  const body: Record<string, unknown> = { model: options.model, messages, stream: options.stream };
  if (options.stream) body.stream_options = { include_usage: true };
  if (ir.tools.length > 0) {
    body.tools = ir.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (ir.toolChoice === 'auto' || ir.toolChoice === 'none' || ir.toolChoice === 'required') body.tool_choice = ir.toolChoice;
  else if (typeof ir.toolChoice === 'object') body.tool_choice = { type: 'function', function: { name: ir.toolChoice.name } };
  if (ir.maxTokens !== undefined && !options.systemAsDeveloper) body.max_tokens = ir.maxTokens;
  if (ir.temperature !== undefined) body.temperature = ir.temperature;
  if (ir.topP !== undefined) body.top_p = ir.topP;
  if (ir.stop?.length) body.stop = ir.stop;
  if (ir.parallelToolCalls !== undefined && ir.tools.length > 0) body.parallel_tool_calls = ir.parallelToolCalls;
  const effort = options.reasoningEffort ?? ir.reasoningEffort;
  if (effort) body.reasoning_effort = effort;
  return body;
}
