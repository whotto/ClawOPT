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
import { OPENCLAW_ABORT_GRACE_MS, type OpenClawChatRunRequest, type RunCoordinator, type RuntimePlatform } from '../../runtime';
import type { ConfigManager } from '../../core/config';
import type { AgentRuntimeAdapter } from '../../runtime';
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
import type { ChatRuns } from './chat-run-managers';
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
import type { DirectChatService } from './direct-chat-service';
import { chatSessionParamGuard } from './session-routes';
import { externalModelTag, runExternalChatTurn } from './external-chat-turn';
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
  chatRuns: ChatRuns;
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

type ChatTurnKind = 'send' | 'regenerate';

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

export function registerChatRoutes(app: RouteApp, ctx: ChatRoutesDeps): void {
  const { agentProvisioner, db, sessionManager, runCoordinator } = ctx;
  const { localChatOperationManager } = ctx.chatRuns;
  const { resolveChatCommandResult } = ctx.chatCommands;
  const { getLatestChatRegenerateTarget, interruptSessionStreamingStateForNewRun, reconcileInactiveChatLatestMessage } = ctx.chatLifecycle;
  const { prepareOutgoingMessage, runDirectChatCompletion } = ctx.directChat;
  const { assertSessionInterruptionEpoch, bumpSessionInterruptionEpoch, getSessionInterruptionEpoch, getSessionWorkspacePath, readAgentBootstrapIntentContext } = ctx.sessionRuntime;
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

  /** 行已落库、流已打开之后的那一段：生图 → 直连模型 → OpenClaw 网关（经运行协调器）。 */
  async function continueChatTurn(turn: {
    req: express.Request;
    res: express.Response;
    transport: 'sse' | 'ws';
    origin?: string;
    sink: ChatStreamSink;
    sessionId: string;
    epoch: number;
    sessionInfo: SessionRow | undefined;
    agentId: string;
    agentName: string;
    modelUsed: string;
    directImageModel: string | null;
    imageIntentContext: string;
    rawMessage: string;
    finalMessage: string;
    userMessageId: number;
    assistantMessageId: number;
    runMarkerMessageIds: number[];
  }): Promise<void> {
    const { sessionId, epoch, agentId, agentName, modelUsed, assistantMessageId, sink } = turn;
    const runtimeSettings = readEffectiveAgentRuntimeSettings(turn.sessionInfo, agentId);

    if (turn.directImageModel) {
      const directImageModel = turn.directImageModel;
      const localImageController = new AbortController();
      const startProcessContent = buildImageGenerationStartProcessContent(directImageModel);
      db.updateMessage(assistantMessageId, '', directImageModel, startProcessContent, true);
      localChatOperationManager.start({
        sessionId,
        epoch,
        messageId: assistantMessageId,
        agentId,
        agentName,
        modelUsed: directImageModel,
        startedAt: Date.now(),
        kind: 'image-generation',
        abortController: localImageController,
      });
      sink.frame({
        type: 'delta',
        text: '',
        process_content: startProcessContent,
        process_streaming: true,
        modelUsed: directImageModel,
        model_used: directImageModel,
      });

      const directImageResult = await tryGenerateImageForPrompt({
        prompt: turn.rawMessage,
        intentText: turn.rawMessage,
        intentContext: turn.imageIntentContext,
        outputDir: path.join(getSessionWorkspacePath(sessionId), 'output', 'image-generations'),
        signal: localImageController.signal,
      });
      if (directImageResult) {
        assertSessionInterruptionEpoch(sessionId, epoch);
        db.updateMessage(assistantMessageId, directImageResult.content, directImageResult.modelUsed, directImageResult.processContent, false);
        const finalEvent = {
          type: 'final',
          text: directImageResult.content,
          process_content: directImageResult.processContent,
          process_streaming: false,
          modelUsed: directImageResult.modelUsed,
          model_used: directImageResult.modelUsed,
        };
        sink.frame(finalEvent);
        sink.end();
        localChatOperationManager.emit(sessionId, finalEvent, epoch);
        localChatOperationManager.finish(sessionId, epoch);
        return;
      }
      localChatOperationManager.finish(sessionId, epoch);
    }

    if (runtimeSettings.runtimeMode === 'direct') {
      const localDirectController = new AbortController();
      localChatOperationManager.start({
        sessionId,
        epoch,
        messageId: assistantMessageId,
        agentId,
        agentName,
        modelUsed,
        startedAt: Date.now(),
        kind: 'direct-runtime',
        abortController: localDirectController,
      });
      await runDirectChatCompletion({
        sessionId,
        agentId,
        userMessageId: turn.userMessageId,
        assistantMessageId,
        message: turn.finalMessage,
        modelUsed,
        stream: sink,
        signal: localDirectController.signal,
        onEvent: (event) => localChatOperationManager.emit(sessionId, event, epoch),
        processStartTag: turn.sessionInfo?.process_start_tag || undefined,
        processEndTag: turn.sessionInfo?.process_end_tag || undefined,
        sessionInterruptionEpoch: epoch,
      });
      localChatOperationManager.finish(sessionId, epoch);
      return;
    }

    // OpenClaw 网关：交给运行协调器。准备段（连网关、清孤儿 run、订阅会话事件、组装消息、
    // 取历史基线、发送）、流式、完成探针、中止都在 runtime/adapters/openclaw.ts；
    // 消息行与帧在 openclaw-chat-projection.ts。
    const attachedFrame = { type: 'attached', messageId: assistantMessageId, agentId, agentName, modelUsed };
    if (turn.transport === 'sse') {
      streamNewChatRunToSse(streamDeps, { sessionId, messageId: assistantMessageId, attachedFrame, res: turn.res });
    }
    const includeDocumentToolingContext = runtimeSettings.toolMode === 'full' || runtimeSettings.toolMode === 'coding';
    await runCoordinator.submit({
      sessionKey: sessionId,
      surface: 'chat',
      topics: [chatSessionTopic(sessionId), `agent:${agentId}`],
      agentId,
      title: agentName,
      adapter: ctx.openclawAdapter,
      request: {
        sessionId,
        agentId,
        getConnection: () => getConnection(sessionId),
        prepareMessage: () => prepareOutgoingMessage(turn.finalMessage, agentId, { includeDocumentToolingContext }),
        onGatewayReconnected: (client: GatewayChatClient) => { ctx.connections.set(sessionId, client as OpenClawClient); },
      },
      projector: (run) => createOpenClawChatProjection({
        db,
        configManager: ctx.configManager,
        run,
        messageId: assistantMessageId,
        runMarkerMessageIds: turn.runMarkerMessageIds,
        agentId,
        agentName,
        modelUsed,
        workspacePath: getSessionWorkspacePath(sessionId),
        processStartTag: turn.sessionInfo?.process_start_tag || undefined,
        processEndTag: turn.sessionInfo?.process_end_tag || undefined,
        resolveErrorModelTag: () => resolveModelTagForErrorReport(agentProvisioner, db.getSession(sessionId)?.agentId || 'main'),
      }),
      origin: turn.origin,
      workspacePath: getSessionWorkspacePath(sessionId),
      meta: { messageId: assistantMessageId, agentId, kind: 'openclaw-run' },
      abortGraceMs: OPENCLAW_ABORT_GRACE_MS,
    }, 'replace');
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
    localChatOperationManager.emit(sessionId, errorEvent, epoch);
    localChatOperationManager.finish(sessionId, epoch);
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

  app.post('/api/chat', guardBodySession, async (req, res) => {
    const { sessionId, message, parentId } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json(buildStructuredChatHttpError('Missing sessionId or message'));
    }

    const normalizedSessionId = String(sessionId);
    const { transport, origin } = readTransport(req);
    const sessionInterruptionEpoch = await interruptSessionStreamingStateForNewRun(normalizedSessionId);

    let userMsgId: number | undefined;
    let assistantMsgId: number | undefined;
    let sink: ChatStreamSink | null = null;

    try {
      const rawMessage = String(message);
      const parsedCommand = parseChatCommand(rawMessage);
      const sessionInfo = sessionManager.getSession(normalizedSessionId);

      if (sessionInfo?.external_runtime) {
        // 外部运行时单聊：`/compact` `/status` `/usage` 交给运行时本身（不是网关的内建命令），其余照常作为一轮。
        let externalParentId = parentId ? Number(parentId) : undefined;
        if (externalParentId === undefined) {
          const history = db.getMessages(normalizedSessionId, 1);
          externalParentId = history.length > 0 ? history[history.length - 1].id : undefined;
        }
        const externalAgentName = sessionInfo.name || sessionInfo.agentId;
        userMsgId = Number(db.saveMessage({ session_key: normalizedSessionId, parent_id: externalParentId, role: 'user', content: rawMessage }));
        ctx.sessionOrg.recordUserMessageForTitle(normalizedSessionId, rawMessage);
        assistantMsgId = Number(db.saveMessage({
          session_key: normalizedSessionId, parent_id: userMsgId, role: 'assistant', content: '',
          model_used: externalModelTag(sessionInfo), agent_id: sessionInfo.agentId, agent_name: externalAgentName,
        }));
        openTurnStream(res, transport, { userMsgId, assistantMsgId });
        sink = createChatStreamSink(streamDeps, { transport, sessionId: normalizedSessionId, res, origin, messageId: assistantMsgId });
        await runExternalChatTurn(externalTurnDeps, {
          session: sessionInfo, transport, origin, res, sink, prompt: rawMessage,
          assistantMessageId: assistantMsgId, runMarkerMessageIds: [userMsgId, assistantMsgId], agentName: externalAgentName,
        });
        return;
      }

      const agentId = sessionInfo?.agentId || 'main';
      const allCharacters = db.getCharacters();
      const character = allCharacters.find(c => c.agentId === agentId);
      const agentName = sessionInfo?.name || character?.name || agentId;
      const imageIntentContext = readAgentBootstrapIntentContext(agentId);
      const directImageModel = shouldUseConfiguredImageGenerationModel(rawMessage, imageIntentContext)
        ? getConfiguredDirectImageGenerationModel()
        : null;
      const modelUsed = directImageModel || agentProvisioner.readAgentModel(agentId) ||
        agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';
      const finalMessage = buildInjectedMessage(sessionInfo, agentId, rawMessage);

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

      let finalParentId = parentId ? Number(parentId) : undefined;
      if (finalParentId === undefined) {
        const history = db.getMessages(normalizedSessionId, 1);
        finalParentId = history.length > 0 ? history[history.length - 1].id : undefined;
      }

      userMsgId = Number(db.saveMessage({ session_key: normalizedSessionId, parent_id: finalParentId, role: 'user', content: rawMessage }));
      ctx.sessionOrg.recordUserMessageForTitle(normalizedSessionId, rawMessage);

      assistantMsgId = Number(db.saveMessage({
        session_key: normalizedSessionId,
        parent_id: userMsgId,
        role: 'assistant',
        content: '', // empty initially
        model_used: modelUsed,
        agent_id: agentId,
        agent_name: agentName
      }));

      openTurnStream(res, transport, { userMsgId, assistantMsgId });
      sink = createChatStreamSink(streamDeps, { transport, sessionId: normalizedSessionId, res, origin, messageId: assistantMsgId });

      await continueChatTurn({
        req, res, transport, origin, sink,
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        sessionInfo, agentId, agentName, modelUsed, directImageModel, imageIntentContext, rawMessage, finalMessage,
        userMessageId: userMsgId,
        assistantMessageId: assistantMsgId,
        runMarkerMessageIds: [userMsgId, assistantMsgId],
      });
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
          assistantMessageId: assistantMsgId, runMarkerMessageIds: [assistantMsgId], agentName: externalAgentName,
        });
        return;
      }

      const agentId = sessionInfo?.agentId || 'main';
      const finalMessage = buildInjectedMessage(sessionInfo, agentId, rawMessage);

      const allCharacters = db.getCharacters();
      const character = allCharacters.find(c => c.agentId === agentId);
      const agentName = sessionInfo?.name || character?.name || agentId;
      const imageIntentContext = readAgentBootstrapIntentContext(agentId);
      const directImageModel = shouldUseConfiguredImageGenerationModel(rawMessage, imageIntentContext)
        ? getConfiguredDirectImageGenerationModel()
        : null;
      const modelUsed = directImageModel || agentProvisioner.readAgentModel(agentId) ||
        agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';

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

      await continueChatTurn({
        req, res, transport, origin, sink,
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        sessionInfo, agentId, agentName, modelUsed, directImageModel, imageIntentContext, rawMessage, finalMessage,
        userMessageId: numericParentId,
        assistantMessageId: assistantMsgId,
        runMarkerMessageIds: [assistantMsgId],
      });
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
      const localOperation = localChatOperationManager.get(sessionId);
      if (!run && !localOperation) {
        await reconcileInactiveChatLatestMessage(sessionId);
        // Return empty payload to indicate no active run
        return res.status(200).json({ active: false });
      }

      openSseResponse(res);

      if (run && pipeChatRunToSse(streamDeps, sessionId, res)) {
        return;
      }

      if (localOperation) {
        localChatOperationManager.attachClient(sessionId, res, { announceAttach: true });
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
      const interruptedEpoch = getSessionInterruptionEpoch(normalizedSessionId);
      bumpSessionInterruptionEpoch(normalizedSessionId);
      const localAbortResult = localChatOperationManager.abort(normalizedSessionId, interruptedEpoch);
      const result = await runCoordinator.abort(normalizedSessionId, 'user_stop');
      // 与迁移前一致：只有「运行中的网关 run 确认停下」才算这一路停掉了；准备阶段被取消不算。
      const gatewayRunAborted = result.outcome?.kind === 'aborted' && result.outcome.phase === 'running' && result.outcome.synced;
      let orphanAbortResult: { aborted: boolean; runIds: string[] } = { aborted: false, runIds: [] };
      try {
        const sessionInfo = sessionManager.getSession(normalizedSessionId);
        if (sessionInfo?.external_runtime) throw Object.assign(new Error('external runtime session'), { skipOrphanAbort: true });
        const agentId = sessionInfo?.agentId || 'main';
        const client = await getConnection(normalizedSessionId);
        orphanAbortResult = await abortOpenClawSessionRuns(
          client,
          buildOpenClawChatSessionKey(normalizedSessionId, agentId),
          `session ${normalizedSessionId} stop`,
          { retryOnMiss: true },
        );
      } catch (error) {
        // 外部运行时会话：协调器那一路已经停了运行时进程组，没有网关 run 可清。
        if (!(error as { skipOrphanAbort?: boolean })?.skipOrphanAbort) {
          console.warn(`[chat] Failed to abort orphan OpenClaw runs while stopping session ${normalizedSessionId}:`, error);
        }
      }
      await reconcileInactiveChatLatestMessage(normalizedSessionId);
      res.json({
        success: true,
        aborted: localAbortResult.aborted || gatewayRunAborted || orphanAbortResult.aborted,
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
}
