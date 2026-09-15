/**
 * 请求的中间表示。两种客户端格式（Anthropic Messages、OpenAI Responses）先解析成它，
 * 再按上游格式（Chat / Responses / Anthropic）写出——2 个解析器 + 3 个写出器，
 * 而不是 6 条两两直译。直通（上游格式 = 客户端格式）不经过这里。
 */

export type IrPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data?: string; url?: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean }
  /** 思维内容。`signature` / `redacted` 只有 Anthropic 原生思维块才有，别家上游回放不了。 */
  | { type: 'reasoning'; text: string; signature?: string; redacted?: string };

export interface IrMessage {
  role: 'user' | 'assistant';
  parts: IrPart[];
}

/**
 * 工具在客户端那边原本是什么。Codex 的命名空间工具、tool_search、自定义（语法）工具
 * 在非 Responses 上游只能表达成普通函数；上游回来的调用要按这张表还原成客户端认得的形状。
 */
export type IrToolOrigin =
  | { kind: 'function' }
  | { kind: 'namespace'; namespace: string; name: string }
  | { kind: 'dispatcher'; namespace: string }
  | { kind: 'tool_search' }
  | { kind: 'custom'; name: string };

export interface IrTool {
  /** 发给上游的函数名（已展平、符合 `^[A-Za-z0-9_-]{1,64}$`）。 */
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  origin: IrToolOrigin;
}

export interface IrRequest {
  model: string;
  system: string[];
  messages: IrMessage[];
  tools: IrTool[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  reasoningEffort?: string;
  parallelToolCalls?: boolean;
}

/** 客户端工具名 ↔ 上游函数名 的还原表。 */
export type ToolNameMap = Map<string, IrToolOrigin>;

export function toolNameMapOf(request: Pick<IrRequest, 'tools'>): ToolNameMap {
  return new Map(request.tools.map((tool) => [tool.name, tool.origin]));
}

export function sanitizeFunctionName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return (cleaned || 'tool').slice(0, 64);
}

export function stringifyJson(value: unknown, fallback = '{}'): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {}) ?? fallback;
  } catch {
    return fallback;
  }
}
