import path from 'path';
import type express from 'express';

import {
  type AgentProvisioner,
  type AgentSettings,
  buildHostTakeoverChatInstruction,
  type ImageGenerationService,
  resolveModelTagForErrorReport,
  shouldUseConfiguredImageGenerationModel,
} from '../../control';
import { getRequestIdentity, type ResourceAccess, sendResourceForbidden } from '../../core/auth';
import type { DB, SessionRow } from '../../core/db';
import type { RouteApp } from '../../core/http';
import type { RealtimeHub } from '../../core/realtime';
import {
  abortOpenClawSessionRuns,
  buildOpenClawChatSessionKey,
  type GatewayChatClient,
  type GatewayConnections,
  type OpenClawClient,
} from '../../openclaw';
import {
  OPENCLAW_ABORT_GRACE_MS,
  type AgentRuntimeAdapter,
  type OpenClawChatRunRequest,
  type RunCoordinator,
  type RunProjector,
  type RunSubmission,
  type RuntimePlatform,
} from '../../runtime';
import type { ConfigManager } from '../../core/config';
import type { UploadService } from '../../workspace';
import { type ChatCommands, parseChatCommand } from './chat-commands';
import {
  CHAT_LATEST_ROUND_ONLY_CODE,
  CHAT_LATEST_ROUND_ONLY_DETAIL,
} from './chat-constants';
import type { ChatLifecycle } from './chat-lifecycle';
import {
  buildStructuredChatErrorStreamEvent,
  buildStructuredChatHttpError,
  createStructuredChatError,
  resolveStructuredChatErrorInput,
} from './chat-messages';
import { registerChatRunControlRoutes } from './chat-run-control-routes';
import {
  CHAT_STREAM_TRANSPORT_HEADER,
  CHAT_WS_CONNECTION_HEADER,
  chatSessionTopic,
  createChatStreamSink,
  type ChatStreamSink,
  openSseResponse,
  pipeChatRunToSse,
  streamNewChatRunToSse,
  writeSseFrame,
} from './chat-stream';
import { ChatTurnRows, persistChatTurnRows, publishChatTurnEcho, readClientTurnId } from './chat-turn-rows';
import type { DirectChatService } from './direct-chat-service';
import { chatSessionParamGuard } from './session-routes';
import { buildExternalChatSubmission, externalModelTag, runExternalChatTurn } from './external-chat-turn';
import {
  createLocalChatTaskProjection,
  localChatTaskAdapter,
  LocalChatTurnChannel,
  withImageFirst,
} from './local-chat-task';
import { externalSessionDefaultWorkspace } from './external-workspace';
import type { SessionOrgStore } from './session-org-store';
import { createOpenClawChatProjection } from './openclaw-chat-projection';
import { rewriteOpenClawMediaPaths } from './process-text';
import type { SessionManager } from './session-manager';
import { SessionInterruptedError, type SessionRuntime } from './session-runtime';

export type ChatRoutesDeps = {
  agentProvisioner: AgentProvisioner;
  configManager: ConfigManager;
  db: DB;
  sessionManager: SessionManager;
  chatCommands: ChatCommands;
  chatLifecycle: ChatLifecycle;
  directChat: DirectChatService;
  sessionRuntime: SessionRuntime;
  agentSettings: AgentSettings;
  imageGeneration: ImageGenerationService;
  gatewayConnections: GatewayConnections;
  connections: Map<string, OpenClawClient>;
  uploads: UploadService;
  realtime: RealtimeHub;
  runCoordinator: RunCoordinator;
  openclawAdapter: AgentRuntimeAdapter<OpenClawChatRunRequest>;
  access: ResourceAccess;
  /** 外部运行时单聊（会话行上有 external_runtime）按运行时 id 取适配器。 */
  runtimePlatform: Pick<RuntimePlatform, 'createAdapter'>;
  /** 对话标题（第一条用户消息 → 自动标题）与分叉血缘。 */
  sessionOrg: Pick<SessionOrgStore, 'recordUserMessageForTitle' | 'getMeta'>;
};

/** 队列面板上显示的文字上限（整条消息仍按原样执行）。 */
const QUEUE_DISPLAY_MAX_CHARS = 500;

/**
 * 流的出口由请求头决定：缺省（与迁移前完全一致）是 SSE；
 * 前端打开 WebSocket 开关时带 `X-ClawOPT-Stream: ws` 与自己的连接 id，
 * 这时 POST 立刻回 JSON（带消息 id），帧从 WebSocket 的 `session:<id>` 主题走。
 */
function readTransport(req: express.Request): { transport: 'sse' | 'ws'; origin?: string } {
  if (String(req.header(CHAT_STREAM_TRANSPORT_HEADER) || '').toLowerCase() !== 'ws') return { transport: 'sse' };
  const origin = String(req.header(CHAT_WS_CONNECTION_HEADER) || '').trim();
  return { transport: 'ws', origin: origin || undefined };
}

/** 这一轮交给哪条执行路径所需的一切（发送与重新生成、立即开始与排队共用）。 */
type ChatTurnPlan = {
  sessionId: string;
  sessionInfo: SessionRow | undefined;
  agentId: string;
  agentName: string;
  modelUsed: string;
  directImageModel: string | null;
  imageIntentContext: string;
  rawMessage: string;
  finalMessage: string;
};

type BuiltChatTurn =
  | { ok: true; submission: RunSubmission<any> }
  | { ok: false; error: ReturnType<typeof createStructuredChatError>; modelTag: string };

export function registerChatRoutes(app: RouteApp, ctx: ChatRoutesDeps): void {
  const { agentProvisioner, db, sessionManager, runCoordinator } = ctx;
  const { resolveChatCommandResult } = ctx.chatCommands;
  const { getLatestChatRegenerateTarget, interruptSessionStreamingStateForNewRun, reconcileInactiveChatLatestMessage } = ctx.chatLifecycle;
  const { prepareOutgoingMessage, runDirectChatCompletion } = ctx.directChat;
  const { bumpSessionInterruptionEpoch, getSessionInterruptionEpoch, getSessionWorkspacePath, readAgentBootstrapIntentContext } = ctx.sessionRuntime;
  const { readEffectiveAgentRuntimeSettings, shouldInjectHostTakeoverInstruction } = ctx.agentSettings;
  const { buildImageGenerationStartProcessContent, getConfiguredDirectImageGenerationModel, tryGenerateImageForPrompt } = ctx.imageGeneration;
  const { getConnection } = ctx.gatewayConnections;
  const { clearStoredFilesBySessionKey } = ctx.uploads;
  const streamDeps = { realtime: ctx.realtime, runCoordinator };

  /**
   * 单聊数据面授权：发送、重新生成、接回流、停止、静默发送都在「这个会话看得见」之后。
   * 会话 id 在请求体里（`/api/chat*`）或路径里（attach）；缺字段的请求交给处理器自己回 400。
   */
  const guardBodySession: express.RequestHandler = (req, res, next) => {
    const sessionId = req.body?.sessionId;
    if (!sessionId) return next();
    if (ctx.access.canAccessChatSession(getRequestIdentity(req), String(sessionId))) return next();
    return sendResourceForbidden(res);
  };
  const guardParamSession = chatSessionParamGuard(ctx, 'sessionId');
  /** 外部运行时单聊的依赖。缺省工作区在 ClawOPT 数据目录下（不在 ~/.openclaw 里造目录：这个会话不是 OpenClaw Agent）。 */
  const externalTurnDeps = {
    db,
    configManager: ctx.configManager,
    realtime: ctx.realtime,
    runCoordinator,
    createAdapter: (runtime: string) => ctx.runtimePlatform.createAdapter(runtime),
    defaultWorkspace: externalSessionDefaultWorkspace,
    // 分叉出来的外部单聊：首轮从父会话的原生会话分叉（适配器按能力声明决定）。
    forkSource: (sessionId: string) => ctx.sessionOrg.getMeta(sessionId)?.parentSessionId ?? null,
  };

  function buildInjectedMessage(sessionInfo: SessionRow | undefined, agentId: string, rawMessage: string): string {
    let injectedInstructions = '';
    if (sessionInfo) {
      if (sessionInfo.process_start_tag && sessionInfo.process_end_tag) {
        injectedInstructions += `【极其重要：输出格式规范】\n当前启用了结构化思考输出。你关于后续任务决断的所有内部思考、分析或工作执行过程，必须严格包裹在 ${sessionInfo.process_start_tag} 和 ${sessionInfo.process_end_tag} 之间！\n真正的最终沟通、回复语言写在标签外部。\n\n`;
      }
    }
    if (shouldInjectHostTakeoverInstruction(sessionInfo, agentId)) {
      injectedInstructions += `${buildHostTakeoverChatInstruction()}\n\n`;
    }
    return injectedInstructions ? `${injectedInstructions}${rawMessage}` : rawMessage;
  }

  function planChatTurn(sessionId: string, sessionInfo: SessionRow | undefined, rawMessage: string): ChatTurnPlan {
    const agentId = sessionInfo?.agentId || 'main';
    const character = db.getCharacters().find(c => c.agentId === agentId);
    const agentName = sessionInfo?.name || character?.name || agentId;
    const imageIntentContext = readAgentBootstrapIntentContext(agentId);
    const directImageModel = shouldUseConfiguredImageGenerationModel(rawMessage, imageIntentContext)
      ? getConfiguredDirectImageGenerationModel()
      : null;
    const modelUsed = directImageModel || agentProvisioner.readAgentModel(agentId) ||
      agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';
    return {
      sessionId,
      sessionInfo,
      agentId,
      agentName,
      modelUsed,
      directImageModel,
      imageIntentContext,
      rawMessage,
      finalMessage: buildInjectedMessage(sessionInfo, agentId, rawMessage),
    };
  }

  /**
   * OpenClaw / 直连模型 / 生图这一轮的提交（外部运行时见 `buildExternalChatSubmission`）。
   * 行 id 从 `rows` 读：立即开始的一轮在调用前已填好；排队的一轮由 `persistRows` 在出队时填。
   */
  function buildLocalOrGatewaySubmission(plan: ChatTurnPlan, rows: ChatTurnRows, options: {
    origin?: string;
    ref?: string | null;
    persistRows?: () => void;
  }): RunSubmission<any> {
    const { sessionId, agentId, agentName, modelUsed } = plan;
    const runtimeSettings = readEffectiveAgentRuntimeSettings(plan.sessionInfo, agentId);
    const channel = new LocalChatTurnChannel();
    // 中断 epoch 在开始那一刻取：排队期间用户点过停止（epoch 变了）不该把排着的这一轮也判成被打断。
    let epoch = getSessionInterruptionEpoch(sessionId);
    const resolveErrorModelTag = () => resolveModelTagForErrorReport(agentProvisioner, db.getSession(sessionId)?.agentId || 'main');
    const localProjectionDeps = (run: Parameters<RunSubmission<any>['projector']>[0]) => ({
      db,
      run,
      channel,
      messageId: rows.assistantMessageId,
      runMarkerMessageIds: rows.runMarkerMessageIds,
      agentId,
      agentName,
      modelUsed,
      resolveErrorModelTag,
    });

    let adapter: AgentRuntimeAdapter<any>;
    let request: unknown;
    let innerProjector: ((run: Parameters<RunSubmission<any>['projector']>[0]) => RunProjector) | null;
    let kind: string;
    if (runtimeSettings.runtimeMode === 'direct') {
      kind = 'direct-runtime';
      adapter = localChatTaskAdapter();
      innerProjector = null;
      request = {
        kind: 'direct-runtime',
        channel,
        run: ({ bridge, signal }: { bridge: ChatStreamSink; signal: AbortSignal }) => runDirectChatCompletion({
          sessionId,
          agentId,
          userMessageId: rows.userMessageId ?? rows.assistantMessageId,
          assistantMessageId: rows.assistantMessageId,
          message: plan.finalMessage,
          modelUsed,
          stream: bridge,
          signal,
          processStartTag: plan.sessionInfo?.process_start_tag || undefined,
          processEndTag: plan.sessionInfo?.process_end_tag || undefined,
          sessionInterruptionEpoch: epoch,
        }),
      };
    } else {
      // OpenClaw 网关：准备段（连网关、清孤儿 run、订阅会话事件、组装消息、取历史基线、发送）、流式、
      // 完成探针、中止都在 runtime/adapters/openclaw.ts；消息行与帧在 openclaw-chat-projection.ts。
      kind = 'openclaw-run';
      adapter = ctx.openclawAdapter;
      const includeDocumentToolingContext = runtimeSettings.toolMode === 'full' || runtimeSettings.toolMode === 'coding';
      request = {
        sessionId,
        agentId,
        getConnection: () => getConnection(sessionId),
        prepareMessage: () => prepareOutgoingMessage(plan.finalMessage, agentId, { includeDocumentToolingContext }),
        onGatewayReconnected: (client: GatewayChatClient) => { ctx.connections.set(sessionId, client as OpenClawClient); },
      } satisfies OpenClawChatRunRequest;
      innerProjector = (run) => createOpenClawChatProjection({
        db,
        configManager: ctx.configManager,
        run,
        messageId: rows.assistantMessageId,
        runMarkerMessageIds: rows.runMarkerMessageIds,
        agentId,
        agentName,
        modelUsed,
        workspacePath: getSessionWorkspacePath(sessionId),
        processStartTag: plan.sessionInfo?.process_start_tag || undefined,
        processEndTag: plan.sessionInfo?.process_end_tag || undefined,
        resolveErrorModelTag,
      });
    }

    if (plan.directImageModel) {
      const directImageModel = plan.directImageModel;
      adapter = withImageFirst(adapter, async ({ signal }) => {
        const startProcessContent = buildImageGenerationStartProcessContent(directImageModel);
        db.updateMessage(rows.assistantMessageId, '', directImageModel, startProcessContent, true);
        channel.bridge.frame({
          type: 'delta',
          text: '',
          process_content: startProcessContent,
          process_streaming: true,
          modelUsed: directImageModel,
          model_used: directImageModel,
        });
        const result = await tryGenerateImageForPrompt({
          prompt: plan.rawMessage,
          intentText: plan.rawMessage,
          intentContext: plan.imageIntentContext,
          outputDir: path.join(getSessionWorkspacePath(sessionId), 'output', 'image-generations'),
          signal,
        });
        if (!result) return { handled: false };
        db.updateMessage(rows.assistantMessageId, result.content, result.modelUsed, result.processContent, false);
        channel.bridge.frame({
          type: 'final',
          text: result.content,
          process_content: result.processContent,
          process_streaming: false,
          modelUsed: result.modelUsed,
          model_used: result.modelUsed,
        });
        return { handled: true, output: result.content };
      });
    }

    const openclaw = kind === 'openclaw-run';
    return {
      sessionKey: sessionId,
      surface: 'chat',
      topics: [chatSessionTopic(sessionId), `agent:${agentId}`],
      agentId,
      title: agentName,
      adapter,
      request,
      ref: options.ref ?? null,
      display: plan.rawMessage.slice(0, QUEUE_DISPLAY_MAX_CHARS),
      beforeStart: () => {
        options.persistRows?.();
        epoch = getSessionInterruptionEpoch(sessionId);
        return { meta: { messageId: rows.assistantMessageId, userMessageId: rows.userMessageId, agentId, kind } };
      },
      projector: (run) => {
        const inner = innerProjector ? innerProjector(run) : undefined;
        // 生图优先或直连模型：本地投影器持帧桥（没出图时终态交给内层网关投影器）。纯网关一轮直接用网关投影器。
        if (plan.directImageModel || !inner) return createLocalChatTaskProjection(localProjectionDeps(run), inner);
        return inner;
      },
      origin: options.origin,
      workspacePath: getSessionWorkspacePath(sessionId),
      meta: { messageId: rows.assistantMessageId, userMessageId: rows.userMessageId, agentId, kind },
      ...(openclaw ? { abortGraceMs: OPENCLAW_ABORT_GRACE_MS } : {}),
    };
  }

  function buildChatTurn(plan: ChatTurnPlan, rows: ChatTurnRows, options: { origin?: string; ref?: string | null; persistRows?: () => void }): BuiltChatTurn {
    if (plan.sessionInfo?.external_runtime) {
      const built = buildExternalChatSubmission(externalTurnDeps, {
        session: plan.sessionInfo,
        prompt: plan.rawMessage,
        agentName: plan.agentName,
        rows,
        origin: options.origin,
        ref: options.ref,
        persistRows: options.persistRows,
      });
      if (!built.ok) return built;
      built.submission.display = plan.rawMessage.slice(0, QUEUE_DISPLAY_MAX_CHARS);
      return { ok: true, submission: built.submission };
    }
    return { ok: true, submission: buildLocalOrGatewaySubmission(plan, rows, options) };
  }

  /** 发送与重新生成共用的错误收尾（与迁移前两份拷贝逐行一致）。 */
  function handleTurnError(params: {
    error: any;
    res: express.Response;
    sink: ChatStreamSink | null;
    sessionId: string;
    epoch: number;
    userMessageId?: number;
    assistantMessageId?: number;
    fallbackParentId?: number;
  }): void {
    const { error, res, sink, sessionId, epoch } = params;
    const resetInterrupted = error instanceof SessionInterruptedError || getSessionInterruptionEpoch(sessionId) !== epoch;
    if (resetInterrupted) {
      if (res.headersSent) {
        sink?.end();
      } else {
        res.status(409).json(buildStructuredChatHttpError('Session was interrupted during processing.'));
      }
      return;
    }

    const structuredErrorInput = resolveStructuredChatErrorInput(error);
    const structuredError = createStructuredChatError(structuredErrorInput.rawDetail, structuredErrorInput.messageCode);
    const agentId = db.getSession(sessionId)?.agentId || 'main';
    const modelUsed = resolveModelTagForErrorReport(agentProvisioner, agentId);

    if (typeof params.assistantMessageId === 'number') {
      try {
        db.updateMessage(params.assistantMessageId, structuredError.content, modelUsed, null, false);
        db.updateMessageEnvelope(params.assistantMessageId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
      } catch {}
    } else if (typeof (params.userMessageId ?? params.fallbackParentId) === 'number') {
      try {
        db.saveMessage({
          session_key: sessionId,
          parent_id: params.userMessageId ?? params.fallbackParentId,
          role: structuredError.role,
          content: structuredError.content,
          model_used: modelUsed,
          agent_id: structuredError.agent_id,
          agent_name: structuredError.agent_name,
        });
      } catch {}
    }

    if (!res.headersSent) {
      res.status(500).json(buildStructuredChatHttpError(structuredErrorInput.rawDetail, structuredErrorInput.messageCode));
      return;
    }
    const errorEvent = buildStructuredChatErrorStreamEvent(structuredError);
    sink?.frame(errorEvent);
    sink?.end();
  }

  /**
   * 打开这一轮的流。SSE：写头、填充块与 `ids` 帧（与迁移前一致）；
   * WebSocket：直接回 JSON，之后的帧走 `session:<id>` 主题。
   */
  function openTurnStream(res: express.Response, transport: 'sse' | 'ws', ids: { userMsgId: number; assistantMsgId: number }): void {
    if (transport === 'ws') {
      res.json({ success: true, stream: 'ws', ...ids });
      return;
    }
    openSseResponse(res);
    res.write(':' + Array(2048).fill(' ').join('') + '\n\n');
    writeSseFrame(res, { type: 'ids', ...ids });
  }

  /**
   * 会话正忙时的发送（请求体 `queue: true`）：不打断正在跑的这一轮，**排进服务端队列**。
   * 行在出队那一刻才落（`beforeStart`），POST 立刻回 JSON；帧与出队通知走会话实时通道
   * （`GET /api/chat/:sessionId/events` 或 `/ws` 的 `session:<id>` 主题），前端据此把排队项挪进时间线并接回流。
   * 不开新运行的内建快捷命令（`/status` `/clear` …）排不进运行队列，忙时回 409 `chat.commandWhileRunning`。
   */
  async function handleQueuedChatTurn(req: express.Request, res: express.Response, params: {
    sessionId: string;
    sessionInfo: SessionRow | undefined;
    rawMessage: string;
    clientTurnId: string | null;
    origin?: string;
  }): Promise<void> {
    const { sessionId, sessionInfo, rawMessage, clientTurnId } = params;
    const parsedCommand = parseChatCommand(rawMessage);
    if (parsedCommand && !sessionInfo?.external_runtime && await isBuiltinChatCommand(parsedCommand.command)) {
      res.status(409).json(buildStructuredChatHttpError('Built-in commands cannot run while a reply is in progress.', 'chat.commandWhileRunning'));
      return;
    }
    const plan = planChatTurn(sessionId, sessionInfo, rawMessage);
    const modelUsed = sessionInfo?.external_runtime ? externalModelTag(sessionInfo) : plan.modelUsed;
    const agentName = sessionInfo?.external_runtime ? (sessionInfo.name || sessionInfo.agentId) : plan.agentName;
    const rows = new ChatTurnRows();
    const persistRows = () => {
      const saved = persistChatTurnRows(db, { sessionId, content: rawMessage, agentId: plan.agentId, agentName, modelUsed });
      ctx.sessionOrg.recordUserMessageForTitle(sessionId, rawMessage);
      rows.userMessageId = saved.userMessageId;
      rows.assistantMessageId = saved.assistantMessageId;
      rows.runMarkerMessageIds = [saved.userMessageId, saved.assistantMessageId];
      publishChatTurnEcho(ctx.realtime, {
        sessionId,
        clientTurnId,
        userMessageId: saved.userMessageId,
        assistantMessageId: saved.assistantMessageId,
        parentId: saved.parentId,
        content: rawMessage,
        agentId: plan.agentId,
        agentName,
        modelUsed,
        queued: true,
      });
    };
    const built = buildChatTurn({ ...plan, agentName }, rows, { origin: params.origin, ref: clientTurnId, persistRows });
    if (!built.ok) {
      res.status(409).json(buildStructuredChatHttpError(built.error.rawDetail, built.error.messageCode));
      return;
    }
    const submitted = await runCoordinator.submit(built.submission, 'queue');
    if (submitted.status === 'queued') {
      res.json({ success: true, queued: true, queueId: submitted.queueId, position: submitted.position, clientTurnId });
      return;
    }
    if (submitted.status === 'started') {
      // 判忙与提交之间上一轮刚好结束：这一轮直接开始了（行已在 beforeStart 里落好）。
      res.json({ success: true, started: true, userMsgId: rows.userMessageId, assistantMsgId: rows.assistantMessageId, clientTurnId });
      return;
    }
    res.status(409).json(buildStructuredChatHttpError('Session is busy.', 'chat.sessionBusy'));
  }

  async function isBuiltinChatCommand(command: string): Promise<boolean> {
    return ['/status', '/help', '/models', '/clear'].includes(command)
      || (db.getQuickCommands() as Array<{ command?: unknown }>).some((entry) => String(entry.command || '').trim().toLowerCase() === command);
  }

  app.post('/api/chat', guardBodySession, async (req, res) => {
    const { sessionId, message, parentId } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json(buildStructuredChatHttpError('Missing sessionId or message'));
    }

    const normalizedSessionId = String(sessionId);
    const { transport, origin } = readTransport(req);
    const clientTurnId = readClientTurnId(req.body?.clientTurnId);
    const rawMessage = String(message);

    if (req.body?.queue === true && runCoordinator.isBusy(normalizedSessionId)) {
      try {
        await handleQueuedChatTurn(req, res, {
          sessionId: normalizedSessionId,
          sessionInfo: sessionManager.getSession(normalizedSessionId),
          rawMessage,
          clientTurnId,
          origin,
        });
      } catch (error: any) {
        if (!res.headersSent) res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to queue chat message.'));
      }
      return;
    }

    const sessionInterruptionEpoch = await interruptSessionStreamingStateForNewRun(normalizedSessionId);

    let userMsgId: number | undefined;
    let assistantMsgId: number | undefined;
    let sink: ChatStreamSink | null = null;

    try {
      const parsedCommand = parseChatCommand(rawMessage);
      const sessionInfo = sessionManager.getSession(normalizedSessionId);
      const echo = (ids: { userMsgId: number; assistantMsgId: number; parentId: number | null }, agentId: string, agentName: string, modelUsed: string) => {
        publishChatTurnEcho(ctx.realtime, {
          sessionId: normalizedSessionId,
          clientTurnId,
          userMessageId: ids.userMsgId,
          assistantMessageId: ids.assistantMsgId,
          parentId: ids.parentId,
          content: rawMessage,
          agentId,
          agentName,
          modelUsed,
          queued: false,
        }, origin);
      };

      if (sessionInfo?.external_runtime) {
        // 外部运行时单聊：`/compact` `/status` `/usage` 交给运行时本身（不是网关的内建命令），其余照常作为一轮。
        const externalAgentName = sessionInfo.name || sessionInfo.agentId;
        const saved = persistChatTurnRows(db, {
          sessionId: normalizedSessionId,
          content: rawMessage,
          agentId: sessionInfo.agentId,
          agentName: externalAgentName,
          modelUsed: externalModelTag(sessionInfo),
          parentId: parentId ? Number(parentId) : undefined,
        });
        userMsgId = saved.userMessageId;
        assistantMsgId = saved.assistantMessageId;
        ctx.sessionOrg.recordUserMessageForTitle(normalizedSessionId, rawMessage);
        openTurnStream(res, transport, { userMsgId, assistantMsgId });
        echo({ userMsgId, assistantMsgId, parentId: saved.parentId }, sessionInfo.agentId, externalAgentName, externalModelTag(sessionInfo));
        sink = createChatStreamSink(streamDeps, { transport, sessionId: normalizedSessionId, res, origin, messageId: assistantMsgId });
        await runExternalChatTurn(externalTurnDeps, {
          session: sessionInfo, transport, origin, res, sink, prompt: rawMessage,
          assistantMessageId: assistantMsgId, userMessageId: userMsgId, runMarkerMessageIds: [userMsgId, assistantMsgId], agentName: externalAgentName,
          ref: clientTurnId,
        });
        return;
      }

      const plan = planChatTurn(normalizedSessionId, sessionInfo, rawMessage);
      const { agentId, agentName, modelUsed } = plan;

      if (parsedCommand) {
        const commandResult = await resolveChatCommandResult(parsedCommand, normalizedSessionId);
        if (commandResult) {
          if (commandResult.clearBeforeSave) {
            db.deleteMessagesBySession(normalizedSessionId);
            clearStoredFilesBySessionKey(normalizedSessionId);
          }

          let finalParentId = parentId ? Number(parentId) : undefined;
          if (finalParentId === undefined) {
            const history = db.getMessages(normalizedSessionId, 1);
            finalParentId = history.length > 0 ? history[history.length - 1].id : undefined;
          }

          userMsgId = Number(db.saveMessage({
            session_key: normalizedSessionId,
            parent_id: finalParentId,
            role: 'user',
            content: rawMessage,
          }));

          assistantMsgId = Number(db.saveMessage({
            session_key: normalizedSessionId,
            parent_id: userMsgId,
            role: 'assistant',
            content: commandResult.content,
            model_used: modelUsed,
            agent_id: agentId,
            agent_name: agentName,
          }));

          openTurnStream(res, transport, { userMsgId, assistantMsgId });
          sink = createChatStreamSink(streamDeps, { transport, sessionId: normalizedSessionId, res, origin, messageId: assistantMsgId });
          sink.frame({ type: 'final', text: commandResult.content });
          sink.end();
          return;
        }

        // Unknown slash command falls back to normal chat flow.
      }

      const saved = persistChatTurnRows(db, {
        sessionId: normalizedSessionId,
        content: rawMessage,
        agentId,
        agentName,
        modelUsed,
        parentId: parentId ? Number(parentId) : undefined,
      });
      userMsgId = saved.userMessageId;
      assistantMsgId = saved.assistantMessageId;
      ctx.sessionOrg.recordUserMessageForTitle(normalizedSessionId, rawMessage);

      openTurnStream(res, transport, { userMsgId, assistantMsgId });
      echo({ userMsgId, assistantMsgId, parentId: saved.parentId }, agentId, agentName, modelUsed);
      sink = createChatStreamSink(streamDeps, { transport, sessionId: normalizedSessionId, res, origin, messageId: assistantMsgId });

      const rows = ChatTurnRows.of({ userMessageId: userMsgId, assistantMessageId: assistantMsgId, runMarkerMessageIds: [userMsgId, assistantMsgId] });
      const built = buildChatTurn(plan, rows, { origin, ref: clientTurnId });
      if (!built.ok) throw Object.assign(new Error(built.error.rawDetail), { messageCode: built.error.messageCode });
      if (transport === 'sse') {
        const attachedFrame = { type: 'attached', messageId: assistantMsgId, agentId, agentName, modelUsed };
        streamNewChatRunToSse(streamDeps, { sessionId: normalizedSessionId, messageId: assistantMsgId, attachedFrame, res });
      }
      await runCoordinator.submit(built.submission, 'replace');
    } catch (error: any) {
      handleTurnError({
        error, res, sink,
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        userMessageId: userMsgId,
        assistantMessageId: assistantMsgId,
      });
    }
  });

  app.post('/api/chat/regenerate', guardBodySession, async (req, res) => {
    const { sessionId, message, parentId, targetMessageId } = req.body;

    if (!sessionId || !message || !parentId) {
      return res.status(400).json(buildStructuredChatHttpError('Missing sessionId, message, or parentId'));
    }

    const normalizedSessionId = String(sessionId);
    const { transport, origin } = readTransport(req);
    const sessionInterruptionEpoch = await interruptSessionStreamingStateForNewRun(normalizedSessionId);

    let assistantMsgId: number | undefined;
    let sink: ChatStreamSink | null = null;

    try {
      const requestedParentId = Number(parentId);
      const requestedTargetMessageId = Number(targetMessageId);
      const { latestUserMessage, latestReplyMessage } = getLatestChatRegenerateTarget(normalizedSessionId);
      const latestUserId = Number(latestUserMessage?.id);
      const latestReplyId = Number(latestReplyMessage?.id);
      const latestReplyParentId = Number(latestReplyMessage?.parent_id);
      const latestRoundTargetIds = new Set<number>();
      if (Number.isFinite(latestUserId)) {
        latestRoundTargetIds.add(latestUserId);
      }
      if (Number.isFinite(latestReplyId)) {
        latestRoundTargetIds.add(latestReplyId);
      }

      const requestReferencesLatestRound = [requestedParentId, requestedTargetMessageId].some((candidateId) => (
        Number.isFinite(candidateId) && latestRoundTargetIds.has(candidateId)
      ));
      const numericParentId = latestUserId;

      if (
        !Number.isFinite(numericParentId)
        || !latestUserMessage
        || !requestReferencesLatestRound
      ) {
        return res.status(409).json(buildStructuredChatHttpError(
          CHAT_LATEST_ROUND_ONLY_DETAIL,
          CHAT_LATEST_ROUND_ONLY_CODE,
        ));
      }

      if (
        latestReplyMessage
        && (latestReplyMessage.role === 'assistant' || latestReplyMessage.role === 'system')
        && latestReplyParentId === numericParentId
        && typeof latestReplyMessage.id === 'number'
      ) {
        db.deleteMessage(Number(latestReplyMessage.id));
      }

      const sessionInfo = sessionManager.getSession(normalizedSessionId);
      const rawMessage = String(message);

      if (sessionInfo?.external_runtime) {
        const externalAgentName = sessionInfo.name || sessionInfo.agentId;
        assistantMsgId = Number(db.saveMessage({
          session_key: normalizedSessionId, parent_id: numericParentId, role: 'assistant', content: '',
          model_used: externalModelTag(sessionInfo), agent_id: sessionInfo.agentId, agent_name: externalAgentName,
        }));
        openTurnStream(res, transport, { userMsgId: numericParentId, assistantMsgId });
        sink = createChatStreamSink(streamDeps, { transport, sessionId: normalizedSessionId, res, origin, messageId: assistantMsgId });
        await runExternalChatTurn(externalTurnDeps, {
          session: sessionInfo, transport, origin, res, sink, prompt: rawMessage,
          assistantMessageId: assistantMsgId, userMessageId: numericParentId, runMarkerMessageIds: [assistantMsgId], agentName: externalAgentName,
        });
        return;
      }

      const plan = planChatTurn(normalizedSessionId, sessionInfo, rawMessage);
      const { agentId, agentName, modelUsed } = plan;

      assistantMsgId = Number(db.saveMessage({
        session_key: normalizedSessionId,
        parent_id: numericParentId,
        role: 'assistant',
        content: '',
        model_used: modelUsed,
        agent_id: agentId,
        agent_name: agentName
      }));

      openTurnStream(res, transport, { userMsgId: numericParentId, assistantMsgId });
      sink = createChatStreamSink(streamDeps, { transport, sessionId: normalizedSessionId, res, origin, messageId: assistantMsgId });

      const rows = ChatTurnRows.of({ userMessageId: numericParentId, assistantMessageId: assistantMsgId, runMarkerMessageIds: [assistantMsgId] });
      const built = buildChatTurn(plan, rows, { origin });
      if (!built.ok) throw Object.assign(new Error(built.error.rawDetail), { messageCode: built.error.messageCode });
      if (transport === 'sse') {
        const attachedFrame = { type: 'attached', messageId: assistantMsgId, agentId, agentName, modelUsed };
        streamNewChatRunToSse(streamDeps, { sessionId: normalizedSessionId, messageId: assistantMsgId, attachedFrame, res });
      }
      await runCoordinator.submit(built.submission, 'replace');
    } catch (error: any) {
      handleTurnError({
        error, res, sink,
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        assistantMessageId: assistantMsgId,
        fallbackParentId: Number(parentId),
      });
    }
  });

  app.get('/api/chat/attach/:sessionId', guardParamSession, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const run = runCoordinator.getActiveRun(sessionId);
      if (!run) {
        await reconcileInactiveChatLatestMessage(sessionId);
        // Return empty payload to indicate no active run
        return res.status(200).json({ active: false });
      }

      openSseResponse(res);

      if (pipeChatRunToSse(streamDeps, sessionId, res)) {
        return;
      }

      res.end();
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to attach chat stream.'));
        return;
      }
      try {
        res.end();
      } catch {}
    }
  });

  app.post('/api/chat/stop', guardBodySession, async (req, res) => {
    const { sessionId } = req.body || {};

    if (!sessionId) {
      return res.status(400).json(buildStructuredChatHttpError('Missing sessionId'));
    }

    try {
      const normalizedSessionId = String(sessionId);
      bumpSessionInterruptionEpoch(normalizedSessionId);
      const activeKind = runCoordinator.getActiveRun(normalizedSessionId)?.meta.kind;
      const result = await runCoordinator.abort(normalizedSessionId, 'user_stop');
      // 与迁移前一致：只有「运行中的网关 run 确认停下」才算这一路停掉了；准备阶段被取消不算。
      // 本地操作（直连模型、生图）迁进协调器之后同一个判据：运行中被停下即算。
      const runAborted = result.outcome?.kind === 'aborted' && result.outcome.phase === 'running' && result.outcome.synced;
      let orphanAbortResult: { aborted: boolean; runIds: string[] } = { aborted: false, runIds: [] };
      try {
        const sessionInfo = sessionManager.getSession(normalizedSessionId);
        if (sessionInfo?.external_runtime || activeKind === 'direct-runtime') {
          throw Object.assign(new Error('not a gateway session run'), { skipOrphanAbort: true });
        }
        const agentId = sessionInfo?.agentId || 'main';
        const client = await getConnection(normalizedSessionId);
        orphanAbortResult = await abortOpenClawSessionRuns(
          client,
          buildOpenClawChatSessionKey(normalizedSessionId, agentId),
          `session ${normalizedSessionId} stop`,
          { retryOnMiss: true },
        );
      } catch (error) {
        // 外部运行时 / 直连模型会话：协调器那一路已经停了，没有网关 run 可清。
        if (!(error as { skipOrphanAbort?: boolean })?.skipOrphanAbort) {
          console.warn(`[chat] Failed to abort orphan OpenClaw runs while stopping session ${normalizedSessionId}:`, error);
        }
      }
      await reconcileInactiveChatLatestMessage(normalizedSessionId);
      res.json({
        success: true,
        aborted: runAborted || orphanAbortResult.aborted,
        runIds: orphanAbortResult.runIds,
      });
    } catch (error: any) {
      res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to stop chat run.'));
    }
  });

  app.post('/api/chat/silent', guardBodySession, async (req, res) => {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Missing sessionId or message' });
    }

    try {
      const client = await getConnection(sessionId);
      const rawResponse = await client.sendChatMessage({ sessionKey: sessionId, message });
      // Rewrite absolute OpenClaw media paths to HTTP-accessible URLs
      const response = rewriteOpenClawMediaPaths(rawResponse, getSessionWorkspacePath(sessionId));
      // Note: We intentionally DO NOT save to DB here
      res.json({ success: true, response });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  registerChatRunControlRoutes(app, {
    db,
    realtime: ctx.realtime,
    runCoordinator,
    access: ctx.access,
    guardParamSession,
  });
}
