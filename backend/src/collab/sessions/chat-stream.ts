/**
 * 单聊流的两种出口：SSE（legacy，默认）与 WebSocket（P1a 起，前端开关控制）。
 *
 * 帧的来源只有一个——实时中枢里 `session:<id>` 主题的事件：
 * 协调器里的网关运行由投影器发 `chat.frame`；直连模型、生图这类本地操作与斜杠命令
 * 也经 `ChatStreamSink` 把帧发进中枢。SSE 只是中枢的一个订阅者，WebSocket 是另一个。
 */
import { randomUUID } from 'crypto';
import type express from 'express';

import type { RealtimeHub } from '../../core/realtime';
import type { RunCoordinator } from '../../runtime';
import { isStreamingClientOpen } from './chat-run-managers';
import { CHAT_FRAME_EVENT, CHAT_STREAM_END_EVENT, type ChatFramePayload } from './openclaw-chat-projection';

export type ChatStreamDeps = {
  realtime: RealtimeHub;
  runCoordinator: RunCoordinator;
};

export const CHAT_STREAM_TRANSPORT_HEADER = 'x-clawopt-stream';
export const CHAT_WS_CONNECTION_HEADER = 'x-clawopt-ws-connection';

export function chatSessionTopic(sessionId: string): string {
  return `session:${sessionId}`;
}

const TERMINAL_RUN_EVENTS = new Set(['run.completed', 'run.failed', 'run.aborted']);

export function openSseResponse(res: express.Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export function writeSseFrame(res: express.Response, frame: unknown): boolean {
  if (!isStreamingClientOpen(res)) return false;
  try {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
    return isStreamingClientOpen(res);
  } catch {
    return false;
  }
}

/**
 * 把协调器里这个会话当前的运行接到一个 SSE 响应上：先写接回快照（attached + 当前文本），
 * 再跟着中枢收后续帧；收到带 end 的帧或运行终态就结束响应。没有运行返回 false。
 */
export function pipeChatRunToSse(deps: ChatStreamDeps, sessionId: string, res: express.Response): boolean {
  const run = deps.runCoordinator.getActiveRun(sessionId);
  if (!run || !isStreamingClientOpen(res)) return false;
  const topic = chatSessionTopic(sessionId);
  const listenerName = `sse:chat:${randomUUID()}`;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    unlisten();
    if (isStreamingClientOpen(res)) {
      try { res.end(); } catch {}
    }
  };

  for (const event of deps.runCoordinator.snapshot(sessionId).attach) {
    if (event.type === CHAT_FRAME_EVENT) writeSseFrame(res, (event.payload as ChatFramePayload).frame);
  }

  // 快照与订阅之间没有 await：同一轮事件循环里不会漏帧。
  const unlisten = deps.realtime.listen(listenerName, (event) => {
    if (closed || event.topic !== topic || event.runId !== run.runId) return;
    if (event.type === CHAT_FRAME_EVENT) {
      const payload = event.payload as ChatFramePayload;
      if (!writeSseFrame(res, payload.frame) || payload.end) close();
      return;
    }
    if (event.type === CHAT_STREAM_END_EVENT || TERMINAL_RUN_EVENTS.has(event.type)) close();
  });
  res.on('close', () => {
    closed = true;
    unlisten();
  });
  return true;
}

/**
 * 发送 / 重新生成的那条 POST 流：在提交运行**之前**就开始听中枢，等到这条助手消息的
 * `run.started` 才绑定 run id——提交与绑定之间哪怕运行已经出了帧（例如准备阶段立刻失败）也不会漏。
 * 绑定时先写 `attached`（与迁移前 PendingChatPreparationManager 的接回帧一致），之后跟帧直到结束。
 */
export function streamNewChatRunToSse(
  deps: ChatStreamDeps,
  params: { sessionId: string; messageId: number; attachedFrame: Record<string, unknown>; res: express.Response },
): { dispose: () => void } {
  const { res } = params;
  const topic = chatSessionTopic(params.sessionId);
  const listenerName = `sse:chat:${randomUUID()}`;
  let runId: string | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unlisten();
    if (isStreamingClientOpen(res)) {
      try { res.end(); } catch {}
    }
  };
  const unlisten = deps.realtime.listen(listenerName, (event) => {
    if (closed || event.topic !== topic) return;
    if (!runId) {
      const meta = (event.payload as { meta?: { messageId?: unknown } } | null)?.meta;
      if (event.type !== 'run.started' || meta?.messageId !== params.messageId || !event.runId) return;
      runId = event.runId;
      if (!writeSseFrame(res, params.attachedFrame)) close();
      return;
    }
    if (event.runId !== runId) return;
    if (event.type === CHAT_FRAME_EVENT) {
      const payload = event.payload as ChatFramePayload;
      if (!writeSseFrame(res, payload.frame) || payload.end) close();
      return;
    }
    if (event.type === CHAT_STREAM_END_EVENT || TERMINAL_RUN_EVENTS.has(event.type)) close();
  });
  res.on('close', () => {
    closed = true;
    unlisten();
  });
  return { dispose: close };
}

/**
 * 路由里「直接写一帧」的地方（斜杠命令、直连模型、生图）用它：
 * SSE 模式写到这个响应；WebSocket 模式发进中枢，由订阅了该会话的连接收。
 */
export interface ChatStreamSink {
  readonly transport: 'sse' | 'ws';
  frame(frame: Record<string, unknown>): void;
  end(): void;
}

export function createChatStreamSink(
  deps: ChatStreamDeps,
  params: { transport: 'sse' | 'ws'; sessionId: string; res: express.Response; origin?: string; messageId?: number },
): ChatStreamSink {
  if (params.transport === 'sse') {
    return {
      transport: 'sse',
      frame: (frame) => { writeSseFrame(params.res, frame); },
      end: () => {
        if (isStreamingClientOpen(params.res)) {
          try { params.res.end(); } catch {}
        }
      },
    };
  }
  const topic = chatSessionTopic(params.sessionId);
  const streamId = `local-${randomUUID()}`;
  return {
    transport: 'ws',
    frame: (frame) => {
      deps.realtime.publish({
        topic,
        type: CHAT_FRAME_EVENT,
        payload: { frame, end: frame.type === 'final' || frame.type === 'error', messageId: params.messageId } ,
        runId: streamId,
        origin: params.origin,
      });
    },
    end: () => {
      deps.realtime.publish({ topic, type: CHAT_STREAM_END_EVENT, payload: { messageId: params.messageId }, runId: streamId, origin: params.origin });
    },
  };
}
