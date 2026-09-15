/**
 * 单聊 × OpenClaw 运行的投影器：把规范事件落成 `chat_messages` 的那一行，并产出前端认的 legacy 帧。
 *
 * 迁移自 v1.8.0 `ActiveRunManager` 的可见层（applyRawTextSnapshot / emitVisibleDelta / emitVisibleFinal /
 * finalizeRun / failRun / abortRun 的落库与推帧部分），**判定与写库顺序逐行保留**：
 * 过程标签拆分、工具进度文案、工作区产物规范化、媒体路径改写、文本快照保护，
 * 以及「终态文本可以比已推的短」这层权威替换语义。`test/chat-run-fake-gateway.test.ts` 逐帧守着。
 *
 * 帧经协调器发到 `session:<id>` 主题（类型 `chat.frame`，负载 `{ frame, end }`），
 * SSE 与 WebSocket 两条通道都从实时中枢取；接回时由 `attachSnapshot` 给出当前快照。
 */
import type { ConfigManager } from '../../core/config';
import type { DB } from '../../core/db';
import { selectPreferredTextSnapshot } from '../../core/util';
import type { AdapterRunOutcome, CanonicalEvent, ProjectorFinish, ProjectorRunContext, RunProjector } from '../../runtime';
import { canonicalizeAssistantWorkspaceArtifacts } from '../../workspace';
import {
  appendToolProgressLine,
  formatToolResultProgress,
  formatToolStartProgress,
  type GroupToolProgressState,
  normalizeGroupToolProgressLocale,
  normalizeToolArgsRecord,
} from '../rooms';
import { createStructuredChatError } from './chat-messages';
import { combineChatProcessContent, rewriteOpenClawMediaPaths, splitChatProcessOutput } from './process-text';

export const CHAT_FRAME_EVENT = 'chat.frame';
/** 准备阶段被停：不推帧，只让流结束。 */
export const CHAT_STREAM_END_EVENT = 'chat.stream.end';

/** `messageId`：这帧属于哪条助手消息。WebSocket 客户端据此把帧路由到对应气泡（SSE 一条流只有一条消息，用不上）。 */
export type ChatFramePayload = { frame: Record<string, unknown>; end: boolean; messageId?: number };

export type OpenClawChatProjectionDeps = {
  db: Pick<DB, 'updateMessage' | 'updateMessageEnvelope' | 'deleteMessage' | 'setChatMessagesRunMarker'>;
  configManager: Pick<ConfigManager, 'getConfig'>;
  run: ProjectorRunContext;
  messageId: number;
  /** 同一次运行产出的行（发送时是用户行 + 助手行；重新生成时只有助手行）。 */
  runMarkerMessageIds: number[];
  agentId: string;
  agentName: string;
  modelUsed: string;
  workspacePath: string;
  processStartTag?: string;
  processEndTag?: string;
  /** 准备阶段出错时写进错误行的模型标签（沿用路由原来的取法）。 */
  resolveErrorModelTag: () => string;
};

type VisiblePatch = { text: string; process_content: string; process_streaming: boolean };

function parseArgs(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createOpenClawChatProjection(deps: OpenClawChatProjectionDeps): RunProjector {
  const { db, run, messageId, modelUsed, workspacePath, processStartTag, processEndTag } = deps;
  const startedAt = run.startedAt;
  db.setChatMessagesRunMarker(deps.runMarkerMessageIds, run.runMarker);

  const state = {
    rawText: '',
    text: '',
    modelProcessContent: '',
    modelProcessStreaming: false,
    toolProcessContent: '',
    processContent: '',
    processStreaming: !!(processStartTag && processEndTag),
    visibleFinalText: undefined as string | undefined,
    visibleProcessContent: undefined as string | undefined,
    visibleProcessStreaming: undefined as boolean | undefined,
    finalEventText: undefined as string | undefined,
    toolProgressLines: [] as string[],
    activeToolCallIds: new Set<string>(),
    toolProgressById: new Map<string, GroupToolProgressState>(),
  };

  const writeFrame = (frame: Record<string, unknown>, end = false) => {
    run.publish(CHAT_FRAME_EVENT, { frame, end, messageId } satisfies ChatFramePayload, { replay: { mode: 'replace', key: CHAT_FRAME_EVENT } });
  };

  const persistVisibleSnapshot = (visible: VisiblePatch) => {
    db.updateMessage(messageId, visible.text, modelUsed, visible.process_content, visible.process_streaming);
  };

  const applyRawTextSnapshot = (candidateText?: string | null, options?: { allowShorterReplacement?: boolean }) => {
    const nextRawText = selectPreferredTextSnapshot(state.rawText, candidateText, options);
    const rawChanged = nextRawText !== state.rawText;
    if (rawChanged) state.rawText = nextRawText;
    const splitOutput = splitChatProcessOutput(state.rawText, processStartTag, processEndTag);
    state.text = splitOutput.finalContent;
    state.modelProcessContent = splitOutput.processContent;
    state.modelProcessStreaming = splitOutput.processStreaming;
    state.processContent = combineChatProcessContent(state.toolProcessContent, state.modelProcessContent);
    state.processStreaming = state.modelProcessStreaming || state.activeToolCallIds.size > 0;
    return rawChanged;
  };

  const buildVisibleChatPatch = (content: string, processContent = state.processContent, processStreaming = state.processStreaming): VisiblePatch => ({
    text: rewriteOpenClawMediaPaths(content, workspacePath),
    process_content: rewriteOpenClawMediaPaths(processContent, workspacePath),
    process_streaming: processStreaming,
  });

  const emitVisibleDelta = (options?: { force?: boolean }) => {
    const visible = buildVisibleChatPatch(state.text);
    const didVisibleChange = visible.text !== state.visibleFinalText
      || visible.process_content !== state.visibleProcessContent
      || visible.process_streaming !== state.visibleProcessStreaming;
    if (!options?.force && !didVisibleChange) return;
    state.visibleFinalText = visible.text;
    state.visibleProcessContent = visible.process_content;
    state.visibleProcessStreaming = visible.process_streaming;
    persistVisibleSnapshot(visible);
    writeFrame({ type: 'delta', ...visible });
  };

  const emitVisibleFinal = (finalText: string, options?: { end?: boolean; allowShorterReplacement?: boolean }) => {
    applyRawTextSnapshot(finalText, { allowShorterReplacement: options?.allowShorterReplacement });
    const canonicalText = options?.end
      ? canonicalizeAssistantWorkspaceArtifacts(state.text, { workspacePath, startedAtMs: startedAt })
      : state.text;
    const visible = buildVisibleChatPatch(canonicalText, state.processContent, options?.end ? false : state.processStreaming);
    const nextVisibleFinalText = selectPreferredTextSnapshot(state.visibleFinalText, visible.text, {
      allowShorterReplacement: options?.allowShorterReplacement,
    });
    const nextVisibleProcessContent = selectPreferredTextSnapshot(state.visibleProcessContent, visible.process_content);
    if (!nextVisibleFinalText.trim() && !nextVisibleProcessContent.trim()) {
      if (options?.end) {
        const empty = { text: nextVisibleFinalText, process_content: nextVisibleProcessContent, process_streaming: false };
        persistVisibleSnapshot(empty);
        writeFrame({ type: 'final', ...empty }, true);
      }
      return '';
    }

    const shouldSendFinalEvent = !!options?.end
      || state.visibleFinalText !== nextVisibleFinalText
      || state.visibleProcessContent !== nextVisibleProcessContent
      || state.visibleProcessStreaming !== visible.process_streaming;
    if (shouldSendFinalEvent) {
      state.visibleFinalText = nextVisibleFinalText;
      state.visibleProcessContent = nextVisibleProcessContent;
      state.visibleProcessStreaming = visible.process_streaming;
      const eventPayload = { text: nextVisibleFinalText, process_content: nextVisibleProcessContent, process_streaming: visible.process_streaming };
      persistVisibleSnapshot(eventPayload);
      writeFrame({ type: 'final', ...eventPayload }, !!options?.end);
      return nextVisibleFinalText;
    }

    if (options?.end) {
      const settled = { text: nextVisibleFinalText, process_content: nextVisibleProcessContent, process_streaming: false };
      persistVisibleSnapshot(settled);
      writeFrame({ type: 'final', ...settled }, true);
    }
    return nextVisibleFinalText;
  };

  const handleTool = (phase: 'start' | 'update' | 'result', toolCallId: string, toolName: string, rawArgs: string | undefined, isError: boolean) => {
    const existingState = state.toolProgressById.get(toolCallId);
    const nextArgs = normalizeToolArgsRecord(parseArgs(rawArgs)) ?? existingState?.args;
    const nextState: GroupToolProgressState = existingState ?? { toolName, args: nextArgs };
    nextState.toolName = toolName;
    nextState.args = nextArgs;

    const progressLocale = normalizeGroupToolProgressLocale(deps.configManager.getConfig().language);
    if (phase === 'start') {
      state.activeToolCallIds.add(toolCallId);
      appendToolProgressLine(state.toolProgressLines, formatToolStartProgress(progressLocale, toolName, nextArgs));
    } else if (phase === 'update') {
      state.activeToolCallIds.add(toolCallId);
    } else {
      state.activeToolCallIds.delete(toolCallId);
      appendToolProgressLine(state.toolProgressLines, formatToolResultProgress(progressLocale, toolName, nextArgs, isError));
    }

    state.toolProcessContent = state.toolProgressLines.join('\n');
    if (phase === 'result') state.toolProgressById.delete(toolCallId);
    else state.toolProgressById.set(toolCallId, nextState);
    applyRawTextSnapshot();
    emitVisibleDelta({ force: true });
  };

  const failRun = (detail: string, code?: string): ProjectorFinish => {
    const structuredError = createStructuredChatError(detail, code);
    state.processStreaming = false;
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(state.processContent, workspacePath);
    db.updateMessage(messageId, structuredError.content, modelUsed, rewrittenProcessContent, false);
    db.updateMessageEnvelope(messageId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
    writeFrame({
      type: 'error',
      text: structuredError.content,
      process_content: rewrittenProcessContent,
      process_streaming: false,
      messageCode: structuredError.messageCode,
      messageParams: structuredError.messageParams,
      rawDetail: structuredError.rawDetail,
      role: structuredError.role,
    }, true);
    return { messageId, error: structuredError.rawDetail };
  };

  const finalizeRun = (finalText: string): ProjectorFinish => {
    const hasFinalEventText = !!state.finalEventText?.trim();
    let protectedRawText = selectPreferredTextSnapshot(state.rawText, finalText);
    protectedRawText = selectPreferredTextSnapshot(protectedRawText, state.finalEventText, { allowShorterReplacement: hasFinalEventText });
    applyRawTextSnapshot(protectedRawText, { allowShorterReplacement: hasFinalEventText });
    state.processStreaming = false;

    const canonicalText = canonicalizeAssistantWorkspaceArtifacts(state.text, { workspacePath, startedAtMs: startedAt });
    const rewritten = rewriteOpenClawMediaPaths(canonicalText, workspacePath);
    const rewrittenProcessContent = rewriteOpenClawMediaPaths(state.processContent, workspacePath);
    if (!rewritten.trim()) {
      const canonicalFallbackText = canonicalizeAssistantWorkspaceArtifacts(state.modelProcessContent, { workspacePath, startedAtMs: startedAt });
      const rewrittenFallbackText = rewriteOpenClawMediaPaths(canonicalFallbackText, workspacePath);
      if (rewrittenFallbackText.trim()) {
        state.text = canonicalFallbackText;
        state.modelProcessContent = '';
        state.processContent = combineChatProcessContent(state.toolProcessContent, state.modelProcessContent);
        state.processStreaming = false;
        const rewrittenFallbackProcessContent = rewriteOpenClawMediaPaths(state.processContent, workspacePath);
        db.updateMessage(messageId, rewrittenFallbackText, modelUsed, rewrittenFallbackProcessContent, false);
        state.visibleFinalText = rewrittenFallbackText;
        state.visibleProcessContent = rewrittenFallbackProcessContent;
        state.visibleProcessStreaming = false;
        writeFrame({ type: 'final', text: rewrittenFallbackText, process_content: rewrittenFallbackProcessContent, process_streaming: false }, true);
        return { messageId, output: rewrittenFallbackText };
      }
      // 网关这一轮已经结束（完成探针先等到了 agent.wait），没有需要再 abort 的运行。
      return failRun('No text output returned from the run.');
    }

    db.updateMessage(messageId, rewritten, modelUsed, rewrittenProcessContent, false);
    const output = emitVisibleFinal(protectedRawText, { end: true, allowShorterReplacement: hasFinalEventText });
    return { messageId, output };
  };

  return {
    onEvent(event: CanonicalEvent) {
      switch (event.type) {
        case 'response.output_text.snapshot':
          if (event.authoritative) {
            state.finalEventText = selectPreferredTextSnapshot(state.finalEventText, event.text, { allowShorterReplacement: true });
            applyRawTextSnapshot(event.text, { allowShorterReplacement: true });
            emitVisibleFinal(state.finalEventText || state.rawText, { allowShorterReplacement: true });
          } else {
            applyRawTextSnapshot(event.text);
            emitVisibleDelta();
          }
          return;
        case 'response.output_item.added':
          if (event.item.type === 'function_call') handleTool('start', event.item.call_id, event.item.name, event.item.arguments, false);
          return;
        case 'response.function_call.updated':
          handleTool('update', event.call_id, event.name, event.arguments, false);
          return;
        case 'response.output_item.done':
          if (event.item.type === 'function_call_output') {
            handleTool('result', event.item.call_id, event.item.name ?? 'tool', event.item.arguments, event.item.status === 'failed');
          }
          return;
        default:
          return;
      }
    },

    finish(outcome: AdapterRunOutcome): ProjectorFinish {
      if (outcome.kind === 'aborted') {
        if (outcome.phase === 'preparing') {
          // 还没交给网关就被停：占位的助手行删掉，流直接结束（不推帧）。
          try {
            db.deleteMessage(messageId);
          } catch (error) {
            console.warn(`[chat] Failed to delete interrupted pending assistant message ${messageId} for session ${run.sessionKey}:`, error);
          }
          run.publish(CHAT_STREAM_END_EVENT, { messageId });
          return { messageId: null };
        }
        const canonicalText = canonicalizeAssistantWorkspaceArtifacts(state.text || '', { workspacePath, startedAtMs: startedAt });
        const rewritten = rewriteOpenClawMediaPaths(canonicalText, workspacePath);
        const rewrittenProcessContent = rewriteOpenClawMediaPaths(state.processContent || '', workspacePath);
        db.updateMessage(messageId, rewritten, modelUsed, rewrittenProcessContent, false);
        writeFrame({ type: 'final', text: rewritten, process_content: rewrittenProcessContent, process_streaming: false }, true);
        return { messageId, output: rewritten };
      }

      if (outcome.kind === 'failed') {
        if (outcome.stopReason === 'preparation_failed') {
          const structuredError = createStructuredChatError(outcome.error, outcome.code);
          try {
            db.updateMessage(messageId, structuredError.content, deps.resolveErrorModelTag(), null, false);
            db.updateMessageEnvelope(messageId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
          } catch {}
          writeFrame({
            type: 'error',
            text: structuredError.content,
            messageCode: structuredError.messageCode,
            messageParams: structuredError.messageParams,
            rawDetail: structuredError.rawDetail,
            role: structuredError.role,
          }, true);
          return { messageId, error: structuredError.rawDetail };
        }
        return failRun(outcome.error, outcome.code);
      }

      if (outcome.stopReason === 'idle_timeout') {
        const finalText = outcome.outputText ?? '';
        applyRawTextSnapshot(finalText);
        const canonicalText = canonicalizeAssistantWorkspaceArtifacts(state.text, { workspacePath, startedAtMs: startedAt });
        const rewritten = rewriteOpenClawMediaPaths(canonicalText, workspacePath);
        const rewrittenProcessContent = rewriteOpenClawMediaPaths(state.processContent, workspacePath);
        db.updateMessage(messageId, rewritten, modelUsed, rewrittenProcessContent, false);
        const output = emitVisibleFinal(finalText, { end: true });
        return { messageId, output };
      }

      return finalizeRun(outcome.outputText ?? '');
    },

    attachSnapshot() {
      const frames: Array<{ type: string; payload: ChatFramePayload }> = [{
        type: CHAT_FRAME_EVENT,
        payload: {
          frame: { type: 'attached', messageId, agentId: deps.agentId, agentName: deps.agentName, modelUsed },
          end: false,
          messageId,
        },
      }];
      if (run.adapterStatus().phase === 'preparing') return frames;
      if (state.visibleFinalText || state.visibleProcessContent) {
        frames.push({
          type: CHAT_FRAME_EVENT,
          payload: {
            frame: {
              type: 'final',
              text: state.visibleFinalText || '',
              process_content: state.visibleProcessContent || '',
              process_streaming: !!state.visibleProcessStreaming,
            },
            end: false,
            messageId,
          },
        });
      } else if (state.text || state.processContent || state.processStreaming) {
        frames.push({ type: CHAT_FRAME_EVENT, payload: { frame: { type: 'delta', ...buildVisibleChatPatch(state.text) }, end: false, messageId } });
      }
      return frames;
    },
  };
}
