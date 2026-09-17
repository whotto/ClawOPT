/**
 * 每次调用的上下文构建（spec 02 F11）：路由说明 + 滚动摘要 + 锚点之后清洗过的转录 + 名册 + 非主人安全提示。
 *
 * 渲染在 `room-prompt.ts`（红线 A 冻结对象）；这里只负责「挑什么、截多少、谁是谁」。
 *
 * ## 转录按 token 截（修 spec 的缺口）
 *
 * 参考实现只靠摘要节奏 + 500 条窗口，单条超长消息能直接撑爆模型上下文。这里：
 * - 取锚点之后、触发消息之前最近 500 条；
 * - 清洗：只留人类与 Agent 的正文（系统提示、失败提示、空占位、工作区 diff、像序列化工具轨迹的文本都丢掉）；
 * - 单条保头保尾截到 `perMessageChars`；
 * - 新 → 旧按 token 估算累加，超出 `budgetTokens` 就停（至少保留最新一条），被省略的条数写进 prompt。
 */
import type { ContextMessageRow } from './room-message-store';
import type { RoomPromptInput, RoomPromptTranscriptLine, RoomPromptTrigger } from './room-prompt';

export const CONTEXT_WINDOW_MESSAGES = 500;
export const CONTEXT_BUDGET_TOKENS = 8000;
export const CONTEXT_PER_MESSAGE_CHARS = 2400;
const EVIDENCE_LINE = /(`|https?:\/\/|\/|\\|\.|已执行|执行|启动|运行|浏览器|监听|地址|端口|日志|结果|存在|生成|导出|输出|完成|成功|失败|校验|验证|测试|created|running|started|output|result|verified|browser|url|path|port|listen)/i;

/** 粗估 token：ASCII 约 4 字符一个，其余（中日韩等）约 1 字符一个。只用于预算，不用于计费。 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other);
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function truncateHeadTail(text: string, maxChars: number): string {
  const normalized = normalize(text);
  if (normalized.length <= maxChars) return normalized;
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.floor(maxChars * 0.3);
  return `${normalized.slice(0, head).trimEnd()}\n...(中间省略 ${normalized.length - head - tail} 字)...\n${normalized.slice(-tail).trimStart()}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function processEvidence(content: string, maxChars: number): string {
  const lines = normalize(content).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const evidence = lines.filter((line) => EVIDENCE_LINE.test(line));
  return truncateHeadTail((evidence.length > 0 ? evidence : lines).join('\n'), maxChars);
}

/** 一条消息进转录的正文：正文 + 过程证据摘要（过程标签里的或单独存的 process_content）。 */
export function contextBodyOf(row: Pick<ContextMessageRow, 'content' | 'process_content'>, tags: { startTag: string; endTag: string } | null, maxChars: number): string {
  const content = normalize(row.content ?? '');
  const processText = normalize(row.process_content ?? '');
  const evidenceBudget = Math.floor(maxChars / 3);
  if (processText) {
    const evidence = processEvidence(processText, evidenceBudget);
    if (content && evidence) return truncateHeadTail(`${content}\n\n[过程证据摘要]\n${evidence}`, maxChars);
    return truncateHeadTail(content || evidence, maxChars);
  }
  if (!content || !tags?.startTag || !tags.endTag) return truncateHeadTail(content, maxChars);
  const pattern = new RegExp(`${escapeRegExp(tags.startTag)}([\\s\\S]*?)(?:${escapeRegExp(tags.endTag)}|$)`, 'g');
  const outside = normalize(content.replace(pattern, '\n\n'));
  const inside = [...content.matchAll(pattern)].map((match) => normalize(match[1] ?? '')).filter(Boolean).join('\n\n');
  const evidence = processEvidence(inside, evidenceBudget);
  if (outside && evidence) return truncateHeadTail(`${outside}\n\n[过程证据摘要]\n${evidence}`, maxChars);
  return truncateHeadTail(outside || evidence || content, maxChars);
}

const TOOL_TRACE_SHAPE = /^\s*[[{]\s*"(type|tool_call|tool_calls|function_call|tool_use|tool_result)"/;

/** 这一行能不能进转录（清洗判据）。 */
export function isCleanContextRow(row: ContextMessageRow, isStructuredNotice: (content: string) => boolean): boolean {
  if (row.message_kind === 'workspace_diff') return false;
  if (row.sender_type === 'agent' && (!row.sender_id || row.sender_id === 'system')) return false;
  if (!String(row.content ?? '').trim()) return false;
  if (isStructuredNotice(row.content)) return false;
  if (TOOL_TRACE_SHAPE.test(row.content)) return false;
  return true;
}

export function selectTranscript(
  rows: ContextMessageRow[],
  options: {
    budgetTokens?: number;
    perMessageChars?: number;
    processTags: { startTag: string; endTag: string } | null;
    isStructuredNotice: (content: string) => boolean;
    rewriteContent?: (text: string) => string;
  },
): { lines: RoomPromptTranscriptLine[]; omitted: number } {
  const budget = options.budgetTokens ?? CONTEXT_BUDGET_TOKENS;
  const perMessage = options.perMessageChars ?? CONTEXT_PER_MESSAGE_CHARS;
  const clean = rows.filter((row) => isCleanContextRow(row, options.isStructuredNotice));
  const picked: RoomPromptTranscriptLine[] = [];
  let used = 0;
  let index = clean.length - 1;
  for (; index >= 0; index -= 1) {
    const row = clean[index];
    const rewritten = options.rewriteContent ? { ...row, content: options.rewriteContent(row.content), process_content: row.process_content ? options.rewriteContent(row.process_content) : row.process_content } : row;
    const body = contextBodyOf(rewritten, options.processTags, perMessage);
    if (!body) continue;
    const name = row.sender_name || (row.sender_type === 'user' ? '用户' : 'Agent');
    const cost = estimateTokens(body) + estimateTokens(name) + 4;
    if (picked.length > 0 && used + cost > budget) break;
    picked.unshift({ speakerKind: row.sender_type === 'agent' ? 'agent' : 'member', name, content: body });
    used += cost;
  }
  return { lines: picked, omitted: Math.max(0, index + 1) };
}

export type BuildContextInput = {
  groupName: string;
  groupSystemPrompt: string;
  member: { name: string; roleDescription: string };
  roster: RoomPromptInput['roster'];
  process: RoomPromptInput['process'];
  hostTakeoverPrompt: string | null;
  workspace: RoomPromptInput['workspace'];
  handoff: RoomPromptInput['handoff'];
  delegationEnabled: boolean;
  security: RoomPromptInput['security'];
  remoteWorkspaceApi: RoomPromptInput['remoteWorkspaceApi'];
  summary: string | null;
  rows: ContextMessageRow[];
  trigger: RoomPromptTrigger;
  isStructuredNotice: (content: string) => boolean;
  rewriteContent?: (text: string) => string;
  budgetTokens?: number;
};

export function buildPromptInput(input: BuildContextInput): RoomPromptInput {
  const transcript = selectTranscript(input.rows, {
    budgetTokens: input.budgetTokens,
    processTags: input.process,
    isStructuredNotice: input.isStructuredNotice,
    rewriteContent: input.rewriteContent,
  });
  return {
    groupName: input.groupName,
    groupSystemPrompt: input.groupSystemPrompt,
    member: input.member,
    roster: input.roster,
    process: input.process,
    hostTakeoverPrompt: input.hostTakeoverPrompt,
    workspace: input.workspace,
    handoff: input.handoff,
    delegationEnabled: input.delegationEnabled,
    security: input.security,
    remoteWorkspaceApi: input.remoteWorkspaceApi,
    summary: input.summary,
    transcript: transcript.lines,
    omittedEarlierMessages: transcript.omitted,
    trigger: input.trigger,
  };
}
