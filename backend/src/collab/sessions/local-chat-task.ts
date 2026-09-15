/**
 * 单聊里宿主自己执行的两类「本地操作」——直连模型（`runtimeMode: direct`）与生图——经运行协调器运行。
 *
 * P1a 时它们还挂在 `LocalChatOperationManager` 上、靠中断 epoch 防串线：不进协调器就没有单会话单运行、
 * 服务端队列、「立即插入」、接回快照，AGENTS.md「已知残余风险」里那一条也一直挂着。P1b 把它们迁进来：
 *
 * - **适配器**（`localChatTaskAdapter()`）只负责「跑一个宿主本地任务」：任务 resolve = 完成，抛错 = 失败，
 *   被中止（信号触发 / `AbortError` / 中断 epoch 变了）= 中止。它不认识帧、不写库。
 * - **投影器**（`createLocalChatTaskProjection`）持有这一轮的帧桥：任务经桥写 legacy 帧（delta / final），
 *   桥把帧发进 `session:<id>` 主题（与网关、外部运行时同一个 `chat.frame` 事件），并记下最后一帧给接回快照；
 *   失败 / 中止时的落库与帧在这里。
 * - **生图优先**（`withImageFirst`）：生图意图命中时先试生图；没出图（没配生图模型、判定不是生图）就把这一轮
 *   原样交给内层适配器（网关或直连模型）。整轮是**一个**运行：中止、排队、接回都只有一份。
 *
 * 任务本身（`direct-chat-service.ts` 的流式请求、`image-generation-service.ts`）照旧自己写那一行消息。
 */
import type { DB } from '../../core/db';
import {
  defineCapabilities,
  NATIVE_ONLY_SOURCE_OF_TRUTH,
  type AdapterRunContext,
  type AdapterRunHandle,
  type AdapterRunOutcome,
  type AgentRuntimeAdapter,
  type CanonicalEvent,
  type InterruptReason,
  type ProjectorFinish,
  type ProjectorRunContext,
  type RunProjector,
} from '../../runtime';
import { createStructuredChatError } from './chat-messages';
import { CHAT_FRAME_EVENT, CHAT_STREAM_END_EVENT, type ChatFramePayload } from './openclaw-chat-projection';
import { SessionInterruptedError } from './session-runtime';

export type LocalChatFrame = Record<string, unknown>;

/** 任务写帧的出口（与 `ChatStreamSink` 同形，直连模型服务原样接受）。 */
export interface LocalChatFrameBridge {
  readonly transport: 'sse' | 'ws';
  frame(frame: LocalChatFrame): void;
  end(): void;
}

/**
 * 一轮本地任务的共享状态：路由在建提交时创建，投影器（绑定帧桥）与任务（经桥写帧）各持一份引用。
 * 是类实例而不是普通对象——协调器对排队请求做快照深拷贝时只拷贝纯数据，类实例按引用保留，两边才看得到同一份。
 */
export class LocalChatTurnChannel {
  private publish: ((frame: LocalChatFrame) => void) | null = null;
  /** 生图已经出图（这一轮不再交给内层运行时）。 */
  imageHandled = false;
  lastFrame: LocalChatFrame | null = null;

  bind(publish: (frame: LocalChatFrame) => void): void {
    this.publish = publish;
  }

  readonly bridge: LocalChatFrameBridge = {
    transport: 'ws',
    frame: (frame) => {
      this.lastFrame = frame;
      this.publish?.(frame);
    },
    // 流由协调器的终态结束；任务调 end() 不做任何事。
    end: () => {},
  };
}

export interface LocalChatTaskRequest {
  /** `direct-runtime`：直连模型；`image-generation`：只生图（生图优先的外层用不到它）。 */
  kind: 'direct-runtime';
  channel: LocalChatTurnChannel;
  run: (io: { bridge: LocalChatFrameBridge; signal: AbortSignal }) => Promise<void>;
}

// 模块加载时不调用 runtime barrel 里的函数：collab ↔ runtime 的 barrel 在启动期有环，顶层调用拿到的是还没初始化的导出。
const localTaskCapabilities = () => defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: false,
  approvals: false,
  clarify: false,
  hostCompression: false,
  nativeCompact: false,
  backgroundDelegation: false,
  images: true,
  mcpInjection: false,
  proxyMode: [],
});

function isAbortLike(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof SessionInterruptedError) return true;
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

/** 等一个 promise 结束，但最多等 ms（中止后任务没理信号时不让 interrupt 永远挂着）。 */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
  });
}

function runLocalTask(
  context: AdapterRunContext<unknown>,
  task: (signal: AbortSignal) => Promise<AdapterRunOutcome>,
): AdapterRunHandle {
  const controller = new AbortController();
  let reason: InterruptReason = 'user_stop';
  let finished = false;
  const onAbort = () => controller.abort();
  if (context.signal.aborted) controller.abort();
  else context.signal.addEventListener('abort', onAbort, { once: true });

  const done = (async (): Promise<AdapterRunOutcome> => {
    try {
      return await task(controller.signal);
    } catch (error) {
      if (isAbortLike(error, controller.signal)) return { kind: 'aborted', reason, synced: true, phase: 'running' };
      return { kind: 'failed', error: (error as Error)?.message || String(error) };
    } finally {
      finished = true;
      context.signal.removeEventListener('abort', onAbort);
    }
  })();

  return {
    done,
    status: () => ({ phase: finished ? 'finished' : 'running' }),
    interrupt: async (interruptReason) => {
      reason = interruptReason;
      controller.abort();
      return { synced: await settleWithin(done, 3000) };
    },
  };
}

let localChatTaskAdapterInstance: AgentRuntimeAdapter<LocalChatTaskRequest> | null = null;

/** 直连模型这类宿主本地任务的适配器（首次用到时构造，见上面关于 barrel 环的说明）。 */
export function localChatTaskAdapter(): AgentRuntimeAdapter<LocalChatTaskRequest> {
  localChatTaskAdapterInstance ??= createLocalChatTaskAdapter();
  return localChatTaskAdapterInstance;
}

function createLocalChatTaskAdapter(): AgentRuntimeAdapter<LocalChatTaskRequest> {
  return {
  id: 'clawopt-local',
  capabilities: localTaskCapabilities(),
  sourceOfTruth: NATIVE_ONLY_SOURCE_OF_TRUTH,
  start(context) {
    const request = context.request;
    return runLocalTask(context, async (signal) => {
      await request.run({ bridge: request.channel.bridge, signal });
      if (signal.aborted) return { kind: 'aborted', reason: 'user_stop', synced: true, phase: 'running' };
      const text = typeof request.channel.lastFrame?.text === 'string' ? request.channel.lastFrame.text : '';
      return { kind: 'completed', outputText: text };
    });
  },
  };
}

export type ImageAttemptResult = { handled: true; output: string } | { handled: false };

/**
 * 生图优先：先跑 `attempt`；出图了这一轮就结束（`stopReason: image_generated`），否则交给内层适配器。
 * 能力与仲裁表沿用内层（界面按内层运行时显示），中止在生图阶段停生图请求、交出去之后交给内层的 interrupt。
 */
export function withImageFirst<TRequest>(
  inner: AgentRuntimeAdapter<TRequest>,
  attempt: (io: { signal: AbortSignal }) => Promise<ImageAttemptResult>,
): AgentRuntimeAdapter<TRequest> {
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    sourceOfTruth: inner.sourceOfTruth,
    start(context) {
      let innerHandle: AdapterRunHandle | null = null;
      const imagePhase = runLocalTask(context, async (signal) => {
        const result = await attempt({ signal });
        if (signal.aborted) return { kind: 'aborted', reason: 'user_stop', synced: true, phase: 'running' };
        if (result.handled) return { kind: 'completed', outputText: result.output, stopReason: 'image_generated' };
        innerHandle = inner.start(context as AdapterRunContext<TRequest>);
        return innerHandle.done;
      });
      const forwardBoundary = inner.capabilities.boundaryInterrupt
        ? { requestBoundaryInterrupt: async (expectedRunId: string) => innerHandle?.requestBoundaryInterrupt
          ? innerHandle.requestBoundaryInterrupt(expectedRunId)
          : { status: 'unsupported' as const, reason: 'image generation in progress' } }
        : {};
      const forwardApprovals = inner.capabilities.approvals
        ? { resolveApproval: (id: string, decision: Parameters<NonNullable<AdapterRunHandle['resolveApproval']>>[1]) => innerHandle?.resolveApproval?.(id, decision) ?? false }
        : {};
      const forwardClarify = inner.capabilities.clarify
        ? { resolveClarify: (id: string, response: string) => innerHandle?.resolveClarify?.(id, response) ?? false }
        : {};
      return {
        done: imagePhase.done,
        status: () => innerHandle?.status() ?? imagePhase.status(),
        interrupt: (reason) => (innerHandle ? innerHandle.interrupt(reason) : imagePhase.interrupt(reason)),
        ...forwardBoundary,
        ...forwardApprovals,
        ...forwardClarify,
      };
    },
  };
}

export type LocalChatProjectionDeps = {
  db: Pick<DB, 'updateMessage' | 'updateMessageEnvelope' | 'deleteMessage' | 'setChatMessagesRunMarker'>;
  run: ProjectorRunContext;
  channel: LocalChatTurnChannel;
  messageId: number;
  runMarkerMessageIds: number[];
  agentId: string;
  agentName: string;
  modelUsed: string;
  /** 失败时写进错误行的模型标签。 */
  resolveErrorModelTag: () => string;
};

/**
 * 本地任务的投影器。`inner` 给了（生图优先 + 网关 / 外部内层）时，没出图的终态交给内层投影器处理。
 */
export function createLocalChatTaskProjection(deps: LocalChatProjectionDeps, inner?: RunProjector): RunProjector {
  const { db, run, channel, messageId } = deps;
  if (!inner) db.setChatMessagesRunMarker(deps.runMarkerMessageIds, run.runMarker);
  channel.bind((frame) => {
    const end = frame.type === 'final' || frame.type === 'error';
    run.publish(CHAT_FRAME_EVENT, { frame, end, messageId } satisfies ChatFramePayload, { replay: { mode: 'replace', key: CHAT_FRAME_EVENT } });
  });

  const lastText = () => (typeof channel.lastFrame?.text === 'string' ? channel.lastFrame.text : '');
  const lastProcess = () => (typeof channel.lastFrame?.process_content === 'string' ? channel.lastFrame.process_content : '');

  return {
    onEvent(event: CanonicalEvent) {
      inner?.onEvent(event);
    },

    finish(outcome: AdapterRunOutcome): ProjectorFinish {
      if (outcome.kind === 'completed' && outcome.stopReason === 'image_generated') {
        channel.imageHandled = true;
        return { messageId, output: outcome.outputText ?? lastText() };
      }
      if (inner) return inner.finish(outcome);

      if (outcome.kind === 'aborted') {
        const text = lastText();
        if (!text.trim()) {
          // 还没出字就被停：占位的助手行删掉，流直接结束（与网关准备阶段被停一致）。
          try {
            db.deleteMessage(messageId);
          } catch (error) {
            console.warn(`[chat] Failed to delete interrupted local assistant message ${messageId} for session ${run.sessionKey}:`, error);
          }
          run.publish(CHAT_STREAM_END_EVENT, { messageId });
          return { messageId: null };
        }
        db.updateMessage(messageId, text, deps.modelUsed, lastProcess(), false);
        const frame: LocalChatFrame = { type: 'final', text, process_content: lastProcess(), process_streaming: false };
        if (outcome.reason === 'queue_insertion') frame.stop_reason = 'queue_insertion';
        run.publish(CHAT_FRAME_EVENT, { frame, end: true, messageId } satisfies ChatFramePayload, { replay: { mode: 'replace', key: CHAT_FRAME_EVENT } });
        return { messageId, output: text };
      }

      if (outcome.kind === 'failed') {
        const structuredError = createStructuredChatError(outcome.error, outcome.code);
        try {
          db.updateMessage(messageId, structuredError.content, deps.resolveErrorModelTag(), null, false);
          db.updateMessageEnvelope(messageId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
        } catch {}
        run.publish(CHAT_FRAME_EVENT, {
          frame: {
            type: 'error',
            text: structuredError.content,
            messageCode: structuredError.messageCode,
            messageParams: structuredError.messageParams,
            rawDetail: structuredError.rawDetail,
            role: structuredError.role,
          },
          end: true,
          messageId,
        } satisfies ChatFramePayload);
        return { messageId, error: structuredError.rawDetail };
      }

      // 完成：任务已经推过终帧、写过库。
      return { messageId, output: outcome.outputText ?? lastText() };
    },

    attachSnapshot() {
      const frames: Array<{ type: string; payload: ChatFramePayload }> = [{
        type: CHAT_FRAME_EVENT,
        payload: { frame: { type: 'attached', messageId, agentId: deps.agentId, agentName: deps.agentName, modelUsed: deps.modelUsed }, end: false, messageId },
      }];
      const innerFrames = inner?.attachSnapshot?.() ?? [];
      const innerHasContent = innerFrames.some((frame) => (frame.payload as ChatFramePayload | undefined)?.frame?.type === 'delta');
      if (innerHasContent) return [...frames, ...innerFrames.filter((frame) => (frame.payload as ChatFramePayload | undefined)?.frame?.type !== 'attached')];
      if (channel.lastFrame && channel.lastFrame.type === 'delta') {
        frames.push({ type: CHAT_FRAME_EVENT, payload: { frame: channel.lastFrame, end: false, messageId } });
      }
      return frames;
    },
  };
}
