/**
 * 外部运行时会话命令结果（契约事件 `session.command`）在单聊里的落库形状与帧。
 *
 * 结果是**结构化**的（压缩前后 token、原生会话状态、用量），界面要按当前语言渲染，所以不写成某一种语言的句子：
 * - 落库：`role = system`，`content = '⌘ ' + JSON(结果)`；读历史时 `withStructuredChatMessage` 认这个前缀，
 *   换成 `messageCode = runtimeCommand.*` + `messageParams` + `rawDetail`（与 `❌ Error:` 结构化错误同一套通道）；
 * - 流：`final` 帧直接带同样的 `messageCode / messageParams / rawDetail / role`，前端 `mapStreamingContentPatch` 接住。
 * `content` 本身留一句英文兜底，老前端或读不懂码时照样能看。
 */
import type { SessionCommandResult } from '../../runtime';
import type { StructuredMessageParams } from '../../core/http';

export const CHAT_COMMAND_RESULT_PREFIX = '⌘ ';

const MISSING = '—';

function show(value: unknown): string | number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return MISSING;
}

export interface StructuredCommandMessage {
  role: 'system';
  messageCode: string;
  messageParams: StructuredMessageParams;
  rawDetail?: string;
  fallbackText: string;
}

export function describeCommandResult(result: SessionCommandResult): StructuredCommandMessage {
  if (!result.ok) {
    const error = show(result.error);
    return {
      role: 'system',
      messageCode: 'runtimeCommand.failed',
      messageParams: { command: result.command, error },
      rawDetail: typeof result.error === 'string' ? result.error : undefined,
      fallbackText: `/${result.command} failed: ${error}`,
    };
  }
  if (result.command === 'compact') {
    const compaction = result.compaction ?? { trigger: 'manual' as const };
    const params = { trigger: compaction.trigger, preTokens: show(compaction.preTokens), postTokens: show(compaction.postTokens) };
    return {
      role: 'system',
      messageCode: 'runtimeCommand.compactDone',
      messageParams: params,
      rawDetail: compaction.summary?.trim() || undefined,
      fallbackText: `Compaction completed (${params.trigger}). Before: ${params.preTokens} tokens. After: ${params.postTokens} tokens.`,
    };
  }
  if (result.command === 'status') {
    const status = result.status ?? {};
    const params = {
      model: show(status.model),
      nativeSessionId: show(status.nativeSessionId),
      thinkingLevel: show(status.thinkingLevel),
      messageCount: show(status.messageCount),
      autoCompaction: show(status.autoCompaction),
    };
    return {
      role: 'system',
      messageCode: 'runtimeCommand.statusDone',
      messageParams: params,
      fallbackText: `Status: model ${params.model}, session ${params.nativeSessionId}, thinking ${params.thinkingLevel}, messages ${params.messageCount}, auto-compaction ${params.autoCompaction}.`,
    };
  }
  const usage = result.usage ?? {};
  const params = {
    inputTokens: show(usage.inputTokens),
    outputTokens: show(usage.outputTokens),
    cacheReadTokens: show(usage.cacheReadTokens),
    cacheWriteTokens: show(usage.cacheWriteTokens),
    costUsd: typeof usage.costUsd === 'number' ? Number(usage.costUsd.toFixed(4)) : MISSING,
    contextTokens: show(usage.contextTokens),
    contextWindow: show(usage.contextWindow),
    contextPercent: typeof usage.contextPercent === 'number' ? Number(usage.contextPercent.toFixed(1)) : MISSING,
  };
  return {
    role: 'system',
    messageCode: 'runtimeCommand.usageDone',
    messageParams: params,
    fallbackText: `Usage: input ${params.inputTokens}, output ${params.outputTokens}, cache read ${params.cacheReadTokens}, cache write ${params.cacheWriteTokens}, cost $${params.costUsd}; context ${params.contextTokens}/${params.contextWindow} (${params.contextPercent}%).`,
  };
}

export function serializeCommandResultContent(result: SessionCommandResult): string {
  return `${CHAT_COMMAND_RESULT_PREFIX}${JSON.stringify(result)}`;
}

/** 读历史：认前缀、解析失败就当普通文本（不因为一行坏数据让整页历史报错）。 */
export function parseCommandResultContent(content: string | null | undefined): StructuredCommandMessage | null {
  if (!content || !content.startsWith(CHAT_COMMAND_RESULT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(content.slice(CHAT_COMMAND_RESULT_PREFIX.length)) as SessionCommandResult;
    if (!parsed || typeof parsed !== 'object' || !['compact', 'status', 'usage'].includes(parsed.command)) return null;
    return describeCommandResult(parsed);
  } catch {
    return null;
  }
}

export function buildCommandResultFrame(result: SessionCommandResult) {
  const described = describeCommandResult(result);
  return {
    type: 'final' as const,
    text: described.fallbackText,
    role: described.role,
    messageCode: described.messageCode,
    messageParams: described.messageParams,
    rawDetail: described.rawDetail,
    process_streaming: false,
  };
}
