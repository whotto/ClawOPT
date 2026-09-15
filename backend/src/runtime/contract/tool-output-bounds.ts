/**
 * 工具输出的三级上限（spec 01 §2.14），三级各管各的，不能拿一个数顶替另一个：
 *
 * 1. **存储**（`boundToolOutputForStorage`）：CLI 工具可能吐出几十 MB（`cat` 一个大文件、`npm ls`），整份写进
 *    `run_tool_calls` 会把库撑爆。超过 256 KB 留头 192 KB + 尾 32 KB，中间放说明标记——头尾都在，排错够用。
 * 2. **线上**（`truncateForWire`）：推给浏览器、回给历史接口的只到 1000 字符；JSON 按结构截（深度、键数、元素数、
 *    字符串长度、节点数都有上限，并标出省略了多少），unified diff 不按 1000 截（截了就看不懂），只受线上硬上限约束。
 *    「复制完整内容」另走按 id 取整份的接口。
 * 3. **上下文**：喂给模型的那一份由运行时自己管（OpenClaw 网关、各 CLI 都有自己的工具结果裁剪）。ClawOPT 不拥有这些会话的
 *    上下文，单聊里宿主自己拼上下文的只有直连模型，而它的历史里没有工具结果——所以这一级在单聊里没有宿主侧实现，
 *    也不写一个没有调用点的函数（群聊的上下文窗口在 collab/rooms 自己裁）。
 */

export const STORAGE_MAX_BYTES = 256 * 1024;
const STORAGE_HEAD_BYTES = 192 * 1024;
const STORAGE_TAIL_BYTES = 32 * 1024;

export const WIRE_MAX_CHARS = 1000;
/** diff 不按 1000 截，但仍有硬上限（一个 diff 片段超过它就只能去看完整内容）。 */
export const WIRE_DIFF_MAX_CHARS = 64_000;

export function boundToolOutputForStorage(output: string | null): string | null {
  if (output === null) return null;
  const bytes = Buffer.byteLength(output, 'utf8');
  if (bytes <= STORAGE_MAX_BYTES) return output;
  const buffer = Buffer.from(output, 'utf8');
  // 按字节切再解码：切在多字节字符中间时 toString 会替换成 U+FFFD，不会产生非法 UTF-8。
  const head = buffer.subarray(0, STORAGE_HEAD_BYTES).toString('utf8');
  const tail = buffer.subarray(bytes - STORAGE_TAIL_BYTES).toString('utf8');
  return `${head}\n[clawopt: tool output truncated for storage — ${bytes} bytes total, middle ${bytes - STORAGE_HEAD_BYTES - STORAGE_TAIL_BYTES} bytes omitted]\n${tail}`;
}

export function looksLikeUnifiedDiff(text: string): boolean {
  return /^(diff --git |--- \S|Index: )/m.test(text) && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text);
}

type JsonLimits = { depth: number; keys: number; items: number; stringChars: number; nodes: number };
const JSON_LIMITS: JsonLimits = { depth: 6, keys: 50, items: 50, stringChars: 200, nodes: 1000 };

function truncateJsonValue(value: unknown, limits: JsonLimits): { value: unknown; truncated: boolean } {
  let nodes = 0;
  let truncated = false;
  const walk = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.nodes) {
      truncated = true;
      return '[…]';
    }
    if (typeof current === 'string') {
      if (current.length <= limits.stringChars) return current;
      truncated = true;
      return `${current.slice(0, limits.stringChars)}… (+${current.length - limits.stringChars} chars)`;
    }
    if (current === null || typeof current !== 'object') return current;
    if (depth >= limits.depth) {
      truncated = true;
      return Array.isArray(current) ? `[… ${current.length} items]` : '{…}';
    }
    if (Array.isArray(current)) {
      const out = current.slice(0, limits.items).map((item) => walk(item, depth + 1));
      if (current.length > limits.items) {
        truncated = true;
        out.push(`… (+${current.length - limits.items} items)`);
      }
      return out;
    }
    const entries = Object.entries(current as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, limits.keys)) out[key] = walk(item, depth + 1);
    if (entries.length > limits.keys) {
      truncated = true;
      out['…'] = `+${entries.length - limits.keys} keys`;
    }
    return out;
  };
  const result = walk(value, 0);
  return { value: result, truncated };
}

export type WireText = { text: string; truncated: boolean; originalLength: number; format: 'json' | 'diff' | 'text' };

/** 线上显示用的截断。JSON 按结构截再美化；diff 不按 1000 截；其余纯文本截前缀。 */
export function truncateForWire(raw: string | null | undefined, maxChars = WIRE_MAX_CHARS): WireText {
  const text = typeof raw === 'string' ? raw : '';
  const originalLength = text.length;
  if (looksLikeUnifiedDiff(text)) {
    return text.length <= WIRE_DIFF_MAX_CHARS
      ? { text, truncated: false, originalLength, format: 'diff' }
      : { text: `${text.slice(0, WIRE_DIFF_MAX_CHARS)}\n…`, truncated: true, originalLength, format: 'diff' };
  }
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
    try {
      const parsed = JSON.parse(trimmed);
      const pretty = JSON.stringify(parsed, null, 2);
      if (pretty.length <= maxChars) return { text: pretty, truncated: false, originalLength, format: 'json' };
      const bounded = truncateJsonValue(parsed, JSON_LIMITS);
      let rendered = JSON.stringify(bounded.value, null, 2);
      let truncated = bounded.truncated;
      if (rendered.length > maxChars) {
        rendered = `${rendered.slice(0, maxChars)}\n…`;
        truncated = true;
      }
      return { text: rendered, truncated, originalLength, format: 'json' };
    } catch {
      // 不是合法 JSON：按纯文本。
    }
  }
  if (text.length <= maxChars) return { text, truncated: false, originalLength, format: 'text' };
  return { text: `${text.slice(0, maxChars)}…`, truncated: true, originalLength, format: 'text' };
}

/** 工具行上的一行预览：参数里第一个有意义的字段（命令、代码、查询、路径、地址、提示词），折叠空白，≤160。 */
export function previewToolArguments(rawArguments: string | null | undefined): string {
  let parsed: unknown = null;
  try {
    parsed = rawArguments ? JSON.parse(rawArguments) : null;
  } catch {
    parsed = null;
  }
  let candidate = '';
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of ['cmd', 'command', 'code', 'query', 'path', 'file_path', 'filePath', 'url', 'pattern', 'prompt', 'description']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) { candidate = value; break; }
      if (Array.isArray(value) && value.every((item) => typeof item === 'string') && value.length > 0) { candidate = value.join(' '); break; }
    }
  } else if (typeof rawArguments === 'string') {
    candidate = rawArguments;
  }
  const collapsed = candidate.replace(/\s+/g, ' ').trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 159)}…` : collapsed;
}
