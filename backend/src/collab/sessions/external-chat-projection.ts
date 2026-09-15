/**
 * 单聊 × 外部编码运行时（Claude Code / Codex / Pi / Grok / OpenCode / DSH / Hermes）的投影器。
 *
 * 与 OpenClaw 投影器共用同一套前端帧（`chat.frame` 负载里的 legacy 帧：delta / final / error / attached），
 * 但只做外部运行时需要的那部分：正文增量拼接、工具进度写进过程区、会话命令结果落成结构化 system 消息、
 * 失败落结构化错误。会话行、排队、陈旧、用量去重、工具调用落库都在协调器里。
 */
import type { ConfigManager } from '../../core/config';
import type { DB } from '../../core/db';
import type { AdapterRunOutcome, CanonicalEvent, ProjectorFinish, ProjectorRunContext, RunProjector, SessionCommandResult } from '../../runtime';
import {
  appendToolProgressLine,
  formatToolResultProgress,
  formatToolStartProgress,
  normalizeGroupToolProgressLocale,
  normalizeToolArgsRecord,
} from '../rooms';
import { buildCommandResultFrame, serializeCommandResultContent } from './chat-command-result';
import { createStructuredChatError } from './chat-messages';
import { CHAT_FRAME_EVENT, CHAT_STREAM_END_EVENT, type ChatFramePayload } from './openclaw-chat-projection';

export type ExternalChatProjectionDeps = {
  db: Pick<DB, 'updateMessage' | 'updateMessageEnvelope' | 'deleteMessage' | 'setChatMessagesRunMarker'>;
  configManager: Pick<ConfigManager, 'getConfig'>;
  run: ProjectorRunContext;
  messageId: number;
  runMarkerMessageIds: number[];
  agentId: string;
  agentName: string;
  modelUsed: string;
  /** 这一轮是会话命令（`/compact`、`/status`、`/usage`）：结果落成结构化 system 消息而不是正文。 */
  command?: SessionCommandResult['command'];
};

function parseArgs(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createExternalChatProjection(deps: ExternalChatProjectionDeps): RunProjector {
  const { db, run, messageId, modelUsed } = deps;
  db.setChatMessagesRunMarker(deps.runMarkerMessageIds, run.runMarker);

  let text = '';
  const toolLines: string[] = [];
  const toolNames = new Map<string, { name: string; args?: Record<string, unknown> }>();
  const activeTools = new Set<string>();
  const commandResults: SessionCommandResult[] = [];

  const locale = () => normalizeGroupToolProgressLocale(deps.configManager.getConfig().language);
  const processContent = () => toolLines.join('\n');
  const writeFrame = (frame: Record<string, unknown>, end = false) => {
    run.publish(CHAT_FRAME_EVENT, { frame, end, messageId } satisfies ChatFramePayload, { replay: { mode: 'replace', key: CHAT_FRAME_EVENT } });
  };
  const pushDelta = () => {
    const frame = { type: 'delta', text, process_content: processContent(), process_streaming: activeTools.size > 0 };
    db.updateMessage(messageId, frame.text, modelUsed, frame.process_content, frame.process_streaming);
    writeFrame(frame);
  };

  const failRun = (detail: string, code?: string): ProjectorFinish => {
    const structuredError = createStructuredChatError(detail, code);
    db.updateMessage(messageId, structuredError.content, modelUsed, processContent(), false);
    db.updateMessageEnvelope(messageId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
    writeFrame({
      type: 'error',
      text: structuredError.content,
      process_content: processContent(),
      process_streaming: false,
      messageCode: structuredError.messageCode,
      messageParams: structuredError.messageParams,
      rawDetail: structuredError.rawDetail,
      role: structuredError.role,
    }, true);
    return { messageId, error: structuredError.rawDetail };
  };

  const finishCommand = (result: SessionCommandResult): ProjectorFinish => {
    db.updateMessage(messageId, serializeCommandResultContent(result), modelUsed, processContent(), false);
    db.updateMessageEnvelope(messageId, 'system', deps.agentId, deps.agentName);
    const frame = buildCommandResultFrame(result);
    writeFrame({ ...frame, process_content: processContent() }, true);
    return { messageId, output: frame.text };
  };

  return {
    onEvent(event: CanonicalEvent) {
      switch (event.type) {
        case 'response.output_text.delta':
          if (!event.delta) return;
          text += event.delta;
          pushDelta();
          return;
        case 'response.output_item.added':
          if (event.item.type === 'function_call') {
            const args = normalizeToolArgsRecord(parseArgs(event.item.arguments));
            toolNames.set(event.item.call_id, { name: event.item.name, args });
            activeTools.add(event.item.call_id);
            appendToolProgressLine(toolLines, formatToolStartProgress(locale(), event.item.name, args));
            pushDelta();
          }
          return;
        case 'response.output_item.done':
          if (event.item.type === 'function_call_output') {
            const known = toolNames.get(event.item.call_id) ?? { name: event.item.name ?? 'tool', args: normalizeToolArgsRecord(parseArgs(event.item.arguments)) };
            activeTools.delete(event.item.call_id);
            appendToolProgressLine(toolLines, formatToolResultProgress(locale(), known.name, known.args, event.item.status === 'failed'));
            pushDelta();
          }
          return;
        case 'session.command':
          commandResults.push(event.result);
          return;
        default:
          return;
      }
    },

    finish(outcome: AdapterRunOutcome): ProjectorFinish {
      activeTools.clear();
      if (outcome.kind === 'aborted') {
        if (outcome.phase === 'preparing') {
          try {
            db.deleteMessage(messageId);
          } catch (error) {
            console.warn(`[chat] Failed to delete interrupted pending assistant message ${messageId} for session ${run.sessionKey}:`, error);
          }
          run.publish(CHAT_STREAM_END_EVENT, { messageId });
          return { messageId: null };
        }
        if (!text.trim() && toolLines.length === 0) {
          // 运行中被停（含被「立即插入」让出）却一个字没出、一个工具没调：不留空的助手行，流直接结束。
          try {
            db.deleteMessage(messageId);
          } catch (error) {
            console.warn(`[chat] Failed to delete empty interrupted assistant message ${messageId} for session ${run.sessionKey}:`, error);
          }
          run.publish(CHAT_STREAM_END_EVENT, { messageId });
          return { messageId: null };
        }
        db.updateMessage(messageId, text, modelUsed, processContent(), false);
        writeFrame({ type: 'final', text, process_content: processContent(), process_streaming: false }, true);
        return { messageId, output: text };
      }

      if (deps.command) {
        const result = commandResults.find((entry) => entry.command === deps.command);
        if (result) return finishCommand(result);
        if (outcome.kind === 'failed') return finishCommand({ command: deps.command, ok: false, error: outcome.error });
        // 运行时把命令当普通一轮执行、没有结构化结果（例如压缩后只回了一句话）：按正文落。
      }

      if (outcome.kind === 'failed') return failRun(outcome.error, outcome.code);

      const finalText = text || outcome.outputText || '';
      if (!finalText.trim()) {
        const autoCompaction = commandResults.find((entry) => entry.command === 'compact');
        if (autoCompaction) return finishCommand(autoCompaction);
        return failRun('No text output returned from the run.');
      }
      db.updateMessage(messageId, finalText, modelUsed, processContent(), false);
      writeFrame({ type: 'final', text: finalText, process_content: processContent(), process_streaming: false }, true);
      return { messageId, output: finalText };
    },

    attachSnapshot() {
      const frames: Array<{ type: string; payload: ChatFramePayload }> = [{
        type: CHAT_FRAME_EVENT,
        payload: { frame: { type: 'attached', messageId, agentId: deps.agentId, agentName: deps.agentName, modelUsed }, end: false, messageId },
      }];
      if (text || toolLines.length) {
        frames.push({ type: CHAT_FRAME_EVENT, payload: { frame: { type: 'delta', text, process_content: processContent(), process_streaming: activeTools.size > 0 }, end: false, messageId } });
      }
      return frames;
    },
  };
}
